/**
 * Isolated daemon-state directories for tests.
 *
 * WHY THIS EXISTS: tests that need a daemon on its DEFAULT socket/PID/token
 * paths (rather than an explicit `socketPath`) used to isolate themselves from
 * the developer's real `~/.lazy/daemon` by pointing `HOME` at a temp dir. That
 * is a blunt instrument: `HOME` also steers credential discovery (`~/.claude`),
 * `~/.gitconfig`, tool caches, and `createStorage`'s default-path branch — so a
 * test that only wanted a private socket silently changes half a dozen other
 * lookups, and does so differently on a developer machine (which HAS a real
 * `~/.claude`, a real `~/.lazy`, and a running daemon) than in a clean CI
 * container. That divergence is exactly how this suite ended up green in a
 * container and red on the author's Mac.
 *
 * `LAZY_DAEMON_BASE_DIR` is the documented, targeted override in
 * `src/daemon/paths.ts`: every daemon path (PID, socket, token, log, lock, web
 * port marker, root marker) flows through `getDaemonBaseDir()`, so they all
 * move together and NOTHING else does.
 *
 * The directory is allocated directly under `/tmp` rather than `os.tmpdir()`,
 * which keeps the resulting socket path short. That is hygiene, not a fix:
 * `Bun.serve({ unix })` was measured binding 130-byte paths on Linux (kernel
 * `sun_path` limit: 108), so Bun evidently works around the limit itself — do
 * NOT rely on a long path failing, or on a short one being required.
 *
 * `LAZY_DAEMON_BASE_DIR` must be passed to CLI subprocesses too (it is read
 * from the environment), which `setupTestLazy`'s `env` option does by merging
 * over `process.env`.
 */

import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';

/** Create a short-pathed, private daemon base directory. */
export async function makeDaemonBaseDir(): Promise<string> {
  return await mkdtemp(join('/tmp', 'lzd-'));
}

/**
 * Point `LAZY_DAEMON_BASE_DIR` at `dir` and return the undo.
 *
 * Use this instead of assigning the variable and `delete`-ing it in `afterEach`,
 * for two reasons that both bit:
 *
 * 1. ORDER. `ctx.cleanup()` reaps the test daemon BY PIDFILE, and the pidfile
 *    path is resolved from `LAZY_DAEMON_BASE_DIR` at the moment cleanup runs.
 *    Clearing the variable first makes teardown look under the DEFAULT base dir
 *    (`~/.lazy/daemon`) instead — where this project's pidfile never was — so
 *    the daemon the suite started is never reaped by pidfile at all and lives on
 *    to squat the shared 26024+ port window for the rest of the run. Call the
 *    undo AFTER `ctx.cleanup()`.
 * 2. RESTORE, don't delete. A `delete` clobbers an outer value; suites nest.
 */
export function pinDaemonBaseDir(dir: string): () => void {
  const prior = process.env.LAZY_DAEMON_BASE_DIR;
  process.env.LAZY_DAEMON_BASE_DIR = dir;
  return () => {
    if (prior === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
    else process.env.LAZY_DAEMON_BASE_DIR = prior;
  };
}

/** Remove a directory created by {@link makeDaemonBaseDir}. */
export async function removeDaemonBaseDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
