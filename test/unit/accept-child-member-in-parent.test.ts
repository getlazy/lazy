/**
 * INVARIANT: accepting a CHILD is refused (409, naming the member) while a
 * member has a terminal open on its PARENT — the task whose worktree the
 * child's merge lands in — and the refusal comes before anything is read,
 * stashed or merged. The check runs under the parent's lifecycle lock, the one
 * a member's entry takes, and members stay out of the parent until the accept
 * has returned. A merge (and its stash of "uncommitted changes") under a
 * member mid-edit would otherwise rewrite their files beneath them.
 */

import { describe, test, expect, afterEach, spyOn } from 'bun:test';
import * as rpcHandlers from '../../src/daemon/rpc-handlers';
import { acceptTask } from '../../src/daemon/task-lifecycle';
import { enterTaskAsMember } from '../../src/daemon/member-entry';
import {
  claimMemberTerminal,
  releaseMemberTerminal,
  memberInsideTask,
  resetMemberTerminalsForTests,
} from '../../src/server/member-terminals';

const ALICE = 'alice@example.com';
const PARENT = 'parent-task-0000-uuid';
const CHILD = 'child-task-0000-uuid';

afterEach(() => resetMemberTerminalsForTests());

/** A store that answers the accept's first question, and records every other. */
function recordingStorage(calls: string[]) {
  const child = { id: CHILD, status: 'blocked', target: { kind: 'task', parentTaskId: PARENT } };
  return new Proxy({}, {
    get(_t, prop: string) {
      if (prop === 'then') return undefined;
      return async (...args: unknown[]) => {
        calls.push(prop);
        if (prop === 'resolveTask') return { task: child };
        throw new Error(`accept went past the refusal: storage.${prop}(${JSON.stringify(args).slice(0, 80)})`);
      };
    },
  });
}

async function aliceInsideParent(): Promise<void> {
  expect(claimMemberTerminal(PARENT, ALICE).ok).toBe(true);
  const entered = await enterTaskAsMember({
    projectRoot: '/p',
    storage: {
      getTask: async () => ({ id: PARENT, status: 'blocked' }) as never,
      getSessionByTaskId: async () => ({ id: 's' }) as never,
      getSessionTurns: async () => [{ sequence: 1 }] as never,
    },
    taskId: PARENT,
    email: ALICE,
    deps: { bindingFor: async () => null, stopTaskContainer: async () => {} },
  });
  expect(entered.ok).toBe(true);
}

describe("accepting a child while a member works in its parent", () => {
  test('is refused with a 409 naming the member, before anything is read past the task itself', async () => {
    await aliceInsideParent();
    const calls: string[] = [];
    const spy = spyOn(rpcHandlers, 'getOrCreateStorage').mockResolvedValue(recordingStorage(calls) as never);
    try {
      const err = await acceptTask('/p', { taskId: CHILD, reason: 'ship it', actor: 'human' } as never).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(rpcHandlers.RpcError);
      expect((err as { status: number }).status).toBe(409);
      expect((err as Error).message).toContain(ALICE);
      expect(calls).toEqual(['resolveTask']);
    } finally {
      spy.mockRestore();
    }
  });

  test('keeps members out of the parent while the accept runs, and lets them back in afterwards', async () => {
    const calls: string[] = [];
    let entryDuring: Awaited<ReturnType<typeof enterTaskAsMember>> | null = null;
    const storage = recordingStorage(calls) as Record<string, unknown>;
    let resolved = 0;
    const spy = spyOn(rpcHandlers, 'getOrCreateStorage').mockResolvedValue(new Proxy(storage, {
      get(t, prop: string) {
        if (prop === 'then') return undefined;
        if (prop === 'resolveTask' && resolved++ === 0) return (t as Record<string, unknown>)[prop];
        {
          // The accept's first read inside the child's lock (past the outer
          // resolve): try to get into the parent right then.
          return async () => {
            expect(claimMemberTerminal(PARENT, ALICE).ok).toBe(true);
            entryDuring = await enterTaskAsMember({
              projectRoot: '/p',
              storage: {
                getTask: async () => ({ id: PARENT, status: 'blocked' }) as never,
                getSessionByTaskId: async () => ({ id: 's' }) as never,
                getSessionTurns: async () => [{ sequence: 1 }] as never,
              },
              taskId: PARENT, email: ALICE,
              deps: { bindingFor: async () => null, stopTaskContainer: async () => {} },
            });
            releaseMemberTerminal(PARENT, ALICE);
            throw new Error('stop the accept here');
          };
        }
      },
    }) as never);
    try {
      await acceptTask('/p', { taskId: CHILD, reason: 'ship it', actor: 'human' } as never).catch(() => {});
      expect(entryDuring).toMatchObject({ ok: false, status: 409 });
      expect(memberInsideTask(PARENT)).toBeNull();
      await aliceInsideParent();
    } finally {
      spy.mockRestore();
    }
  });
});
