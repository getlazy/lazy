/**
 * INVARIANT: redo refuses (409, naming the member) while a member is working
 * in the task's files, BEFORE it writes anything: its close tears those files
 * down, so a replacement task written ahead of that refusal was left behind as
 * a stray duplicate of the task being redone.
 *
 * INVARIANT (engineer, 2026-10-21, replacing "reparent refuses too"): reparent
 * does NOT wait for a member. Its sync merges the new parent into the
 * worktree the way a turn does, and turns never wait for a member.
 */

import { describe, test, expect, afterEach, spyOn } from 'bun:test';
import * as rpcHandlers from '../../src/daemon/rpc-handlers';
import { reparentTask } from '../../src/daemon/task-lifecycle';
import { redoTask } from '../../src/daemon/clone-redo';
import { claimMemberTerminal, markMemberTerminalEntered, resetMemberTerminalsForTests } from '../../src/server/member-terminals';

const ALICE = 'alice@example.com';
const TASK = { id: 'held-task-0000-uuid', code: 'held', goal: 'Held', status: 'blocked', type: 'task', agent_id: 'claude-code', created_at: 1, metadata: {}, target: { kind: 'branch', branch: 'main' } };
const PARENT = { id: 'new-parent-0000-uuid', code: 'np', goal: 'New parent', status: 'blocked', type: 'task', agent_id: 'claude-code', created_at: 1, metadata: {}, target: { kind: 'branch', branch: 'main' } };

/** Every write this store is asked for. Reads answer the two tasks, or nothing. */
const WRITES = /^(create|update|delete|set|add|end|increment|mark|close|resolve[A-Z]|record|append|put|remove)/;
function recordingStorage(writes: string[]) {
  const byId = (id: string) => (id === TASK.id || id === 'held' ? TASK : id === PARENT.id || id === 'np' ? PARENT : null);
  return new Proxy({}, {
    get(_t, prop: string) {
      if (prop === 'then') return undefined;
      return async (...args: unknown[]) => {
        if (prop === 'resolveTask') return { task: byId(String(args[0])), ambiguousMatches: [] };
        if (prop === 'getTask') return byId(String(args[0]));
        if (prop === 'getTaskAncestry') return [];
        if (prop === 'getSessionByTaskId') return { id: 's', task_id: TASK.id, git_start_sha: null, ended_at: null };
        if (prop === 'getSessionTurns' || prop === 'getChildTasks') return [];
        if (prop === 'getProjectSettings') return {};
        if (WRITES.test(prop)) { writes.push(prop); return undefined; }
        return null;
      };
    },
  });
}

function aliceInside(): void {
  expect(claimMemberTerminal(TASK.id, ALICE).ok).toBe(true);
  markMemberTerminalEntered(TASK.id, ALICE);
}

afterEach(() => resetMemberTerminalsForTests());

describe('while a member is working in the task', () => {
  test('reparent is not refused for the member: it goes on to repoint the task', async () => {
    aliceInside();
    const writes: string[] = [];
    const spy = spyOn(rpcHandlers, 'getOrCreateStorage').mockResolvedValue(recordingStorage(writes) as never);
    try {
      const err = await reparentTask('/nonexistent-project', { taskId: 'held', parent: 'np' } as never).then(() => null, (e: unknown) => e);
      // Whatever ends it in this fake store, it is not a refusal naming her.
      expect(err === null || !(err as Error).message.includes(ALICE)).toBe(true);
      expect(writes).toContain('updateTaskTarget');
    } finally {
      spy.mockRestore();
    }
  });

  for (const [name, run] of [
    ['redo', () => redoTask('/nonexistent-project', { taskId: 'held', reason: 'try again' } as never)],
  ] as const) {
    test(`${name} is refused with a 409 naming them, and writes nothing`, async () => {
      aliceInside();
      const writes: string[] = [];
      const spy = spyOn(rpcHandlers, 'getOrCreateStorage').mockResolvedValue(recordingStorage(writes) as never);
      try {
        const err = await run().then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(rpcHandlers.RpcError);
        expect((err as { status: number }).status).toBe(409);
        expect((err as Error).message).toContain(ALICE);
        expect(writes).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    });
  }
});
