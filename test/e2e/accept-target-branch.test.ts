import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/**
 * Find the full task UUID from a short (8-char) prefix.
 */
function findFullTaskId(root: string, shortId: string): string {
  const tasksDir = join(root, '.lazy', 'tasks');
  const dirs = readdirSync(tasksDir);
  const match = dirs.find(d => d.startsWith(shortId));
  if (!match) throw new Error(`Task directory not found for ${shortId}`);
  return match;
}

/**
 * Set remote_target_branch metadata on a task by directly editing task.json.
 */
function setRemoteTargetBranch(root: string, shortId: string, targetBranch: string): void {
  const fullId = findFullTaskId(root, shortId);
  const taskPath = join(root, '.lazy', 'tasks', fullId, 'task.json');
  const task = JSON.parse(readFileSync(taskPath, 'utf-8'));
  if (!task.metadata) task.metadata = {};
  task.metadata.remote_target_branch = targetBranch;
  writeFileSync(taskPath, JSON.stringify(task, null, 2));
}

/**
 * Tests for accept command using remote_target_branch metadata
 * instead of hardcoding 'main' as the merge target for root tasks.
 */
describe('lazy accept target branch', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('accept merges into remote_target_branch when set', async () => {
    // 1. Create a non-main branch to simulate a task created from a feature branch
    const branchResult = ctx.git('checkout', '-b', 'feature/custom-branch');
    expect(branchResult.exitCode).toBe(0);

    // Add a commit so the branch has content
    writeFileSync(join(ctx.root, 'feature.txt'), 'feature content\n');
    ctx.git('add', 'feature.txt');
    ctx.git('commit', '-m', 'Add feature file');

    // Switch back to main so we're in the normal state for task creation
    ctx.git('checkout', 'main');

    // 2. Create and start a task
    const taskId = await createTask(ctx, 'Target branch test', 'Add a file');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // 3. Set remote_target_branch to the feature branch
    setRemoteTargetBranch(ctx.root, taskId, 'feature/custom-branch');

    // 4. Add a commit in the worktree
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    writeFileSync(join(worktreePath, 'new-file.txt'), 'some content\n');
    ctx.git('-C', worktreePath, 'add', 'new-file.txt');
    ctx.git('-C', worktreePath, 'commit', '-m', 'Add new file');

    // 5. Accept should merge into feature/custom-branch, not main
    const acceptResult = await ctx.lazy(['accept', taskId]);
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'accepted and merged into feature/custom-branch');
    expectOutput(acceptResult, 'Merging root task');
    expectOutput(acceptResult, 'into feature/custom-branch');
  });

  test('accept falls back to main when remote_target_branch is not set', async () => {
    // 1. Create and start a task (no remote_target_branch metadata)
    const taskId = await createTask(ctx, 'Fallback test', 'Add a file');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // 2. Add a commit in the worktree
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    writeFileSync(join(worktreePath, 'new-file.txt'), 'some content\n');
    ctx.git('-C', worktreePath, 'add', 'new-file.txt');
    ctx.git('-C', worktreePath, 'commit', '-m', 'Add new file');

    // 3. Accept should merge into main (the default fallback)
    const acceptResult = await ctx.lazy(['accept', taskId]);
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'accepted and merged into main');
  });

  test('accept with conflicts references correct target branch in message', async () => {
    // 1. Create a feature branch with content
    ctx.git('checkout', '-b', 'ivan/deno-v2');
    writeFileSync(join(ctx.root, 'test.txt'), 'feature branch content\n');
    ctx.git('add', 'test.txt');
    ctx.git('commit', '-m', 'Add test file on feature branch');
    ctx.git('checkout', 'main');

    // 2. Create and start a task
    const taskId = await createTask(ctx, 'Conflict target test', 'Add a file');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // 3. Set remote_target_branch to the feature branch
    setRemoteTargetBranch(ctx.root, taskId, 'ivan/deno-v2');

    // 4. Create a conflicting file in the worktree
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    writeFileSync(join(worktreePath, 'test.txt'), 'task branch content\n');
    ctx.git('-C', worktreePath, 'add', 'test.txt');
    ctx.git('-C', worktreePath, 'commit', '-m', 'Add conflicting content');

    // 5. Accept should detect conflicts with ivan/deno-v2, not main
    const acceptResult = await ctx.lazy(['accept', taskId]);
    expectFailure(acceptResult, 1);
    expectOutput(acceptResult, 'Session branch has conflicts with ivan/deno-v2');
  });
});
