import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/**
 * Resolve the tasks directory for the test project. Test projects init with
 * external storage (external_path in lazy.toml), so tasks live outside the repo
 * — reading root/.lazy/tasks finds nothing. Fall back to the in-repo layout only
 * when no external_path is configured. Mirrors tasksDirFor() in
 * auto-react-budget.test.ts / reconcile.test.ts.
 */
function tasksDirFor(root: string): string {
  const toml = readFileSync(join(root, 'lazy.toml'), 'utf-8');
  const m = toml.match(/^external_path\s*=\s*"(.+)"/m);
  if (m && m[1]) return join(m[1], 'tasks');
  return join(root, '.lazy', 'tasks');
}

/**
 * Find the full task UUID from a short (8-char) prefix.
 */
function findFullTaskId(root: string, shortId: string): string {
  const tasksDir = tasksDirFor(root);
  const dirs = readdirSync(tasksDir);
  const match = dirs.find(d => d.startsWith(shortId));
  if (!match) throw new Error(`Task directory not found for ${shortId}`);
  return match;
}

/**
 * Point a root task at a named integration branch by directly editing task.json.
 *
 * Since the TaskTarget refactor, a task's merge target is the discriminated-union
 * `task.target` field ({ kind: 'branch', branch } for root tasks) — the legacy
 * `metadata.remote_target_branch` key is only consulted by FileStorage when
 * `task.target` is absent (see file-storage.ts). Current tasks always carry
 * `task.target`, so setting the legacy metadata alone is a no-op; we must write
 * `task.target` directly.
 */
function setTargetBranch(root: string, shortId: string, targetBranch: string): void {
  const fullId = findFullTaskId(root, shortId);
  const taskPath = join(tasksDirFor(root), fullId, 'task.json');
  const task = JSON.parse(readFileSync(taskPath, 'utf-8'));
  task.target = { kind: 'branch', branch: targetBranch };
  writeFileSync(taskPath, JSON.stringify(task, null, 2));
}

/**
 * Tests for accept command using remote_target_branch metadata
 * instead of hardcoding 'main' as the merge target for root tasks.
 */
describe('lazy accept target branch', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // INVARIANT: `start` + `accept` need a real daemon. Daemonless, the task
    // stays 'working' and accept refuses ("Task X is still working"). Mirrors
    // accept-reason / accept-gates.
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /**
   * Start a task and wait for the reconciler to move it out of 'working'. The
   * explicit `wait` is mandatory because `start` launches the supervisor
   * asynchronously under the daemon.
   */
  async function startAndWait(taskId: string): Promise<void> {
    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    const waitResult = await ctx.lazy(['wait', taskId]);
    if (waitResult.exitCode !== 0) {
      throw new Error(`wait failed for ${taskId}: ${waitResult.stderr}\n${waitResult.stdout}`);
    }
  }

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

    await startAndWait(taskId);

    // 3. Point the task at the feature branch
    setTargetBranch(ctx.root, taskId, 'feature/custom-branch');

    // 4. Add a commit in the worktree
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    writeFileSync(join(worktreePath, 'new-file.txt'), 'some content\n');
    ctx.git('-C', worktreePath, 'add', 'new-file.txt');
    ctx.git('-C', worktreePath, 'commit', '-m', 'Add new file');

    // 5. Accept should merge into feature/custom-branch, not main.
    // INVARIANT: a root task with a branch target integrates into that branch.
    // The accept success message no longer echoes the branch name (it's just
    // "accepted and merged."), so verify the target via git: the merged file
    // must land on feature/custom-branch and NOT on main.
    const acceptResult = await ctx.lazy(['accept', taskId]);
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'accepted and merged');
    expect(ctx.git('cat-file', '-e', 'feature/custom-branch:new-file.txt').exitCode).toBe(0);
    expect(ctx.git('cat-file', '-e', 'main:new-file.txt').exitCode).not.toBe(0);
  });

  test('accept falls back to main when no branch target is set', async () => {
    // 1. Create and start a task (default branch target — main)
    const taskId = await createTask(ctx, 'Fallback test', 'Add a file');

    await startAndWait(taskId);

    // 2. Add a commit in the worktree
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    writeFileSync(join(worktreePath, 'new-file.txt'), 'some content\n');
    ctx.git('-C', worktreePath, 'add', 'new-file.txt');
    ctx.git('-C', worktreePath, 'commit', '-m', 'Add new file');

    // 3. Accept should merge into main (the default). The success message no
    //    longer echoes the branch name, so verify the merge landed on main.
    const acceptResult = await ctx.lazy(['accept', taskId]);
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'accepted and merged');
    expect(ctx.git('cat-file', '-e', 'main:new-file.txt').exitCode).toBe(0);
  });

  // INVARIANT: conflict detection and the resulting message reference the task's
  // configured target branch (ivan/deno-v2), NOT a hardcoded 'main'. Non-interactive
  // accept auto-invokes sync-with-upstream on conflict (see accept-conflicts), so
  // this succeeds after auto-sync — the message still names the correct target.
  test('accept with conflicts references correct target branch in message', async () => {
    // 1. Create a feature branch with content
    ctx.git('checkout', '-b', 'ivan/deno-v2');
    writeFileSync(join(ctx.root, 'test.txt'), 'feature branch content\n');
    ctx.git('add', 'test.txt');
    ctx.git('commit', '-m', 'Add test file on feature branch');
    ctx.git('checkout', 'main');

    // 2. Create and start a task
    const taskId = await createTask(ctx, 'Conflict target test', 'Add a file');

    await startAndWait(taskId);

    // 3. Point the task at the feature branch
    setTargetBranch(ctx.root, taskId, 'ivan/deno-v2');

    // 4. Create a conflicting file in the worktree
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    writeFileSync(join(worktreePath, 'test.txt'), 'task branch content\n');
    ctx.git('-C', worktreePath, 'add', 'test.txt');
    ctx.git('-C', worktreePath, 'commit', '-m', 'Add conflicting content');

    // 5. Accept should detect conflicts with ivan/deno-v2, not main. Uses
    //    lazyMocked because the auto-sync fallback launches a supervisor.
    const acceptResult = await ctx.lazyMocked(['accept', taskId], MOCK_CLAUDE_SUCCESS);
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'Session branch has conflicts with ivan/deno-v2');
    expectOutput(acceptResult, 'Automatically syncing with upstream');
  });
});
