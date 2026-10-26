import { describe, expect, mock, test } from 'bun:test';
import { stopTaskAgent } from '../../src/runner/stop-task-agent';
import type { Runner } from '../../src/runner/types';

describe('stopTaskAgent', () => {
  // INVARIANT: host-process Stop reaches the agent even after its supervisor
  // dies. isRunning only sees the supervisor; stopRun/removeRun find orphans.
  test('stops and removes a non-sandboxed run whose supervisor is not running', async () => {
    const calls: string[] = [];
    const runner = {
      usesSandbox: () => false,
      isRunning: mock(async () => false),
      stopRun: mock(async () => { calls.push('stop'); return true; }),
      removeRun: mock(async () => { calls.push('remove'); }),
    };

    await stopTaskAgent(runner as unknown as Runner, 'host-run', '/protocol');

    expect(runner.stopRun).toHaveBeenCalledWith('host-run');
    expect(runner.removeRun).toHaveBeenCalledWith('host-run');
    expect(calls).toEqual(['stop', 'remove']);
  });

  test('still attempts removal when stopRun finds no live process', async () => {
    const runner = {
      usesSandbox: () => false,
      isRunning: mock(async () => false),
      stopRun: mock(async () => false),
      removeRun: mock(async () => {}),
    };

    await stopTaskAgent(runner as unknown as Runner, 'host-run', '/protocol');

    expect(runner.stopRun).toHaveBeenCalledWith('host-run');
    expect(runner.removeRun).toHaveBeenCalledWith('host-run');
  });

  test('a run-record cleanup failure does not undo the stop', async () => {
    const runner = {
      usesSandbox: () => false,
      stopRun: mock(async () => true),
      removeRun: mock(async () => { throw new Error('record cleanup failed'); }),
    };

    await expect(stopTaskAgent(runner as unknown as Runner, 'host-run', '/protocol')).resolves.toBeUndefined();
    expect(runner.stopRun).toHaveBeenCalledWith('host-run');
    expect(runner.removeRun).toHaveBeenCalledWith('host-run');
  });

  // INVARIANT: sandboxed Stop ends only the turn. The shared container can
  // contain services and files that must survive it.
  test('stops inside a sandbox without stopping or removing its run', async () => {
    const runner = {
      usesSandbox: () => true,
      isRunning: mock(async () => true),
      execInRun: mock(async () => 0),
      stopRun: mock(async () => true),
      removeRun: mock(async () => {}),
    };

    await stopTaskAgent(runner as unknown as Runner, 'container-run', '/protocol');

    expect(runner.execInRun).toHaveBeenCalledTimes(1);
    expect(runner.stopRun).not.toHaveBeenCalled();
    expect(runner.removeRun).not.toHaveBeenCalled();
  });
});
