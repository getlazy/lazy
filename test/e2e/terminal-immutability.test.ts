import { describe, test, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask, disablePreAccept, startAndAccept, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

describe('terminal task immutability', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    // Daemonless suite: nothing here can execute the pre-accept agent turn.
    disablePreAccept(ctx.root);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // --- abandonTask rejects already-abandoned tasks ---

  test('cannot abandon an already-abandoned task', async () => {
    const taskId = await createTask(ctx, 'Abandon once');
    await ctx.lazyMocked(['close', taskId, '--reason', 'First abandon'], MOCK_CLAUDE_SUCCESS);

    const result = await ctx.lazyMocked(['close', taskId, '--reason', 'Second abandon'], MOCK_CLAUDE_SUCCESS);
    expectFailure(result);
    expectError(result, 'already abandoned');
  });

  test('cannot abandon a completed task', async () => {
    const taskId = await createTask(ctx, 'Accept then abandon', 'Do the work');

    await startAndAccept(ctx, taskId);

    const result = await ctx.lazyMocked(['close', taskId, '--reason', 'Try to abandon completed'], MOCK_CLAUDE_SUCCESS);
    expectFailure(result);
    expectError(result, 'already complete');
  });

  // --- metadata and comments still work on abandoned tasks ---

  test('can add comment to abandoned task', async () => {
    const taskId = await createTask(ctx, 'Abandoned with comment');
    await ctx.lazyMocked(['close', taskId, '--reason', 'Done'], MOCK_CLAUDE_SUCCESS);

    const result = await ctx.lazy(['comment', taskId, '--message', 'Annotation on abandoned task']);
    expectSuccess(result);
  });

  test('can add comment to completed task', async () => {
    const taskId = await createTask(ctx, 'Completed with comment', 'Do the work');

    await startAndAccept(ctx, taskId);

    const result = await ctx.lazy(['comment', taskId, '--message', 'Annotation on completed task']);
    expectSuccess(result);
  });

  // --- edit blocked on terminal tasks ---

  test('cannot edit goal of abandoned task', async () => {
    const taskId = await createTask(ctx, 'Edit abandoned goal');
    await ctx.lazyMocked(['close', taskId, '--reason', 'Done'], MOCK_CLAUDE_SUCCESS);

    const result = await ctx.lazy(['edit', taskId, '--goal', 'New goal']);
    expectFailure(result);
    expectError(result, 'already abandoned');
  });

  // --- abandon reason is preserved (first abandon wins) ---

  test('abandon reason from first abandon is preserved', async () => {
    const taskId = await createTask(ctx, 'Preserve abandon reason');
    await ctx.lazyMocked(['close', taskId, '--reason', 'Original reason'], MOCK_CLAUDE_SUCCESS);

    // Second abandon attempt fails
    await ctx.lazyMocked(['close', taskId, '--reason', 'Overwrite attempt'], MOCK_CLAUDE_SUCCESS);

    // Verify original reason persists
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'Original reason');
  });
});
