import { describe, test, beforeEach, afterEach } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from '../../src/utils/spawn';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/**
 * Tests for accept behavior on protected branches.
 *
 * INVARIANT: When accepting into a protected branch, lazy must refuse by default.
 * The user must either:
 * 1. Get the MR/PR approved externally, then re-run accept
 * 2. Set auto_approve = true in [remote] config
 *
 * Harness notes (why this suite is withDaemon + file-based):
 *   - `start`/`accept` require a real daemon (daemonless the task stays 'working'
 *     and accept refuses). The accept merge — including the protection gate —
 *     runs INSIDE the daemon, so per-test env on the CLI subprocess never reaches
 *     the driver. Protection state that is constant across the suite
 *     (LAZY_MOCK_PROTECTED_BRANCH, LAZY_MOCK_NEEDS_SYNC) is therefore set on the
 *     daemon via daemonEnv; the one per-test variable (external approval) is
 *     written to <protocolBase>/mock-approval.json, which the remote mock
 *     re-reads on every call (mirrors the accept-gates file mechanism).
 *   - LAZY_MOCK_ACCEPT_GATES='[]' activates the remote mock inside the daemon
 *     (see preload-mocks.ts) without injecting any blocking gate.
 *   - needsSync=true makes the preflight run validateBranchInSyncWithRemote, a
 *     REAL `git fetch origin main`; we add a bare origin and push main so the
 *     branch is in sync and the check passes.
 */
describe('lazy accept protected branch', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: {
        LAZY_MOCK_ACCEPT_GATES: '[]',
        LAZY_MOCK_PROTECTED_BRANCH: '1',
        LAZY_MOCK_NEEDS_SYNC: '1',
      },
    });

    // needsSync=true triggers a real `git fetch origin main` in preflight —
    // add a bare origin with main pushed so the sync check passes.
    const bareRemotePath = join(ctx.root, '.test-remote.git');
    const initBare = spawnSync(['git', 'init', '--bare', bareRemotePath], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (initBare.exitCode !== 0) throw new Error(`git init --bare failed: ${initBare.stderr}`);
    ctx.git('remote', 'add', 'origin', bareRemotePath);
    const push = ctx.git('push', 'origin', 'main');
    if (push.exitCode !== 0) throw new Error(`git push origin main failed: ${push.stderr}`);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** Toggle the remote-approval state the daemon's mock driver reads per accept. */
  function setApproval(state: { hasRemoteRef?: boolean; hasExternalApproval?: boolean }) {
    writeFileSync(join(ctx.protocolBase, 'mock-approval.json'), JSON.stringify(state));
  }

  /**
   * Helper: create a task, start it, wait for the reconciler to move it out of
   * 'working', and commit a file so it's ready for accept. The explicit `wait`
   * is mandatory because `start` launches the supervisor asynchronously.
   */
  async function setupBlockedTask(): Promise<string> {
    const taskId = await createTask(ctx, 'Protected branch test', 'Add a file');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    const waitResult = await ctx.lazy(['wait', taskId]);
    if (waitResult.exitCode !== 0) {
      throw new Error(`wait failed for ${taskId}: ${waitResult.stderr}\n${waitResult.stdout}`);
    }

    // Add a file in the worktree so there's something to merge
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    writeFileSync(join(worktreePath, 'protected-test.txt'), 'content\n');
    ctx.git('-C', worktreePath, 'add', 'protected-test.txt');
    ctx.git('-C', worktreePath, 'commit', '-m', 'Add protected test file');

    return taskId;
  }

  // INVARIANT: Accept refuses on protected branches by default (no auto_approve, no external approval).
  test('accept refuses on protected branch by default', async () => {
    const taskId = await setupBlockedTask();

    const result = await ctx.lazy(['accept', taskId, '--yes']);

    // The refusal is a 409 RpcError surfaced on stderr by the accept CLI.
    expectFailure(result);
    expectError(result, 'protection rules requiring approval');
    expectError(result, 'lazy submit');
  }, 15000);

  // INVARIANT: Accept proceeds when MR has external approval, even without auto_approve.
  test('accept succeeds on protected branch with external approval', async () => {
    const taskId = await setupBlockedTask();

    // Simulate an existing, approved remote ref.
    setApproval({ hasRemoteRef: true, hasExternalApproval: true });

    const result = await ctx.lazy(['accept', taskId, '--yes']);

    expectSuccess(result);
    expectOutput(result, 'accepted and merged');
  }, 15000);

  // INVARIANT: Accept proceeds on protected branch when auto_approve is configured.
  test('accept succeeds on protected branch with auto_approve config', async () => {
    const taskId = await setupBlockedTask();

    // Configure auto_approve in lazy.toml
    const configPath = join(ctx.root, 'lazy.toml');
    writeFileSync(configPath, '[remote]\nauto_approve = true\n');

    const result = await ctx.lazy(['accept', taskId, '--yes']);

    expectSuccess(result);
    expectOutput(result, 'accepted and merged');
  }, 15000);
});
