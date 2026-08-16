/**
 * INVARIANT: a daemon spawned by an e2e test run must never outlive that run.
 *
 * Every other reaper — `ctx.cleanup()` and the exit/SIGINT handlers in
 * test/helpers/daemon-registry.ts — lives inside the `bun test` process, so all
 * of them are skipped when that process is SIGKILLed (a sweep's own timeout, an
 * OOM kill, `kill -9` during local iteration). The daemon's own parent watch is
 * the only thing that covers that case, and this suite proves it end-to-end
 * against a REAL `lazy daemon start --foreground`, not a stand-in: the daemon
 * must exit on its own once the pid named by LAZY_TEST_PARENT_PID is gone.
 *
 * Eight such orphans (each ~110MB and holding its temp project's .storage-lock)
 * were found in one container mid-sweep; that is the bug this guards.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { resolve } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { readPid } from '../../src/daemon';
import { waitForDaemon } from '../../src/daemon';
import { TEST_PARENT_PID_ENV } from '../../src/daemon/test-parent-watch';

const ENTRY_PATH = resolve(__dirname, '../../src/index.ts');

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return !isAlive(pid);
}

describe('test daemon dies with its declared test parent', () => {
  let ctx: TestContext;
  let stand: ReturnType<typeof Bun.spawn> | null = null;
  let daemonPid: number | null = null;

  beforeEach(async () => {
    // Daemonless setup: this suite starts its own daemon so it can hand it a
    // DIFFERENT parent pid than the `bun test` process (whose death would end
    // the test itself).
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    if (stand && isAlive(stand.pid)) {
      try { stand.kill('SIGKILL'); } catch { /* already gone */ }
    }
    if (daemonPid !== null && isAlive(daemonPid)) {
      try { process.kill(daemonPid, 'SIGKILL'); } catch { /* already gone */ }
    }
    stand = null;
    daemonPid = null;
    await ctx.cleanup();
  });

  test('daemon exits after the pid in LAZY_TEST_PARENT_PID goes away', async () => {
    // Stand-in for a `bun test` process: something with a pid that we can kill
    // without taking this test down with it.
    stand = Bun.spawn(['sleep', '300'], { stdout: 'ignore', stderr: 'ignore' });

    const proc = Bun.spawn(
      ['bun', 'run', ENTRY_PATH, 'daemon', 'start', '--foreground', '--project', ctx.root],
      {
        cwd: ctx.root,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
        env: {
          ...process.env,
          LAZY_PROTOCOL_BASE: ctx.protocolBase,
          ANTHROPIC_API_KEY: 'sk-test-fake-key-for-testing',
          // The subject of this test: the daemon watches THIS pid, not its own
          // parent (a detached daemon is reparented to init immediately, so its
          // real ppid says nothing about whether the test run is still alive).
          [TEST_PARENT_PID_ENV]: String(stand.pid),
        },
      },
    );
    proc.unref();

    expect(await waitForDaemon(ctx.root, 10_000)).toBe(true);
    daemonPid = readPid(ctx.root);
    expect(daemonPid).not.toBeNull();
    expect(isAlive(daemonPid!)).toBe(true);

    // Nothing signals the daemon: the stand-in dies, and the daemon must notice
    // by itself. SIGKILL so no cooperative handoff can be credited for the exit.
    stand.kill('SIGKILL');
    await stand.exited;

    // The poll is 1s; allow generous slack for a loaded container.
    expect(await waitUntilDead(daemonPid!, 15_000)).toBe(true);
  }, 45_000);

  // INVARIANT: this is a test-only guard. Without the env var the daemon must
  // ignore the pid of whatever spawned it and keep running — a production
  // daemon outliving the CLI that started it is the entire point of detaching.
  test('a daemon without the env var survives its spawner', async () => {
    const proc = Bun.spawn(
      ['bun', 'run', ENTRY_PATH, 'daemon', 'start', '--foreground', '--project', ctx.root],
      {
        cwd: ctx.root,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
        env: {
          ...process.env,
          LAZY_PROTOCOL_BASE: ctx.protocolBase,
          ANTHROPIC_API_KEY: 'sk-test-fake-key-for-testing',
          [TEST_PARENT_PID_ENV]: '',
        },
      },
    );
    proc.unref();

    expect(await waitForDaemon(ctx.root, 10_000)).toBe(true);
    daemonPid = readPid(ctx.root);
    expect(daemonPid).not.toBeNull();

    // Well past several poll intervals of the watch that must NOT be running.
    await new Promise(r => setTimeout(r, 3_000));
    expect(isAlive(daemonPid!)).toBe(true);
  }, 45_000);
});
