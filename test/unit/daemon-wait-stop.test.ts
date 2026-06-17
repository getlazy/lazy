/**
 * Unit tests: waitForDaemonStop.
 *
 * `lazy upgrade` shuts the daemon down and then starts a fresh one. Because
 * `requestShutdown` only DELIVERS the shutdown request (the daemon exits async),
 * upgrade must wait for the old process to actually die before `ensureDaemon` —
 * otherwise ensureDaemon sees the still-alive daemon, skips the restart, and the
 * project is left with NO daemon. That stranded the builder relaunch loop until
 * it timed out. These tests pin the wait behavior.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { waitForDaemonStop } from '../../src/daemon';
import { getSocketPath, getTokenPath, getPidPath, getDaemonDir } from '../../src/daemon/paths';

describe('waitForDaemonStop', () => {
  let root: string;

  // Make isDaemonRunning(root) report TRUE: socket + token files present and a
  // live pid (this test process is alive).
  const markRunning = async () => {
    await mkdir(getDaemonDir(root), { recursive: true });
    await writeFile(getSocketPath(root), '');
    await writeFile(getTokenPath(root), 'test-token');
    await writeFile(getPidPath(root), String(process.pid));
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-wait-stop-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('returns true immediately when no daemon is running', async () => {
    expect(await waitForDaemonStop(root, 1000)).toBe(true);
  });

  test('returns false when the daemon stays alive past the timeout', async () => {
    await markRunning();
    const start = Date.now();
    expect(await waitForDaemonStop(root, 300)).toBe(false);
    // Honored the timeout (didn't return instantly).
    expect(Date.now() - start).toBeGreaterThanOrEqual(250);
  });

  test('returns true once the daemon goes away (socket removed)', async () => {
    await markRunning();
    // Remove the socket shortly after starting the wait — simulates the old
    // daemon finishing its async shutdown.
    setTimeout(() => { unlink(getSocketPath(root)).catch(() => {}); }, 150);
    expect(await waitForDaemonStop(root, 3000)).toBe(true);
  });

  // The pid-based path is what `lazy upgrade` uses: it waits for the OLD
  // daemon's exact process to die. A pid well above the OS max is never alive.
  const DEAD_PID = 2_000_000;

  test('with expectedPid, reports stopped only when that process is dead', async () => {
    // Even with the socket/PID files still present (isDaemonRunning would say
    // "running"), a dead expectedPid means the old daemon is truly gone.
    await markRunning();
    expect(await waitForDaemonStop(root, 1000, DEAD_PID)).toBe(true);
  });

  test('with expectedPid, keeps waiting while that process is alive', async () => {
    // This test process is alive — stands in for an old daemon that has not yet
    // exited. The socket-based check is bypassed in favor of the pid.
    const start = Date.now();
    expect(await waitForDaemonStop(root, 300, process.pid)).toBe(false);
    expect(Date.now() - start).toBeGreaterThanOrEqual(250);
  });
});
