/**
 * Unit tests: checkDaemonHealth / requestShutdown must never hang.
 *
 * INVARIANT: a diagnostic must never hang on the thing it diagnoses.
 *
 * A daemon whose event loop is frozen still has a live kernel listener on its
 * unix socket, so connect(2) succeeds and the request is queued to a process
 * that will never read it. Both of these calls used to fetch with no
 * AbortSignal, so `lazy daemon status` (and `lazy daemon stop`) hung forever
 * against exactly the daemon they were run to investigate — an hour of blind
 * debugging in a real incident (see fix-markdown-crlf-daemon-hang).
 *
 * The other half of the invariant is that the timeout must not be reported as a
 * plain "not running": a live process with a stuck loop needs a kill, while
 * "nothing is there" needs a start. checkDaemonHealth therefore distinguishes
 * three states, and these tests pin all three.
 *
 * The stalling daemon is simulated with a real unix listener that accepts the
 * connection and then never writes a byte — the same thing the kernel does for
 * a frozen daemon.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile, rm } from 'fs/promises';
import {
  checkDaemonHealth,
  requestShutdown,
  DAEMON_HEALTH_TIMEOUT_MS,
} from '../../src/daemon';
import { getSocketPath, getTokenPath, getPidPath, getDaemonDir } from '../../src/daemon/paths';
import {
  makeDaemonBaseDir,
  pinDaemonBaseDir,
  removeDaemonBaseDir,
} from '../helpers/daemon-base-dir';

/** A pid well above every OS maximum is never alive. */
const DEAD_PID = 2_000_000;

/** Room for the 3s probe plus scheduling slack, well under any real hang. */
const TEST_TIMEOUT_MS = 20_000;

describe('checkDaemonHealth timeout', () => {
  // A fake project root is enough: nothing here reads the repo, only the daemon
  // state dir derived from it (which pinDaemonBaseDir puts in a temp dir).
  const root = '/tmp/lazy-health-timeout-project';
  let baseDir: string;
  let unpin: () => void;
  let listener: { stop: (closeActiveConnections?: boolean) => void } | null = null;

  const writeStateFiles = async (pid: number) => {
    await mkdir(getDaemonDir(root), { recursive: true });
    await writeFile(getTokenPath(root), 'test-token');
    await writeFile(getPidPath(root), String(pid));
  };

  /**
   * Bind a unix listener that accepts and then stalls — a frozen daemon from the
   * client's point of view. No `data` handling, no reply, ever.
   */
  const startStallingListener = () => {
    listener = Bun.listen({
      unix: getSocketPath(root),
      socket: {
        data() { /* Deliberately silent: this is the freeze being simulated. */ },
        open() { /* Accept and stall. */ },
      },
    }) as unknown as { stop: (closeActiveConnections?: boolean) => void };
  };

  beforeEach(async () => {
    baseDir = await makeDaemonBaseDir();
    unpin = pinDaemonBaseDir(baseDir);
  });

  afterEach(async () => {
    // Close active connections too: an in-flight aborted fetch otherwise keeps
    // the listener (and the test process) alive.
    listener?.stop(true);
    listener = null;
    unpin();
    await removeDaemonBaseDir(baseDir);
    await rm(getSocketPath(root), { force: true }).catch(() => {});
  });

  // THE regression test. Before the fix this call never returned.
  test('a listener that accepts but never replies yields "alive but unresponsive"', async () => {
    await writeStateFiles(process.pid); // this process is alive
    startStallingListener();

    const start = Date.now();
    const status = await checkDaemonHealth(root);
    const elapsed = Date.now() - start;

    expect(status.running).toBe(false);
    expect(status.unresponsive).toBe(true);
    expect(status.pid).toBe(process.pid);
    // Bounded by the probe budget — not hanging, and not returning instantly
    // either (it really did wait for the daemon).
    expect(elapsed).toBeGreaterThanOrEqual(DAEMON_HEALTH_TIMEOUT_MS - 250);
    expect(elapsed).toBeLessThan(DAEMON_HEALTH_TIMEOUT_MS + 5_000);
  }, TEST_TIMEOUT_MS);

  // The "unresponsive" verdict claims a live process. Without a live pid there
  // is nothing to kill, so it must fall back to plain "not running".
  test('a stalling socket with a DEAD pid is plain not-running, not unresponsive', async () => {
    await writeStateFiles(DEAD_PID);
    startStallingListener();

    const status = await checkDaemonHealth(root);

    expect(status.running).toBe(false);
    expect(status.unresponsive).toBeFalsy();
  }, TEST_TIMEOUT_MS);

  // State (b): the socket FILE exists but nothing is listening on it, so the
  // connection is refused. That is "not running" and must be reported fast —
  // never as a freeze.
  test('a socket file with nothing listening is not-running, and fast', async () => {
    await writeStateFiles(process.pid);
    await writeFile(getSocketPath(root), ''); // a plain file, not a live socket

    const start = Date.now();
    const status = await checkDaemonHealth(root);

    expect(status.running).toBe(false);
    expect(status.unresponsive).toBeFalsy();
    expect(Date.now() - start).toBeLessThan(DAEMON_HEALTH_TIMEOUT_MS);
  }, TEST_TIMEOUT_MS);

  test('no socket file at all is not-running, not unresponsive', async () => {
    await writeStateFiles(process.pid);

    const status = await checkDaemonHealth(root);

    expect(status.running).toBe(false);
    expect(status.unresponsive).toBeFalsy();
  });

  // Same invariant for the shutdown RPC: `lazy daemon stop` must fall through to
  // its SIGTERM path instead of hanging on a daemon that cannot answer.
  test('requestShutdown returns false within the timeout instead of hanging', async () => {
    await writeStateFiles(process.pid);
    startStallingListener();

    const start = Date.now();
    const accepted = await requestShutdown(root);
    const elapsed = Date.now() - start;

    expect(accepted).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(DAEMON_HEALTH_TIMEOUT_MS - 250);
    expect(elapsed).toBeLessThan(DAEMON_HEALTH_TIMEOUT_MS + 5_000);
  }, TEST_TIMEOUT_MS);
});
