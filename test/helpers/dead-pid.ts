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
