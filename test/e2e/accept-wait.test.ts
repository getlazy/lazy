import { describe, test, beforeEach, afterEach } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/**
 * Tests for the accept --wait flag.
 *
 * INVARIANT: The --wait flag tells accept to poll CI checks and retry the merge
 * when the initial merge fails due to pending checks. This avoids wasting an
 * agent turn on pure infrastructure work (merge upstream + push).
 *
 * Note: These e2e tests use the local driver (no remote), so waitForChecks
 * always returns { passed: true }. The polling behavior is tested in
 * test/unit/github-driver-wait-for-checks.test.ts.
 */
describe('lazy accept --wait', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // INVARIANT: `start` + `accept` need a real daemon. Daemonless, the task
    // stays 'working' and accept refuses ("Task X is still working"). Mirrors
    // accept-reason / accept-gates.
    ctx = await setupTestLazy({ withDaemon: true });
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

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: --wait is a valid flag that doesn't cause errors.
  test('accept with --wait succeeds on clean merge (local driver)', async () => {
    const taskId = await createTask(ctx, 'Wait test', 'Add a file');

    await startAndWait(taskId);

    // Add a non-conflicting file in the worktree
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    writeFileSync(join(worktreePath, 'new-file.txt'), 'content\n');

    const gitAdd = await ctx.git('-C', worktreePath, 'add', 'new-file.txt');
    const gitCommit = await ctx.git('-C', worktreePath, 'commit', '-m', 'Add file');

    // Accept with --wait should succeed normally
    const acceptResult = await ctx.lazy(['accept', taskId, '--wait']);
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'accepted and merged');
  });

  // INVARIANT: --wait combines with --yes and --reason flags.
  test('accept with --wait --yes --reason succeeds', async () => {
    const taskId = await createTask(ctx, 'Wait combined flags', 'Add a file');

    await startAndWait(taskId);

    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    writeFileSync(join(worktreePath, 'combined.txt'), 'content\n');

    await ctx.git('-C', worktreePath, 'add', 'combined.txt');
    await ctx.git('-C', worktreePath, 'commit', '-m', 'Add combined file');

    const acceptResult = await ctx.lazy(['accept', taskId, '--wait', '--yes', '--reason', 'Ship it']);
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'accepted and merged');
  });

  // INVARIANT: --wait doesn't change conflict handling behavior.
  // Non-interactive accept (including --wait) auto-invokes sync-with-upstream on conflict.
  test('accept with --wait auto-invokes sync-with-upstream on conflict', async () => {
    const taskId = await createTask(ctx, 'Wait conflict test', 'Add a file');

    await startAndWait(taskId);

    // Create conflicting content on main
    writeFileSync(join(ctx.root, 'conflict.txt'), 'main content\n');
    await ctx.git('add', 'conflict.txt');
    await ctx.git('commit', '-m', 'Add conflicting file on main');

    // Create conflicting content in worktree
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    writeFileSync(join(worktreePath, 'conflict.txt'), 'task content\n');
    await ctx.git('-C', worktreePath, 'add', 'conflict.txt');
    await ctx.git('-C', worktreePath, 'commit', '-m', 'Add conflicting file on task');

    // --wait should not affect conflict handling — conflicts are handled before checks.
    // Non-interactive mode auto-invokes sync-with-upstream.
    const acceptResult = await ctx.lazyMocked(['accept', taskId, '--wait'], MOCK_CLAUDE_SUCCESS);
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'Session branch has conflicts with main');
    expectOutput(acceptResult, 'Automatically syncing with upstream');
  });
});
