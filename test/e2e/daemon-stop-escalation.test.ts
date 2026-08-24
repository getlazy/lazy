/**
 * E2E: `lazy daemon stop` against a daemon that is alive but frozen.
 *
 * INVARIANT: stop must CLEAR a wedged daemon itself, not hand the human a
 * `kill -9` to run.
 *
 * A frozen daemon cannot be stopped politely: the shutdown RPC is never answered
 * (the loop that would read it is stuck) and the SIGTERM handler runs on that
 * same loop, so the signal is never processed either. Meanwhile the still-alive
 * process holds the daemon lock, so no replacement can start — leaving the
 * project with no working daemon until someone kills it by hand. Stop therefore
 * escalates on its own: bounded shutdown request → SIGTERM → SIGKILL, narrated
 * at every step.
 *
 * The wedge is simulated, because a genuinely frozen daemon cannot be produced on
 * demand: a stalling unix listener at the daemon's socket path (accepts, never
 * replies — exactly what the kernel does for a frozen daemon) plus a real,
 * SIGSTOPped process recorded as the daemon pid. A stopped process is alive to
 * kill(pid, 0), does not act on SIGTERM, and dies to SIGKILL — the same three
 * observable properties the frozen daemon has.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectOutput } from '../helpers/assertions';
import { getSocketPath, getTokenPath, getPidPath, getDaemonDir } from '../../src/daemon/paths';
import { makeDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { startForeignProcess, type ForeignProcess } from '../helpers/foreign-process';
import { isProcessAlive } from '../../src/daemon/lifecycle';

/**
 * The child spends 3s on the bounded shutdown probe, then 5s of unaccepted-grace
 * before SIGKILL, plus spawn and inventory overhead.
 */
const TEST_TIMEOUT_MS = 60_000;

describe('lazy daemon stop — frozen daemon', () => {
  let ctx: TestContext;
  let baseDir: string;
  let listener: { stop: (closeActiveConnections?: boolean) => void } | null = null;
  let wedged: ForeignProcess | null = null;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    baseDir = await makeDaemonBaseDir();
  });

  afterEach(async () => {
    listener?.stop(true);
    listener = null;
    // SIGCONT first: a process left stopped would never reap, and kill() alone on
    // a stopped process is fine but the continue makes the cleanup unambiguous.
    if (wedged) {
      try { process.kill(wedged.pid, 'SIGCONT'); } catch { /* already gone — fine */ }
      wedged.kill();
      wedged = null;
    }
    await ctx.cleanup();
    await removeDaemonBaseDir(baseDir);
  });

  test('escalates to SIGKILL and reports the stop instead of telling the human to kill it', async () => {
    // LAZY_DAEMON_BASE_DIR reaches the CHILD only; pin it here just long enough
    // to compute the same paths the child will use.
    const priorBaseDir = process.env.LAZY_DAEMON_BASE_DIR;
    process.env.LAZY_DAEMON_BASE_DIR = baseDir;
    let socketPath: string;
    try {
      await mkdir(getDaemonDir(ctx.root), { recursive: true });
      socketPath = getSocketPath(ctx.root);
      wedged = await startForeignProcess(ctx.root, 'wedged-lazy-daemon');
      await writeFile(getTokenPath(ctx.root), 'test-token');
      await writeFile(getPidPath(ctx.root), String(wedged.pid));
    } finally {
      if (priorBaseDir === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
      else process.env.LAZY_DAEMON_BASE_DIR = priorBaseDir;
    }

    listener = Bun.listen({
      unix: socketPath,
      socket: {
        data() { /* Deliberately silent: this IS the freeze. */ },
        open() { /* Accept and stall. */ },
      },
    }) as unknown as { stop: (closeActiveConnections?: boolean) => void };

    // Stop the process so SIGTERM cannot take effect — the frozen daemon's
    // defining property from the CLI's point of view.
    process.kill(wedged!.pid, 'SIGSTOP');

    const result = await ctx.lazy(['daemon', 'stop', '--yes'], {
      env: { LAZY_DAEMON_BASE_DIR: baseDir },
    });

    // Narration: every escalation step is stated, so nothing about a force-kill
    // is silent.
    expectOutput(result, 'did not accept the shutdown request');
    expectOutput(result, 'Escalating to SIGKILL');
    expectOutput(result, 'Daemon stopped (SIGKILL');

    // And the wedged process is actually gone — the point of the escalation.
    expect(isProcessAlive(wedged!.pid)).toBe(false);
    expect(result.exitCode).toBe(0);
  }, TEST_TIMEOUT_MS);
});
