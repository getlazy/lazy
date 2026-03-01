import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

describe('lazy reopen', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('reopens a closed task', async () => {
    const taskId = await createTask(ctx, 'Task to close then reopen');

    // Close the task
    const closeResult = await ctx.lazy(['close', taskId, '--reason', 'Premature closure']);
    expectSuccess(closeResult);
    expectOutput(closeResult, 'closed');

    // Reopen it
    const reopenResult = await ctx.lazy(['reopen', taskId]);
    expectSuccess(reopenResult);
    expectOutput(reopenResult, 'reopened');
    expectOutput(reopenResult, 'backlog');

    // Verify status is now backlog (never had a session)
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'backlog');
  });

  test('reopens an abandoned (rejected) task', async () => {
    const taskId = await createTask(ctx, 'Task to reject then reopen', 'Do some work');

    // Start and let the mock agent "work"
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // Reject the task
    const rejectResult = await ctx.lazy(['reject', taskId, '--reason', 'Wrong approach', '--yes']);
    expectSuccess(rejectResult);
    expectOutput(rejectResult, 'rejected');

    // Reopen it
    const reopenResult = await ctx.lazy(['reopen', taskId]);
    expectSuccess(reopenResult);
    expectOutput(reopenResult, 'reopened');
    expectOutput(reopenResult, 'blocked');

    // Verify status is now blocked
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'blocked');
  });

  // INVARIANT: Close must remove the worktree but preserve the git branch,
  // so that reopen can recreate the worktree from the preserved branch.
  // Previously, close deleted both worktree and branch, making reopen impossible.
  test('reopens a closed task that had a session (worktree removed, branch preserved)', async () => {
    const taskId = await createTask(ctx, 'Task to start, close, then reopen', 'Do some work');

    // Start and let the mock agent "work"
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // Close the task (should remove worktree but preserve branch)
    const closeResult = await ctx.lazy(['close', taskId, '--reason', 'Taking a different approach']);
    expectSuccess(closeResult);
    expectOutput(closeResult, 'closed');
    expectOutput(closeResult, 'Worktree removed');
    expectOutput(closeResult, 'Branch preserved');

    // Verify worktree directory is gone
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    const { existsSync } = await import('fs');
    expect(existsSync(worktreePath)).toBe(false);

    // Reopen it — should succeed without "already exists" error
    const reopenResult = await ctx.lazy(['reopen', taskId]);
    expectSuccess(reopenResult);
    expectOutput(reopenResult, 'reopened');
    expectOutput(reopenResult, 'blocked');

    // Verify status is now blocked (had a session)
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'blocked');
  });

  test('fails to reopen a working task', async () => {
    const taskId = await createTask(ctx, 'Working task');

    // Start the task (it will be in working/blocked state)
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    const result = await ctx.lazy(['reopen', taskId]);
    expectFailure(result);
    expectError(result, 'only abandoned, closed, or complete tasks can be reopened');
  });

  test('fails for nonexistent task', async () => {
    const result = await ctx.lazy(['reopen', 'nonexist0']);
    expectFailure(result);
    expectError(result, 'No task found matching');
  });

  test('reopens a complete (accepted) task with reason', async () => {
    const taskId = await createTask(ctx, 'Task to accept then reopen', 'Do some work');

    // Start and let the mock agent "work"
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // Add a non-conflicting file in the worktree so accept has something to merge
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    writeFileSync(join(worktreePath, 'feature.txt'), 'feature content\n');

    const gitAdd = ctx.git('-C', worktreePath, 'add', 'feature.txt');
    expect(gitAdd.exitCode).toBe(0);

    const gitCommit = ctx.git('-C', worktreePath, 'commit', '-m', 'Add feature');
    expect(gitCommit.exitCode).toBe(0);

    // Accept the task
    const acceptResult = await ctx.lazy(['accept', taskId, '--reason', 'Looks good']);
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'accepted');

    // Reopen it with a reason
    const reopenResult = await ctx.lazy(['reopen', taskId, '--reason', 'Erroneous acceptance']);
    expectSuccess(reopenResult);
    expectOutput(reopenResult, 'reopened');
    expectOutput(reopenResult, 'Erroneous acceptance');
    expectOutput(reopenResult, 'blocked');

    // Verify status is now blocked
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'blocked');
    expectOutput(showResult, '[Reopened] Erroneous acceptance');
  });

  test('reopens a complete task with piped stdin as reason', async () => {
    const taskId = await createTask(ctx, 'Task to accept then reopen via stdin', 'Do some work');

    // Start and let the mock agent "work"
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // Add a non-conflicting file in the worktree
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    writeFileSync(join(worktreePath, 'feature.txt'), 'feature content\n');

    const gitAdd = ctx.git('-C', worktreePath, 'add', 'feature.txt');
    expect(gitAdd.exitCode).toBe(0);

    const gitCommit = ctx.git('-C', worktreePath, 'commit', '-m', 'Add feature');
    expect(gitCommit.exitCode).toBe(0);

    // Accept the task
    const acceptResult = await ctx.lazy(['accept', taskId, '--reason', 'Looks good']);
    expectSuccess(acceptResult);

    // Reopen with piped stdin reason
    const reopenResult = await ctx.lazy(['reopen', taskId], {
      input: 'Need to fix a bug',
    });
    expectSuccess(reopenResult);
    expectOutput(reopenResult, 'reopened');
    expectOutput(reopenResult, 'Need to fix a bug');

    // Verify reason is stored as a comment
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, '[Reopened] Need to fix a bug');
  });

  test('fails to reopen complete task without reason', async () => {
    const taskId = await createTask(ctx, 'Task to accept then reopen without reason', 'Do some work');

    // Start and let the mock agent "work"
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // Add a non-conflicting file in the worktree
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    writeFileSync(join(worktreePath, 'feature.txt'), 'feature content\n');

    const gitAdd = ctx.git('-C', worktreePath, 'add', 'feature.txt');
    expect(gitAdd.exitCode).toBe(0);

    const gitCommit = ctx.git('-C', worktreePath, 'commit', '-m', 'Add feature');
    expect(gitCommit.exitCode).toBe(0);

    // Accept the task
    const acceptResult = await ctx.lazy(['accept', taskId, '--reason', 'Looks good']);
    expectSuccess(acceptResult);

    // Try to reopen without a reason (should fail in non-interactive mode)
    const reopenResult = await ctx.lazy(['reopen', taskId]);
    expectFailure(reopenResult);
    expectError(reopenResult, 'This command requires an interactive terminal');
  });
});
