/**
 * Test-only safety net: a daemon spawned by a test run must never outlive it.
 *
 * WHY THIS EXISTS
 * ---------------
 * The e2e suite starts REAL daemons — explicitly via `setupTestLazy({ withDaemon })`
 * and implicitly whenever a `ctx.lazy` subprocess auto-starts one (`ensureDaemon`).
 * Both are detached: they survive the subprocess that spawned them on purpose, so
 * a daemon can serve many CLI calls within one test.
 *
 * Teardown normally reaps them (`afterEach` → `stopTestDaemon`, plus the
 * process-death net in `test/helpers/daemon-registry.ts`). Both of those live in
 * the `bun test` process, so both are skipped when that process dies WITHOUT
 * running its handlers — a SIGKILL from a sweep's own timeout, an OOM kill, a
 * hard `kill -9` during local iteration. Every daemon it started is then
 * reparented to PID 1 and runs forever, each holding its temp project's
 * `.storage-lock` and squatting a port from the bounded daemon web-port window.
 * Eight such orphans were observed in one container mid-sweep.
 *
 * This module closes that hole from the OTHER side: the daemon itself watches
 * the pid recorded in `LAZY_TEST_PARENT_PID` and shuts down once that process is
 * gone. Because the variable is inherited by every process the harness spawns,
 * an implicitly auto-started daemon gets the same guard for free — including one
 * started by a straggler subprocess AFTER its test's cleanup already ran, which
 * no pidfile-based reaper can ever see.
 *
 * PRODUCTION IS UNAFFECTED. Nothing in `src/` ever sets `LAZY_TEST_PARENT_PID`;
 * without it {@link startTestParentWatch} returns null and installs no timer. It
 * belongs to the same test-only env var family as `LAZY_FORCE_TTY` and
 * `LAZY_PROMPT_DEFAULTS` (see CLAUDE.md) — never read it from production code
 * paths, and never set it from one.
 *
 * NOTE ON PID REUSE: a recycled parent pid would make the watch see a live
 * process and keep the daemon up. That is the safe direction (a leak the other
 * reapers still cover), and within a single test run the window is negligible.
 */

/** Env var naming the process whose death must take the test daemon with it. */
export const TEST_PARENT_PID_ENV = 'LAZY_TEST_PARENT_PID';

/** How often the parent's liveness is probed. */
const DEFAULT_POLL_MS = 1000;

/**
 * Is `pid` still running? `kill(pid, 0)` sends no signal — it only performs the
 * permission/existence check. ESRCH is the one answer that means "gone"; EPERM
 * means the process exists but is owned by another user, which is still alive.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export interface TestParentWatchOptions {
  /** Poll interval in ms. Defaults to 1000. */
  pollMs?: number;
  /** Environment to read from. Defaults to `process.env` (injectable for tests). */
  env?: Record<string, string | undefined>;
}

/**
 * Start watching the test parent process, if one was declared.
 *
 * @param onParentGone Invoked once, after the parent is observed dead. Typically
 *   shuts the daemon down and exits.
 * @returns A stop function, or null when `LAZY_TEST_PARENT_PID` is unset — i.e.
 *   in every production daemon.
 * @throws When the variable is set to something that is not a positive integer.
 *   That can only be a harness bug, and silently ignoring it would restore
 *   exactly the leak this module exists to prevent.
 */
export function startTestParentWatch(
  onParentGone: () => void | Promise<void>,
  options: TestParentWatchOptions = {},
): (() => void) | null {
  const raw = (options.env ?? process.env)[TEST_PARENT_PID_ENV];
  if (raw === undefined || raw === '') return null;

  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(
      `${TEST_PARENT_PID_ENV} must be a positive integer pid, got ${JSON.stringify(raw)}`,
    );
  }

  let fired = false;
  const timer = setInterval(() => {
    if (fired || isProcessAlive(pid)) return;
    fired = true;
    clearInterval(timer);
    void (async () => {
      try {
        await onParentGone();
      } catch (err) {
        // The callback shuts the daemon down; if that fails we still must not
        // stay alive — that is the whole point. Report and leave the decision
        // to the caller's own error handling by rethrowing asynchronously.
        console.error(
          `Test parent watch: shutdown after parent ${pid} exited failed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
    })();
  }, options.pollMs ?? DEFAULT_POLL_MS);

  // Never keep the daemon's event loop alive just for this probe.
  timer.unref?.();

  return () => clearInterval(timer);
}
