import { describe, test, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectFailure, expectError } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';

describe('lazy stop', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: only 'working' tasks can be stopped. For other statuses, the
  // user is pointed at lazy close / lazy unblock / lazy resume.
  test('fails on backlog task (not working)', async () => {
    const taskId = await createTask(ctx, 'Backlog task');

    const result = await ctx.lazy(['stop', taskId, '--yes']);

    expectFailure(result);
    expectError(result, 'not working');
  });

  test('error message points users to the right next step', async () => {
    const taskId = await createTask(ctx, 'Backlog task');

    const result = await ctx.lazy(['stop', taskId, '--yes']);

    expectFailure(result);
    expectError(result, 'lazy close');
  });

  test('fails for nonexistent task', async () => {
    const result = await ctx.lazy(['stop', 'nonexist0', '--yes']);

    expectFailure(result);
  });

  test('shows usage when no task id is given', async () => {
    const result = await ctx.lazy(['stop']);

    expectFailure(result);
  });

  test('accepts --reason flag (status validation still wins for backlog)', async () => {
    const taskId = await createTask(ctx, 'Backlog task');

    const result = await ctx.lazy(['stop', taskId, '--reason', 'changing direction']);

    // Backlog task: should fail with status-validation message, not a reason error.
    expectFailure(result);
    expectError(result, 'not working');
  });

  test('non-TTY without --yes still resolves to default reason (status validation)', async () => {
    const taskId = await createTask(ctx, 'Backlog task');

    // No --reason, no --yes; ctx.lazy runs non-TTY — should use default reason
    // silently and then fail on status validation, not on missing reason.
    const result = await ctx.lazy(['stop', taskId]);

    expectFailure(result);
    expectError(result, 'not working');
  });
});
