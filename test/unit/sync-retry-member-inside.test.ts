/**
 * INVARIANT (engineer, 2026-10-21, replacing "a member-held task is skipped"):
 * the sync retry loop does not wait for a member. A member with sessions open
 * in a task never holds its sync off — a sync merges into the worktree the way
 * a turn does, and turns never wait for a member either. The loop tries the
 * task on the same tick, exactly as it would with nobody inside.
 */

import { test, expect, afterEach, spyOn } from 'bun:test';
import * as rpcHandlers from '../../src/daemon/rpc-handlers';
import * as lifecycle from '../../src/daemon/task-lifecycle';
import { runSyncRetryTick } from '../../src/daemon/sync-retry';
import { claimMemberTerminal, markMemberTerminalEntered, resetMemberTerminalsForTests } from '../../src/server/member-terminals';

const TASK = { id: 'held-task-0000-uuid', status: 'blocked', pending_sync: 1, metadata: {}, target: { kind: 'branch', branch: 'main' } };

afterEach(() => resetMemberTerminalsForTests());

test('a task with a member inside is synced like any other', async () => {
  expect(claimMemberTerminal(TASK.id, 'alice@example.com').ok).toBe(true);
  markMemberTerminalEntered(TASK.id, 'alice@example.com');
  const storageSpy = spyOn(rpcHandlers, 'getOrCreateStorage').mockResolvedValue({
    listTasksWithOptions: async () => [TASK],
    incrementTaskPendingSync: async () => {},
  } as never);
  const syncSpy = spyOn(lifecycle, 'syncTask').mockResolvedValue({
    taskId: TASK.id, displayId: 'held', status: 'up_to_date', message: 'ok', warnings: [],
  });
  try {
    const r = await runSyncRetryTick('/p', new Map());
    expect(r.attempted).toEqual([TASK.id.substring(0, 8)]);
    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect('heldByMember' in r).toBe(false);
  } finally {
    storageSpy.mockRestore();
    syncSpy.mockRestore();
  }
});
