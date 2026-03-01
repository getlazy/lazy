import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/**
 * Helper: create a task, start it, make a commit in the worktree so accept has something to merge.
 */
async function createStartedTaskWithCommit(ctx: TestContext, goal: string): Promise<string> {
  const taskId = await createTask(ctx, goal, 'Some work');

  const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
    env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
  });
  expectSuccess(startResult);

  // Add a non-conflicting file in the worktree
  const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
  writeFileSync(join(worktreePath, 'feature.txt'), 'feature content\n');

  const gitAdd = ctx.git('-C', worktreePath, 'add', 'feature.txt');
  expect(gitAdd.exitCode).toBe(0);

  const gitCommit = ctx.git('-C', worktreePath, 'commit', '-m', 'Add feature');
  expect(gitCommit.exitCode).toBe(0);

  return taskId;
}

describe('lazy accept --reason', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('accepts task with --reason flag', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Reason flag test');

    const result = await ctx.lazy(['accept', taskId, '--reason', 'Clean implementation']);
    expectSuccess(result);
    expectOutput(result, 'accepted');
  });

  test('accept reason is visible in lazy show', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Show reason test');

    const acceptResult = await ctx.lazy(['accept', taskId, '--reason', 'LGTM - tests pass']);
    expectSuccess(acceptResult);

    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, '[Accepted] LGTM - tests pass');
  });

  test('accepts task with piped stdin as reason', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Stdin reason test');

    const result = await ctx.lazy(['accept', taskId], { input: 'Looks good to me' });
    expectSuccess(result);
    expectOutput(result, 'accepted');

    // Verify reason is stored
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, '[Accepted] Looks good to me');
  });

  test('accepts task with --yes uses LGTM as default reason', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Yes flag default test');

    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(result);
    expectOutput(result, 'accepted');

    // Verify default reason is stored
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, '[Accepted] LGTM');
  });

  test('non-interactive mode without --reason uses LGTM default', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Non-interactive default test');

    // No --reason, no piped stdin, no TTY → falls back to "LGTM"
    const result = await ctx.lazy(['accept', taskId]);
    expectSuccess(result);
    expectOutput(result, 'accepted');

    // Verify default reason is stored
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, '[Accepted] LGTM');
  });

  test('--reason flag takes priority over piped stdin', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Priority test');

    const result = await ctx.lazy(['accept', taskId, '--reason', 'Flag reason'], {
      input: 'Stdin reason',
    });
    expectSuccess(result);
    expectOutput(result, 'accepted');

    // Verify flag reason is stored, not stdin
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, '[Accepted] Flag reason');
  });
});
