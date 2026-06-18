import { describe, test, expect, afterEach } from 'bun:test';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';
import { resolve } from 'path';

// This file lives separately from docker-runner.test.ts because it relies on
// mocking '../../src/utils/spawn'. DockerRunner binds `spawn` at module
// evaluation time, so the mock must be installed before the FIRST import of
// DockerRunner in this module — a sibling file that statically imports
// DockerRunner would capture the real spawn and defeat the mock.
//
// We use the project's mockModule/restoreMockedModules helper (NOT raw
// mock.module + mock.restore): bun's mock.restore() only undoes spies, not
// module mocks, so a raw mock.module('.../utils/spawn') would leak the fake
// spawn into every later test file — and since nearly all git/process work
// funnels through utils/spawn, that corrupts the whole unit suite. restoreMockedModules()
// in afterEach re-installs the real spawn before the next file runs.
const SPAWN_PATH = resolve(import.meta.dir, '../../src/utils/spawn.ts');

describe('DockerRunner.stopRun', () => {
  afterEach(() => {
    restoreMockedModules();
  });

  test('uses `kill` (immediate SIGKILL), not `stop`, and resolves true on success', async () => {
    const calls: string[][] = [];
    await mockModule(SPAWN_PATH, () => ({
      spawn: (cmd: string[]) => {
        calls.push(cmd);
        return { exited: Promise.resolve(0), kill: () => {} };
      },
      // Other code paths in the module may touch spawnSync at import time.
      spawnSync: () => ({ exitCode: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }),
      DEFAULT_SUBPROCESS_TIMEOUT_MS: 60_000,
    }));

    const { DockerRunner } = await import('../../src/runner/docker-runner');
    const runner = new DockerRunner('docker');

    const result = runner.stopRun('lazy-abc12345');
    // INVARIANT: stopRun is async (returns a Promise) so the daemon event loop is
    // not blocked while the container is killed. A synchronous `docker stop` here
    // froze the whole daemon — see task kill-blocking-spawnsync.
    expect(result).toBeInstanceOf(Promise);

    const ok = await result;
    expect(ok).toBe(true);

    // INVARIANT: container stop is a hard kill. `docker stop` sends SIGTERM and
    // waits out a grace period before SIGKILL; there is no graceful shutdown to
    // wait for, so that grace period is pure latency. Use `docker kill`.
    expect(calls).toEqual([['docker', 'kill', 'lazy-abc12345']]);
  });

  test('resolves false when kill exits non-zero', async () => {
    await mockModule(SPAWN_PATH, () => ({
      spawn: () => ({ exited: Promise.resolve(1), kill: () => {} }),
      spawnSync: () => ({ exitCode: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }),
      DEFAULT_SUBPROCESS_TIMEOUT_MS: 60_000,
    }));

    const { DockerRunner } = await import('../../src/runner/docker-runner');
    const runner = new DockerRunner('docker');

    expect(await runner.stopRun('lazy-abc12345')).toBe(false);
  });
});
