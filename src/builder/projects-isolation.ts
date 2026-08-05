/**
 * Per-builder Claude projects-dir isolation (host side).
 *
 * WHY: A single `lazy builder` run spans several Claude session JSONL files
 * (a `/clear`, compaction, or resume each rolls to a fresh `<uuid>.jsonl`). The
 * supervisor attributes the resume target to the NEWEST file it OWNS — files that
 * are new-or-modified since launch. Under a SHARED `~/.claude/projects/<proj>`
 * dir (docker-runner bind-mounts host `~/.claude` into every container, all at the
 * same repo path) there is no on-disk evidence to attribute a post-`/clear`
 * segment to one specific concurrent builder: every builder sees identical
 * cwd/branch metadata and the `/clear` segment has `parentUuid: null` (no lineage
 * back to a known root). See the empirical findings on `fix-resume-latest-session`.
 *
 * THE FIX: give each `lazy builder` invocation its OWN projects dir, mounted at
 * `/home/user/.claude/projects` in addition to the shared `~/.claude` mount. Then
 * any file in that dir is unambiguously THIS run's, and the already-merged
 * ownership machinery becomes evidence-based.
 *
 * KEYING (this is the subtle part): the isolation dir must be STABLE across the
 * upgrade-relaunch loop's iterations (so `--resume <id>` after an upgrade restart
 * finds the prior segment's JSONL) yet DISTINCT between concurrent invocations.
 * It is resolved PER LAUNCH (resolveBuilderProjectsDirForLaunch), keyed on THAT
 * launch's resume id — the upgrade relaunch re-resolves with the session the
 * supervisor stamped, not the id the run originally started with (often null for a
 * fresh run). On a resume we locate the existing dir that already holds the target
 * session so the resumed line keeps its on-disk history AND `--resume` finds the
 * JSONL wherever it actually lives (a specific isolation dir, or the shared dir);
 * for a fresh run we mint a new id. Resolving once up front and reusing the dir was
 * the auto-resume bug — the relaunch's resolved session could live somewhere other
 * than the initially-minted dir, so `--resume` hit "No conversation found".
 *
 * SEEDING (restores Claude's in-session `/resume` picker): giving each builder its
 * OWN projects dir means Claude's native `/resume` picker — which lists only the
 * mounted projects dir — no longer sees prior sessions (they live in the shared
 * dir or in other builders' isolation dirs). So before launch we COPY every prior
 * builder session's JSONL into this run's dir. This restores the union view for
 * `/resume` WITHOUT weakening ownership: the copies exist before the container
 * starts, so they land in the supervisor's before-launch snapshot and are never
 * mis-attributed to this run nor re-captured — only files genuinely created or
 * modified after launch are owned. See seedProjectsDirFromHistory and
 * src/supervisor/builder.ts.
 */

import { randomUUID } from 'crypto';
import { mkdir, readdir, stat, rm, copyFile, utimes, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { encodeProjectPath } from '../import/claude-code-logs';
import { pathExists } from '../utils/fs';
import { getHome } from '../utils/home';
import { logger } from '../utils/logger';

/** Parent directory that holds all per-builder isolation dirs for a project. */
export function builderProjectsRoot(dataDirAbs: string): string {
  return join(dataDirAbs, 'builder-projects');
}

/**
 * Result of resolving the isolation dir for a builder launch.
 * `null` (returned by resolveBuilderProjectsDir) means "do not isolate this run"
 * — fall back to the shared host projects dir.
 */
export interface BuilderProjectsIsolation {
  /** Stable id for this invocation's isolation dir (the dir's basename). */
  id: string;
  /**
   * Absolute host path to mount at /home/user/.claude/projects. Already created.
   * Its contents mirror a real Claude projects dir: <encoded-cwd>/<session>.jsonl.
   */
  hostDir: string;
  /**
   * True ONLY when this dir provably holds a CONTAINER-WRITTEN copy of the launch's
   * resume target session — i.e. Claude created the JSONL here (the session file is
   * present AND absent from this dir's seed manifest). Such a dir is known-writable
   * by the container user, so the docker runner trusts it over a transient
   * write-probe failure. See shouldMountProjectsDir.
   *
   * A merely-present session is NOT sufficient: seedProjectsDirFromHistory copies
   * every prior session into every freshly minted dir HOST-side, so a bare
   * dirHasSession match is frequently a host-written SEEDED copy — no evidence the
   * container user can write here. Seeded copies are recorded in a per-dir
   * `.lazy-seeded.json` manifest and excluded from this trust (and skipped as
   * resume targets, since they are stale snapshots — the live session lives in its
   * birth dir or the shared dir).
   */
  holdsResumeSession: boolean;
}

/**
 * Does an isolation dir already contain the given session's JSONL? Claude writes
 * `<projects>/<encoded-cwd>/<session>.jsonl`; the encoded cwd is deterministic
 * because the repo is mounted at the same path inside every builder container.
 */
async function dirHasSession(hostDir: string, encodedCwd: string, sessionId: string): Promise<boolean> {
  return pathExists(join(hostDir, encodedCwd, `${sessionId}.jsonl`));
}

/**
 * mtime of a session's JSONL inside an isolation dir, or null when the dir does
 * not hold it. Recency is how resume resolution ranks candidate dirs: every copy
 * of a session carries its source's mtime, so the newest copy is the one with the
 * most history.
 *
 * A dir we cannot stat is not a usable candidate, so it degrades to "does not hold
 * it" — but never silently: an unreadable isolation dir is worth surfacing,
 * because it usually means a permissions problem that will bite the mount too.
 */
async function sessionMtimeMs(hostDir: string, encodedCwd: string, sessionId: string): Promise<number | null> {
  const file = join(hostDir, encodedCwd, `${sessionId}.jsonl`);
  try {
    const info = await stat(file);
    return info.isFile() ? info.mtimeMs : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; // normal: dir just doesn't hold it
    logger.warn(`Skipping builder session dir ${hostDir} as a resume candidate: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Per-dir manifest of SEEDED session ids — the sessions that seedProjectsDirFromHistory
 * copied into this dir HOST-side (see WHY below). Lives at the isolation dir ROOT,
 * a sibling of the `<encodedCwd>/` subdir, so Claude — which only enumerates
 * `<projects>/<encoded>/` — never sees it.
 *
 * WHY it exists: seeding copies every prior session into every freshly minted dir
 * so Claude's `/resume` picker lists them. That means a session's JSONL being
 * PRESENT in a dir is NOT proof the container user can write there — a host process
 * put it there. The write-trust fast path (holdsResumeSession/trustWritable) needs
 * container-write evidence, so it must exclude seeded copies. A session is
 * container-written in a dir iff it is present AND not listed in this manifest.
 */
const SEED_MANIFEST_NAME = '.lazy-seeded.json';

function seedManifestPath(hostDir: string): string {
  return join(hostDir, SEED_MANIFEST_NAME);
}

/**
 * Read the set of session ids seeded into `hostDir`. Returns `null` when the dir
 * has NO manifest — a legacy/pre-manifest dir whose files are of unknown provenance
 * (they could be seeded copies), so callers must NOT grant it the write-trust fast
 * path (they fall back to the probe instead). Returns a (possibly empty) Set when a
 * manifest exists: an empty manifest is positive evidence that no file here is
 * seeded, so present files are container-written and trustworthy.
 */
async function readSeedManifest(hostDir: string): Promise<Set<string> | null> {
  return (await readManifest(hostDir))?.seeded ?? null;
}

/**
 * Sessions this dir ADOPTED — a `lazy builder --resume <id> --import` deliberately
 * took over a session that had never run under isolation (see adoption notes on
 * resolveBuilderProjectsDir). Adopted ids stay in `seededSessionIds` too, so write
 * TRUST is unaffected: the copy is still host-written and still probe-gated until
 * Claude actually writes here. What adoption records is INTENT — the next plain
 * `--resume <id>` resolves to this dir and proceeds silently instead of demanding
 * `--import` again.
 */
async function readAdoptedSessions(hostDir: string): Promise<Set<string>> {
  return (await readManifest(hostDir))?.adopted ?? new Set();
}

/** Both id sets from a dir's manifest; null for a legacy/unreadable one. */
async function readManifest(hostDir: string): Promise<{ seeded: Set<string>; adopted: Set<string> } | null> {
  let raw: string;
  try {
    raw = await readFile(seedManifestPath(hostDir), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // A manifest that exists but can't be read (permissions, I/O) is not a normal
    // condition — surface it with context; the launch's outer try degrades to shared.
    throw new Error(`Failed to read builder seed manifest ${seedManifestPath(hostDir)}: ${(err as Error).message}`);
  }
  const toSet = (value: unknown): Set<string> =>
    Array.isArray(value) ? new Set(value.filter((x): x is string => typeof x === 'string')) : new Set();
  try {
    const parsed = JSON.parse(raw) as { seededSessionIds?: unknown; adoptedSessionIds?: unknown };
    return { seeded: toSet(parsed?.seededSessionIds), adopted: toSet(parsed?.adoptedSessionIds) };
  } catch (err) {
    // A broken manifest must never strand a launch. Treat as "unknown provenance"
    // (same as legacy → null) so the dir is probe-gated rather than wrongly trusted.
    logger.warn(`Ignoring unreadable builder seed manifest ${seedManifestPath(hostDir)}: ${(err as Error).message}`);
    return null;
  }
}

/** Rewrite a dir's manifest, preserving whichever set is not being changed. */
async function writeManifest(hostDir: string, seeded: Set<string>, adopted: Set<string>): Promise<void> {
  await writeFile(
    seedManifestPath(hostDir),
    JSON.stringify({ seededSessionIds: [...seeded].sort(), adoptedSessionIds: [...adopted].sort() }, null, 2) + '\n',
  );
}

/**
 * Mark `sessionId` as ADOPTED by this dir (and seeded, since the copy here is
 * host-written). Called only on the explicit `--import` path.
 */
async function recordAdoptedSession(hostDir: string, sessionId: string): Promise<void> {
  const manifest = await readManifest(hostDir);
  const seeded = manifest?.seeded ?? new Set<string>();
  const adopted = manifest?.adopted ?? new Set<string>();
  seeded.add(sessionId);
  adopted.add(sessionId);
  await writeManifest(hostDir, seeded, adopted);
}

/**
 * Record `newlySeeded` session ids into `hostDir`'s manifest, merging with any
 * existing entries.
 *
 * On FIRST creation (no manifest yet) every session file ALREADY present in the dir
 * is also recorded: such a dir's existing files are of unknown provenance (a
 * pre-manifest seeded copy is indistinguishable from a container write), so they are
 * conservatively marked seeded — they lose only the fast path (the probe still gates
 * them), never correctness, and a genuinely-unwritable seeded copy can never be
 * wrongly trusted. Only sessions Claude writes AFTER the manifest exists are absent
 * from it and therefore trusted.
 */
async function recordSeededSessions(hostDir: string, encodedCwd: string, newlySeeded: string[]): Promise<void> {
  const existing = await readSeedManifest(hostDir);
  const ids = existing ?? new Set<string>();
  if (existing === null) {
    // First manifest for this dir — treat all currently-present sessions as seeded.
    let present: string[] = [];
    try {
      present = (await readdir(join(hostDir, encodedCwd)))
        .filter(f => f.endsWith('.jsonl'))
        .map(f => f.replace(/\.jsonl$/, ''));
    } catch {
      // No encodedCwd subdir yet (nothing present) — normal for a just-minted dir.
    }
    for (const id of present) ids.add(id);
  }
  for (const id of newlySeeded) ids.add(id);
  // Preserve adoptedSessionIds — losing it would make every later plain --resume of
  // an adopted session demand --import again.
  await writeManifest(hostDir, ids, await readAdoptedSessions(hostDir));
}

/** How a resume target relates to per-builder isolation. */
export type ResumeSessionProvenance =
  /** Some isolation dir holds a copy that may be resumed as-is. */
  | 'isolated'
  /** The session exists, but only as host-seeded/shared copies — needs `--import`. */
  | 'needs-import'
  /** Not found anywhere — a bogus id; let Claude report the miss. */
  | 'unknown';

type ResumeCandidate = { iso: BuilderProjectsIsolation; mtimeMs: number; rank: number };

/**
 * Scan the isolation root for copies of `resumeId`, split into the copies that may
 * be resumed directly and the host-seeded ones that may only be ADOPTED.
 *
 * Both lists are ranked by RECENCY, not by provenance: the newest copy is by
 * definition the one with the most history (a copy carries the source's mtime, and
 * only Claude appending to it makes it newer), so mounting it never resumes a stale
 * snapshot. Provenance breaks exact-mtime ties (container-written > legacy >
 * adopted) and — separately — decides write TRUST, which only a container-written
 * copy earns.
 */
async function scanResumeCandidates(
  root: string,
  encodedCwd: string,
  resumeId: string,
): Promise<{ usable: ResumeCandidate | null; seededOnly: ResumeCandidate | null }> {
  let children: string[] = [];
  try {
    children = await readdir(root);
  } catch {
    // Root doesn't exist yet → no isolation dir can hold the session.
    children = [];
  }
  let usable: ResumeCandidate | null = null;
  let seededOnly: ResumeCandidate | null = null;
  const better = (a: ResumeCandidate | null, b: ResumeCandidate): boolean =>
    !a || b.mtimeMs > a.mtimeMs || (b.mtimeMs === a.mtimeMs && b.rank > a.rank);

  for (const child of children) {
    const hostDir = join(root, child);
    const mtimeMs = await sessionMtimeMs(hostDir, encodedCwd, resumeId);
    if (mtimeMs === null) continue;
    const manifest = await readManifest(hostDir);
    // 2 = container-written (present, manifest-aware dir, not listed) ⇒ writable
    // 1 = legacy pre-manifest dir (provenance unknown) ⇒ probe-gated
    // 0 = host-seeded copy ⇒ probe-gated, and resumable only once ADOPTED
    const rank = manifest === null ? 1 : (manifest.seeded.has(resumeId) ? 0 : 2);
    const candidate: ResumeCandidate = {
      iso: { id: child, hostDir, holdsResumeSession: rank === 2 },
      mtimeMs,
      rank,
    };
    const adopted = manifest?.adopted.has(resumeId) ?? false;
    if (rank > 0 || adopted) {
      if (better(usable, candidate)) usable = candidate;
    } else if (better(seededOnly, candidate)) {
      seededOnly = candidate;
    }
  }
  return { usable, seededOnly };
}

/**
 * Classify a resume target without creating, seeding or mutating anything.
 *
 * This is what `lazy builder --resume <id>` gates on: `needs-import` means the
 * session has never run under builder isolation, so resuming it would silently
 * ADOPT it into an overlay — the user opts into that with `--import`.
 */
export async function classifyResumeSession(opts: {
  dataDirAbs: string;
  lazyRoot: string;
  resumeId: string;
  /** Host home holding the shared ~/.claude/projects dir. Injectable for tests. */
  homeDirAbs?: string;
}): Promise<ResumeSessionProvenance> {
  const { dataDirAbs, lazyRoot, resumeId, homeDirAbs = getHome() } = opts;
  const encodedCwd = encodeProjectPath(lazyRoot);
  const { usable, seededOnly } = await scanResumeCandidates(builderProjectsRoot(dataDirAbs), encodedCwd, resumeId);
  if (usable) return 'isolated';
  if (seededOnly) return 'needs-import';
  const sharedHasIt = await pathExists(join(homeDirAbs, '.claude', 'projects', encodedCwd, `${resumeId}.jsonl`));
  return sharedHasIt ? 'needs-import' : 'unknown';
}

/**
 * Resolve the per-builder projects dir to mount, creating it if needed.
 *
 * - resumeId set + some isolation dir holds a RESUMABLE copy of it → reuse the dir
 *   holding the NEWEST such copy (ties broken towards container-written, then
 *   legacy, then adopted). The resumed line keeps its on-disk history and the
 *   upgrade relaunch resolves here too. Write-TRUST is a separate question,
 *   answered by provenance alone: only a container-written copy (present AND
 *   absent from the seed manifest) earns it.
 *   Resumable = container-written, legacy (pre-manifest, provenance unknown), or
 *   previously ADOPTED via `--import`.
 * - resumeId set + every copy is host-SEEDED or lives only in the SHARED host dir
 *   (legacy/pre-isolation, or a run whose write-probe was off) → return null
 *   UNLESS `adopt` is set. The session has never run under builder isolation, so
 *   picking an overlay for it is an ADOPTION, not a resume: `lazy builder` errors
 *   with that message and the user opts in with `--import`. With `adopt` set, the
 *   newest seeded copy's dir is taken over (or a fresh dir is minted for a
 *   shared-only session) and the id is recorded in `adoptedSessionIds`, so later
 *   plain resumes of it land here silently.
 *   Note that mounting the SHARED dir is never an option — that was the resume
 *   SPLIT-BRAIN; see the seeding note below.
 * - resumeId set + the session is nowhere at all (a bogus/typo'd id) → return
 *   null. Nothing to isolate; let Claude report the miss against the shared dir
 *   exactly as it always has.
 * - no resumeId (fresh run) → mint a new id and create a fresh empty dir.
 *
 * @param lazyRoot  Repo root — its encoded form is the projects subdir name.
 */
export async function resolveBuilderProjectsDir(opts: {
  dataDirAbs: string;
  lazyRoot: string;
  resumeId: string | null;
  /** Host home holding the shared ~/.claude/projects dir. Injectable for tests. */
  homeDirAbs?: string;
  /** `--import`: deliberately adopt a session that has never run under isolation. */
  adopt?: boolean;
}): Promise<BuilderProjectsIsolation | null> {
  const { dataDirAbs, lazyRoot, resumeId, homeDirAbs = getHome(), adopt = false } = opts;
  const root = builderProjectsRoot(dataDirAbs);
  const encodedCwd = encodeProjectPath(lazyRoot);

  /** Mint a new, distinct isolation dir for a run with no dir of its own yet. */
  const mintFreshDir = async (): Promise<BuilderProjectsIsolation> => {
    const id = randomUUID().split('-')[0];
    const hostDir = join(root, id);
    await mkdir(join(hostDir, encodedCwd), { recursive: true });
    return { id, hostDir, holdsResumeSession: false };
  };

  let target: BuilderProjectsIsolation | null = null;
  /** Set when this call is ADOPTING the resume target into `target`. */
  let adoptingSessionId: string | null = null;

  if (resumeId) {
    // A resume target can appear in MANY dirs: its birth dir (container-written)
    // plus a host-SEEDED copy in every later-minted dir (seedProjectsDirFromHistory).
    const { usable, seededOnly } = await scanResumeCandidates(root, encodedCwd, resumeId);
    target = usable?.iso ?? null;

    if (!target) {
      // Nothing resumable. The session may still EXIST — as a seeded copy here, or
      // in the shared host projects dir (pre-isolation history, or a run whose
      // write-probe was off). Taking one of those over is an ADOPTION: it makes an
      // overlay authoritative for a session that has never run under isolation.
      // That used to happen silently; now the caller must opt in with `--import`.
      //
      // WHY NOT mount the shared dir here (this is the split-brain fix): the
      // shared dir is a seeding SOURCE but never a seeding SINK — no
      // isolation-born session is ever copied back into it. So a builder mounted
      // on the shared dir sees a strictly older, disjoint slice of history, and
      // its Claude `/resume` picker cannot list any session born under isolation
      // — including a live one from another terminal. Which list you got depended
      // on which session id you resumed. Isolating keeps every launch's picker on
      // the SAME seeded union.
      if (!adopt) return null;
      if (seededOnly) {
        // Same overlay the pre-gate path selected: the dir with the newest copy.
        target = seededOnly.iso;
      } else {
        const sharedHasIt = await pathExists(
          join(homeDirAbs, '.claude', 'projects', encodedCwd, `${resumeId}.jsonl`),
        );
        // Nowhere at all — a bogus id. Don't mint a dir for a session that does not
        // exist; fall back to the shared dir so Claude reports the miss as before.
        if (!sharedHasIt) return null;
        target = await mintFreshDir();
      }
      adoptingSessionId = resumeId;
    }
  } else {
    target = await mintFreshDir();
  }

  // Seed prior builder sessions into this run's dir so Claude's `/resume` picker
  // lists them again. Best-effort — a seeding failure must NEVER block the
  // launch (the builder still works; /resume just shows fewer sessions).
  try {
    await seedProjectsDirFromHistory({
      dataDirAbs,
      homeDirAbs,
      encodedCwd,
      targetHostDir: target.hostDir,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Could not seed builder /resume history for this run: ${msg}`);
  }

  // Record the adoption AFTER seeding (seeding rewrites the manifest). This is the
  // only durable effect of `--import`: the session stays host-written and therefore
  // untrusted/probe-gated, but later plain `--resume` calls resolve here without
  // demanding `--import` again.
  if (adoptingSessionId) {
    await recordAdoptedSession(target.hostDir, adoptingSessionId);
  }

  // Mark the dir as USED now. Pruning ages dirs by their own mtime, and writing
  // session files into `<dir>/<encodedCwd>/` never touches it — so without this a
  // dir resumed daily still looked untouched since the day it was created and got
  // reaped out from under an active line. Best-effort: a failed touch only risks
  // an early prune, never this launch.
  try {
    const now = new Date();
    await utimes(target.hostDir, now, now);
  } catch (err) {
    logger.debug(`Could not refresh builder session dir mtime ${target.hostDir}: ${(err as Error).message}`);
  }

  return target;
}

/**
 * What the docker runner needs to mount a per-builder projects dir for one launch.
 */
export interface BuilderLaunchProjects {
  /** Absolute host dir to mount at /home/user/.claude/projects. */
  hostDir: string;
  /**
   * True when host-side resolution positively located this dir as the one holding
   * the launch's resume target session. Such a dir is known-writable (Claude wrote
   * that session's JSONL into it through a container user that could write there),
   * so the docker runner trusts it OVER a failing write-probe — mounting it anyway
   * rather than stranding `--resume` by falling back to the shared dir where the
   * session does not live. A fresh (minted) dir has no session at stake, so it is
   * NOT trusted and the probe still gates it. See shouldMountProjectsDir.
   */
  trustWritable: boolean;
}

/**
 * Decide whether the docker runner should mount the resolved isolation dir at
 * ~/.claude/projects. Pure so the flip-safe decision can be unit-tested without
 * docker.
 *
 * - `trustWritable` (the dir already holds the resume target's session) wins
 *   outright: the dir is known-writable, so a transient write-probe failure (e.g.
 *   a `docker run` timeout under upgrade load) must NOT drop the mount — doing so
 *   would strand `--resume`, since the session lives only in this dir. This is the
 *   residual auto-resume bug: the probe flipping to fail between the initial run
 *   and the upgrade relaunch shadowed the isolation dir and broke `--resume`.
 * - Otherwise gate on the probe: a fresh dir has no session to strand, so a real
 *   uid-mismatch (unwritable overlay) correctly falls back to the shared dir.
 */
export function shouldMountProjectsDir(opts: {
  trustWritable: boolean;
  probeWritable: boolean;
}): boolean {
  return opts.trustWritable || opts.probeWritable;
}

/**
 * Resolve the per-builder projects dir to mount for ONE launch, keyed on that
 * launch's resume id, and opportunistically prune stale dirs. Returns the host
 * dir to mount at ~/.claude/projects, or `undefined` to use the shared
 * ~/.claude/projects dir. The write-probe TRUST for the returned dir is a separate
 * concern — see isTrustedResumeProjectsDir.
 *
 * WHY per-launch (this is the upgrade-auto-resume fix): a `lazy builder` run may
 * launch the child MORE than once — after `lazy upgrade` stops the container the
 * relaunch loop re-launches with `--resume <resolvedId>`, where `resolvedId` is
 * the session the supervisor stamped, NOT the id the run originally started with
 * (often null for a fresh run). Resolving the dir ONCE up front and reusing it
 * pointed the relaunch's `--resume` at the initially-minted dir, which may not
 * hold the resolved session (it landed in the shared dir that run, or a different
 * isolation dir) — Claude then printed "No conversation found with session ID".
 * Re-resolving here per launch performs the SAME lookup a manual
 * `lazy builder --resume <id>` does: locate the dir that actually holds the
 * session, or fall back to the shared dir where it lives.
 *
 * Self-healing: this NEVER throws. A resolution failure degrades to the shared
 * dir (returns undefined) rather than blocking the launch, matching the host-side
 * fallback the builder command relied on before.
 */
export async function resolveBuilderProjectsDirForLaunch(opts: {
  dataDirAbs: string;
  lazyRoot: string;
  resumeId: string | null;
  /** Host home holding the shared ~/.claude/projects dir. Injectable for tests. */
  homeDirAbs?: string;
  /** `--import`: deliberately adopt a session that has never run under isolation. */
  adopt?: boolean;
}): Promise<string | undefined> {
  const { dataDirAbs, lazyRoot, resumeId, homeDirAbs, adopt } = opts;
  try {
    const isolation = await resolveBuilderProjectsDir({ dataDirAbs, lazyRoot, resumeId, homeDirAbs, adopt });
    // Opportunistic cleanup so per-builder dirs don't accumulate. Best-effort —
    // never block launching on a prune failure. Keep the active dir.
    try {
      const removed = await pruneStaleBuilderProjectsDirs(dataDirAbs, isolation?.id ?? null);
      if (removed.length > 0) {
        logger.info(`Cleaned up ${removed.length} stale builder session dir(s).`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Could not prune stale builder session dirs: ${msg}`);
    }
    return isolation?.hostDir;
  } catch (err) {
    // Host-side isolation setup failed (e.g. the dir couldn't be created).
    // Degrade gracefully: run against the shared dir rather than failing.
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      `Per-builder Claude projects isolation could not be set up (${msg}); ` +
      `falling back to the shared ~/.claude/projects dir for this run. ` +
      `Concurrent builders may cross-capture sessions.`,
    );
    return undefined;
  }
}

/**
 * Is `hostDir` the write-probe-TRUSTED dir for resuming `resumeId` — i.e. does it
 * hold a CONTAINER-WRITTEN copy of that session (the JSONL is present AND absent
 * from the dir's seed manifest)? Such a dir is known-writable, so the docker runner
 * mounts it even if the write-probe transiently fails (the residual auto-resume
 * fix). Returns false for a fresh run (no resumeId), a legacy pre-manifest dir
 * (unknown provenance → probe-gated), or a dir holding only a host-SEEDED copy
 * (stale, no write evidence). See BuilderProjectsIsolation.holdsResumeSession and
 * shouldMountProjectsDir.
 *
 * Kept separate from resolveBuilderProjectsDirForLaunch (which returns just the
 * hostDir) so the launch's mount target and its write-trust stay decoupled. Never
 * throws — any error degrades to `false` (probe-gated), matching the conservative
 * fallback everything else here uses.
 */
export async function isTrustedResumeProjectsDir(opts: {
  hostDir: string;
  lazyRoot: string;
  resumeId: string | null;
}): Promise<boolean> {
  const { hostDir, lazyRoot, resumeId } = opts;
  if (!resumeId) return false;
  try {
    const encodedCwd = encodeProjectPath(lazyRoot);
    if (!(await dirHasSession(hostDir, encodedCwd, resumeId))) return false;
    const seeded = await readSeedManifest(hostDir);
    // Trusted only with positive container-write evidence: a manifest exists
    // (dir is manifest-aware) AND does not list this session (Claude wrote it here).
    return seeded !== null && !seeded.has(resumeId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Could not determine builder projects write-trust for ${hostDir}; probe-gating: ${msg}`);
    return false;
  }
}

/**
 * Copy prior builder sessions' JSONLs into `targetHostDir/<encodedCwd>/` so
 * Claude Code's in-session `/resume` picker lists them. Sources are every OTHER
 * known session location for this repo: the shared host `~/.claude/projects/<proj>`
 * dir and every OTHER per-builder isolation dir.
 *
 * A copy already present in the target is REFRESHED when a strictly newer copy
 * exists elsewhere and the present one is a host-seeded copy (listed in this dir's
 * seed manifest). Without that, a session resumed-and-grown in another dir stayed
 * frozen here at whatever length it had when this dir was first seeded — one more
 * way two builders ended up looking at different history. Files that are NOT
 * provably host-seeded — container-written sessions, and everything in a legacy
 * pre-manifest dir — are never touched: those are (or may be) this line's own live
 * history, and clobbering them could lose turns.
 *
 * WHY COPY (not hardlink/symlink): each isolation dir must stay fully independent
 * so a session resumed-and-appended in one dir can never perturb another dir's
 * ownership evidence through a shared inode. The copies land before the container
 * starts, so the supervisor's before-launch snapshot already contains them and
 * ownership/capture (src/supervisor/builder.ts) correctly excludes them.
 *
 * Original mtimes are preserved so Claude's picker orders sessions by their true
 * recency and the snapshot sees them as pre-launch, not fresh.
 */
async function seedProjectsDirFromHistory(opts: {
  dataDirAbs: string;
  homeDirAbs: string;
  encodedCwd: string;
  targetHostDir: string;
}): Promise<void> {
  const { dataDirAbs, homeDirAbs, encodedCwd, targetHostDir } = opts;
  const targetDir = join(targetHostDir, encodedCwd);
  await mkdir(targetDir, { recursive: true });

  // Collect source dirs: the shared host projects dir + all OTHER isolation dirs.
  const sourceDirs = [join(homeDirAbs, '.claude', 'projects', encodedCwd)];
  const root = builderProjectsRoot(dataDirAbs);
  let isolationChildren: string[] = [];
  try {
    isolationChildren = await readdir(root);
  } catch {
    // No isolation root yet → only the shared dir (if any) contributes. Normal.
    isolationChildren = [];
  }
  for (const child of isolationChildren) {
    const childDir = join(root, child, encodedCwd);
    if (childDir === targetDir) continue; // never seed a dir from itself
    sourceDirs.push(childDir);
  }

  // Build a union keyed by session filename; when the same session exists in
  // several dirs (e.g. resumed-and-continued in one line), keep the newest.
  const best = new Map<string, { path: string; atimeMs: number; mtimeMs: number }>();
  for (const dir of sourceDirs) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      // Source dir absent (never used, or no shared history) — normal; skip.
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const full = join(dir, entry);
      let info;
      try {
        info = await stat(full);
      } catch {
        continue; // Vanished between readdir and stat — skip.
      }
      if (!info.isFile()) continue;
      const prev = best.get(entry);
      if (!prev || info.mtimeMs > prev.mtimeMs) {
        best.set(entry, { path: full, atimeMs: info.atimeMs, mtimeMs: info.mtimeMs });
      }
    }
  }

  // Which of the target's existing files are host-seeded copies (safe to refresh)?
  // null = legacy dir, unknown provenance → refresh nothing here. An ADOPTED
  // session is excluded too: this dir is the live home of that line now, so its
  // copy must never be overwritten from elsewhere.
  const targetManifest = await readManifest(targetHostDir);

  // Copy each session into the target unless it's already there and up to date.
  const seededIds: string[] = [];
  for (const [entry, src] of best) {
    const dest = join(targetDir, entry);
    const sessionId = entry.replace(/\.jsonl$/, '');
    let destInfo: Awaited<ReturnType<typeof stat>> | null = null;
    try {
      destInfo = await stat(dest);
    } catch (err) {
      // ENOENT is the common case (nothing seeded yet); anything else means we
      // can't reason about the destination, so treat it as "leave it alone".
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.debug(`Skipped seeding builder session ${entry} (cannot stat destination): ${(err as Error).message}`);
        continue;
      }
    }
    if (destInfo) {
      // Only a known host-seeded copy may be replaced, and only by newer content.
      if (!targetManifest?.seeded.has(sessionId)) continue;
      if (targetManifest.adopted.has(sessionId)) continue;
      if (src.mtimeMs <= destInfo.mtimeMs) continue;
    }
    try {
      await copyFile(src.path, dest);
      await utimes(dest, new Date(src.atimeMs), new Date(src.mtimeMs));
      seededIds.push(entry.replace(/\.jsonl$/, ''));
    } catch (err) {
      // One un-seedable session just won't appear in /resume for this run — a
      // cosmetic loss, never worth failing the launch. Surface it at debug.
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug(`Skipped seeding builder session ${entry} into /resume history: ${msg}`);
    }
  }

  // Record the seeded (host-written) sessions so later resume resolution never
  // mistakes a seeded COPY for container-write evidence. Always written — even with
  // nothing seeded — so the dir is marked manifest-aware and the sessions Claude
  // writes into it AFTER this point earn the write-trust fast path. See readSeedManifest.
  await recordSeededSessions(targetHostDir, encodedCwd, seededIds);
}

const DEFAULT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/**
 * Remove per-builder isolation dirs that haven't been touched recently so they
 * don't accumulate on disk. The currently-active dir (`keepId`) is always kept.
 * Best-effort: failures to remove a single stale dir are logged by the caller's
 * choice, not thrown — pruning must never block launching a builder.
 *
 * @returns the ids that were removed.
 */
export async function pruneStaleBuilderProjectsDirs(
  dataDirAbs: string,
  keepId: string | null,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
  now: number = Date.now(),
): Promise<string[]> {
  const root = builderProjectsRoot(dataDirAbs);
  let children: string[];
  try {
    children = await readdir(root);
  } catch {
    return []; // Nothing to prune.
  }

  const removed: string[] = [];
  for (const child of children) {
    if (child === keepId) continue;
    const hostDir = join(root, child);
    try {
      const info = await stat(hostDir);
      if (!info.isDirectory()) continue;
      if (now - info.mtimeMs < maxAgeMs) continue;
      await rm(hostDir, { recursive: true, force: true });
      removed.push(child);
    } catch {
      // A dir we can't stat or remove is left in place; skip it. Pruning is
      // opportunistic cleanup, never a hard requirement for launching.
    }
  }
  return removed;
}
