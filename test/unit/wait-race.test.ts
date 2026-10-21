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
}

/**
 * In-memory storage that advances task state as polls come in, so a test can
 * script "task B finishes on the second sweep, task A on the fifth".
 */
function makeStorage(specs: FakeTaskSpec[]) {
  const polls = new Map<string, number>();
  const byId = new Map<string, FakeTaskSpec>();
  for (const spec of specs) {
    byId.set(spec.id, spec);
    polls.set(spec.id, 0);
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
      return task(spec, statusFor(spec));
    },
    async getSessionByTaskId(id: string) {
      const spec = byId.get(id);
      if (!spec || spec.hasSession === false) return null;
      return { id: `sess-${id}` };
    },
    async getStatusHistory(id: string) {
      return [{ timestamp: 1, actor: id.startsWith('agentmade') ? 'agent' : 'human' }];
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

  // INVARIANT: an agent turn on a still-`working` task never settles a wait. The
  // reconciler records the turn BEFORE it parks the task, so returning on the
  // turn reported "now working" (exit 1) to a caller that had just started it.
  test('a task that stays working is not settled until its status changes', async () => {
    const storage = makeStorage([
      { id: 'aaaa1111', code: 'a', status: 'working', finishesAtPoll: 5, becomes: 'blocked' },
    ]);

    const result = await raceWait(storage, ['a'], FAST);

    expect(result.status).toBe('blocked');
    expect(result.timed_out).toBe(false);
    expect(storage.getTaskCalls.length).toBeGreaterThanOrEqual(5);
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

describe('raceWait interruption by a new subtask', () => {
  // INVARIANT: a subtask added under the waiter mid-wait ends the wait with an
  // explicit `interrupted` reason — never a fake timeout or a fake settle — so a
  // parent blocked on its children learns about work added from outside.
  test('returns interrupted (not timed out) when a child appears under the waiter', async () => {
    const storage = makeStorage([{ id: 'aaaa1111', code: 'a', status: 'working' }]);
    let reads = 0;
    storage.getChildTasks = async () => {
      reads++;
      const kids = [{ id: 'old1', code: 'old', status: 'working' }];
      if (reads > 2) kids.push({ id: 'new1', code: 'fresh', status: 'backlog' });
      return kids as unknown as Task[];
    };

    const result = await raceWait(storage, ['a'], { ...FAST, interruptOnNewChildOf: 'parent' });

    expect(result.timed_out).toBe(false);
    expect(result.interrupted?.reason).toBe('subtask_added');
    expect(result.interrupted?.new_tasks?.map(t => t.task_id)).toEqual(['new1']);
    expect(result.status).toBe('working');
  });

  test('children that existed when the wait began do not interrupt it', async () => {
    const storage = makeStorage([{ id: 'aaaa1111', code: 'a', status: 'working', finishesAtPoll: 3 }]);
    storage.getChildTasks = async () => [{ id: 'old1', code: 'old', status: 'working' }] as unknown as Task[];

    const result = await raceWait(storage, ['a'], { ...FAST, interruptOnNewChildOf: 'parent' });

    expect(result.interrupted).toBeUndefined();
    expect(result.status).toBe('blocked');
  });
});

describe('raceWait interruption details', () => {
  // INVARIANT: only children created from outside interrupt; the waiter's own
  // agent creating a child must never wake its own wait.
  test('a child created by the waiting agent itself does not interrupt', async () => {
    const storage = makeStorage([{ id: 'aaaa1111', code: 'a', status: 'working', finishesAtPoll: 4 }]);
    let reads = 0;
    storage.getChildTasks = async () => (reads++ > 1 ? [{ id: 'agentmade1', status: 'backlog' }] : []) as unknown as Task[];
    const result = await raceWait(storage, ['a'], { ...FAST, interruptOnNewChildOf: 'parent' });
    expect(result.interrupted).toBeUndefined();
    expect(result.status).toBe('blocked');
  });

  // INVARIANT: a task that settles in the same sweep stays the answer.
  test('a settle in the same sweep as a new child is reported as the winner, with the interruption', async () => {
    const storage = makeStorage([{ id: 'aaaa1111', code: 'a', status: 'working', finishesAtPoll: 1 }]);
    let reads = 0;
    storage.getChildTasks = async () => (reads++ > 0 ? [{ id: 'new1', status: 'backlog' }] : []) as unknown as Task[];
    const result = await raceWait(storage, ['a'], { ...FAST, interruptOnNewChildOf: 'parent' });
    expect(result.status).toBe('blocked');
    expect(result.task_id).toBe('aaaa1111');
    expect(result.interrupted?.new_tasks?.map(t => t.task_id)).toEqual(['new1']);
  });
});

describe('raceWait comment interruption', () => {
  const claimOf = (notes: string) => ({ notes, count: 1, through: 5000, claim_id: 'claim-1' });

  // INVARIANT: a comment that lands on the waiting task interrupts the wait
  // within a poll and carries the notes block itself, so the agent can act on
  // it without ending its turn. A human's comment and a builder's are the same.
  for (const who of ['human', 'builder']) {
    test(`a ${who} comment interrupts the wait with its content and a claim`, async () => {
      const storage = makeStorage([{ id: 'aaaa1111', code: 'a', status: 'working', finishesAtPoll: 50 }]);
      let polls = 0;
      const result = await raceWait(storage, ['a'], {
        ...FAST,
        claimComments: async () => (++polls >= 3 ? claimOf(`NOTES ADDED SINCE YOUR LAST TURN:\n[${who}] use the new API`) : null),
      });

      expect(result.timed_out).toBe(false);
      expect(result.status).toBe('working');
      expect(result.interrupted?.reason).toBe('comment_added');
      expect(result.interrupted?.notes).toContain('use the new API');
      expect(result.interrupted?.claim).toEqual({ through: 5000, claim_id: 'claim-1' });
      expect(result.pending.map(t => t.display_id)).toEqual(['a']);
    });
  }

  // INVARIANT: with nothing claimable (the hook filters system notices and the
  // waiter's own writes, as the mid-turn hand-off does) the wait runs on.
  test('no claimable comment leaves the wait to settle normally', async () => {
    const storage = makeStorage([{ id: 'aaaa1111', code: 'a', status: 'working', finishesAtPoll: 4 }]);
    const result = await raceWait(storage, ['a'], { ...FAST, claimComments: async () => null });
    expect(result.interrupted).toBeUndefined();
    expect(result.status).toBe('blocked');
  });

  // INVARIANT: a claim counts against the turn budget, so it is made only when
  // it will be returned: a pending subtask interruption goes first and the
  // comment is never claimed (and so never lost) on that sweep.
  test('a subtask interruption takes precedence and the comment is not claimed', async () => {
    const storage = makeStorage([{ id: 'aaaa1111', code: 'a', status: 'working', finishesAtPoll: 50 }]);
    let reads = 0;
    storage.getChildTasks = async () => (reads++ > 0 ? [{ id: 'new1', status: 'backlog' }] : []) as unknown as Task[];
    let claims = 0;
    const result = await raceWait(storage, ['a'], {
      ...FAST, interruptOnNewChildOf: 'parent', claimComments: async () => { claims++; return claimOf('n'); },
    });
    expect(result.interrupted?.reason).toBe('subtask_added');
    expect(claims).toBe(0);
  });
});
