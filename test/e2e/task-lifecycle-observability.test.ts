import { describe, test, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/**
 * Task lifecycle observability: start, unblock, close, and reject narrate what
 * they are doing phase by phase — the same contract as `lazy accept`.
 */
describe('lazy task lifecycle observability', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** Task started, waited out of working, ready to unblock. */
  async function setupBlockedTask(goal: string): Promise<string> {
    const taskId = await createTask(ctx, goal, 'Some work');

    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    return taskId;
  }

  test('lazy start announces phases and narrates the launch', async () => {
    const taskId = await createTask(ctx, 'Start observability', 'Do work');

    const result = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
    expectSuccess(result);

    expectOutput(result, 'phases');
    expectOutput(result, 'Pre-flight validation');
    expectOutput(result, 'Resolve integration base');
    expectOutput(result, 'Launch agent');
    expectOutput(result, 'Started task');
  });

  test('lazy unblock announces phases and narrates the relaunch', async () => {
    const taskId = await setupBlockedTask('Unblock observability');

    const result = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Continue', '--yes'],
      MOCK_CLAUDE_SUCCESS,
    );
    expectSuccess(result);

    expectOutput(result, 'phases');
    expectOutput(result, 'Pre-flight validation');
    expectOutput(result, 'Save unblock feedback');
    expectOutput(result, 'Launch agent');
    expectOutput(result, 'unblocked');
  });

  test('lazy close announces phases through cleanup', async () => {
    const taskId = await createTask(ctx, 'Close observability', 'Never started');

    const result = await ctx.lazy(['close', taskId, '--reason', 'Not needed', '--yes']);
    expectSuccess(result);

    expectOutput(result, 'phases');
    expectOutput(result, 'Pre-flight validation');
    expectOutput(result, 'Update task status');
    expectOutput(result, 'closed');
  });

  test('lazy reject announces phases through cleanup', async () => {
    const taskId = await setupBlockedTask('Reject observability');

    const result = await ctx.lazy(['reject', taskId, '--reason', 'Wrong approach', '--yes']);
    expectSuccess(result);

    expectOutput(result, 'phases');
    expectOutput(result, 'Pre-flight validation');
    expectOutput(result, 'Update task status');
    expectOutput(result, 'Clean up worktree');
    expectOutput(result, 'rejected');
  });
});
