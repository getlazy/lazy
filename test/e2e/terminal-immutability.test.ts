import { describe, test, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask, disablePreAccept, startAndAccept } from '../helpers/fixtures';

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
    await ctx.lazy(['close', taskId, '--reason', 'First abandon']);

    const result = await ctx.lazy(['close', taskId, '--reason', 'Second abandon']);
    expectFailure(result);
    expectError(result, 'already abandoned');
  });

  test('cannot abandon a completed task', async () => {
    const taskId = await createTask(ctx, 'Accept then abandon', 'Do the work');

    await startAndAccept(ctx, taskId);

    const result = await ctx.lazy(['close', taskId, '--reason', 'Try to abandon completed']);
    expectFailure(result);
    expectError(result, 'already complete');
  });

  // --- metadata and comments still work on abandoned tasks ---

  test('can add comment to abandoned task', async () => {
    const taskId = await createTask(ctx, 'Abandoned with comment');
    await ctx.lazy(['close', taskId, '--reason', 'Done']);

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
    await ctx.lazy(['close', taskId, '--reason', 'Done']);

    const result = await ctx.lazy(['edit', taskId, '--goal', 'New goal']);
    expectFailure(result);
    expectError(result, 'already abandoned');
  });

  // --- abandon reason is preserved (first abandon wins) ---

  test('abandon reason from first abandon is preserved', async () => {
    const taskId = await createTask(ctx, 'Preserve abandon reason');
    await ctx.lazy(['close', taskId, '--reason', 'Original reason']);

    // Second abandon attempt fails
    await ctx.lazy(['close', taskId, '--reason', 'Overwrite attempt']);

    // Verify original reason persists
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'Original reason');
  });
});
