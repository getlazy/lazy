/**
 * A held sync whose attempt THROWS on every tick.
 *
 * The retry loop catches the throw and tries again next tick, which is right;
 * but it used to remember nothing, so `lazy daemon health` read the task as
 * "due on the next retry tick" — OK — while it had been failing for hours. The
 * loop now records each task's consecutive throws and the last error, and the
 * Held syncs row warns on it.
 */

import { describe, test, expect, spyOn } from 'bun:test';
import * as rpcHandlers from '../../src/daemon/rpc-handlers';
import * as lifecycle from '../../src/daemon/task-lifecycle';
import { runSyncRetryTick, type SyncFailureEntry } from '../../src/daemon/sync-retry';
import { describeHeldSync } from '../../src/daemon/daemon-health';
import { buildHeldSyncsRow } from '../../src/daemon/daemon-health-rows';
import type { Task } from '../../src/types';

const TASK = { id: 'throw-task-0000-uuid', code: 'throwing-sync', status: 'blocked', pending_sync: 1, metadata: {}, target: { kind: 'branch', branch: 'main' } };

describe('a held sync that keeps throwing', () => {
  // INVARIANT: a sync that fails on every tick is never reported OK.
  test('is recorded by the retry loop and warns in the Held syncs row', async () => {
    const storageSpy = spyOn(rpcHandlers, 'getOrCreateStorage').mockResolvedValue({
      listTasksWithOptions: async () => [TASK],
    } as never);
    let fail = true;
    const syncSpy = spyOn(lifecycle, 'syncTask').mockImplementation(async () => {
      if (fail) throw new Error('fatal: could not read from remote repository\nmore detail');
      return { taskId: TASK.id, displayId: 'throwing-sync', status: 'up_to_date', message: 'ok', warnings: [] };
    });
    try {
      const backoff = new Map();
      const failures = new Map<string, SyncFailureEntry>();
      for (let tick = 0; tick < 3; tick++) await runSyncRetryTick('/p', backoff, failures);

      const entry = failures.get(TASK.id)!;
      expect(entry.failures).toBe(3);
      expect(entry.lastError).toContain('could not read from remote repository');

      const held = describeHeldSync(TASK as unknown as Task, backoff.get(TASK.id), Date.now(), entry);
      const row = buildHeldSyncsRow([held]);
      expect(row.state).toBe('warn');
      expect(row.reason).toContain('could not read from remote repository');
      expect(row.reason).not.toContain('more detail');

      // A sync that goes through again clears the record.
      fail = false;
      await runSyncRetryTick('/p', backoff, failures);
      expect(failures.has(TASK.id)).toBe(false);
    } finally {
      storageSpy.mockRestore();
      syncSpy.mockRestore();
    }
  });
});
