import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, expectOutputExcludes } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

describe('lazy close', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('closes a backlog task with --reason', async () => {
    const taskId = await createTask(ctx, 'Task to close');

    const result = await ctx.lazy(['close', taskId, '--reason', 'No longer needed']);

    expectSuccess(result);
    expectOutput(result, 'closed');
  });

  // INVARIANT: close does not require an active session — it works on backlog tasks.
  test('closed task is in abandoned state and shows reason', async () => {
    const taskId = await createTask(ctx, 'Task with close reason');
    await ctx.lazy(['close', taskId, '--reason', 'Superseded by other work']);

    const showResult = await ctx.lazy(['show', taskId]);

    expectSuccess(showResult);
    expectOutput(showResult, 'abandoned');
    expectOutput(showResult, 'Superseded by other work');
  });

  test('fails for nonexistent task', async () => {
    const result = await ctx.lazy(['close', 'nonexist0', '--reason', 'test']);

    expectFailure(result);
    expectError(result, 'No task found matching');
  });

  test('fails to close already-closed task', async () => {
    const taskId = await createTask(ctx, 'Already closed');
    await ctx.lazy(['close', taskId, '--reason', 'First close']);

    const result = await ctx.lazy(['close', taskId, '--reason', 'Second close']);

    expectFailure(result);
    expectError(result, 'already abandoned');
  });

  test('fails without TTY when no --reason provided', async () => {
    const taskId = await createTask(ctx, 'Task needing TTY');

    const result = await ctx.lazy(['close', taskId]);

    expectFailure(result);
    expectError(result, 'This command requires an interactive terminal');
  });

  test('no-TTY error does not include task prompt text', async () => {
    const promptText = 'This is a detailed prompt that should not leak into error output';
    const taskId = await createTask(ctx, 'Clean close error', promptText);

    const result = await ctx.lazy(['close', taskId]);

    expectFailure(result);
    expectError(result, 'This command requires an interactive terminal');
    expectOutputExcludes(result, promptText);
    expect(result.stderr).not.toContain(promptText);
  });

  test('closes task with --yes and --reason (non-interactive mode)', async () => {
    const taskId = await createTask(ctx, 'Task to close non-interactively');

    const result = await ctx.lazy(['close', taskId, '--yes', '--reason', 'Closing non-interactively']);

    expectSuccess(result);
    expectOutput(result, 'closed');
  });

  test('fails with --yes but no --reason', async () => {
    const taskId = await createTask(ctx, 'Task needing reason');

    const result = await ctx.lazy(['close', taskId, '--yes']);

    expectFailure(result);
    expectError(result, '--reason is required when using --yes flag');
  });

  test('works with --yes and piped stdin', async () => {
    const taskId = await createTask(ctx, 'Task with piped reason');

    const result = await ctx.lazy(['close', taskId, '--yes'], {
      input: 'Reason from stdin',
    });

    expectSuccess(result);
    expectOutput(result, 'closed');
  });

  // INVARIANT: Close must remove the worktree but preserve the git branch,
  // so that reopen can recreate the worktree from the preserved branch.
  test('close with session removes worktree but preserves branch', async () => {
    const taskId = await createTask(ctx, 'Task to start then close', 'Do some work');

    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    const { existsSync } = await import('fs');
    expect(existsSync(worktreePath)).toBe(true);

    const closeResult = await ctx.lazy(['close', taskId, '--reason', 'Taking a different approach', '--yes']);
    expectSuccess(closeResult);
    expectOutput(closeResult, 'closed');
    expectOutput(closeResult, 'Worktree removed');
    expectOutput(closeResult, 'Branch preserved');
    expectOutput(closeResult, 'lazy reopen');

    expect(existsSync(worktreePath)).toBe(false);

    const branchCheck = ctx.git('branch', '--list', `lazy/${taskId}`);
    expect(branchCheck.stdout.trim()).not.toBe('');
  });

  test('fails when worktree has uncommitted changes', async () => {
    const taskId = await createTask(ctx, 'Task with uncommitted changes', 'Some work');

    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' }
    });

    const { writeFile } = await import('fs/promises');
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    await writeFile(join(worktreePath, 'test-file.txt'), 'uncommitted content\n');

    const result = await ctx.lazy(['close', taskId, '--reason', 'Not needed', '--yes']);

    expectFailure(result);
    expectError(result, 'Task has uncommitted changes!');
    expectError(result, 'Commit or stash your changes before closing');
  });

  test('succeeds with --accept-dirty-worktree when worktree has uncommitted changes', async () => {
    const taskId = await createTask(ctx, 'Task with uncommitted changes', 'Some work');

    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' }
    });

    const { writeFile } = await import('fs/promises');
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    await writeFile(join(worktreePath, 'test-file.txt'), 'uncommitted content\n');

    const result = await ctx.lazy(['close', taskId, '--accept-dirty-worktree', '--reason', 'Discard all work', '--yes']);

    expectSuccess(result);
    expectOutput(result, 'closed');
  });
});
