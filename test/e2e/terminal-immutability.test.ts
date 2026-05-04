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

  // --- abandonTask rejects already-abandoned tasks ---

  test('cannot abandon an already-abandoned task', async () => {
    const taskId = await createTask(ctx, 'Abandon once');
    await ctx.lazy(['abandon', taskId, '--reason', 'First abandon']);

    const result = await ctx.lazy(['abandon', taskId, '--reason', 'Second abandon']);
    expectFailure(result);
    expectError(result, 'already abandoned');
  });

  test('cannot abandon a completed task', async () => {
    const taskId = await createTask(ctx, 'Accept then abandon', 'Do the work');

    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    await ctx.lazy(['accept', taskId]);

    const result = await ctx.lazy(['abandon', taskId, '--reason', 'Try to abandon completed']);
    expectFailure(result);
    expectError(result, 'already complete');
  });

  // --- metadata and comments still work on abandoned tasks ---

  test('can add comment to abandoned task', async () => {
    const taskId = await createTask(ctx, 'Abandoned with comment');
    await ctx.lazy(['abandon', taskId, '--reason', 'Done']);

    const result = await ctx.lazy(['comment', taskId, '--message', 'Annotation on abandoned task']);
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

  test('cannot edit goal of abandoned task', async () => {
    const taskId = await createTask(ctx, 'Edit abandoned goal');
    await ctx.lazy(['abandon', taskId, '--reason', 'Done']);

    const result = await ctx.lazy(['edit', taskId, '--goal', 'New goal']);
    expectFailure(result);
    expectError(result, 'already abandoned');
  });

  // --- abandon reason is preserved (first abandon wins) ---

  test('abandon reason from first abandon is preserved', async () => {
    const taskId = await createTask(ctx, 'Preserve abandon reason');
    await ctx.lazy(['abandon', taskId, '--reason', 'Original reason']);

    // Second abandon attempt fails
    await ctx.lazy(['abandon', taskId, '--reason', 'Overwrite attempt']);

    // Verify original reason persists
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'Original reason');
  });
});
