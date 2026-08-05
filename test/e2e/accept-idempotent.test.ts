import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, expectFailure, expectError } from '../helpers/assertions';
import { createTask, disablePreAccept, startAndReconcile } from '../helpers/fixtures';
import { worktreePathFor } from '../helpers/storage';

/**
 * Helper: create a task, start it, make a commit in the worktree so accept has something to merge.
 */
async function createStartedTaskWithCommit(ctx: TestContext, goal: string): Promise<string> {
  const taskId = await createTask(ctx, goal, 'Some work');

  // Drive the reconcile pass too — accept refuses a task that is still
  // 'working', and only a reconcile (daemon or explicit) moves it to 'blocked'.
  await startAndReconcile(ctx, taskId);

  // Add a non-conflicting file in the worktree
  const worktreePath = worktreePathFor(ctx.root, taskId);
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
    // Daemonless suite: no runner exists to execute the pre-accept agent turn,
    // and these tests assert on transition idempotence, not on pre-accept.
    disablePreAccept(ctx.root);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: a second accept on an already-accepted task is a HARD, ACTIONABLE
  // error — not a silent no-op. The merge already landed; pretending otherwise
  // hides whether the second caller's work was included. This replaces an older
  // "accept twice is idempotent" assertion: the double-call UX fix (c376a799)
  // made "call accept on an already-complete task → clear, actionable error, not
  // 'Invalid status transition'" an explicit requirement, and
  // test/unit/accept-concurrent-race.test.ts encodes the same rule for the
  // concurrent case.
  test('accept twice fails with an actionable already-accepted error', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Idempotent accept test');

    // First accept
    const firstAccept = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(firstAccept);
    expectOutput(firstAccept, 'accepted');

    // Verify task is complete
    const showAfterFirst = await ctx.lazy(['show', taskId]);
    expectSuccess(showAfterFirst);
    expectOutput(showAfterFirst, 'complete');

    // Second accept reports what actually happened and what to do next. The
    // accepted worktree/branch are gone by now, so this also pins the check
    // ORDER: the outcome check must beat worktree recovery, or the user gets an
    // unrelated "branch not found on remote" after three fetch retries.
    const secondAccept = await ctx.lazy(['accept', taskId, '--yes']);
    expectFailure(secondAccept);
    expectError(secondAccept, 'was already accepted');
    expectError(secondAccept, `lazy reopen ${taskId}`);

    // Verify task is still complete
    const showAfterSecond = await ctx.lazy(['show', taskId]);
    expectSuccess(showAfterSecond);
    expectOutput(showAfterSecond, 'complete');
  });

  test('reject twice succeeds (idempotent abandoned → abandoned)', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Idempotent reject test');

    // First reject
    const firstReject = await ctx.lazy(['reject', taskId, '--reason', 'First rejection', '--yes']);
    expectSuccess(firstReject);

    // Verify task is abandoned
    const showAfterFirst = await ctx.lazy(['show', taskId]);
    expectSuccess(showAfterFirst);
    expectOutput(showAfterFirst, 'abandoned');

    // Second reject (should be idempotent - no error)
    const secondReject = await ctx.lazy(['reject', taskId, '--reason', 'Second rejection', '--yes']);
    expectSuccess(secondReject);

    // Verify task is still abandoned
    const showAfterSecond = await ctx.lazy(['show', taskId]);
    expectSuccess(showAfterSecond);
    expectOutput(showAfterSecond, 'abandoned');
  });

  // `lazy abandon` was removed; `lazy close` is its direct successor (same
  // --reason contract, same 'abandoned' terminal status).
  test('close twice fails (not idempotent)', async () => {
    const taskId = await createTask(ctx, 'Double close test');

    // First close
    const firstClose = await ctx.lazy(['close', taskId, '--reason', 'First close']);
    expectSuccess(firstClose);

    // Verify task is abandoned
    const showAfterFirst = await ctx.lazy(['show', taskId]);
    expectSuccess(showAfterFirst);
    expectOutput(showAfterFirst, 'abandoned');

    // Second close should fail (already abandoned)
    const secondClose = await ctx.lazy(['close', taskId, '--reason', 'Second close']);
    expectFailure(secondClose);
    expectError(secondClose, 'already abandoned');
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

    // Try to reject it (complete → abandoned should fail). The gate is the
    // session outcome, so the error names it: the session ended as 'accepted'.
    const rejectResult = await ctx.lazy(['reject', taskId, '--reason', 'Trying to reject', '--yes']);
    expectFailure(rejectResult);
    expectError(rejectResult, 'Session already ended (accepted)');
  });

  test('reopening a terminal task and accepting again works', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Reopen and accept test');

    // Accept the task
    const acceptResult = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(acceptResult);

    // Reopen the task. Reopening a *complete* task demands a reason (it undoes
    // a landed merge), so pass it non-interactively.
    const reopenResult = await ctx.lazy(['reopen', taskId, '--reason', 'More work needed']);
    expectSuccess(reopenResult);

    // Verify task is blocked (reopened with session)
    const showAfterReopen = await ctx.lazy(['show', taskId]);
    expectSuccess(showAfterReopen);
    expectOutput(showAfterReopen, 'blocked');

    // The first accept merged everything the branch had, so the reopened branch
    // is identical to main and accept would (correctly) refuse with "Nothing to
    // merge". Commit follow-up work — that is the whole point of reopening.
    const worktreePath = worktreePathFor(ctx.root, taskId);
    writeFileSync(join(worktreePath, 'followup.txt'), 'follow-up content\n');
    expect(ctx.git('-C', worktreePath, 'add', 'followup.txt').exitCode).toBe(0);
    expect(ctx.git('-C', worktreePath, 'commit', '-m', 'Add follow-up').exitCode).toBe(0);

    // Accept again (should work - not terminal anymore)
    const secondAccept = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(secondAccept);

    // Verify task is complete again
    const showAfterSecondAccept = await ctx.lazy(['show', taskId]);
    expectSuccess(showAfterSecondAccept);
    expectOutput(showAfterSecondAccept, 'complete');
  });
});
