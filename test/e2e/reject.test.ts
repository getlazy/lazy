import { describe, test, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectFailure, expectError } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';

describe('lazy reject', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: reject requires an active session — for tasks that haven't been
  // worked on, `lazy close` is the right command.
  test('fails on backlog task with no session', async () => {
    const taskId = await createTask(ctx, 'Task with no session');

    const result = await ctx.lazy(['reject', taskId, '--reason', 'Bad', '--yes']);

    expectFailure(result);
    expectError(result, 'has no session');
  });

  test('error message points users to lazy close', async () => {
    const taskId = await createTask(ctx, 'Task with no session');

    const result = await ctx.lazy(['reject', taskId, '--reason', 'Bad', '--yes']);

    expectFailure(result);
    expectError(result, "lazy close");
  });

  test('fails for nonexistent task', async () => {
    const result = await ctx.lazy(['reject', 'nonexist0', '--reason', 'test', '--yes']);

    expectFailure(result);
    expectError(result, 'No task found matching');
  });

  test('shows usage when no task id', async () => {
    const result = await ctx.lazy(['reject']);

    expectFailure(result);
  });
});
