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

/** Remove a directory created by {@link makeDaemonBaseDir}. */
export async function removeDaemonBaseDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
