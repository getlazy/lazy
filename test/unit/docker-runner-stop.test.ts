import { describe, test, expect, mock, afterEach } from 'bun:test';

// This file lives separately from docker-runner.test.ts because it relies on
// mock.module('../../src/utils/spawn'). DockerRunner binds `spawn` at module
// evaluation time, so the mock must be installed before the FIRST import of
// DockerRunner in this module — a sibling file that statically imports
// DockerRunner would capture the real spawn and defeat the mock.

describe('DockerRunner.stopRun', () => {
  afterEach(() => {
    mock.restore();
  });

  test('uses `kill` (immediate SIGKILL), not `stop`, and resolves true on success', async () => {
    const calls: string[][] = [];
    mock.module('../../src/utils/spawn', () => ({
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
    mock.module('../../src/utils/spawn', () => ({
      spawn: () => ({ exited: Promise.resolve(1), kill: () => {} }),
      spawnSync: () => ({ exitCode: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }),
      DEFAULT_SUBPROCESS_TIMEOUT_MS: 60_000,
    }));

    const { DockerRunner } = await import('../../src/runner/docker-runner');
    const runner = new DockerRunner('docker');

    expect(await runner.stopRun('lazy-abc12345')).toBe(false);
  });
});
