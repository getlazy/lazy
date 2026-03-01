import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/**
 * Helper: create a task, start it, make a commit in the worktree.
 */
async function createStartedTaskWithCommit(ctx: TestContext, goal: string): Promise<string> {
  const taskId = await createTask(ctx, goal, 'Some work');

  const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
    env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
  });
  expectSuccess(startResult);

  // Add a file and commit it
  const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
  writeFileSync(join(worktreePath, 'feature.txt'), 'feature content\n');

  const gitAdd = ctx.git('-C', worktreePath, 'add', 'feature.txt');
  expect(gitAdd.exitCode).toBe(0);

  const gitCommit = ctx.git('-C', worktreePath, 'commit', '-m', 'Add feature');
  expect(gitCommit.exitCode).toBe(0);

  return taskId;
}

describe('Lazy co-author trailer', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('accept squash commit has Lazy co-author trailer', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Test co-author on squash commit');

    // Accept the task (which creates a squash merge commit)
    const acceptResult = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(acceptResult);

    // Check that the squash merge commit on main has the Lazy co-author trailer
    const logResult = ctx.git('log', '--format=%B', '-n', '1', 'main');
    expect(logResult.exitCode).toBe(0);

    const commitMessage = logResult.stdout;
    expect(commitMessage).toContain('Accept task');
    expect(commitMessage).toContain('Co-Authored-By: Lazy <noreply@getlazy.dev>');
  });

  test('multiple accepts all include co-author trailer', async () => {
    // Create and accept multiple tasks
    for (let i = 1; i <= 3; i++) {
      const taskId = await createStartedTaskWithCommit(ctx, `Task ${i}`);
      const acceptResult = await ctx.lazy(['accept', taskId, '--yes']);
      expectSuccess(acceptResult);
    }

    // Check that all 3 squash commits have the co-author trailer
    const logResult = ctx.git('log', '--format=%B%x00', '-n', '3', 'main');
    expect(logResult.exitCode).toBe(0);

    const commits = logResult.stdout.split('\0').filter(s => s.trim());

    // All commits should have the trailer
    for (const commit of commits) {
      expect(commit).toContain('Co-Authored-By: Lazy <noreply@getlazy.dev>');
    }
  });
});
