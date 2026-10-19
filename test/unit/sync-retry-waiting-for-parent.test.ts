/**
 * INVARIANT: the sync retry loop treats a task whose parent has not started as
 * WAITING. It checks locally before calling sync — no fetch, no attempt, debug
 * logging only — instead of re-running a full sync (with an origin fetch) on
 * every 5-second tick for as long as the parent sits in the backlog. And a sync
 * queued because its upstream branch is not on the remote is recorded as
 * exactly that, never as a failed fetch.
 */

import { describe, test, expect, spyOn } from 'bun:test';
import { tmpdir } from 'os';
import * as rpcHandlers from '../../src/daemon/rpc-handlers';
import * as lifecycle from '../../src/daemon/task-lifecycle';
import { runSyncRetryTick } from '../../src/daemon/sync-retry';

const PARENT = { id: 'parent-0000-uuid', status: 'backlog', pending_sync: 0, metadata: { task_ref: 'never-started-parent' }, target: { kind: 'branch', branch: 'main' } };
const CHILD = { id: 'child-00000-uuid', status: 'blocked', pending_sync: 1, metadata: {}, target: { kind: 'task', parentTaskId: PARENT.id } };

describe('the sync retry loop and an unstarted parent', () => {
  test('skips the child without syncing or backing off', async () => {
    const storageSpy = spyOn(rpcHandlers, 'getOrCreateStorage').mockResolvedValue({
      listTasksWithOptions: async () => [CHILD],
      getTask: async (id: string) => (id === PARENT.id ? PARENT : null),
    } as never);
    const syncSpy = spyOn(lifecycle, 'syncTask').mockImplementation(async () => { throw new Error('sync must not be called'); });
    try {
      const backoff = new Map();
      for (let tick = 0; tick < 3; tick++) {
        // A directory that is not a repository: the parent's branch cannot exist.
        const r = await runSyncRetryTick(tmpdir(), backoff);
        expect(r.attempted).toEqual([]);
        expect(r.backedOff).toEqual([]);
        expect(r.skipped).toEqual([CHILD.id.substring(0, 8)]);
      }
      expect(syncSpy).not.toHaveBeenCalled();
      expect(backoff.get(CHILD.id)?.reason).toBe('waiting-for-parent');
      expect(backoff.get(CHILD.id)?.nextRetryAt).toBe(0);
    } finally {
      storageSpy.mockRestore();
      syncSpy.mockRestore();
    }
  });

  test('a missing upstream branch is recorded as missing, not as a failed fetch', async () => {
    const topLevel = { ...CHILD, target: { kind: 'branch', branch: 'main' } };
    const storageSpy = spyOn(rpcHandlers, 'getOrCreateStorage').mockResolvedValue({
      listTasksWithOptions: async () => [topLevel],
      getTask: async () => null,
    } as never);
    const syncSpy = spyOn(lifecycle, 'syncTask').mockResolvedValue({
      taskId: CHILD.id, displayId: 'c', status: 'pending_sync', message: 'Branch x does not exist on origin.', warnings: [], remoteBranchMissing: true,
    });
    try {
      const backoff = new Map();
      await runSyncRetryTick(tmpdir(), backoff);
      expect(backoff.get(CHILD.id)?.reason).toBe('branch-missing');
    } finally {
      storageSpy.mockRestore();
      syncSpy.mockRestore();
    }
  });
});
