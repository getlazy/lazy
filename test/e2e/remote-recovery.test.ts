import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join, basename } from 'path';
import { existsSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, extractTaskId } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/**
 * Add a bare "remote" repo so we can test fetching branches that only
 * exist on the remote.
 */
function addBareRemote(ctx: TestContext): string {
  const bareDir = join(ctx.root, '..', 'bare-remote.git');
  Bun.spawnSync(['git', 'init', '--bare', bareDir], { stdout: 'pipe', stderr: 'pipe' });
  ctx.git('remote', 'add', 'origin', bareDir);
  // Push main so the remote has a base
  ctx.git('push', 'origin', 'main');
  return bareDir;
}

describe('remote branch recovery', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: When the worktree is gone but the branch exists on remote,
  // diff should fetch the remote branch and recover the worktree.
  test('diff recovers worktree from remote branch', async () => {
    addBareRemote(ctx);

    // Create and start a task
    const taskId = await createTask(ctx, 'Remote recovery test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    await ctx.lazy(['show', taskId]);

    // Get the branch name
    const showResult = await ctx.lazy(['show', taskId, '--json']);
    const showData = JSON.parse(showResult.stdout);
    const branchName = showData.session.git_branch;

    // Push the task branch to "remote"
    ctx.git('push', 'origin', branchName);

    // Delete the worktree and local branch to simulate moving machines
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    rmSync(worktreePath, { recursive: true, force: true });
    ctx.git('worktree', 'prune');
    // Force-delete the local branch (it was checked out in the now-removed worktree)
    ctx.git('branch', '-D', branchName);

    // Verify branch is gone locally
    const branchCheck = ctx.git('rev-parse', '--verify', branchName);
    expect(branchCheck.exitCode).not.toBe(0);

    // diff should recover by fetching from remote
    const diffResult = await ctx.lazy(['diff', taskId]);
    expectSuccess(diffResult);
    expectOutput(diffResult, 'agent-output');

    // Worktree should be recreated
    expect(existsSync(worktreePath)).toBe(true);
  });

  // INVARIANT: When the branch doesn't exist locally OR on remote,
  // diff should fail with a clear error message.
  test('diff fails with clear error when branch not on remote either', async () => {
    addBareRemote(ctx);

    const taskId = await createTask(ctx, 'No branch anywhere', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    await ctx.lazy(['show', taskId]);

    const showResult = await ctx.lazy(['show', taskId, '--json']);
    const showData = JSON.parse(showResult.stdout);
    const branchName = showData.session.git_branch;

    // Delete worktree and local branch but DON'T push to remote
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    rmSync(worktreePath, { recursive: true, force: true });
    ctx.git('worktree', 'prune');
    ctx.git('branch', '-D', branchName);

    // diff should fail with actionable error
    const diffResult = await ctx.lazy(['diff', taskId]);
    expectFailure(diffResult);
    expectError(diffResult, 'not found locally or on remote');
  });

  // INVARIANT: When the worktree is gone but the branch still exists locally,
  // diff should recover from the local branch (no remote fetch needed).
  test('diff recovers worktree from local branch', async () => {
    const taskId = await createTask(ctx, 'Local recovery test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    await ctx.lazy(['show', taskId]);

    // Delete the worktree directory but keep the local branch
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    rmSync(worktreePath, { recursive: true, force: true });
    ctx.git('worktree', 'prune');

    // diff should recover from local branch
    const diffResult = await ctx.lazy(['diff', taskId]);
    expectSuccess(diffResult);
    expectOutput(diffResult, 'agent-output');
    expect(existsSync(worktreePath)).toBe(true);
  });

  // INVARIANT: When the worktree is gone but the branch exists on remote,
  // unblock should fetch the remote branch and recover the worktree
  // (not fail with "Worktree not found").
  test('unblock recovers worktree from remote branch', async () => {
    addBareRemote(ctx);

    const taskId = await createTask(ctx, 'Unblock recovery test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    await ctx.lazy(['show', taskId]);

    const showResult = await ctx.lazy(['show', taskId, '--json']);
    const showData = JSON.parse(showResult.stdout);
    const branchName = showData.session.git_branch;

    // Push the task branch to "remote"
    ctx.git('push', 'origin', branchName);

    // Force task to blocked
    setTaskStatus(ctx, taskId, 'blocked');

    // Delete the worktree and local branch
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    rmSync(worktreePath, { recursive: true, force: true });
    ctx.git('worktree', 'prune');
    ctx.git('branch', '-D', branchName);

    // Unblock should recover the worktree from remote.
    // The command may fail later (daemon storage init in test env), but
    // the error must NOT be about a missing worktree — recovery should pass.
    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Continue working'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    const combined = unblockResult.stdout + unblockResult.stderr;
    expect(combined).not.toContain('Worktree not found');
    expect(combined).not.toContain('not found locally or on remote');
  });

  // INVARIANT: When the worktree is gone but the branch exists on remote,
  // sync should fetch the remote branch and recover the worktree.
  test('sync recovers worktree from remote branch', async () => {
    addBareRemote(ctx);

    const taskId = await createTask(ctx, 'Sync recovery test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    await ctx.lazy(['show', taskId]);

    const showResult = await ctx.lazy(['show', taskId, '--json']);
    const showData = JSON.parse(showResult.stdout);
    const branchName = showData.session.git_branch;

    // Push the task branch to "remote"
    ctx.git('push', 'origin', branchName);

    // Force task to blocked
    setTaskStatus(ctx, taskId, 'blocked');

    // Delete the worktree and local branch
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    rmSync(worktreePath, { recursive: true, force: true });
    ctx.git('worktree', 'prune');
    ctx.git('branch', '-D', branchName);

    // Sync should recover from remote branch (and report up to date since
    // main hasn't changed since task was created)
    const syncResult = await ctx.lazy(['sync', taskId]);
    expectSuccess(syncResult);
    expectOutput(syncResult, 'up to date');

    // Worktree should be recreated
    expect(existsSync(worktreePath)).toBe(true);
  });
});

/**
 * Set a task's status in storage directly.
 * After lazyMocked start, the task may remain in 'working' because
 * reconciliation hasn't run yet. This forces a specific status.
 */
function setTaskStatus(ctx: TestContext, taskId: string, status: string): void {
  const tasksDir = join(homedir(), '.lazy', basename(ctx.root), 'tasks');
  const entries = readdirSync(tasksDir);
  const fullId = entries.find(e => e.startsWith(taskId));
  if (!fullId) throw new Error(`No task directory starting with ${taskId}`);
  const taskJsonPath = join(tasksDir, fullId, 'task.json');
  const taskData = JSON.parse(readFileSync(taskJsonPath, 'utf-8'));
  taskData.status = status;
  writeFileSync(taskJsonPath, JSON.stringify(taskData, null, 2) + '\n');
}
