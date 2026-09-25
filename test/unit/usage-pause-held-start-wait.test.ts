/**
 * A subtask whose start the usage pause is HOLDING (src/daemon/usage-pause.ts,
 * `holdAgentStart`) is waitable: `lazy_wait` treats it as still running, not as
 * "never started" or "finished in backlog" (src/daemon/wait-race.ts).
 */

import { describe, test, expect } from 'bun:test';
import { raceWait, type WaitStorage } from '../../src/daemon/wait-race';
import { USAGE_PAUSE_PENDING_START_KEY } from '../../src/usage-pause/hold';
import type { Task } from '../../src/types';

const HELD = JSON.stringify({ requestedAt: 1, params: {} });

/** One task whose state follows a script, advanced once per poll sweep. */
function scripted(steps: Array<{ status: string; held?: boolean; session?: boolean; turns?: number; lastRole?: string }>) {
  let poll = 0;
  const at = () => steps[Math.min(poll, steps.length - 1)]!;
  const task = (): Task => ({
    id: 'child-1', code: 'child', goal: 'g', status: at().status,
    metadata: at().held ? { [USAGE_PAUSE_PENDING_START_KEY]: HELD } : {},
  }) as unknown as Task;
  const storage: WaitStorage = {
    async resolveTask() { return { task: task() }; },
    async getTask() { poll++; return task(); },
    async getSessionByTaskId() { return at().session ? { id: 'sess' } : null; },
    async getTurnCountByTaskId() { return at().turns ?? 0; },
    async getSessionTurns() {
      const n = at().turns ?? 0;
      return Array.from({ length: n }, (_, i) => ({ sequence: i, role: i === n - 1 ? (at().lastRole ?? 'agent') : 'human', timestamp: i }));
    },
  };
  return storage;
}

describe('waiting on a start the usage pause holds', () => {
  // INVARIANT: a held start is waited on as if it were running. Its parent's
  // agent was told "do not start it again; wait on it" — so the wait must not
  // refuse it for having no session, must not return at once because it is
  // `backlog`, and must list it as pending when it times out.
  test('a held child is not refused, and a timed-out wait reports it pending and held', async () => {
    const storage = scripted([{ status: 'backlog', held: true }]);
    const result = await raceWait(storage, ['child-1'], { timeoutSecs: 0.05, pollIntervalMs: 10 });
    expect(result.timed_out).toBe(true);
    expect(result.pending.map((t) => t.task_id)).toEqual(['child-1']);
    expect(result.pending[0]!.held_by_usage_pause).toBe(true);
  });

  // INVARIANT: once the daemon launches the held start, the wait returns when
  // that FIRST TURN ends — not at the launch (the start's own records do not
  // count as the turn finishing), and not never.
  test('returns when the launched child finishes its first turn', async () => {
    const storage = scripted([
      { status: 'backlog', held: true },
      { status: 'backlog', held: true },
      { status: 'working', session: true, turns: 1, lastRole: 'agent' },
      { status: 'working', session: true, turns: 1, lastRole: 'agent' },
      { status: 'blocked', session: true, turns: 2 },
    ]);
    const result = await raceWait(storage, ['child-1'], { timeoutSecs: 5, pollIntervalMs: 5 });
    expect(result.timed_out).toBe(false);
    expect(result.status).toBe('blocked');
  });

  test('a never-started task that is NOT held is still refused', async () => {
    const storage = scripted([{ status: 'backlog' }]);
    await expect(raceWait(storage, ['child-1'], { timeoutSecs: 0.05, pollIntervalMs: 10 })).rejects.toThrow(/no session/);
  });
});
