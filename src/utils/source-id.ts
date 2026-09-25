/**
 * The identity of the lazy SOURCE TREE a process runs from — one answer, one
 * algorithm, every surface.
 *
 * WHY THIS EXISTS. Lazy is a monolith from the point of view of version
 * management: Lazy Teams and every project daemon it supervises run the same
 * code from the app's own tree. Making that true at runtime means the fleet has
 * to be able to ask "which lazy code is this?" of a running daemon and of the
 * checkout it would launch the next one from, and get two answers it can
 * COMPARE. Before this module there were three partial answers and none of them
 * was comparable:
 *
 *  - {@link getRunningCodeSha} (src/daemon/code-version.ts) gives the git short
 *    SHA — null for a release build with no `.git`, and blind to uncommitted
 *    edits, which is most of a development day.
 *  - The self-host Dockerfile computed a content fingerprint with a
 *    `find | xargs sha256sum | sha256sum | awk` pipeline and baked it into
 *    `.source-fingerprint`.
 *  - The self-host entrypoint read that file back, falling back to a `sed` over
 *    `src/version.ts` when it was missing.
 *
 * The motivating incident is recorded in the `monolithic-versioning` task: a
 * daemon built from `main` silently failed to render a review feature that
 * existed only on the release branch. The feature looked lost; it was a version
 * mismatch nothing on any screen could have shown.
 *
 * WHAT THE ID IS. The first 16 hex characters of a sha256 over the sorted
 * per-file sha256 of {@link FINGERPRINT_ROOTS} — `src/**` plus the three files
 * that decide what `bun run src/index.ts` actually executes. Deliberately the
 * same file set the Dockerfile hashed, so the value does not move under anyone
 * upgrading into this.
 *
 * A CONTENT hash rather than a git SHA because the question is "is this the same
 * code", not "is this the same commit": a dirty working tree is the normal state
 * of a development checkout, and a fleet that ignored uncommitted edits would
 * tell the engineer their daemons were current when they were not.
 *
 * BAKED BEATS COMPUTED. A `.source-fingerprint` at the checkout root is used
 * verbatim. It is a build-time CACHE of this same function (the Dockerfile calls
 * `lazy system source-id --write` to produce it), not a second implementation —
 * which is the whole point of the file surviving the rewrite that deleted the
 * shell pipeline.
 */

import { createHash } from 'crypto';
import { readdir, readFile } from 'fs/promises';
import { join, relative, sep } from 'path';

import { VERSION } from '../version';
import { readEmbeddedBuildProvenance } from './build-provenance';

/**
 * What the fingerprint covers, relative to the checkout root.
 *
 * `src/` is the code. The other three decide what that code IS at runtime:
 * `package.json` carries the version and the scripts, `bun.lock` pins every
 * dependency resolved into the process, and `Dockerfile.lazy` is the agent
 * container image lazy builds and runs turns in — a change there changes what a
 * turn executes just as surely as a change in `src/`.
 *
 * Deliberately identical to the set the self-host Dockerfile hashed before this
 * module existed, so an install upgrading into it does not see a spurious
 * "everything is stale" on first boot.
 */
export const FINGERPRINT_ROOTS = ['src', 'package.json', 'bun.lock', 'Dockerfile.lazy'] as const;

/** Name of the build-time cache of {@link computeSourceFingerprint}. */
export const FINGERPRINT_FILE = '.source-fingerprint';

/** Hex characters kept from the sha256. Matches what the Dockerfile baked. */
const ID_LENGTH = 16;

/**
 * Where the id came from — which is information, not trivia.
 *
 * `baked` says a build wrote it and the tree was not read; `computed` says this
 * process hashed the tree it is running from; `build` says there is no source
 * tree at all (a compiled binary), so the id is derived from build provenance
 * and CANNOT be compared against a checkout's fingerprint.
 */
export type SourceIdKind = 'baked' | 'computed' | 'build';

export interface SourceIdentity {
  /** 16 hex chars for `baked`/`computed`; `build:<sha>` or `version:<v>` otherwise. */
  id: string;
  kind: SourceIdKind;
  /** The checkout root the id describes, or null for a compiled binary. */
  checkoutPath: string | null;
}

/** Directory names never worth hashing — none of them is lazy's own source. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

/**
 * Every file under `dir`, relative to `root`, depth-first and unsorted.
 *
 * Async throughout: this runs at daemon startup, and a recursive sync walk of
 * ~800 files on a slow filesystem is exactly the kind of "cold code" the
 * project's no-sync-fs rule exists to keep out of a hot path later.
 */
async function walk(root: string, dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(root, join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(relative(root, join(dir, entry.name)));
    }
  }
}

/**
 * Hash the lazy source tree rooted at `checkoutRoot`.
 *
 * Deterministic and pure. Paths are normalised to forward slashes and sorted by
 * code unit before hashing, so the same tree on a different platform — or read
 * back in a different directory order — yields the same id. A path named in
 * {@link FINGERPRINT_ROOTS} that does not exist is skipped rather than fatal:
 * `bun.lock` is absent from some checkouts, and a fingerprint that refuses to
 * exist is worse than one covering slightly less.
 *
 * Throws only if the root itself cannot be read, which the callers turn into a
 * stated "unknown" rather than a failure.
 */
export async function computeSourceFingerprint(checkoutRoot: string): Promise<string> {
  const files: string[] = [];
  for (const entry of FINGERPRINT_ROOTS) {
    const target = join(checkoutRoot, entry);
    try {
      await walk(checkoutRoot, target, files);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      // ENOTDIR is a plain file (package.json and friends); ENOENT is a member
      // of the set this checkout does not have. Anything else is a real read
      // failure and belongs to the caller.
      if (code === 'ENOTDIR') files.push(relative(checkoutRoot, target));
      else if (code !== 'ENOENT') throw err;
    }
  }

  const normalised = files
    .map(path => (sep === '/' ? path : path.split(sep).join('/')))
    .sort();

  const outer = createHash('sha256');
  for (const path of normalised) {
    const bytes = await readFile(join(checkoutRoot, ...path.split('/')));
    // `<file sha256>  <path>` per line: the same shape `sha256sum` emits, so the
    // value is reproducible by hand from a shell when somebody doubts it.
    outer.update(`${createHash('sha256').update(bytes).digest('hex')}  ${path}\n`);
  }
  return outer.digest('hex').slice(0, ID_LENGTH);
}

/**
 * The baked fingerprint at `checkoutRoot`, or null when there is none.
 *
 * Validated rather than trusted: the file is written by a build and read at
 * runtime, and a truncated or garbage value would be compared against real ids
 * forever, making every daemon look permanently stale. A value that is not
 * `ID_LENGTH` lowercase hex characters is treated as absent, and the tree is
 * hashed instead.
 */
export async function readBakedFingerprint(checkoutRoot: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(join(checkoutRoot, FINGERPRINT_FILE), 'utf-8');
  } catch {
    return null;
  }
  const value = raw.trim();
  return new RegExp(`^[0-9a-f]{${ID_LENGTH}}$`).test(value) ? value : null;
}

/**
 * The checkout root this module's own file sits in, or null when there is none.
 *
 * `import.meta.dir` is `<checkout>/src/utils` when running from source and a
 * virtual path inside a compiled binary — where the parent directories do not
 * exist on any filesystem, which is how the `build` kind is detected rather than
 * guessed.
 */
export function sourceCheckoutRoot(): string | null {
  const dir = import.meta.dir;
  const marker = `${sep}src${sep}utils`;
  return dir.endsWith(marker) ? dir.slice(0, -marker.length) : null;
}

let cached: SourceIdentity | undefined;

/**
 * The identity of the code THIS process is running.
 *
 * Memoized for the process lifetime, on the same argument `code-version.ts`
 * makes: a live process cannot change the code it is executing, so one lookup is
 * authoritative. Measured cold cost on lazy's own tree: ~90 ms for ~800 files —
 * paid once, at startup.
 *
 * Never throws. An unreadable tree yields the `build` kind, which says "not
 * comparable" rather than inventing an id two surfaces would then disagree about.
 */
export async function getSourceIdentity(): Promise<SourceIdentity> {
  if (cached !== undefined) return cached;
  cached = await resolveSourceIdentity();
  return cached;
}

async function resolveSourceIdentity(): Promise<SourceIdentity> {
  const root = sourceCheckoutRoot();
  if (root !== null) {
    const baked = await readBakedFingerprint(root);
    if (baked) return { id: baked, kind: 'baked', checkoutPath: root };
    try {
      return { id: await computeSourceFingerprint(root), kind: 'computed', checkoutPath: root };
    } catch {
      // Fall through to build provenance: a checkout we cannot read is closer to
      // a compiled binary than to a tree we can describe.
    }
  }
  return { id: await buildIdentityFallback(), kind: 'build', checkoutPath: null };
}

/**
 * The identity of a compiled binary, which has no tree to hash.
 *
 * Prefixed so it can never collide with a real fingerprint: comparing a
 * `build:` id against a `computed:` one must read as "different", and it does,
 * for the honest reason that they are not the same kind of answer.
 */
async function buildIdentityFallback(): Promise<string> {
  const provenance = await readEmbeddedBuildProvenance();
  const sha = provenance?.buildSha;
  return sha && sha !== 'dev' && sha !== 'unknown' ? `build:${sha}` : `version:${VERSION}`;
}

/**
 * The identity of an arbitrary checkout, for a caller naming one explicitly
 * (`lazy system source-id --checkout`, doctor comparing the daemon against the
 * tree on disk). Not cached: the point is to read the tree as it is now.
 */
export async function sourceIdentityOf(checkoutRoot: string): Promise<SourceIdentity> {
  const baked = await readBakedFingerprint(checkoutRoot);
  if (baked) return { id: baked, kind: 'baked', checkoutPath: checkoutRoot };
  return { id: await computeSourceFingerprint(checkoutRoot), kind: 'computed', checkoutPath: checkoutRoot };
}

/**
 * The identity of a checkout, computed from the TREE, ignoring any baked file.
 *
 * This is what `--write` must use. Every other reader prefers the baked value —
 * that is the point of baking it — but a writer that did the same could only
 * ever rewrite a stale file with itself, so a `.source-fingerprint` left behind
 * by an old build would pin that checkout's identity for ever and no re-bake
 * could dislodge it. Both halves of that failure hide staleness rather than
 * over-report it, which is the direction nobody notices until a feature "does
 * not exist" on a daemon again.
 */
export async function computeSourceIdentityOf(checkoutRoot: string): Promise<SourceIdentity> {
  return { id: await computeSourceFingerprint(checkoutRoot), kind: 'computed', checkoutPath: checkoutRoot };
}

/** Reset the cache. Testing only. */
export function resetSourceIdentityCache(): void {
  cached = undefined;
}
