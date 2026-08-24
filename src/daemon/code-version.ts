/**
 * Running-code identity for staleness detection.
 *
 * A long-lived daemon serves whatever code it was started with — it does not
 * hot-reload when the source changes. During lazy's own development this bites
 * hard: you merge a fix, but the daemon still runs the old handlers, so behavior
 * that was fixed on disk still misbehaves at runtime with no visible signal.
 *
 * `getRunningCodeSha()` returns the git short SHA of the source checkout THIS
 * process is running from. The daemon captures it at startup and surfaces it via
 * GET /daemon/status; `lazy daemon status` compares it against the working tree's
 * current HEAD and warns when they diverge, pointing the operator at
 * `lazy daemon restart`.
 *
 * Returns null when the SHA can't be determined — a compiled/installed binary
 * (no source tree, git fails) or a non-git checkout. In those cases there is no
 * divergence warning; the existing version/buildTime fields already cover
 * compiled-binary staleness.
 */

import { spawnSyncUnsupervised } from '../utils/spawn';

let cached: string | null | undefined;

/** Deadline for the one-shot `git rev-parse`; unknown beats blocked. */
const GIT_SHA_TIMEOUT_MS = 5_000;

/**
 * Git short SHA of the source this process runs from, or null when unavailable.
 *
 * Cached: a live process cannot change the code it is executing, so one lookup
 * is authoritative for the process lifetime. Uses a sync spawn deliberately —
 * this is called from daemon startup and CLI paths, never a hot async loop.
 */
export function getRunningCodeSha(): string | null {
  if (cached !== undefined) return cached;
  try {
    const res = spawnSyncUnsupervised(['git', 'rev-parse', '--short', 'HEAD'], {
      // import.meta.dir is the source directory in dev (bun run ./src/index.ts)
      // and a virtual path inside a compiled binary — where git simply fails,
      // yielding null, which is the correct "unknown" answer.
      cwd: import.meta.dir,
      stdout: 'pipe',
      stderr: 'pipe',
      // DAEMON-REACHABLE sync spawn (daemon startup and `daemon status`): git
      // can hang on a locked index or a slow filesystem, and the default
      // backstop is far longer than a rev-parse should ever take.
      timeout: GIT_SHA_TIMEOUT_MS,
    });
    const out = res.stdout.toString().trim();
    cached = res.exitCode === 0 && out ? out : null;
  } catch {
    // git not installed, or import.meta.dir not on a filesystem git can read.
    cached = null;
  }
  return cached;
}

/** Reset the cache. Testing only. */
export function resetRunningCodeShaCache(): void {
  cached = undefined;
}
