/**
 * Unit tests: multi-task wait race (src/daemon/wait-race.ts).
 *
 * THE INCIDENT (2026-07-31): an agent had two tasks running, waited on one of
 * them, guessed wrong about which would finish first, and sat blocked on the
 * slow one while the fast one was already sitting ready for review.
 *
 * INVARIANT: `raceWait` returns as soon as the FIRST task in the set finishes,
 * regardless of the order the tasks were listed in, and names which one fired.
 * Do not "optimize" this back into a sequential wait over the set.
 */

import { describe, test, expect } from 'bun:test';
import { raceWait, normalizeWaitInputs } from '../../src/daemon/wait-race';
import type { WaitStorage } from '../../src/daemon/wait-race';
import { RpcError } from '../../src/daemon/rpc-handlers';
import type { Task } from '../../src/types';

interface FakeTaskSpec {
  id: string;
  code?: string | null;
  status: string;
  /** Poll sweep (1-based) at which the task flips to `becomes`. */
  finishesAtPoll?: number;
  becomes?: string;
  hasSession?: boolean;
  /** Poll sweep at which an agent turn is appended (without a status change). */
  agentTurnAtPoll?: number;
}

/**
 * In-memory storage that advances task state as polls come in, so a test can
 * script "task B finishes on the second sweep, task A on the fifth".
 */
function makeStorage(specs: FakeTaskSpec[]) {
  const polls = new Map<string, number>();
  const turnCounts = new Map<string, number>();
  const byId = new Map<string, FakeTaskSpec>();
  for (const spec of specs) {
    byId.set(spec.id, spec);
    polls.set(spec.id, 0);
    turnCounts.set(spec.id, 1);
  }

  const task = (spec: FakeTaskSpec, status: string): Task =>
    ({ id: spec.id, code: spec.code ?? null, status, goal: 'g' }) as unknown as Task;

  const statusFor = (spec: FakeTaskSpec): string => {
    const seen = polls.get(spec.id) ?? 0;
    if (spec.finishesAtPoll !== undefined && seen >= spec.finishesAtPoll) {
      return spec.becomes ?? 'blocked';
    }
    return spec.status;
  };

  const storage: WaitStorage & { getTaskCalls: string[] } = {
    getTaskCalls: [],
    async resolveTask(input: string) {
      const spec = specs.find(s => s.id === input || s.code === input || s.id.startsWith(input));
      return { task: spec ? task(spec, statusFor(spec)) : null };
    },
    async getTask(id: string) {
      const spec = byId.get(id);
      if (!spec) return null;
      storage.getTaskCalls.push(id);
      // Count the sweep BEFORE reading status, so finishesAtPoll: 1 means
      // "already finished by the first poll sweep".
      polls.set(id, (polls.get(id) ?? 0) + 1);
      if (spec.agentTurnAtPoll !== undefined && polls.get(id)! >= spec.agentTurnAtPoll) {
        turnCounts.set(id, 2);
      }
      return task(spec, statusFor(spec));
    },
    async getSessionByTaskId(id: string) {
      const spec = byId.get(id);
      if (!spec || spec.hasSession === false) return null;
      return { id: `sess-${id}` };
    },
    async getTurnCountByTaskId(id: string) {
      return turnCounts.get(id) ?? 1;
    },
    async getSessionTurns(sessionId: string) {
      const id = sessionId.replace(/^sess-/, '');
      const count = turnCounts.get(id) ?? 1;
      return Array.from({ length: count }, (_, i) => ({
        sequence: i + 1,
        role: i === count - 1 && count > 1 ? 'agent' : 'human',
        timestamp: 1000 + i,
      }));
    },
  };

  return storage;
}

const FAST = { timeoutSecs: 5, pollIntervalMs: 5 };

describe('normalizeWaitInputs', () => {
  test('accepts a single taskId string (back-compat)', () => {
    expect(normalizeWaitInputs({ taskId: 'abc1' })).toEqual(['abc1']);
  });

  test('accepts a taskIds array', () => {
    expect(normalizeWaitInputs({ taskIds: ['abc1', 'def2'] })).toEqual(['abc1', 'def2']);
  });

  test('accepts an array passed as taskId', () => {
    expect(normalizeWaitInputs({ taskId: ['abc1', 'def2'] })).toEqual(['abc1', 'def2']);
  });

  test('rejects an empty request', () => {
    expect(() => normalizeWaitInputs({})).toThrow('taskId is required');
  });

  test('rejects a non-string entry', () => {
    expect(() => normalizeWaitInputs({ taskIds: [42] })).toThrow('taskIds[]');
  });
});

describe('raceWait', () => {
  // THE INCIDENT: the task listed SECOND finishes first. The race must return
  // it, not sit on the first-listed task.
  test('returns the second-listed task when it finishes first', async () => {
    const storage = makeStorage([
      { id: 'aaaa1111', code: 'slow', status: 'working', finishesAtPoll: 20, becomes: 'blocked' },
      { id: 'bbbb2222', code: 'fast', status: 'working', finishesAtPoll: 2, becomes: 'blocked' },
    ]);

    const result = await raceWait(storage, ['slow', 'fast'], FAST);

    expect(result.timed_out).toBe(false);
    expect(result.task_id).toBe('bbbb2222');
    expect(result.display_id).toBe('fast');
    expect(result.status).toBe('blocked');
    // The loser is reported as still pending, with its current status.
    expect(result.pending.map(t => t.display_id)).toEqual(['slow']);
    expect(result.tasks).toHaveLength(2);
  });

  test('a task that is already not working wins immediately', async () => {
    const storage = makeStorage([
      { id: 'aaaa1111', code: 'a', status: 'working' },
      { id: 'bbbb2222', code: 'b', status: 'blocked' },
    ]);

    const result = await raceWait(storage, ['a', 'b'], FAST);

    expect(result.task_id).toBe('bbbb2222');
    expect(result.status).toBe('blocked');
    expect(result.timed_out).toBe(false);
    // Won before any polling happened — the still-working task was never polled.
    expect(storage.getTaskCalls).toHaveLength(0);
    expect(result.pending.map(t => t.display_id)).toEqual(['a']);
  });

  test('a new agent turn wins even while the task stays working', async () => {
    const storage = makeStorage([
      { id: 'aaaa1111', code: 'a', status: 'working', agentTurnAtPoll: 2 },
      { id: 'bbbb2222', code: 'b', status: 'working' },
    ]);

    const result = await raceWait(storage, ['a', 'b'], FAST);

    expect(result.task_id).toBe('aaaa1111');
    expect(result.status).toBe('working');
    expect(result.turn_count).toBe(2);
    expect(result.latest_turn?.role).toBe('agent');
    expect(result.timed_out).toBe(false);
  });

  test('duplicate references are deduped to one poll target', async () => {
    const storage = makeStorage([
      { id: 'aaaa1111', code: 'a', status: 'working', finishesAtPoll: 2, becomes: 'blocked' },
    ]);

    const result = await raceWait(storage, ['a', 'aaaa1111', 'a'], FAST);

    expect(result.task_id).toBe('aaaa1111');
    expect(result.tasks).toHaveLength(1);
  });

  // INVARIANT: one bad reference fails the WHOLE call, naming it. Racing the
  // valid subset silently would leave the caller waiting on fewer tasks than it
  // asked for with no way to tell.
  test('an unknown reference fails the whole call and names it', async () => {
    const storage = makeStorage([
      { id: 'aaaa1111', code: 'a', status: 'working', finishesAtPoll: 1, becomes: 'blocked' },
    ]);

    const err = await raceWait(storage, ['a', 'nope'], FAST).catch(e => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).status).toBe(404);
    expect((err as Error).message).toContain('nope');
  });

  test('a task with no session fails the whole call with start guidance', async () => {
    const storage = makeStorage([
      { id: 'aaaa1111', code: 'a', status: 'working' },
      { id: 'bbbb2222', code: 'b', status: 'backlog', hasSession: false },
    ]);

    const err = await raceWait(storage, ['a', 'b'], FAST).catch(e => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as Error).message).toContain('lazy start b');
  });

  test('all tasks still working at the deadline returns timed_out with every status', async () => {
    const storage = makeStorage([
      { id: 'aaaa1111', code: 'a', status: 'working' },
      { id: 'bbbb2222', code: 'b', status: 'working' },
    ]);

    const result = await raceWait(storage, ['a', 'b'], { timeoutSecs: 0.05, pollIntervalMs: 5 });

    expect(result.timed_out).toBe(true);
    expect(result.status).toBe('working');
    expect(result.tasks.map(t => t.status)).toEqual(['working', 'working']);
    expect(result.pending).toHaveLength(2);
  });

  // Back-compat: a single reference behaves exactly like the old single-task wait.
  test('single reference keeps the original single-task shape', async () => {
    const storage = makeStorage([
      { id: 'aaaa1111', code: 'a', status: 'working', finishesAtPoll: 2, becomes: 'interrupted' },
    ]);

    const result = await raceWait(storage, ['a'], FAST);

    expect(result.task_id).toBe('aaaa1111');
    expect(result.status).toBe('interrupted');
    expect(result.timed_out).toBe(false);
    expect(result.pending).toHaveLength(0);
  });
});
