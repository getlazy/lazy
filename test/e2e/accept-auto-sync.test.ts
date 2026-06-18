import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/**
 * Tests for accept behavior when the GitHub driver is configured but the task
 * has no PR yet.
 *
 * NOTE: Since `fix-mr-targets-main`, merges into an UNPROTECTED target (which
 * includes `main` when the remote has no branch-protection rules — exactly the
 * case here, where the bare file-path remote has no protection) are LOCAL squash
 * merges and NEVER open a PR/MR. Since `fix-push-after-local-merge`, that local
 * merge also pushes the parent branch to origin. So these tests assert: accept
 * SUCCEEDS via a local merge, opens NO PR, and keeps origin in lockstep — not the
 * old (pre-routing) behavior of auto-creating a PR.
 */
describe('lazy accept auto-sync', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // INVARIANT: `start` + `accept` require a real daemon. Since the v0.11
    // daemon refactor (93f6a839), CLI commands must go through the daemon
    // for storage — LAZY_TEST=1 no longer falls back to FileStorage. Tests
    // that exercise `start`/`accept` must run against a real daemon.
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /**
   * Helper: switch the test repo to use GitHub driver.
   * Also sets up a local bare remote so git push succeeds.
   */
  function switchToGitHubDriver() {
    // Update lazy.toml to use github driver
    const tomlPath = join(ctx.root, 'lazy.toml');
    let toml = readFileSync(tomlPath, 'utf-8');
    toml = toml.replace('driver = "local"', 'driver = "github"');
    writeFileSync(tomlPath, toml);

    // Set up a local bare remote inside the test dir so pushBranch succeeds
    const bareRemotePath = join(ctx.root, '.test-remote.git');
    const initBare = Bun.spawnSync(['git', 'init', '--bare', bareRemotePath], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(initBare.exitCode).toBe(0);

    // Check if origin remote already exists
    const checkRemote = ctx.git('remote', 'get-url', 'origin');
    if (checkRemote.exitCode === 0) {
      // Remote exists — update its URL
      const setUrl = ctx.git('remote', 'set-url', 'origin', bareRemotePath);
      expect(setUrl.exitCode).toBe(0);
    } else {
      const addRemote = ctx.git('remote', 'add', 'origin', bareRemotePath);
      expect(addRemote.exitCode).toBe(0);
    }

    // Push main to the bare remote so it exists there
    const pushMain = ctx.git('push', '-u', 'origin', 'main');
    if (pushMain.exitCode !== 0) {
      throw new Error(`Push to origin failed: ${pushMain.stderr}`);
    }
  }

  // INVARIANT (fix-mr-targets-main + fix-push-after-local-merge): merging into an
  // UNPROTECTED `main` is a LOCAL squash merge that opens NO PR and pushes the
  // merged branch to origin. Accept must SUCCEED — it must NOT fail trying to
  // create a PR (the pre-routing behavior).
  test('accept with github driver into unprotected main does a local merge (no PR)', async () => {
    // 1. Create and start a task (with local driver first, so start works)
    const taskId = await createTask(ctx, 'Auto-sync test', 'Add a file');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // INVARIANT: `start` launches the supervisor asynchronously via the
    // daemon — it returns before the task transitions out of 'working'.
    // Wait for the daemon reconciler to pick up the supervisor's response
    // and move the task to a non-'working' state before calling accept.
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

    // 2. Add a commit in the worktree
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    const worktreeFile = join(worktreePath, 'new-file.txt');
    writeFileSync(worktreeFile, 'some content\n');

    const gitAddWorktree = ctx.git('-C', worktreePath, 'add', 'new-file.txt');
    expect(gitAddWorktree.exitCode).toBe(0);

    const gitCommitWorktree = ctx.git('-C', worktreePath, 'commit', '-m', 'Add new file');
    expect(gitCommitWorktree.exitCode).toBe(0);

    // 3. Switch to GitHub driver (task has no PR in metadata)
    switchToGitHubDriver();

    // 4. Accept — unprotected main → local merge + push, never a PR.
    const acceptResult = await ctx.lazy(['accept', taskId]);
    expectSuccess(acceptResult);

    // No PR was created and no auto-sync PR path ran.
    expect(acceptResult.stderr).not.toContain('PR creation failed');
    expect(acceptResult.stdout).not.toContain('No remote reference found');
    // Should NOT show the old misleading "start the task" message
    expect(acceptResult.stderr).not.toContain('start the task to push the branch');
    expect(acceptResult.stderr).not.toContain('lazy start');
  });

  // INVARIANT (fix-push-after-local-merge): the local merge into unprotected main
  // pushes the merged branch to origin, so local and origin stay in lockstep.
  test('accept into unprotected main pushes the merge to origin (no divergence)', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'No-divergence test', 'Add a file');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // Wait for the daemon reconciler (see test above for rationale).
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

    // 2. Add a commit in the worktree
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    const worktreeFile = join(worktreePath, 'new-file.txt');
    writeFileSync(worktreeFile, 'some content\n');

    const gitAddWorktree = ctx.git('-C', worktreePath, 'add', 'new-file.txt');
    expect(gitAddWorktree.exitCode).toBe(0);

    const gitCommitWorktree = ctx.git('-C', worktreePath, 'commit', '-m', 'Add new file');
    expect(gitCommitWorktree.exitCode).toBe(0);

    // 3. Switch to GitHub driver (with bare remote for push)
    switchToGitHubDriver();
    const bareRemotePath = join(ctx.root, '.test-remote.git');

    // 4. Accept should succeed and leave origin/main == local main.
    const acceptResult = await ctx.lazy(['accept', taskId]);
    expectSuccess(acceptResult);

    const localMain = ctx.git('rev-parse', 'main').stdout.trim();
    const originMain = ctx.git('--git-dir', bareRemotePath, 'rev-parse', 'main').stdout.trim();
    expect(originMain).toBe(localMain);
  });

  test('accept with local driver still works (no auto-sync needed)', async () => {
    // This verifies we didn't break the local driver path
    const taskId = await createTask(ctx, 'Local driver test', 'Add a file');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // Wait for the daemon reconciler (see tests above for rationale).
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

    // Add a commit in the worktree
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    const worktreeFile = join(worktreePath, 'new-file.txt');
    writeFileSync(worktreeFile, 'some content\n');

    const gitAddWorktree = ctx.git('-C', worktreePath, 'add', 'new-file.txt');
    expect(gitAddWorktree.exitCode).toBe(0);

    const gitCommitWorktree = ctx.git('-C', worktreePath, 'commit', '-m', 'Add new file');
    expect(gitCommitWorktree.exitCode).toBe(0);

    // Accept should succeed — local driver has no PR requirement
    const acceptResult = await ctx.lazy(['accept', taskId]);
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'accepted and merged');

    // Should NOT show any auto-sync messages
    expect(acceptResult.stdout).not.toContain('No remote reference found');
  });
});
