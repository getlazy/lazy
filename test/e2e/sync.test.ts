/**
 * E2E tests for `lazy sync`.
 *
 * NOTE ON SCOPE: global `lazy sync` (fetch PR comments, check CI, export
 * branches, post artifacts) no longer exists as a CLI command — it moved into
 * the daemon's reconcile loop (src/daemon/remote-sync.ts). The only remaining
 * CLI surface is `lazy sync <task_id>`: merge upstream into ONE task's
 * worktree. These tests cover that surface plus the guidance the bare command
 * now prints. Retry/backoff behavior lives in sync-retry.test.ts.
 */

import { describe, test, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask, startAndReconcile } from '../helpers/fixtures';
import { setTaskStatus } from '../helpers/storage';

describe('lazy sync', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('bare `lazy sync` points at the daemon and the per-task form', async () => {
    const result = await ctx.lazy(['sync']);
    expectFailure(result);
    expectError(result, 'Global sync is now handled automatically by the daemon.');
    expectError(result, 'lazy sync <task_id>');
    expectError(result, 'lazy daemon start');
  });

  test('sync shows help', async () => {
    const result = await ctx.lazy(['sync', '--help']);
    expectSuccess(result);
    expectOutput(result, 'Usage: lazy sync <task_id>');
    expectOutput(result, "Merge upstream changes into a task's worktree by task ID.");
    expectOutput(result, 'Task must be blocked/conflict/interrupted (not working)');
    expectOutput(result, 'Global remote sync');
  });

  test('sync rejects an unknown task', async () => {
    const result = await ctx.lazy(['sync', 'deadbeef']);
    expectFailure(result);
    expectError(result, 'Task not found: deadbeef');
  });

  test('sync rejects a task that was never started', async () => {
    const taskId = await createTask(ctx, 'Never started', 'Do work');

    const result = await ctx.lazy(['sync', taskId]);
    expectFailure(result);
    expectError(result, 'has no session');
    expectError(result, `lazy start ${taskId}`);
  });

  test('sync refuses to run while the agent is working', async () => {
    const taskId = await createTask(ctx, 'Working task', 'Do work');
    await startAndReconcile(ctx, taskId);

    // Put the task back into `working` — the state sync must refuse, because
    // merging upstream under a running agent would rewrite its worktree.
    setTaskStatus(ctx.root, taskId, 'working');

    const result = await ctx.lazy(['sync', taskId]);
    expectFailure(result);
    expectError(result, 'is currently working');
    expectError(result, 'Cannot sync while agent is running');
  });

  test('sync reports a blocked task with no upstream changes as up to date', async () => {
    const taskId = await createTask(ctx, 'Up to date task', 'Do work');
    await startAndReconcile(ctx, taskId);

    const result = await ctx.lazy(['sync', taskId]);
    expectSuccess(result);
    expectOutput(result, 'Already up to date.');
  });
});
