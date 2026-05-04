import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, expectFailure, expectError } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/**
 * Helper: create a task, start it, make a commit in the worktree so accept has something to merge.
 */
async function createStartedTaskWithCommit(ctx: TestContext, goal: string): Promise<string> {
  const taskId = await createTask(ctx, goal, 'Some work');

  const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
    env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
  });
  expectSuccess(startResult);

  // Add a non-conflicting file in the worktree
  const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
  writeFileSync(join(worktreePath, 'feature.txt'), 'feature content\n');

  const gitAdd = ctx.git('-C', worktreePath, 'add', 'feature.txt');
  expect(gitAdd.exitCode).toBe(0);

  const gitCommit = ctx.git('-C', worktreePath, 'commit', '-m', 'Add feature');
  expect(gitCommit.exitCode).toBe(0);

  return taskId;
}

describe('lazy accept idempotent transitions', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: Idempotent state transitions (complete → complete) are a no-op, not an error.
  // This allows retry logic to safely re-run accept after partial failures without failing
  // on "already in terminal state" errors.
  test('accept twice succeeds (idempotent complete → complete)', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Idempotent accept test');

    // First accept
    const firstAccept = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(firstAccept);
    expectOutput(firstAccept, 'accepted');

    // Verify task is complete
    const showAfterFirst = await ctx.lazy(['show', taskId]);
    expectSuccess(showAfterFirst);
    expectOutput(showAfterFirst, 'complete');

    // Second accept (should be idempotent - no error)
    const secondAccept = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(secondAccept);

    // Verify task is still complete
    const showAfterSecond = await ctx.lazy(['show', taskId]);
    expectSuccess(showAfterSecond);
    expectOutput(showAfterSecond, 'complete');
  });

  test('reject twice succeeds (idempotent abandoned → abandoned)', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Idempotent reject test');

    // First reject
    const firstReject = await ctx.lazy(['reject', taskId, '--reason', 'First rejection']);
    expectSuccess(firstReject);

    // Verify task is abandoned
    const showAfterFirst = await ctx.lazy(['show', taskId]);
    expectSuccess(showAfterFirst);
    expectOutput(showAfterFirst, 'abandoned');

    // Second reject (should be idempotent - no error)
    const secondReject = await ctx.lazy(['reject', taskId, '--reason', 'Second rejection']);
    expectSuccess(secondReject);

    // Verify task is still abandoned
    const showAfterSecond = await ctx.lazy(['show', taskId]);
    expectSuccess(showAfterSecond);
    expectOutput(showAfterSecond, 'abandoned');
  });

  test('abandon twice fails (not idempotent)', async () => {
    const taskId = await createTask(ctx, 'Double abandon test');

    // First abandon
    const firstAbandon = await ctx.lazy(['abandon', taskId, '--reason', 'First abandon']);
    expectSuccess(firstAbandon);

    // Verify task is abandoned
    const showAfterFirst = await ctx.lazy(['show', taskId]);
    expectSuccess(showAfterFirst);
    expectOutput(showAfterFirst, 'abandoned');

    // Second abandon should fail (already abandoned)
    const secondAbandon = await ctx.lazy(['abandon', taskId, '--reason', 'Second abandon']);
    expectFailure(secondAbandon);
    expectError(secondAbandon, 'already abandoned');
  });

  test('transitioning from terminal to different terminal state fails', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Terminal transition test');

    // Accept the task (sets to complete)
    const acceptResult = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(acceptResult);

    // Verify task is complete
    const showAfterAccept = await ctx.lazy(['show', taskId]);
    expectSuccess(showAfterAccept);
    expectOutput(showAfterAccept, 'complete');

    // Try to reject it (complete → abandoned should fail)
    const rejectResult = await ctx.lazy(['reject', taskId, '--reason', 'Trying to reject']);
    expectFailure(rejectResult);
    expectError(rejectResult, 'terminal state');
  });

  test('reopening a terminal task and accepting again works', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Reopen and accept test');

    // Accept the task
    const acceptResult = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(acceptResult);

    // Reopen the task
    const reopenResult = await ctx.lazy(['reopen', taskId]);
    expectSuccess(reopenResult);

    // Verify task is blocked (reopened with session)
    const showAfterReopen = await ctx.lazy(['show', taskId]);
    expectSuccess(showAfterReopen);
    expectOutput(showAfterReopen, 'blocked');

    // Accept again (should work - not terminal anymore)
    const secondAccept = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(secondAccept);

    // Verify task is complete again
    const showAfterSecondAccept = await ctx.lazy(['show', taskId]);
    expectSuccess(showAfterSecondAccept);
    expectOutput(showAfterSecondAccept, 'complete');
  });
});
