/**
 * INVARIANT: reparent and redo refuse (409, naming the member) while a member
 * is working in the task's files, and they refuse BEFORE they write anything.
 * Reparent's sync merges the new parent into those files and redo's close
 * tears them down, and both of those refuse while a member is inside — so a
 * repoint or a replacement task written ahead of that refusal was left behind:
 * a task pointing at a parent it was never synced with, or a stray duplicate
 * of the task being redone.
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
  for (const [name, run] of [
    ['reparent', () => reparentTask('/nonexistent-project', { taskId: 'held', parent: 'np' } as never)],
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
