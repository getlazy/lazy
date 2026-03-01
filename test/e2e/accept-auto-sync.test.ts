import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/**
 * Tests for accept auto-sync behavior when the GitHub driver is configured
 * but the task has no PR yet. Verifies that accept attempts to push and
 * create a PR automatically instead of failing with a misleading error.
 */
describe('lazy accept auto-sync', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
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

  test('accept with github driver auto-syncs when no PR exists', async () => {
    // 1. Create and start a task (with local driver first, so start works)
    const taskId = await createTask(ctx, 'Auto-sync test', 'Add a file');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

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

    // 4. Try to accept — should attempt auto-sync instead of old error
    const acceptResult = await ctx.lazy(['accept', taskId]);

    // The auto-sync will push (succeeds with bare remote) but PR creation
    // fails (no real GitHub). The accept should fail gracefully.
    expectFailure(acceptResult);

    // Should show the auto-sync attempt message
    expectOutput(acceptResult, 'No remote reference found');
    expectOutput(acceptResult, 'pushing branch and creating PR');

    // Should NOT show the old misleading "start the task" message
    expect(acceptResult.stderr).not.toContain('start the task to push the branch');
    expect(acceptResult.stderr).not.toContain('lazy start');
  });

  test('accept auto-sync failure shows correct error message', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'Error msg test', 'Add a file');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

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

    // 4. Accept should fail with the new accurate error message
    const acceptResult = await ctx.lazy(['accept', taskId]);
    expectFailure(acceptResult);

    // Should suggest `lazy sync` (not `lazy start`)
    expectError(acceptResult, 'lazy sync');

    // Should NOT contain the old misleading message
    expect(acceptResult.stdout).not.toContain('Or start the task');
    expect(acceptResult.stderr).not.toContain('Or start the task');
  });

  test('accept with local driver still works (no auto-sync needed)', async () => {
    // This verifies we didn't break the local driver path
    const taskId = await createTask(ctx, 'Local driver test', 'Add a file');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

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
