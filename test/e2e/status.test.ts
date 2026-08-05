import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, expectOutputExcludes } from '../helpers/assertions';
import { createTask, disablePreAccept, startAndReconcile } from '../helpers/fixtures';
import { worktreePathFor } from '../helpers/storage';

/**
 * Helper: create a task, start it, make a commit in the worktree.
 */
async function createStartedTaskWithCommit(ctx: TestContext, goal: string): Promise<string> {
  const taskId = await createTask(ctx, goal, 'Some work');

  // Drive the reconcile pass too: daemonless, nothing else moves the task out
  // of 'working', and accept/unblock refuse a working task.
  await startAndReconcile(ctx, taskId);

  // Add a non-conflicting file in the worktree
  const worktreePath = worktreePathFor(ctx.root, taskId);
  writeFileSync(join(worktreePath, 'feature.txt'), 'feature content\n');

  const gitAdd = ctx.git('-C', worktreePath, 'add', 'feature.txt');
  expect(gitAdd.exitCode).toBe(0);

  const gitCommit = ctx.git('-C', worktreePath, 'commit', '-m', 'Add feature');
  expect(gitCommit.exitCode).toBe(0);

  return taskId;
}

describe('lazy status', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    // Daemonless suite: nothing here can execute the pre-accept agent turn.
    disablePreAccept(ctx.root);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('shows task status for task with worktree', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Test task with worktree');

    const result = await ctx.lazy(['status', taskId]);

    expectSuccess(result);
    expectOutput(result, 'Test task with worktree');
    expectOutput(result, 'Worktree:');
    expectOutput(result, 'HEAD:');
    expectOutput(result, 'Commits:');
  });

  // INVARIANT: For terminal tasks (complete, abandoned, closed), a missing worktree
  // is expected and normal. The status command should NOT show an ERROR message,
  // but instead show a note that the worktree has been cleaned up.
  test('handles missing worktree gracefully for completed task', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Completed task test');

    // Accept the task to move it to 'complete' status
    const acceptResult = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(acceptResult);

    // Remove the worktree directory to simulate cleanup
    const worktreePath = worktreePathFor(ctx.root, taskId);
    rmSync(worktreePath, { recursive: true, force: true });

    // Run status command
    const result = await ctx.lazy(['status', taskId]);

    expectSuccess(result);
    // Should show a note, not an error
    expectOutput(result, 'Note:');
    expectOutput(result, 'Worktree directory has been cleaned up');
    expectOutput(result, 'complete');
    // Should NOT show ERROR
    expectOutputExcludes(result, 'ERROR: Worktree directory does not exist!');
    expectOutputExcludes(result, 'The session cannot be resumed without the worktree.');
  });

  // INVARIANT: Missing worktree on a non-terminal task should show a warning
  // but NOT early-return — remaining diagnostics (auto-react, session info) are
  // still valuable and must be rendered.
  test('shows WARNING for non-terminal task with missing worktree but continues output', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Active task test');

    // Unblock to move it to 'blocked' status (non-terminal)
    // Note: this requires Docker, so we skip this test if Docker is not available
    try {
      const unblockResult = await ctx.lazy(['unblock', taskId], { input: 'Continue working' });
      expectSuccess(unblockResult);
    } catch (err) {
      // Skip test if Docker is not available
      if (String(err).includes('docker')) {
        console.log('Skipping test: Docker not available');
        return;
      }
      throw err;
    }

    // Verify task is in blocked status
    const listResult = await ctx.lazy(['list']);
    expectOutput(listResult, 'blocked');

    // Remove the worktree directory
    const worktreePath = worktreePathFor(ctx.root, taskId);
    rmSync(worktreePath, { recursive: true, force: true });

    // Run status command - should show warning but continue rendering
    const result = await ctx.lazy(['status', taskId]);

    expectSuccess(result);
    // Should show WARNING (not ERROR) for missing worktree
    expectOutput(result, 'WARNING:');
    expectOutput(result, 'Worktree directory does not exist!');
    expectOutput(result, 'The session cannot be resumed without the worktree.');
    // Should NOT early-return — session status and other sections should still appear
    expectOutput(result, 'Session status:');
  });

  test('handles missing worktree gracefully for abandoned task', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Abandoned task test');

    // Reject the task to move it to 'abandoned' status
    const rejectResult = await ctx.lazy(['reject', taskId, '--reason', 'Test rejection', '--yes']);
    expectSuccess(rejectResult);

    // Remove the worktree directory
    const worktreePath = worktreePathFor(ctx.root, taskId);
    rmSync(worktreePath, { recursive: true, force: true });

    // Run status command
    const result = await ctx.lazy(['status', taskId]);

    expectSuccess(result);
    // Should show a note, not an error
    expectOutput(result, 'Note:');
    expectOutput(result, 'Worktree directory has been cleaned up');
    expectOutput(result, 'abandoned');
    // Should NOT show ERROR
    expectOutputExcludes(result, 'ERROR: Worktree directory does not exist!');
  });

  test('handles missing worktree gracefully for closed task', async () => {
    const taskId = await createTask(ctx, 'Closed task test', 'Test prompt');

    // Close the task directly (without starting)
    const closeResult = await ctx.lazy(['close', taskId, '--reason', 'Test closure']);
    expectSuccess(closeResult);

    // Since task was never started, there's no worktree to remove,
    // but status should still handle it gracefully
    const result = await ctx.lazy(['status', taskId]);

    expectSuccess(result);
    // Should show that task has no session
    expectOutput(result, 'not started');
  });
});
