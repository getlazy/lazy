import { describe, test, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';
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

describe('lazy unblock --sync-with-upstream', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // --sync-with-upstream is combinable with all feedback sources.
  // When combined, the agent gets merge-conflict context plus the feedback.
  test('accepts --sync-with-upstream combined with --message', async () => {
    const taskId = await createBlockedTask(ctx, 'Sync with message');

    const result = await ctx.lazyMocked(
      ['unblock', taskId, '--sync-with-upstream', '--message', 'Please fix this'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(result);
    expectOutput(result, 'Supervisor will merge before proceeding');
  });

  test('accepts --sync-with-upstream combined with piped stdin', async () => {
    const taskId = await createBlockedTask(ctx, 'Sync with stdin');

    const result = await ctx.lazyMocked(
      ['unblock', taskId, '--sync-with-upstream'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' }, input: 'Detailed feedback via pipe' },
    );
    expectSuccess(result);
    expectOutput(result, 'Supervisor will merge before proceeding');
  });

  test('accepts --sync-with-upstream when task has unconsumed comments', async () => {
    const taskId = await createBlockedTask(ctx, 'Sync with comments');

    // Add a comment that the agent hasn't seen
    const commentResult = await ctx.lazy(['comment', taskId, '--message', 'Important feedback']);
    expectSuccess(commentResult);

    // Should succeed — comments are delivered alongside merge
    const result = await ctx.lazyMocked(
      ['unblock', taskId, '--sync-with-upstream'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(result);
    expectOutput(result, 'Supervisor will merge before proceeding');
  });

  test('succeeds with --sync-with-upstream alone (no extra feedback, no comments)', async () => {
    const taskId = await createBlockedTask(ctx, 'Sync clean');

    // Use lazyMocked because --sync-with-upstream will launch a feedback turn
    const result = await ctx.lazyMocked(
      ['unblock', taskId, '--sync-with-upstream'],
      MOCK_CLAUDE_SUCCESS,
    );
    expectSuccess(result);
  });
});
