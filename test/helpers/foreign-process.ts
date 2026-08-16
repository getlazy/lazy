/**
 * A real, live process under a chosen program NAME, for the pid-identity tests.
 *
 * The storage lock's identity rules ("is the process at this pid still the one
 * that took the lock?") can only be exercised against a genuine process the OS
 * will report on — a fabricated pid proves nothing. Those tests therefore spawn
 * one whose command line either does or does not look like a lazy process, and
 * the name is the only knob they need.
 *
 * Two portability rules are baked in here, both learned from a Mac host where
 * five storage-lock tests failed while the same tests passed in Linux
 * containers:
 *
 *  1. **The name comes from a SYMLINK to /bin/sleep, never a copy.** argv[0] is
 *     what `ps` and procfs report, and a symlink sets it just as well as a copy
 *     does — but the kernel execs the real, signed binary in its original
 *     location. Copying a system binary elsewhere puts it through the host's
 *     code-signing rules at exec time (Apple Silicon enforces these on every
 *     executable), which is a question these tests have no reason to be asking.
 *
 *  2. **The holder is not handed back until the OS agrees it is alive.** A
 *     holder that exits during setup makes a lock the test wrote as "held by a
 *     live process" read as STALE, and the test then fails several layers away
 *     from the cause — as `expect(report).not.toBeNull()`, with nothing said
 *     about the process. `awaitLiveIdentity` fails at the setup step instead,
 *     naming what the OS actually reported.
 */

import { symlinkSync, rmSync } from 'fs';
import { join } from 'path';
import { spawn } from '../../src/utils/spawn';
import { isZombieState, readProcessIdentity, type ProcessIdentity } from '../../src/utils/process-identity';

/** The system binary the holder actually executes. Long-lived and universally present. */
const SLEEP_BIN = '/bin/sleep';

/** How long the holder sleeps — far longer than any suite that spawns one. */
const HOLD_SECONDS = '120';

/** How long to wait for the OS to report the freshly-spawned holder as live. */
const READY_TIMEOUT_MS = 3_000;
const READY_POLL_MS = 25;

export interface ForeignProcess {
  /** The pid the tests write into lock files. */
  pid: number;
  /** What the OS says about it: verified live, non-zombie, with a start time. */
  identity: ProcessIdentity;
  /** Terminate it. Safe to call more than once. */
  kill: () => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Poll until the OS reports `pid` as a live, non-zombie process with a readable
 * start time — the exact shape `judgeHolder` needs to call a holder verified.
 *
 * Throws with the evidence rather than returning a half-answer: every caller is
 * test SETUP, and a setup that silently produces an unverifiable holder makes
 * the assertions downstream lie about what they measured.
 */
async function awaitLiveIdentity(pid: number, label: string): Promise<ProcessIdentity> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last: ProcessIdentity | null = null;
  for (;;) {
    last = await readProcessIdentity(pid);
    if (last && !isZombieState(last.state) && last.started) return last;
    if (Date.now() >= deadline) break;
    await sleep(READY_POLL_MS);
  }
  throw new Error(
    `holder process "${label}" (pid ${pid}) never became a verifiable live process ` +
      `within ${READY_TIMEOUT_MS}ms. Last identity from the OS: ${JSON.stringify(last)}. ` +
      `(null = the process is gone; state starting with "Z" = it exited and was not yet reaped; ` +
      `started: null = this host's process-identity source reported no start time.)`,
  );
}

/**
 * Start a live process named `programName` inside `dir`, and return it only
 * once the OS reports it as a verifiable live holder.
 *
 * `programName` is what shows up in the process's command line, so it decides
 * whether `looksLikeLazyProcess` considers the holder plausibly-lazy. Pass a
 * name containing "lazy" for the plausible case and anything else for the
 * unrelated-program case.
 */
export async function startForeignProcess(dir: string, programName: string): Promise<ForeignProcess> {
  const binPath = join(dir, programName);
  // A stale link from an earlier call in the same directory would make symlink()
  // fail with EEXIST; the tests reuse one temp dir per case, so just replace it.
  rmSync(binPath, { force: true });
  symlinkSync(SLEEP_BIN, binPath);

  const proc = spawn([binPath, HOLD_SECONDS], { stdout: 'ignore', stderr: 'ignore' });
  const kill = () => {
    try {
      proc.kill('SIGKILL');
    } catch {
      // Already gone — that is the state we wanted.
    }
  };

  try {
    const identity = await awaitLiveIdentity(proc.pid, programName);
    return { pid: proc.pid, identity, kill };
  } catch (err) {
    kill();
    throw err;
  }
}
