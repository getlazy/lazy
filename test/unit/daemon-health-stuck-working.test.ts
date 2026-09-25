/**
 * The "Working tasks have a live run" row, gathered with fakes.
 *
 * One task whose run lookup throws must not take the whole row down with it:
 * every other stuck task still has to be reported.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { collectStuckWorking, stuckWorkingCheck, runBoundedCheck, workingRunProber, type WorkingRunProber } from '../../src/daemon/daemon-health';
import { buildStuckWorkingRow } from '../../src/daemon/daemon-health-rows';
import type { Storage } from '../../src/storage/interface';
import type { Runner } from '../../src/runner';
import type { WorkingRunProbe } from '../../src/utils/working-run';
import type { Task } from '../../src/types';

let protocolBase: string;
let previousBase: string | undefined;

beforeAll(async () => {
  // An empty protocol dir: no status checkpoint, no response — a dead run.
  protocolBase = await mkdtemp(join(tmpdir(), 'health-stuck-'));
  previousBase = process.env.LAZY_PROTOCOL_BASE;
  process.env.LAZY_PROTOCOL_BASE = protocolBase;
});

afterAll(async () => {
  if (previousBase === undefined) delete process.env.LAZY_PROTOCOL_BASE;
  else process.env.LAZY_PROTOCOL_BASE = previousBase;
  await rm(protocolBase, { recursive: true, force: true });
});

const NOW = Date.now();

function task(id: string, code: string): Task {
  return { id, code, status: 'working' } as unknown as Task;
}

/** What the shared resolver answers for a run it confirmed dead. */
function deadProbe(taskId: string, info: WorkingRunProbe['info']): WorkingRunProbe {
  return {
    run: { runner: {} as Runner, runName: `run-${taskId}`, protoDir: join(protocolBase, taskId), claim: null },
    alive: false,
    substate: { kind: 'not-alive' },
    info,
  };
}

const storage = {
  getSessionByTaskId: async (taskId: string) => ({
    task_id: taskId,
    container_name: `run-${taskId}`,
    last_interaction_at: NOW - 10 * 60_000,
  }),
} as unknown as Storage;

describe('collecting stuck working tasks', () => {
  // INVARIANT: one task's failed liveness lookup is reported as that task's
  // "liveness unknown" — it never hides the other stuck tasks in the row.
  test('a task whose run lookup throws is reported on its own; the others still are', async () => {
    const prober: WorkingRunProber = async (t) => {
      if (t.id === 'aaaa') throw new Error('docker inspect timed out');
      return deadProbe(t.id, { running: false, exitCode: 137, finishedAt: new Date(NOW - 5 * 60_000).toISOString() });
    };

    const found = await collectStuckWorking(storage, prober, [task('aaaa', 'broken-lookup'), task('bbbb', 'dead-run')], NOW);

    expect(found.map(t => t.code)).toEqual(['broken-lookup', 'dead-run']);
    expect(found[0]!.livenessError).toContain('docker inspect timed out');
    expect(found[1]!.goneForMs).toBe(5 * 60_000);

    const row = buildStuckWorkingRow(found, 2);
    expect(row.state).toBe('fail');
    expect(row.reason).toContain('dead-run');
    expect(row.reason).toContain('broken-lookup');
    expect(row.reason).toContain('liveness unknown');
  });

  test('a lookup failure alone is a WARN: it is not evidence the task is stuck', () => {
    const row = buildStuckWorkingRow([{ code: 'a', goneForMs: null, livenessError: 'boom' }], 1);
    expect(row.state).toBe('warn');
    expect(row.reason).toContain('liveness unknown');
  });
});

describe('the working-tasks check under a deadline', () => {
  // INVARIANT: only a confirmed dead run may FAIL this row. A runtime too slow
  // to answer in time confirms nothing, so the check's own timeout is a WARN.
  test('a runner whose lookups never answer yields a WARN, not a FAIL', async () => {
    const runner = {
      type: 'docker',
      runNameForTask: () => 'unused',
      isRunning: () => new Promise(() => {}),
      getRunInfo: () => new Promise(() => {}),
    } as unknown as Runner;
    const check = stuckWorkingCheck({
      listWorking: async () => [task('cccc', 'slow-one'), task('dddd', 'slow-two')],
      storage: async () => storage,
      prober: async () => workingRunProber('/nowhere', runner),
      runnerType: () => 'docker',
      now: () => NOW,
      timeoutMs: 50,
    });
    const rows = await runBoundedCheck(check);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('tasks:working-not-alive');
    expect(rows[0]!.state).toBe('warn');
    expect(rows[0]!.reason).toContain('could not be checked');
    expect(rows[0]!.remedy).toContain('docker');
  });

  test('the timeout remedy names the configured runner', async () => {
    const hang = { type: 'host-process', runNameForTask: () => 'x', isRunning: () => new Promise(() => {}), getRunInfo: () => new Promise(() => {}) } as unknown as Runner;
    const check = stuckWorkingCheck({
      listWorking: async () => [task('eeee', 'host-task')],
      storage: async () => storage,
      prober: async () => workingRunProber('/nowhere', hang),
      runnerType: () => 'host-process',
      now: () => NOW,
      timeoutMs: 50,
    });
    const [row] = await runBoundedCheck(check);
    expect(row!.state).toBe('warn');
    expect(row!.remedy).not.toContain('docker');
  });

  // Independent lookups run at once: total time is the slowest, not the sum.
  test('per-task lookups run concurrently', async () => {
    let inFlight = 0;
    let peak = 0;
    const prober: WorkingRunProber = async (t) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 20));
      inFlight--;
      return { ...deadProbe(t.id, null), alive: true, substate: { kind: 'agent' } as WorkingRunProbe['substate'] };
    };
    await collectStuckWorking(storage, prober, [task('ffff', 'a'), task('gggg', 'b'), task('hhhh', 'c')], NOW);
    expect(peak).toBe(3);
  });
});

describe('a runtime that does not answer is not a dead run', () => {
  const launched30MinAgo = {
    getSessionByTaskId: async (taskId: string) => ({
      task_id: taskId,
      container_name: `run-${taskId}`,
      last_interaction_at: NOW - 30 * 60_000,
    }),
  } as unknown as Storage;

  // INVARIANT: only the runtime ANSWERING "no such container / exited" confirms
  // a dead run. A lookup the runtime never answered (timeout, killed, cannot
  // connect) confirms nothing about the task — that task is "liveness unknown"
  // and the row WARNs, with the reason, however long ago the task launched.
  test('"did not answer" for a task launched 30 min ago is a WARN with the reason', async () => {
    const runner = {
      type: 'docker',
      runNameForTask: () => 'unused',
      isRunning: async () => false,
      getRunInfo: async () => null,
      probeRunInfo: async () => ({ kind: 'no-answer', reason: 'docker inspect did not answer within 10s' }),
    } as unknown as Runner;
    const found = await collectStuckWorking(launched30MinAgo, workingRunProber('/nowhere', runner), [task('iiii', 'slow-docker')], NOW);
    expect(found).toEqual([{ code: 'slow-docker', goneForMs: null, livenessError: 'docker inspect did not answer within 10s' }]);
    const row = buildStuckWorkingRow(found, 1);
    expect(row.state).toBe('warn');
    expect(row.reason).toContain('did not answer within 10s');
  });

  test('the runtime answering "no such container" is still a confirmed dead run: FAIL', async () => {
    const runner = {
      type: 'docker',
      runNameForTask: () => 'unused',
      isRunning: async () => false,
      getRunInfo: async () => null,
      probeRunInfo: async () => ({ kind: 'answered', info: null }),
    } as unknown as Runner;
    const found = await collectStuckWorking(launched30MinAgo, workingRunProber('/nowhere', runner), [task('jjjj', 'gone')], NOW);
    expect(found).toHaveLength(1);
    expect(found[0]!.livenessError).toBeUndefined();
    expect(buildStuckWorkingRow(found, 1).state).toBe('fail');
  });
});

describe('health probes the runner the task actually ran on', () => {
  // INVARIANT: the health row resolves liveness through the reconciler's own
  // resolution, so a per-task runner override is probed on THAT runner — never
  // the project default, where the run does not exist and would read as dead.
  test('a session on podman under a docker project default is probed on podman', async () => {
    const probed: string[] = [];
    const fake = (type: string, running: boolean) => ({
      type,
      runNameForTask: () => 'unused',
      isRunning: async (name: string) => { probed.push(`${type}:${name}`); return running; },
      getRunInfo: async () => ({ running, exitCode: null, finishedAt: null }),
    }) as unknown as Runner;
    const docker = fake('docker', false);
    const podman = fake('podman', true);
    const overridden = {
      getSessionByTaskId: async (taskId: string) => ({
        task_id: taskId,
        container_name: `run-${taskId}`,
        runner_type: 'podman',
        last_interaction_at: NOW - 30 * 60_000,
      }),
    } as unknown as Storage;
    const prober = workingRunProber('/nowhere', docker, async (type) => {
      expect(type).toBe('podman');
      return podman;
    });
    const found = await collectStuckWorking(overridden, prober, [task('kkkk', 'on-podman')], NOW);
    expect(probed).toEqual(['podman:run-kkkk']);
    expect(found).toEqual([]);
  });
});
