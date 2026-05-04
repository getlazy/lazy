import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

describe('full task lifecycle', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('create -> start -> accept', async () => {
    // 1. Create task
    const taskId = await createTask(ctx, 'Full lifecycle test', 'Implement feature X');

    // 2. Start task (mock Claude making a commit)
    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);
    expectOutput(startResult, 'Started task');

    // 3. Verify worktree exists
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    expect(existsSync(worktreePath)).toBe(true);

    // 4. Accept task (merges to main)
    const acceptResult = await ctx.lazy(['accept', taskId]);
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'accepted and merged');

    // 5. Verify task is complete
    const showResult = await ctx.lazy(['show', taskId]);
    expectOutput(showResult, 'complete');
  });

  test('create -> start -> abandon with --reason', async () => {
    const taskId = await createTask(ctx, 'Abandon test', 'Try feature Y');

    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // abandon requires --reason flag and --yes to skip interactive confirmation
    const abandonResult = await ctx.lazy(['abandon', taskId, '--yes', '--reason', 'Incorrect approach, needs redesign']);
    expectSuccess(abandonResult);
    expectOutput(abandonResult, 'abandoned');

    // Verify task is abandoned and reason is stored as a note
    const showResult = await ctx.lazy(['show', taskId]);
    expectOutput(showResult, 'abandoned');
    expectOutput(showResult, 'Incorrect approach, needs redesign');
  });

  test('abandon without --reason in non-TTY fails', async () => {
    const taskId = await createTask(ctx, 'Abandon no reason', 'Try feature Z');

    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // abandon without --reason should fail in non-TTY context
    const abandonResult = await ctx.lazy(['abandon', taskId, '--yes']);
    expectFailure(abandonResult, 1);
    expectError(abandonResult, '--reason is required when using --yes flag');
  });

  test('create -> abandon (no session)', async () => {
    const taskId = await createTask(ctx, 'Abandon test', 'Something');

    const abandonResult = await ctx.lazy(['abandon', taskId, '--reason', 'No longer needed']);
    expectSuccess(abandonResult);
    expectOutput(abandonResult, 'abandoned');

    const showResult = await ctx.lazy(['show', taskId]);
    expectOutput(showResult, 'abandoned');
    expectOutput(showResult, 'No longer needed');
  });

  test('create -> start -> show has session info', async () => {
    const taskId = await createTask(ctx, 'Session detail test', 'Build something');

    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    // Should show session info
    expectOutput(showResult, 'claude-code');
    // Should show human turn (recorded before container launch)
    expectOutput(showResult, 'Turns:');
  });
});
