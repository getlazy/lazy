/**
 * INVARIANT: the sync retry loop treats a task held by a member's open
 * terminal as WAITING, not failing. It skips it before any fetch, sets no
 * backoff, never bumps the pending-sync counter again, and logs nothing above
 * debug — and a sync that finds a member arrived in between reports
 * `held_by_member`, which is handled the same way. Treated as a fetch failure,
 * a member's hour-long session pushed the task's retry out to the 5-minute
 * backoff ceiling, inflated its counter every tick, and filled the log with
 * "fetch failed" for a fetch that never ran.
 */

import { describe, test, expect, afterEach, spyOn } from 'bun:test';
import * as rpcHandlers from '../../src/daemon/rpc-handlers';
import * as lifecycle from '../../src/daemon/task-lifecycle';
import { runSyncRetryTick } from '../../src/daemon/sync-retry';
import { claimMemberTerminal, markMemberTerminalEntered, resetMemberTerminalsForTests } from '../../src/server/member-terminals';

const TASK = { id: 'held-task-0000-uuid', status: 'blocked', pending_sync: 1, metadata: {}, target: { kind: 'branch', branch: 'main' } };

afterEach(() => resetMemberTerminalsForTests());

function storageRecording(bumps: string[]) {
  return {
    listTasksWithOptions: async () => [TASK],
    incrementTaskPendingSync: async (id: string) => { bumps.push(id); },
  };
}

describe('the sync retry loop and a member-held task', () => {
  test('skips it before trying, with no backoff and no counter bump', async () => {
    expect(claimMemberTerminal(TASK.id, 'alice@example.com').ok).toBe(true);
    markMemberTerminalEntered(TASK.id, 'alice@example.com');
    const bumps: string[] = [];
    const storageSpy = spyOn(rpcHandlers, 'getOrCreateStorage').mockResolvedValue(storageRecording(bumps) as never);
    const syncSpy = spyOn(lifecycle, 'syncTask').mockImplementation(async () => { throw new Error('sync must not be called'); });
    try {
      const backoff = new Map();
      for (let tick = 0; tick < 3; tick++) {
        const r = await runSyncRetryTick('/p', backoff);
        expect(r.heldByMember).toEqual([TASK.id.substring(0, 8)]);
        expect(r.attempted).toEqual([]);
        expect(r.backedOff).toEqual([]);
      }
      expect(syncSpy).not.toHaveBeenCalled();
      expect(backoff.size).toBe(0);
      expect(bumps).toEqual([]);
    } finally {
      storageSpy.mockRestore();
      syncSpy.mockRestore();
    }
  });

  test('a sync that reports held_by_member sets no backoff either', async () => {
    const storageSpy = spyOn(rpcHandlers, 'getOrCreateStorage').mockResolvedValue(storageRecording([]) as never);
    const syncSpy = spyOn(lifecycle, 'syncTask').mockResolvedValue({
      taskId: TASK.id, displayId: 'held', status: 'held_by_member', message: 'held', warnings: [],
    });
    try {
      const backoff = new Map();
      const r = await runSyncRetryTick('/p', backoff);
      expect(r.heldByMember).toEqual([TASK.id.substring(0, 8)]);
      expect(r.backedOff).toEqual([]);
      expect(backoff.size).toBe(0);
    } finally {
      storageSpy.mockRestore();
      syncSpy.mockRestore();
    }
  });
});

// INVARIANT: standing a sync down for a member queues it ONCE. A sync already
// on the counter is not counted again each time it is retried while the
// member stays inside.
test('standing down for a member does not re-count a sync already queued', async () => {
  expect(claimMemberTerminal(TASK.id, 'alice@example.com').ok).toBe(true);
  markMemberTerminalEntered(TASK.id, 'alice@example.com');
  const bumps: string[] = [];
  const storage = { incrementTaskPendingSync: async (id: string) => { bumps.push(id); } };
  expect(await lifecycle.standDownForMember(storage, { id: TASK.id, pending_sync: 2 }, { queueIfMemberInside: true })).toBe('alice@example.com');
  expect(bumps).toEqual([]);
  expect(await lifecycle.standDownForMember(storage, { id: TASK.id, pending_sync: 0 }, { queueIfMemberInside: true })).toBe('alice@example.com');
  expect(bumps).toEqual([TASK.id]);
});
