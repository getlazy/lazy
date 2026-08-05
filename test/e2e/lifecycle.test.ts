import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask, disablePreAccept, startAndReconcile } from '../helpers/fixtures';

describe('full task lifecycle', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    // Daemonless suite: no runner exists to execute the pre-accept agent turn,
    // and these tests assert on the merge outcome, not on pre-accept.
    disablePreAccept(ctx.root);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('create -> start -> accept', async () => {
    // 1. Create task
    const taskId = await createTask(ctx, 'Full lifecycle test', 'Implement feature X');

    // 2. Start task (mock Claude making a commit), then drive the reconcile
    //    pass that moves it working → blocked so accept will take it.
    await startAndReconcile(ctx, taskId);

    // 3. Verify worktree exists
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    expect(existsSync(worktreePath)).toBe(true);

    // 4. Accept task (merges to main)
    const acceptResult = await ctx.lazy(['accept', taskId]);
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'accepted and merged');

    // 5. Verify task is complete
    const showResult = await ctx.lazy(['show', taskId]);
    expectOutput(showResult, 'complete');
  });

  test('create -> start -> close with --reason', async () => {
    const taskId = await createTask(ctx, 'Abandon test', 'Try feature Y');

    await startAndReconcile(ctx, taskId);

    // `lazy abandon` was removed; `lazy close` is its successor — same
    // --reason/--yes contract, same resulting 'abandoned' status.
    const closeResult = await ctx.lazy(['close', taskId, '--yes', '--reason', 'Incorrect approach, needs redesign']);
    expectSuccess(closeResult);
    // close reports "closed"; the resulting STATUS is 'abandoned' (asserted below)
    expectOutput(closeResult, 'closed');

    // Verify task is abandoned and reason is stored as a note
    const showResult = await ctx.lazy(['show', taskId]);
    expectOutput(showResult, 'abandoned');
    expectOutput(showResult, 'Incorrect approach, needs redesign');
  });

  test('close without --reason in non-TTY fails', async () => {
    const taskId = await createTask(ctx, 'Abandon no reason', 'Try feature Z');

    await startAndReconcile(ctx, taskId);

    // close without --reason should fail in non-TTY context
    const closeResult = await ctx.lazy(['close', taskId, '--yes']);
    expectFailure(closeResult, 1);
    expectError(closeResult, '--reason is required when using --yes flag');
  });

  test('create -> close (no session)', async () => {
    const taskId = await createTask(ctx, 'Abandon test', 'Something');

    const closeResult = await ctx.lazy(['close', taskId, '--reason', 'No longer needed']);
    expectSuccess(closeResult);
    expectOutput(closeResult, 'closed');

    const showResult = await ctx.lazy(['show', taskId]);
    expectOutput(showResult, 'abandoned');
    expectOutput(showResult, 'No longer needed');
  });

  test('create -> start -> show has session info', async () => {
    const taskId = await createTask(ctx, 'Session detail test', 'Build something');

    await startAndReconcile(ctx, taskId);

    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    // Should show session info
    expectOutput(showResult, 'claude-code');
    // Should show human turn (recorded before container launch)
    expectOutput(showResult, 'Turns:');
  });
});
