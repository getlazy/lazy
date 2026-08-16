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
 *
 * TWO THINGS THIS NET STILL CANNOT DO, AND WHO DOES THEM
 * -----------------------------------------------------
 * 1. A daemon whose pidfile the harness already deleted (cleanup removed the
 *    daemon dir, then a straggler subprocess auto-started a fresh daemon for
 *    that root). Covered here by the command-line sweep over `allTestRoots`.
 * 2. A `bun test` process that is SIGKILLed: no handler in it runs at all. Only
 *    the daemon's own parent watch can cover that — see
 *    `src/daemon/test-parent-watch.ts`, armed by `LAZY_TEST_PARENT_PID` in
 *    setup.ts.
 */

// NOTE: import the lightweight `paths` module directly, NOT the `src/daemon`
// barrel. The barrel transitively pulls the daemon status path, which imports
// the generated `src/build-info.ts`. This module is imported by the global
// preload, which runs BEFORE that file is generated — pulling the barrel there
// would crash the preload in worktrees. `paths` only depends on path/crypto/os.
import { readFileSync, existsSync, readdirSync } from 'fs';
import { getPidPath } from '../../src/daemon/paths';
import { commandLooksLikeDaemon } from '../../src/daemon/process-identity';

/** Project roots of test daemons that have not been gracefully stopped yet. */
const liveDaemonRoots = new Set<string>();

/**
 * Every root this process has EVER registered — never pruned.
 *
 * `liveDaemonRoots` is the pidfile-based path and is emptied by a graceful
 * `cleanup()`. But a straggler CLI subprocess can auto-start a fresh daemon for
 * a root AFTER its cleanup ran (`ensureDaemon` sees no daemon and spawns one),
 * and that daemon is invisible to a pidfile the harness already deleted. The
 * exit-time command-line sweep uses this set instead, so such a latecomer is
 * still reaped.
 *
 * Deliberately scoped to roots THIS process created (mkdtemp names are unique):
 * a sweep keyed on "any /tmp/lazy-e2e-* daemon" would reap the daemons of a
 * concurrently running `bun test` process too.
 */
const allTestRoots = new Set<string>();

let handlersInstalled = false;

/** Sync read of a root's daemon pidfile. Mirrors `readPid` without the barrel. */
function readDaemonPid(root: string): number | null {
  const pidPath = getPidPath(root);
  if (!existsSync(pidPath)) return null;
  const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
  return Number.isNaN(pid) ? null : pid;
}

/**
 * Does this command line belong to a lazy daemon serving exactly `root`?
 *
 * Daemon-ness is decided by the canonical matcher in
 * `src/daemon/process-identity.ts`; on top of it we require the `--project`
 * argument to name this root EXACTLY (token comparison, not `includes`, so one
 * temp root can never match another's daemon). Every daemon the harness can
 * leak carries that flag — `startTestDaemon` passes it, and so does
 * `startDaemonBackground` for auto-started ones.
 */
export function isDaemonCommandForRoot(cmd: string, root: string): boolean {
  // `null` root on purpose: passing the root would take the matcher's
  // "the root appears anywhere" shortcut, which is right when the pid came
  // from that root's daemon dir but far too loose here — we scan EVERY process
  // on the machine, and `lazy show --project <root>` must not read as a daemon.
  if (!commandLooksLikeDaemon(cmd, null)) return false;
  // Every daemon the harness can leak is a `--foreground` one: startTestDaemon
  // spawns it that way, and so does startDaemonBackground's detached child.
  if (!cmd.includes('--foreground')) return false;
  const tokens = cmd.split(/\s+/);
  const idx = tokens.lastIndexOf('--project');
  return idx !== -1 && tokens[idx + 1] === root;
}

/**
 * Read every live process's command line, keyed by pid. Synchronous on purpose:
 * the callers run inside `process.on('exit')`, where async work never completes.
 *
 * Linux reads /proc directly. Everything else (macOS) shells out to `ps` once.
 * A platform where neither works yields an empty map, which degrades this sweep
 * to a no-op — the pidfile path and the daemon's own parent watch still apply.
 */
function readAllProcessCommands(): Map<number, string> {
  const out = new Map<number, string>();
  if (process.platform === 'linux') {
    let entries: string[];
    try {
      entries = readdirSync('/proc');
    } catch {
      // No /proc (unusual for linux, but never worth crashing teardown over).
      return out;
    }
    for (const entry of entries) {
      const pid = parseInt(entry, 10);
      if (Number.isNaN(pid)) continue;
      try {
        // /proc/<pid>/cmdline is NUL-separated (and NUL-terminated).
        const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim();
        if (cmd.length > 0) out.set(pid, cmd);
      } catch {
        // Process exited between readdir and here, or it is a kernel thread.
      }
    }
    return out;
  }
  try {
    const result = Bun.spawnSync(['ps', '-axo', 'pid=,command='], { stdout: 'pipe', stderr: 'ignore' });
    for (const line of result.stdout.toString().split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (m) out.set(parseInt(m[1], 10), m[2].trim());
    }
  } catch {
    // `ps` missing or failed — sweep degrades to a no-op, as documented above.
  }
  return out;
}

/**
 * SIGKILL every lazy daemon process serving `root`, found by command line
 * rather than by pidfile. Synchronous; safe from an `exit` handler.
 *
 * Returns the pids it signalled, so callers (and tests) can tell whether the
 * pidfile path had already covered everything.
 */
export function killDaemonsForRoot(root: string, commands?: Map<number, string>): number[] {
  const killed: number[] = [];
  for (const [pid, cmd] of commands ?? readAllProcessCommands()) {
    if (pid === process.pid) continue;
    if (!isDaemonCommandForRoot(cmd, root)) continue;
    try {
      process.kill(pid, 'SIGKILL');
      killed.push(pid);
    } catch {
      // Already exited (ESRCH) — nothing to reap.
    }
  }
  return killed;
}

/**
 * SIGKILL the daemon for every still-registered root, then sweep the process
 * table for any daemon serving a root this process ever created. Synchronous so
 * it is safe to call from a `process.on('exit')` handler. Best-effort: a pidfile
 * that is missing or a pid that is already gone is silently skipped.
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

  // The pidfile pass above misses two cases: a daemon that died before writing
  // its pidfile's dir was recreated, and one auto-started after its root was
  // unregistered and its daemon dir deleted. One process-table scan covers both
  // for every root this run owns. One scan, reused across all roots.
  if (allTestRoots.size === 0) return;
  const commands = readAllProcessCommands();
  const swept: number[] = [];
  for (const root of allTestRoots) swept.push(...killDaemonsForRoot(root, commands));
  if (swept.length > 0) {
    // Never reap silently: anything the sweep finds is a daemon that BOTH
    // cleanup() and the pidfile pass missed, which is a harness bug worth
    // seeing rather than a routine event. One line, on the way out.
    process.stderr.write(
      `daemon-registry: swept ${swept.length} leaked test daemon(s) at exit: ${swept.join(', ')}\n`,
    );
  }
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
  allTestRoots.add(root);
}

/** Stop tracking a root once its daemon has been gracefully stopped + cleaned. */
export function unregisterTestDaemonRoot(root: string): void {
  liveDaemonRoots.delete(root);
}

// Install handlers on import so the net is armed the moment any test module —
// or the global preload — loads this file, even before the first daemon spawns.
ensureHandlersInstalled();
