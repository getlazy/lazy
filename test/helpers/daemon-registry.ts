/**
 * Death-resilient registry for daemons spawned by the e2e test suite.
 *
 * WHY THIS EXISTS
 * ---------------
 * Each `setupTestLazy({ withDaemon })` — and any CLI call that implicitly
 * auto-starts a daemon via `ensureDaemon` — leaves a REAL `lazy daemon` running
 * as a detached, `unref()`'d subprocess so it can outlive the individual
 * `runLazy` subprocess calls within a test. `ctx.cleanup()` stops it in
 * `afterEach`.
 *
 * The problem: a detached daemon is not a child that dies with the test
 * process. Whenever the `bun test` process dies WITHOUT running every
 * `afterEach` — Ctrl-C during local iteration (the common case), a test-file
 * crash, or a hard kill — every daemon it started survives FOREVER. These
 * strays squat the daemon web-port window (DEFAULT_WEB_PORT + 100 auto-increment
 * slots); we have observed 100+ orphans exhaust the 26024–26123 range so that
 * the real project daemon gets shoved off the default port and browsers land on
 * an empty e2e store.
 *
 * The fix is a teardown path that does NOT depend on per-test `afterEach`:
 * every test project ROOT is registered here, and process-level
 * `exit`/`SIGINT`/`SIGTERM` handlers read each root's pidfile and SIGKILL any
 * surviving daemon. Normal exits and uncaught crashes go through `exit`; Ctrl-C
 * and `kill` go through the signal handlers. `afterEach` remains the primary,
 * graceful path — this is the net that catches everything it misses.
 *
 * Tracking ROOTS (not pids) is deliberate: an implicitly auto-started daemon is
 * spawned by a grandchild `runLazy` subprocess, so its pid is never visible to
 * the parent test process. But both explicit and auto-started daemons write
 * their pid to `<root>`'s daemon dir, so `readPid(root)` reaps either one.
 *
 * Bun runs all test files in a single process, so one module-level registry
 * (imported by `setup.ts` and the global preload) covers the whole suite.
 */

// NOTE: import the lightweight `paths` module directly, NOT the `src/daemon`
// barrel. The barrel transitively pulls the daemon status path, which imports
// the generated `src/build-info.ts`. This module is imported by the global
// preload, which runs BEFORE that file is generated — pulling the barrel there
// would crash the preload in worktrees. `paths` only depends on path/crypto/os.
import { readFileSync, existsSync } from 'fs';
import { getPidPath } from '../../src/daemon/paths';

/** Project roots of test daemons that have not been gracefully stopped yet. */
const liveDaemonRoots = new Set<string>();

let handlersInstalled = false;

/** Sync read of a root's daemon pidfile. Mirrors `readPid` without the barrel. */
function readDaemonPid(root: string): number | null {
  const pidPath = getPidPath(root);
  if (!existsSync(pidPath)) return null;
  const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
  return Number.isNaN(pid) ? null : pid;
}

/**
 * SIGKILL the daemon for every still-registered root. Synchronous so it is safe
 * to call from a `process.on('exit')` handler. Best-effort: a pidfile that is
 * missing or a pid that is already gone is silently skipped.
 */
function reapAllTestDaemons(): void {
  for (const root of liveDaemonRoots) {
    const pid = readDaemonPid(root);
    if (pid === null) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already exited (ESRCH) — nothing to reap. Any other error here is not
      // actionable during process teardown; we have no way to surface it.
    }
  }
  liveDaemonRoots.clear();
}

/**
 * Install the process-death safety net exactly once. Idempotent: safe to call
 * from both the preload and `setup.ts` regardless of import order.
 */
function ensureHandlersInstalled(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;

  // Normal exit and most uncaught-exception exits. Synchronous only.
  process.on('exit', reapAllTestDaemons);

  // Ctrl-C / external kill: reap, then exit so the run is reported as
  // interrupted (the 'exit' handler runs too, harmlessly re-reaping an empty
  // set).
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      reapAllTestDaemons();
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  }
}

/**
 * Record a test project root whose daemon must be reaped if `afterEach` is
 * skipped. Call once per `setupTestLazy`, regardless of whether the daemon is
 * started explicitly (`withDaemon`) or auto-started later by a CLI call.
 */
export function registerTestDaemonRoot(root: string): void {
  ensureHandlersInstalled();
  liveDaemonRoots.add(root);
}

/** Stop tracking a root once its daemon has been gracefully stopped + cleaned. */
export function unregisterTestDaemonRoot(root: string): void {
  liveDaemonRoots.delete(root);
}

// Install handlers on import so the net is armed the moment any test module —
// or the global preload — loads this file, even before the first daemon spawns.
ensureHandlersInstalled();
