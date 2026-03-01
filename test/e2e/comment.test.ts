import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';

describe('lazy comment', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('adds a comment with --message flag', async () => {
    const taskId = await createTask(ctx, 'Task with comments');

    const result = await ctx.lazy(['comment', taskId, '--message', 'This is a test comment']);

    expectSuccess(result);
    expectOutput(result, 'Added comment to task');
  });

  test('comment appears in show output', async () => {
    const taskId = await createTask(ctx, 'Task with visible comment');
    await ctx.lazy(['comment', taskId, '--message', 'Important observation']);

    const showResult = await ctx.lazy(['show', taskId]);

    expectSuccess(showResult);
    expectOutput(showResult, 'Important observation');
  });

  test('fails with nonexistent task', async () => {
    const result = await ctx.lazy(['comment', 'nonexist0', '--message', 'some comment']);

    expectFailure(result);
    expectError(result, 'No task found matching');
  });

  test('fails without TTY when no --message provided', async () => {
    const taskId = await createTask(ctx, 'Comment without message');

    const result = await ctx.lazy(['comment', taskId]);

    expectFailure(result);
    expectError(result, 'Interactive mode requires a TTY');
  });

});
