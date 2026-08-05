import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/**
 * Tests for accept command behavior when conflicts are detected.
 *
 * Note: The interactive mode (TTY + no --yes flag) cannot be easily tested
 * in the e2e framework since it requires user input via promptYesNo().
 * These tests focus on non-interactive mode behavior.
 */
describe('lazy accept with conflicts', () => {
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

  // INVARIANT: Non-interactive accept auto-invokes sync-with-upstream on conflict.
  // When accept detects merge conflicts in non-interactive mode (no TTY or --yes),
  // it automatically triggers sync-with-upstream instead of just printing manual
  // instructions. This prevents the common failure mode where `lazy accept` fails
  // with conflicts and the user has to manually run `lazy unblock --sync-with-upstream`.
  test('accept with conflicts in non-interactive mode auto-invokes sync-with-upstream', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'Conflict test', 'Add a file');

    await startAndWait(taskId);

    // 2. Make a conflicting change on main
    const testFile = join(ctx.root, 'test.txt');
    writeFileSync(testFile, 'main branch content\n');

    const gitAdd = await ctx.git('add', 'test.txt');
    expect(gitAdd.exitCode).toBe(0);

    const gitCommit = await ctx.git('commit', '-m', 'Add conflicting content on main');
    expect(gitCommit.exitCode).toBe(0);

    // 3. Make the same file in the worktree with different content
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    const worktreeFile = join(worktreePath, 'test.txt');
    writeFileSync(worktreeFile, 'task branch content\n');

    const gitAddWorktree = await ctx.git('-C', worktreePath, 'add', 'test.txt');
    expect(gitAddWorktree.exitCode).toBe(0);

    const gitCommitWorktree = await ctx.git('-C', worktreePath, 'commit', '-m', 'Add conflicting content on task branch');
    expect(gitCommitWorktree.exitCode).toBe(0);

    // 4. Try to accept — should detect conflict and auto-invoke sync-with-upstream.
    // Uses lazyMocked because auto-sync triggers unblock which launches a supervisor.
    const acceptResult = await ctx.lazyMocked(['accept', taskId], MOCK_CLAUDE_SUCCESS);
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'Session branch has conflicts with main');
    expectOutput(acceptResult, 'Automatically syncing with upstream');
    expectOutput(acceptResult, 'Retry when ready');
  });

  // INVARIANT: --yes flag also auto-invokes sync-with-upstream on conflict.
  // The --yes flag puts accept in non-interactive mode, which auto-syncs.
  test('accept with conflicts and --yes flag auto-invokes sync-with-upstream', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'Conflict test with --yes', 'Add a file');

    await startAndWait(taskId);

    // 2. Make a conflicting change on main
    const testFile = join(ctx.root, 'test.txt');
    writeFileSync(testFile, 'main branch content\n');

    const gitAdd = await ctx.git('add', 'test.txt');
    expect(gitAdd.exitCode).toBe(0);

    const gitCommit = await ctx.git('commit', '-m', 'Add conflicting content on main');
    expect(gitCommit.exitCode).toBe(0);

    // 3. Make the same file in the worktree with different content
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    const worktreeFile = join(worktreePath, 'test.txt');
    writeFileSync(worktreeFile, 'task branch content\n');

    const gitAddWorktree = await ctx.git('-C', worktreePath, 'add', 'test.txt');
    expect(gitAddWorktree.exitCode).toBe(0);

    const gitCommitWorktree = await ctx.git('-C', worktreePath, 'commit', '-m', 'Add conflicting content on task branch');
    expect(gitCommitWorktree.exitCode).toBe(0);

    // 4. Try to accept with --yes — should auto-invoke sync-with-upstream
    const acceptResult = await ctx.lazyMocked(['accept', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'Session branch has conflicts with main');
    expectOutput(acceptResult, 'Automatically syncing with upstream');
  });

  test('accept refuses task with zero commits', async () => {
    // 1. Create and start a task whose branch has nothing to merge.
    const taskId = await createTask(ctx, 'Zero commit test', 'Add a file');

    // startAndWait passes LAZY_MOCK_SHOULD_COMMIT to the CLI, but the daemon's
    // agent ignores it, so the branch never diverges from main — nothing to merge.
    await startAndWait(taskId);

    // 2. Try to accept — should hard refuse since there is nothing to merge.
    //
    // INVARIANT: accept refuses a task whose branch has no changes to merge and
    // directs the user to `lazy close`/`lazy reject` instead. Under the daemon
    // harness the mock run records an (empty) session commit, so this surfaces
    // as the git-level "no changes relative to main" refusal rather than the
    // storage-level "has no commits" preflight — both are the same refusal with
    // the same remedy.
    const acceptResult = await ctx.lazy(['accept', taskId]);
    expectFailure(acceptResult, 1);
    expectError(acceptResult, 'has no changes relative to main');
    expectError(acceptResult, 'lazy close');
  });

  test('accept without conflicts succeeds', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'No conflict test', 'Add a file');

    await startAndWait(taskId);

    // 2. Make a non-conflicting change in the worktree
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    const worktreeFile = join(worktreePath, 'new-file.txt');
    writeFileSync(worktreeFile, 'some content\n');

    const gitAddWorktree = await ctx.git('-C', worktreePath, 'add', 'new-file.txt');
    expect(gitAddWorktree.exitCode).toBe(0);

    const gitCommitWorktree = await ctx.git('-C', worktreePath, 'commit', '-m', 'Add new file');
    expect(gitCommitWorktree.exitCode).toBe(0);

    // 3. Accept should succeed
    const acceptResult = await ctx.lazy(['accept', taskId]);
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'accepted and merged');
  });
});
