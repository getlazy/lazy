import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, expectOutputExcludes } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

describe('lazy reject', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('rejects task with --reason and --yes flags', async () => {
    const taskId = await createTask(ctx, 'Task to reject', 'Some work');

    // Start the task to create a session
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' }
    });

    const result = await ctx.lazy(['reject', taskId, '--reason', 'Not the right approach', '--yes']);

    expectSuccess(result);
    expectOutput(result, 'rejected');
  });

  test('reject reason is visible in lazy show with [Rejected] prefix', async () => {
    const taskId = await createTask(ctx, 'Show reject reason test', 'Some work');

    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' }
    });

    const rejectResult = await ctx.lazy(['reject', taskId, '--reason', 'Wrong approach, needs redesign', '--yes']);
    expectSuccess(rejectResult);

    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, '[Rejected] Wrong approach, needs redesign');
  });

  test('reject with piped stdin as reason', async () => {
    const taskId = await createTask(ctx, 'Stdin reject test', 'Some work');

    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' }
    });

    const result = await ctx.lazy(['reject', taskId, '--yes'], { input: 'Bad implementation' });
    expectSuccess(result);
    expectOutput(result, 'rejected');

    // Verify reason is stored with prefix
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, '[Rejected] Bad implementation');
  });

  test('--reason flag takes priority over piped stdin', async () => {
    const taskId = await createTask(ctx, 'Priority test', 'Some work');

    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' }
    });

    const result = await ctx.lazy(['reject', taskId, '--reason', 'Flag reason', '--yes'], {
      input: 'Stdin reason',
    });
    expectSuccess(result);

    // Verify flag reason is stored, not stdin
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, '[Rejected] Flag reason');
  });

  test('fails without TTY when --reason provided but no --yes', async () => {
    const taskId = await createTask(ctx, 'Task to reject', 'Some work');

    // Start the task to create a session
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' }
    });

    // Provide reason but not --yes, which requires TTY for confirmation
    const result = await ctx.lazy(['reject', taskId, '--reason', 'Bad approach']);

    expectFailure(result);
    expectError(result, 'This command requires an interactive terminal for confirmation');
  });

  test('fails without TTY when no --reason provided', async () => {
    const taskId = await createTask(ctx, 'Task to reject', 'Some work');

    // Start the task to create a session
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' }
    });

    // No reason and no TTY
    const result = await ctx.lazy(['reject', taskId]);

    expectFailure(result);
    expectError(result, 'Rejection reason is required');
  });

  test('fails when task has no session', async () => {
    const taskId = await createTask(ctx, 'Not started');

    const result = await ctx.lazy(['reject', taskId, '--reason', 'test', '--yes']);

    expectFailure(result);
    expectError(result, 'has no session');
  });

  test('no-TTY error does not include task prompt text', async () => {
    const promptText = 'This is a detailed prompt that should not leak into error output';
    const taskId = await createTask(ctx, 'Clean reject error', promptText);

    // Start the task to create a session
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' }
    });

    // No reason and no TTY — should fail cleanly
    const result = await ctx.lazy(['reject', taskId]);

    expectFailure(result);
    expectError(result, 'Rejection reason is required');
    // The prompt text must NOT appear in stdout or stderr
    expectOutputExcludes(result, promptText);
    expect(result.stderr).not.toContain(promptText);
  });

  test('fails when worktree has uncommitted changes', async () => {
    const taskId = await createTask(ctx, 'Task with uncommitted changes', 'Some work');

    // Start the task to create a session and worktree
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' }
    });

    // Create uncommitted changes in the worktree
    const { join } = await import('path');
    const { writeFile } = await import('fs/promises');
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    await writeFile(join(worktreePath, 'test-file.txt'), 'uncommitted content\n');

    // Try to reject without --accept-dirty-worktree
    const result = await ctx.lazy(['reject', taskId, '--reason', 'Bad approach', '--yes']);

    expectFailure(result);
    expectError(result, 'Task has uncommitted changes!');
    expectError(result, 'Commit or stash your changes before rejecting');
  });

  test('succeeds with --accept-dirty-worktree when worktree has uncommitted changes', async () => {
    const taskId = await createTask(ctx, 'Task with uncommitted changes', 'Some work');

    // Start the task to create a session and worktree
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' }
    });

    // Create uncommitted changes in the worktree
    const { join } = await import('path');
    const { writeFile } = await import('fs/promises');
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    await writeFile(join(worktreePath, 'test-file.txt'), 'uncommitted content\n');

    // Reject with --accept-dirty-worktree
    const result = await ctx.lazy(['reject', taskId, '--accept-dirty-worktree', '--reason', 'Discard all work', '--yes']);

    expectSuccess(result);
    expectOutput(result, 'rejected');
  });
});
