import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { createTask, disablePreAccept, startAndReconcile } from '../helpers/fixtures';
import { worktreePathFor } from '../helpers/storage';

/**
 * Helper: create a task, start it, make a commit in the worktree.
 */
async function createStartedTaskWithCommit(ctx: TestContext, goal: string): Promise<string> {
  const taskId = await createTask(ctx, goal, 'Some work');

  // Drive the reconcile pass too — accept refuses a task that is still
  // 'working', and only a reconcile (daemon or explicit) moves it to 'blocked'.
  await startAndReconcile(ctx, taskId);

  // Add a file and commit it. The filename must be unique per task: the second
  // test accepts three tasks in a row, so a shared 'feature.txt' would already
  // be on main (with identical content) by the time task 2 branches off it, and
  // `git commit` would fail with "nothing to commit".
  const worktreePath = worktreePathFor(ctx.root, taskId);
  const featureFile = `feature-${taskId}.txt`;
  writeFileSync(join(worktreePath, featureFile), `feature content for ${taskId}\n`);

  const gitAdd = ctx.git('-C', worktreePath, 'add', featureFile);
  expect(gitAdd.exitCode).toBe(0);

  const gitCommit = ctx.git('-C', worktreePath, 'commit', '-m', 'Add feature');
  expect(gitCommit.exitCode).toBe(0);

  return taskId;
}

describe('Lazy co-author trailer', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    // Daemonless suite: no runner exists to execute the pre-accept agent turn,
    // and these tests assert on the merge commit, not on pre-accept.
    disablePreAccept(ctx.root);
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
