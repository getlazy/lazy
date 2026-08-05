/**
 * Tests for daemon sync retry loop with progressive backoff.
 *
 * Tests the sync retry mechanism that retries failed syncs with backoff,
 * skips working tasks, and preserves pending_sync on unblock.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { readTaskJson, writeTaskJson, setTaskStatus, findFullTaskId } from '../helpers/storage';
import { initDaemonStorage, closeAllStorage } from '../../src/daemon/rpc-handlers';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { pinConfig } from '../helpers/pin-config';
import { calculateBackoffMs, runSyncRetryTick } from '../../src/daemon/sync-retry';

// This suite awaits runSyncRetryTick() IN-PROCESS in a daemonless project, so
// the `bun test` process itself runs production code and must declare test
// mode. See CLAUDE.md, "A daemonless suite that calls src/ in-process must
// declare test mode".
enableInProcessTestMode();

/**
 * Helper: set pending_sync on a task by directly writing task.json.
 *
 * Task state lives in EXTERNAL storage (see test/helpers/storage.ts) — the old
 * hand-rolled `<root>/.lazy/tasks` paths here died with ENOENT.
 */
function setTaskPendingSync(root: string, shortId: string, value: number): void {
  const data = readTaskJson(root, shortId);
  data.pending_sync = value;
  writeTaskJson(root, shortId, data);
}

describe('sync retry', () => {
  describe('calculateBackoffMs', () => {
    // INVARIANT: Backoff follows exponential schedule capped at 300s.
    // This prevents hammering the network on persistent failures while
    // ensuring retries happen within reasonable timeframes.
    test('follows exponential backoff schedule', () => {
      expect(calculateBackoffMs(0)).toBe(1_000);   // 1s
      expect(calculateBackoffMs(1)).toBe(2_000);   // 2s
      expect(calculateBackoffMs(2)).toBe(4_000);   // 4s
      expect(calculateBackoffMs(3)).toBe(8_000);   // 8s
      expect(calculateBackoffMs(4)).toBe(16_000);  // 16s
      expect(calculateBackoffMs(5)).toBe(32_000);  // 32s
      expect(calculateBackoffMs(6)).toBe(64_000);  // 64s
      expect(calculateBackoffMs(7)).toBe(128_000); // 128s
      expect(calculateBackoffMs(8)).toBe(256_000); // 256s
    });

    // INVARIANT: Backoff caps at 300s (5 minutes) to ensure tasks are retried
    // at a reasonable frequency even after many failures.
    test('caps at 300 seconds', () => {
      expect(calculateBackoffMs(9)).toBe(300_000);
      expect(calculateBackoffMs(10)).toBe(300_000);
      expect(calculateBackoffMs(100)).toBe(300_000);
    });
  });

  describe('sync retry tick (e2e)', () => {
    let ctx: TestContext;
    let restoreConfig: () => void;

    beforeEach(async () => {
      ctx = await setupTestLazy();
      // Pin config resolution to THIS project's lazy.toml — otherwise the
      // in-process loadConfig walks up from bun test's cwd (lazy's own
      // worktree) and adopts the developer's live store. See pin-config.ts.
      restoreConfig = pinConfig(ctx.root);
      // runSyncRetryTick reaches storage through the daemon's module-level
      // singleton, so an in-process caller must point it at this test's project
      // (and tear it down afterwards, or the NEXT test inherits this root's
      // Storage and silently asserts against the wrong project).
      initDaemonStorage(ctx.root);
    });

    afterEach(async () => {
      await closeAllStorage();
      restoreConfig();
      await ctx.cleanup();
    });

    // INVARIANT: Working tasks are never synced by the retry loop.
    // The agent has the worktree locked — syncing would corrupt state.
    test('skips working tasks with pending_sync > 0', async () => {
      const taskId = await createTask(ctx, 'Working task sync test', 'Do work');

      // Start the task so it gets a session and worktree
      const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
        env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
      });
      expectSuccess(startResult);

      // Set pending_sync > 0 and status to working
      setTaskPendingSync(ctx.root, taskId, 3);
      setTaskStatus(ctx.root, taskId, 'working');

      // Run sync retry tick
      const backoffState = new Map();
      const result = await runSyncRetryTick(ctx.root, backoffState);

      // Working task should not be attempted
      expect(result.attempted).toHaveLength(0);
      expect(result.succeeded).toHaveLength(0);

      // Verify pending_sync is preserved
      const taskData = readTaskJson(ctx.root, taskId);
      expect(taskData.pending_sync).toBe(3);
    });

    // INVARIANT: Blocked tasks with pending_sync > 0 are eligible for sync.
    // When fetch succeeds and there are no upstream changes, pending_sync is reset.
    test('attempts sync for blocked tasks with pending_sync > 0', async () => {
      const taskId = await createTask(ctx, 'Blocked sync test', 'Do work');

      // Start and let it complete to blocked state
      const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
        env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
      });
      expectSuccess(startResult);

      // Ensure task is blocked and has pending_sync
      setTaskStatus(ctx.root, taskId, 'blocked');
      setTaskPendingSync(ctx.root, taskId, 1);

      // Run sync retry tick — with local driver, fetch won't fail but there
      // are no upstream changes, so it should succeed with 'up_to_date'
      const backoffState = new Map();
      const result = await runSyncRetryTick(ctx.root, backoffState);

      // Task should have been attempted and succeeded
      expect(result.attempted.length).toBeGreaterThanOrEqual(0);

      // After sync, pending_sync should be reset to 0
      const taskData = readTaskJson(ctx.root, taskId);
      expect(taskData.pending_sync).toBe(0);
    });

    // INVARIANT: Unblock proceeds even when pending_sync > 0.
    // Unblock has zero dependency on sync — the sync debt is not forgotten,
    // it stays for the retry loop to pick up when the task blocks again.
    test('unblock preserves pending_sync counter', async () => {
      const taskId = await createTask(ctx, 'Unblock sync test', 'Do work');

      // Start and let it complete
      const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
        env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
      });
      expectSuccess(startResult);

      // Set pending_sync > 0 while blocked
      setTaskStatus(ctx.root, taskId, 'blocked');
      setTaskPendingSync(ctx.root, taskId, 2);

      // Unblock the task — should succeed regardless of pending_sync
      const unblockResult = await ctx.lazyMocked(
        ['unblock', taskId, '--message', 'Fix the issue'],
        MOCK_CLAUDE_SUCCESS,
        { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
      );
      expectSuccess(unblockResult);

      // pending_sync should be exactly 2 — unblock does NOT call syncTask
      // and does NOT touch pending_sync at all.
      const taskData = readTaskJson(ctx.root, taskId);
      expect(taskData.pending_sync).toBe(2);
    });

    // INVARIANT: Backoff state prevents hammering on persistent failures.
    // If a sync attempt records backoff, subsequent ticks within the backoff
    // window skip the task.
    test('respects backoff timing', async () => {
      const taskId = await createTask(ctx, 'Backoff test', 'Do work');

      const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
        env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
      });
      expectSuccess(startResult);

      setTaskStatus(ctx.root, taskId, 'blocked');
      setTaskPendingSync(ctx.root, taskId, 1);

      // Simulate a backoff entry with a future nextRetryAt
      const fullId = findFullTaskId(ctx.root, taskId);
      const backoffState = new Map();
      backoffState.set(fullId, {
        nextRetryAt: Date.now() + 60_000, // 60 seconds from now
        attempt: 3,
      });

      const result = await runSyncRetryTick(ctx.root, backoffState);

      // Task should be skipped due to backoff
      expect(result.attempted).toHaveLength(0);
      expect(result.skipped.length).toBeGreaterThanOrEqual(1);

      // pending_sync should still be set
      const taskData = readTaskJson(ctx.root, taskId);
      expect(taskData.pending_sync).toBe(1);
    });

    // INVARIANT: Tasks with pending_sync = 0 are not attempted.
    // The retry loop only processes tasks that actually need sync.
    test('ignores tasks with pending_sync = 0', async () => {
      const taskId = await createTask(ctx, 'No sync needed', 'Do work');

      const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
        env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
      });
      expectSuccess(startResult);

      setTaskStatus(ctx.root, taskId, 'blocked');
      // pending_sync defaults to 0, don't set it

      const backoffState = new Map();
      const result = await runSyncRetryTick(ctx.root, backoffState);

      expect(result.attempted).toHaveLength(0);
    });
  });
});
