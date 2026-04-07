import { describe, test, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectOutputExcludes } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/**
 * Helper: create a task, start it (so it becomes blocked with a session),
 * and return the short task ID.
 */
async function createBlockedTask(ctx: TestContext, goal: string): Promise<string> {
  const taskId = await createTask(ctx, goal, 'Do work');
  const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
    env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
  });
  expectSuccess(startResult);
  return taskId;
}

describe('lazy unblock (no --sync-with-upstream)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // --sync-with-upstream was removed. Verify the flag is no longer recognized.
  test('rejects --sync-with-upstream flag as unknown', async () => {
    const taskId = await createBlockedTask(ctx, 'Flag removed test');

    const result = await ctx.lazyMocked(
      ['unblock', taskId, '--sync-with-upstream', '--message', 'Fix it'],
      MOCK_CLAUDE_SUCCESS,
    );
    expectFailure(result);
  });

  // INVARIANT: Unblock does NOT trigger upstream merge — sync is separate.
  test('unblock does NOT mention upstream merge', async () => {
    const taskId = await createBlockedTask(ctx, 'No merge test');

    const result = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Fix the bug'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(result);
    // Should NOT mention upstream merge — unblock is just feedback now
    expectOutputExcludes(result, 'Supervisor will merge before proceeding');
  });
});
