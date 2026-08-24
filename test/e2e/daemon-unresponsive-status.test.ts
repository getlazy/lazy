/**
 * E2E: `lazy daemon status` against a daemon that is alive but frozen.
 *
 * INVARIANT: a diagnostic must never hang on the thing it diagnoses, and must
 * never report a wedged daemon as "not running".
 *
 * A frozen event loop still leaves the kernel listener up, so the socket accepts
 * the connection and then nothing ever answers. `lazy daemon status` used to
 * hang there forever — the one command run to explain the freeze became another
 * symptom of it (see fix-markdown-crlf-daemon-hang). It must now come back
 * within seconds, name the state explicitly, and print a recovery that accounts
 * for SIGTERM being handled on the very loop that is stuck.
 *
 * The freeze is simulated by binding the daemon's socket path in THIS process
 * with a listener that accepts and never replies, alongside the token/pid state
 * files that make `isDaemonRunning` report a live daemon. No real daemon is
 * started: a genuinely frozen one cannot be produced on demand, and the client
 * behavior under test depends only on what the socket does.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdir, writeFile, rm } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectOutput } from '../helpers/assertions';
import { getSocketPath, getTokenPath, getPidPath, getDaemonDir } from '../../src/daemon/paths';
import { makeDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';

/** Room for the 3s probe in the child plus process spawn overhead. */
const TEST_TIMEOUT_MS = 30_000;

describe('lazy daemon status — alive but unresponsive', () => {
  let ctx: TestContext;
  let baseDir: string;
  let listener: { stop: (closeActiveConnections?: boolean) => void } | null = null;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    baseDir = await makeDaemonBaseDir();
  });

  afterEach(async () => {
    listener?.stop(true);
    listener = null;
    await ctx.cleanup();
    await removeDaemonBaseDir(baseDir);
  });

  test('reports the freeze with pid and recovery instead of hanging', async () => {
    // LAZY_DAEMON_BASE_DIR is passed to the CHILD only — the parent never
    // resolves daemon paths through the env, so nothing leaks into other suites.
    // We compute the same paths here by pinning it around the path helpers.
    const priorBaseDir = process.env.LAZY_DAEMON_BASE_DIR;
    process.env.LAZY_DAEMON_BASE_DIR = baseDir;
    let socketPath: string;
    try {
      await mkdir(getDaemonDir(ctx.root), { recursive: true });
      socketPath = getSocketPath(ctx.root);
      // A live pid + token + socket is what isDaemonRunning falls back to when
      // the dir has no lock file, so the CLI gets past its liveness gate and
      // actually probes the socket — which is the code path under test.
      await writeFile(getTokenPath(ctx.root), 'test-token');
      await writeFile(getPidPath(ctx.root), String(process.pid));
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

    const start = Date.now();
    const result = await ctx.lazy(['daemon', 'status'], {
      env: { LAZY_DAEMON_BASE_DIR: baseDir },
    });
    const elapsed = Date.now() - start;

    // Came back at all — the whole point.
    expect(elapsed).toBeLessThan(TEST_TIMEOUT_MS - 5_000);

    expectOutput(result, 'ALIVE but UNRESPONSIVE');
    expectOutput(result, `(PID ${process.pid})`);
    // The recovery must be a lazy command that CLEARS this state itself, not a
    // hand-rolled kill: `lazy daemon restart` escalates to SIGKILL on its own,
    // because the daemon's SIGTERM handler runs on the frozen loop.
    expectOutput(result, 'lazy daemon restart');
    expectOutput(result, 'force-kills');

    // Must NOT be reported as absent: "not running" sends the human to
    // `daemon start`, which refuses while the wedged process holds the dir.
    expect(result.stdout).not.toContain('Daemon is not running.');
  }, TEST_TIMEOUT_MS);
});
