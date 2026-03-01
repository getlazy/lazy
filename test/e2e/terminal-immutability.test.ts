import { describe, test, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

describe('terminal task immutability', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // --- closeTask rejects already-closed tasks ---

  test('cannot close a closed task again', async () => {
    const taskId = await createTask(ctx, 'Close once');
    await ctx.lazy(['close', taskId, '--reason', 'First close']);

    const result = await ctx.lazy(['close', taskId, '--reason', 'Second close']);
    expectFailure(result);
    expectError(result, 'already closed');
  });

  test('cannot close a completed task', async () => {
    const taskId = await createTask(ctx, 'Accept then close', 'Do the work');

    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    await ctx.lazy(['accept', taskId]);

    const result = await ctx.lazy(['close', taskId, '--reason', 'Try to close completed']);
    expectFailure(result);
    expectError(result, 'already complete');
  });

  test('cannot close a rejected/abandoned task', async () => {
    const taskId = await createTask(ctx, 'Reject then close', 'Do the work');

    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    await ctx.lazy(['reject', taskId, '--yes', '--reason', 'Not good']);

    const result = await ctx.lazy(['close', taskId, '--reason', 'Try to close rejected']);
    expectFailure(result);
    expectError(result, 'already abandoned');
  });

  // --- metadata and comments still work on closed tasks ---

  test('can add comment to closed task', async () => {
    const taskId = await createTask(ctx, 'Closed with comment');
    await ctx.lazy(['close', taskId, '--reason', 'Done']);

    const result = await ctx.lazy(['comment', taskId, '--message', 'Annotation on closed task']);
    expectSuccess(result);
  });

  test('can add comment to completed task', async () => {
    const taskId = await createTask(ctx, 'Completed with comment', 'Do the work');

    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    await ctx.lazy(['accept', taskId]);

    const result = await ctx.lazy(['comment', taskId, '--message', 'Annotation on completed task']);
    expectSuccess(result);
  });

  // --- edit blocked on terminal tasks ---

  test('cannot edit goal of closed task', async () => {
    const taskId = await createTask(ctx, 'Edit closed goal');
    await ctx.lazy(['close', taskId, '--reason', 'Done']);

    const result = await ctx.lazy(['edit', taskId, '--goal', 'New goal']);
    expectFailure(result);
    expectError(result, 'already closed');
  });

  // --- close reason is preserved (first close wins) ---

  test('close reason from first close is preserved', async () => {
    const taskId = await createTask(ctx, 'Preserve close reason');
    await ctx.lazy(['close', taskId, '--reason', 'Original reason']);

    // Second close attempt fails
    await ctx.lazy(['close', taskId, '--reason', 'Overwrite attempt']);

    // Verify original reason persists
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'Original reason');
  });
});
