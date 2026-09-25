import { isRunningProcessSync } from '../../src/utils/process-identity';

/**
 * A PID that is guaranteed NOT to name a live process.
 *
 * Needed because daemon cleanup refuses to delete state files whose recorded PID
 * belongs to a live process — that guard is what stops a losing `lazy daemon
 * start` from deleting a healthy daemon's files. A test that wants the "these
 * files really are stale" path must therefore write a PID that is definitely
 * dead. Hardcoded low PIDs (12345 and friends) are frequently live on a busy
 * host, which makes such a test flap in exactly the confusing direction: the
 * guard doing its job looks like a cleanup regression.
 *
 * We probe downwards from above every platform's pid_max (Linux's default is
 * 4194304; macOS caps at 99998) and return the first PID `kill(pid, 0)` reports
 * as absent, so the value is verified rather than assumed.
 */
export function findDeadPid(): number {
  for (let pid = 4_194_303; pid > 4_000_000; pid--) {
    try {
      process.kill(pid, 0);
      // Live (or a permission error, which also means it exists) — keep looking.
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') continue;
      return pid;
    }
  }
  throw new Error('findDeadPid: could not find an unused PID to use as a dead-process marker');
}

/** Memoized `findDeadPid()` — the answer cannot become wrong mid-run. */
export const DEAD_PID = findDeadPid();

/**
 * Is this pid a process that is still RUNNING — as opposed to merely present?
 *
 * `process.kill(pid, 0)` answers "does the pid exist in the process table", and
 * a ZOMBIE answers yes. That distinction is normally academic and is exactly not
 * academic here: every suite that asserts an agent died first kills the process
 * that was its PARENT, so the agent is reparented to PID 1 and stays a zombie
 * until PID 1 reaps it. Whether that happens promptly is a property of the
 * ENVIRONMENT, not of the code under test — this project's agent container runs
 * `docker-init` (tini) as PID 1, which reaps (verified: an orphaned child left
 * no `/proc` entry), but a CI container running the test process itself as PID 1
 * would not. Keying on `kill(pid, 0)` alone would therefore fail for a process
 * that is genuinely dead, and the failure would read as though the fix regressed.
 *
 * The procfs-vs-`ps` split and the "cannot tell means running" rule belong to
 * src/utils/process-identity.ts, which owns process reading for the storage
 * lock; this is a named re-export so the test suites read the intent rather
 * than the mechanism.
 */
export function isProcessRunning(pid: number): boolean {
  return isRunningProcessSync(pid);
}
