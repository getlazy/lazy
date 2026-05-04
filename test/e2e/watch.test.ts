import { describe, test, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';

describe('lazy watch', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('shows error when no tasks are running', async () => {
    const result = await ctx.lazy(['watch']);
    // No working tasks — should show a message
    expectOutput(result, 'No tasks are currently running');
  });

  test('shows error when task is not in working status', async () => {
    const taskId = await createTask(ctx, 'Test task for watch');
    const result = await ctx.lazy(['watch', taskId]);
    expectFailure(result);
    expectError(result, 'not currently running');
  });

  test('shows error when task not found', async () => {
    const result = await ctx.lazy(['watch', 'nonexist']);
    expectFailure(result);
    // Should fail because task doesn't exist
  });

  test('shows help with --help flag', async () => {
    const result = await ctx.lazy(['watch', '--help']);
    expectOutput(result, 'lazy watch');
    expectOutput(result, 'real-time');
  });

  test('help text does not require tmux', async () => {
    const result = await ctx.lazy(['watch', '--help']);
    // INVARIANT: lazy watch no longer depends on tmux
    if (result.stdout.includes('tmux must be installed')) {
      throw new Error('Watch help text should not require tmux');
    }
  });
});
