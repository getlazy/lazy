/**
 * The one decision every turn launch makes about a task's container before it
 * hands over a command or creates a new one (src/runner/start-or-recreate.ts).
 */

import { describe, test, expect } from 'bun:test';
import { reuseOrStartTaskRun } from '../../src/runner/start-or-recreate';
import { mustRecreateForContainerAgent } from '../../src/runner/session-launch';

function fakes(opts: { running: boolean; canStart?: boolean; noStart?: boolean }) {
  const calls: string[] = [];
  const runner = {
    isRunning: async (n: string) => { calls.push(`isRunning ${n}`); return opts.running; },
    ...(opts.noStart ? {} : { startStoppedRun: async (n: string) => { calls.push(`start ${n}`); return opts.canStart ?? false; } }),
  };
  const storage = {
    updateSessionContainerName: async (id: string, name: string | null, agent?: string | null) => { calls.push(`name ${id} ${name}${agent !== undefined ? ` ${agent}` : ''}`); },
  } as never;
  return { calls, runner, storage };
}

describe('reuseOrStartTaskRun', () => {
  // INVARIANT: a container is never recreated casually. A named recreate
  // predicate is the only thing that discards a running or startable
  // container; a stopped one is started again with everything in it.
  test('a recreate predicate wins and touches nothing', async () => {
    const f = fakes({ running: true, canStart: true });
    expect(await reuseOrStartTaskRun(f.runner, f.storage, { id: 's', container_name: 'lazy-a' }, 'lazy-a', true, 'claude-code')).toBeNull();
    expect(f.calls).toEqual([]);
  });

  test('a running container is reused, its stamp left alone', async () => {
    const f = fakes({ running: true });
    const session = { id: 's', container_name: 'lazy-a', container_agent_id: 'claude-code' };
    expect(await reuseOrStartTaskRun(f.runner, f.storage, session, 'lazy-a', false, 'claude-code')).toBe('reused');
    expect(f.calls).toEqual(['isRunning lazy-a']);
  });

  // INVARIANT: a kept container with NO stamp (a record from before stamps
  // were kept on every path) gets one when it is reused or started again for
  // the task's agent, so the next agent switch recreates it instead of going
  // unnoticed (review round 3).
  test('a kept container with no stamp is stamped with the agent it is kept for', async () => {
    const f = fakes({ running: true });
    const session = { id: 's', container_name: 'lazy-a' as string | null, container_agent_id: null as string | null };
    expect(await reuseOrStartTaskRun(f.runner, f.storage, session, 'lazy-a', false, 'claude-code')).toBe('reused');
    expect(f.calls).toEqual(['isRunning lazy-a', 'name s lazy-a claude-code']);
    expect(session.container_agent_id).toBe('claude-code');
    const g = fakes({ running: false, canStart: true });
    const stopped = { id: 's', container_name: 'lazy-a' as string | null, container_agent_id: null as string | null };
    expect(await reuseOrStartTaskRun(g.runner, g.storage, stopped, 'lazy-a', false, 'codex')).toBe('started');
    expect(g.calls).toEqual(['isRunning lazy-a', 'start lazy-a', 'name s null', 'name s lazy-a codex']);
  });

  test('a stopped container is started again, and its name cleared then re-recorded so ports.changed fires', async () => {
    const f = fakes({ running: false, canStart: true });
    const session = { id: 's', container_name: 'lazy-a' as string | null, container_agent_id: 'claude-code' };
    expect(await reuseOrStartTaskRun(f.runner, f.storage, session, 'lazy-a', false, 'claude-code')).toBe('started');
    expect(f.calls).toEqual(['isRunning lazy-a', 'start lazy-a', 'name s null', 'name s lazy-a claude-code']);
    expect(session.container_name).toBe('lazy-a');
  });

  test('one that cannot be started, or a runner that cannot start one, is recreated', async () => {
    const f = fakes({ running: false, canStart: false });
    expect(await reuseOrStartTaskRun(f.runner, f.storage, null, 'lazy-a', false, 'claude-code')).toBeNull();
    const g = fakes({ running: false, noStart: true });
    expect(await reuseOrStartTaskRun(g.runner, g.storage, null, 'lazy-a', false, 'claude-code')).toBeNull();
  });
});

/**
 * A FileStorage-shaped session record: clearing the name clears the agent
 * stamp, exactly as `FileStorage.updateSessionContainerName` does.
 */
function recordingStorage(session: { id: string; container_name: string | null; container_agent_id: string | null }) {
  return {
    updateSessionContainerName: async (_id: string, name: string | null, agent?: string | null) => {
      session.container_name = name;
      if (name === null) session.container_agent_id = null;
      else if (agent !== undefined) session.container_agent_id = agent;
    },
  } as never;
}

describe('a kept container keeps the agent it was created for', () => {
  // INVARIANT: a container's agent stamp survives every path that keeps the
  // container, so a task whose agent was switched while its container was
  // stopped gets a NEW container — the launch env is fixed at create time — and
  // a container started again is re-recorded with its ORIGINAL stamp, never
  // the task's current agent (review round 2, finding 1).
  test('the agent switched while the container was stopped: it is recreated, not started', async () => {
    const session = { id: 's', container_name: 'lazy-a', container_agent_id: 'claude-code' };
    const f = fakes({ running: false, canStart: true });
    const recreate = mustRecreateForContainerAgent(session, 'codex');
    expect(recreate).toBe(true);
    expect(await reuseOrStartTaskRun(f.runner, recordingStorage(session), session, 'lazy-a', recreate, 'claude-code')).toBeNull();
    expect(f.calls).toEqual([]);
  });

  test('a container started again is re-recorded with its original stamp', async () => {
    const session = { id: 's', container_name: 'lazy-a', container_agent_id: 'claude-code' };
    const f = fakes({ running: false, canStart: true });
    expect(await reuseOrStartTaskRun(f.runner, recordingStorage(session), session, 'lazy-a', false, 'claude-code')).toBe('started');
    expect(session).toEqual({ id: 's', container_name: 'lazy-a', container_agent_id: 'claude-code' });
    // So a switch made AFTER it was started still recreates it.
    expect(mustRecreateForContainerAgent(session, 'codex')).toBe(true);
  });

  test('the paths that keep a stopped container never clear its recorded name and stamp', async () => {
    const { readFile } = await import('fs/promises');
    const { join } = await import('path');
    for (const file of ['src/utils/reconcile.ts', 'src/daemon/task-lifecycle.ts']) {
      const lines = (await readFile(join(import.meta.dir, '../..', file), 'utf-8')).split('\n');
      const kept = lines.flatMap((l, i) => (/is KEPT|Kept, not removed/.test(l) ? [i] : []));
      expect(kept.length).toBeGreaterThan(0);
      for (const i of kept) {
        expect(lines.slice(i, i + 8).join('\n')).not.toMatch(/updateSessionContainerName\([^)]*,\s*null\)/);
      }
    }
  });
});
