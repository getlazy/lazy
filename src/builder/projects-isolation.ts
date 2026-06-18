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
 * It is resolved ONCE in the builder command before the relaunch loop and threaded
 * through. On a resume we locate the existing dir that already holds the target
 * session so the resumed line keeps its on-disk history; for a fresh run we mint a
 * new id.
 */

import { randomUUID } from 'crypto';
import { mkdir, readdir, stat, rm } from 'fs/promises';
import { join } from 'path';
import { encodeProjectPath } from '../import/claude-code-logs';
import { pathExists } from '../utils/fs';

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
 * Resolve the per-builder projects dir to mount, creating it if needed.
 *
 * - resumeId set + an existing isolation dir holds it → reuse that dir (the
 *   resumed line keeps its history; the upgrade-relaunch loop resolves here too).
 * - resumeId set + NOT found in any isolation dir → return null. The session
 *   predates isolation (or lives in the shared dir), so isolating would HIDE it
 *   and break `--resume`. Fall back to the shared dir for this run.
 * - no resumeId (fresh run) → mint a new id and create a fresh empty dir.
 *
 * @param lazyRoot  Repo root — its encoded form is the projects subdir name.
 */
export async function resolveBuilderProjectsDir(opts: {
  dataDirAbs: string;
  lazyRoot: string;
  resumeId: string | null;
}): Promise<BuilderProjectsIsolation | null> {
  const { dataDirAbs, lazyRoot, resumeId } = opts;
  const root = builderProjectsRoot(dataDirAbs);
  const encodedCwd = encodeProjectPath(lazyRoot);

  if (resumeId) {
    // Find the existing isolation dir that already holds this session.
    let children: string[] = [];
    try {
      children = await readdir(root);
    } catch {
      // Root doesn't exist yet → no isolation dir can hold the session.
      children = [];
    }
    for (const child of children) {
      const hostDir = join(root, child);
      if (await dirHasSession(hostDir, encodedCwd, resumeId)) {
        return { id: child, hostDir };
      }
    }
    // Not found anywhere — the session lives in the shared dir (legacy or
    // pre-isolation). Don't isolate; let Claude resume it from the shared dir.
    return null;
  }

  // Fresh run: mint a new, distinct id.
  const id = randomUUID().split('-')[0];
  const hostDir = join(root, id);
  await mkdir(join(hostDir, encodedCwd), { recursive: true });
  return { id, hostDir };
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
