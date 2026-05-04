import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, expectOutputExcludes } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

describe('lazy abandon', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // --- Basic abandon (no session, like old "close") ---

  test('abandons a backlog task with --reason', async () => {
    const taskId = await createTask(ctx, 'Task to abandon');

    const result = await ctx.lazy(['abandon', taskId, '--reason', 'No longer needed']);

    expectSuccess(result);
    expectOutput(result, 'abandoned');
  });

  test('abandoned task shows reason in show output', async () => {
    const taskId = await createTask(ctx, 'Task with abandon reason');
    await ctx.lazy(['abandon', taskId, '--reason', 'Superseded by other work']);

    const showResult = await ctx.lazy(['show', taskId]);

    expectSuccess(showResult);
    expectOutput(showResult, 'abandoned');
    expectOutput(showResult, 'Superseded by other work');
  });

  test('fails for nonexistent task', async () => {
    const result = await ctx.lazy(['abandon', 'nonexist0', '--reason', 'test']);

    expectFailure(result);
    expectError(result, 'No task found matching');
  });

  test('fails to abandon already-abandoned task', async () => {
    const taskId = await createTask(ctx, 'Already abandoned');
    await ctx.lazy(['abandon', taskId, '--reason', 'First abandon']);

    const result = await ctx.lazy(['abandon', taskId, '--reason', 'Second abandon']);

    expectFailure(result);
    expectError(result, 'already abandoned');
  });

  test('fails without TTY when no --reason provided', async () => {
    const taskId = await createTask(ctx, 'Task needing TTY');

    const result = await ctx.lazy(['abandon', taskId]);

    expectFailure(result);
    expectError(result, 'This command requires an interactive terminal');
  });

  test('no-TTY error does not include task prompt text', async () => {
    const promptText = 'This is a detailed prompt that should not leak into error output';
    const taskId = await createTask(ctx, 'Clean abandon error', promptText);

    const result = await ctx.lazy(['abandon', taskId]);

    expectFailure(result);
    expectError(result, 'This command requires an interactive terminal');
    expectOutputExcludes(result, promptText);
    expect(result.stderr).not.toContain(promptText);
  });

  test('abandons task with --yes and --reason (non-interactive mode)', async () => {
    const taskId = await createTask(ctx, 'Task to abandon non-interactively');

    const result = await ctx.lazy(['abandon', taskId, '--yes', '--reason', 'Abandoning non-interactively']);

    expectSuccess(result);
    expectOutput(result, 'abandoned');
  });

  test('fails with --yes but no --reason', async () => {
    const taskId = await createTask(ctx, 'Task needing reason');

    const result = await ctx.lazy(['abandon', taskId, '--yes']);

    expectFailure(result);
    expectError(result, '--reason is required when using --yes flag');
  });

  test('works with --yes and piped stdin', async () => {
    const taskId = await createTask(ctx, 'Task with piped reason');

    const result = await ctx.lazy(['abandon', taskId, '--yes'], {
      input: 'Reason from stdin',
    });

    expectSuccess(result);
    expectOutput(result, 'abandoned');
  });

  // --- Abandon with session (like old "reject") ---

  test('abandons started task with --reason and --yes flags', async () => {
    const taskId = await createTask(ctx, 'Task to reject', 'Some work');

    // Start the task to create a session
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' }
    });

    const result = await ctx.lazy(['abandon', taskId, '--reason', 'Not the right approach', '--yes']);

    expectSuccess(result);
    expectOutput(result, 'abandoned');
  });

  test('abandon reason is visible in lazy show with [Abandoned] prefix', async () => {
    const taskId = await createTask(ctx, 'Show abandon reason test', 'Some work');

    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' }
    });

    const abandonResult = await ctx.lazy(['abandon', taskId, '--reason', 'Wrong approach, needs redesign', '--yes']);
    expectSuccess(abandonResult);

    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, '[Abandoned] Wrong approach, needs redesign');
  });

  // INVARIANT: Abandon must remove the worktree but preserve the git branch,
  // so that reopen can recreate the worktree from the preserved branch.
  test('abandon with session removes worktree but preserves branch', async () => {
    const taskId = await createTask(ctx, 'Task to start then abandon', 'Do some work');

    // Start and let the mock agent "work"
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // Verify worktree exists before abandon
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    const { existsSync } = await import('fs');
    expect(existsSync(worktreePath)).toBe(true);

    // Abandon the task
    const abandonResult = await ctx.lazy(['abandon', taskId, '--reason', 'Taking a different approach', '--yes']);
    expectSuccess(abandonResult);
    expectOutput(abandonResult, 'abandoned');
    expectOutput(abandonResult, 'Worktree removed');
    expectOutput(abandonResult, 'Branch preserved');
    expectOutput(abandonResult, 'lazy reopen');

    // Verify worktree directory is gone
    expect(existsSync(worktreePath)).toBe(false);

    // Verify branch still exists
    const branchCheck = ctx.git('branch', '--list', `lazy/${taskId}`);
    expect(branchCheck.stdout.trim()).not.toBe('');
  });

  test('fails when worktree has uncommitted changes', async () => {
    const taskId = await createTask(ctx, 'Task with uncommitted changes', 'Some work');

    // Start the task to create a session and worktree
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' }
    });

    // Create uncommitted changes in the worktree
    const { writeFile } = await import('fs/promises');
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    await writeFile(join(worktreePath, 'test-file.txt'), 'uncommitted content\n');

    // Try to abandon without --accept-dirty-worktree
    const result = await ctx.lazy(['abandon', taskId, '--reason', 'Not needed', '--yes']);

    expectFailure(result);
    expectError(result, 'Task has uncommitted changes!');
    expectError(result, 'Commit or stash your changes before abandoning');
  });

  test('succeeds with --accept-dirty-worktree when worktree has uncommitted changes', async () => {
    const taskId = await createTask(ctx, 'Task with uncommitted changes', 'Some work');

    // Start the task to create a session and worktree
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' }
    });

    // Create uncommitted changes in the worktree
    const { writeFile } = await import('fs/promises');
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    await writeFile(join(worktreePath, 'test-file.txt'), 'uncommitted content\n');

    // Abandon with --accept-dirty-worktree
    const result = await ctx.lazy(['abandon', taskId, '--accept-dirty-worktree', '--reason', 'Discard all work', '--yes']);

    expectSuccess(result);
    expectOutput(result, 'abandoned');
  });

  // --- Backward compatibility aliases ---

  test('"lazy close" works as alias for abandon', async () => {
    const taskId = await createTask(ctx, 'Task to close');

    const result = await ctx.lazy(['close', taskId, '--reason', 'No longer needed']);

    expectSuccess(result);
    expectOutput(result, 'abandoned');
  });

  test('"lazy reject" works as alias for abandon', async () => {
    const taskId = await createTask(ctx, 'Task to reject', 'Some work');

    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' }
    });

    const result = await ctx.lazy(['reject', taskId, '--reason', 'Bad approach', '--yes']);

    expectSuccess(result);
    expectOutput(result, 'abandoned');
  });
});
