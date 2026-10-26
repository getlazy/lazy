/**
 * INVARIANT (engineer, 2026-10-21, replacing "accepting a child is refused
 * while a member works in its parent"): a child's accept into a parent with a
 * member's sessions open is NOT refused and does not wait — the merge may
 * change or delete files under their sessions, exactly as a turn can — and the
 * parent says so afterwards, naming the member. Warning, not waiting, is the
 * engineer's sanctioned choice for a merge into a live session
 * (docs/design/task-sessions-and-ssh.md §1).
 */

import { describe, test, expect, afterEach, spyOn } from 'bun:test';
import * as rpcHandlers from '../../src/daemon/rpc-handlers';
import { acceptTask, warnMemberDuringChildMerge } from '../../src/daemon/task-lifecycle';
import { enterTaskAsMember } from '../../src/daemon/member-entry';
import { claimMemberTerminal, resetMemberTerminalsForTests } from '../../src/server/member-terminals';

const ALICE = 'alice@example.com';
const PARENT = 'parent-task-0000-uuid';
const CHILD = 'child-task-0000-uuid';

afterEach(() => resetMemberTerminalsForTests());

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
  });
  expect(entered.ok).toBe(true);
}

describe("accepting a child while a member works in its parent", () => {
  test('is not refused: the accept goes on past the member', async () => {
    await aliceInsideParent();
    const calls: string[] = [];
    const child = { id: CHILD, status: 'blocked', target: { kind: 'task', parentTaskId: PARENT } };
    const spy = spyOn(rpcHandlers, 'getOrCreateStorage').mockResolvedValue(new Proxy({}, {
      get(_t, prop: string) {
        if (prop === 'then') return undefined;
        return async () => {
          calls.push(prop);
          if (prop === 'resolveTask' && calls.length === 1) return { task: child };
          throw new Error('stop the accept here');
        };
      },
    }) as never);
    try {
      const err = await acceptTask('/p', { taskId: CHILD, reason: 'ship it', actor: 'human' } as never).then(() => null, (e: unknown) => e);
      // Whatever stopped it, it was not a member refusal.
      expect((err as Error).message).toBe('stop the accept here');
      expect(calls.length).toBeGreaterThan(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('after the merge, the parent says who had sessions open', async () => {
    await aliceInsideParent();
    const comments: Array<{ task: string; content: string; actor: unknown }> = [];
    const storage = { createComment: async (task: string, content: string, actor: unknown) => { comments.push({ task, content, actor }); return {} as never; } };
    expect(await warnMemberDuringChildMerge(storage as never, PARENT, null, 'child-code')).toBe(true);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.task).toBe(PARENT);
    expect(comments[0]!.content).toContain(ALICE);
    expect(comments[0]!.content).toContain('child-code');
    expect(comments[0]!.actor).toBe('system');
  });

  test('says nothing when nobody was inside', async () => {
    const comments: string[] = [];
    const storage = { createComment: async (_t: string, content: string) => { comments.push(content); return {} as never; } };
    expect(await warnMemberDuringChildMerge(storage as never, PARENT, null, 'child-code')).toBe(false);
    expect(comments).toEqual([]);
  });

  test('a member who left during the merge is still named', async () => {
    const comments: string[] = [];
    const storage = { createComment: async (_t: string, content: string) => { comments.push(content); return {} as never; } };
    expect(await warnMemberDuringChildMerge(storage as never, PARENT, 'bob@example.com', 'child-code')).toBe(true);
    expect(comments[0]).toContain('bob@example.com');
  });
});
