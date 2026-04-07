import { describe, test, beforeEach, afterEach } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/**
 * Tests for accept behavior on protected branches.
 *
 * INVARIANT: When accepting into a protected branch, lazy must refuse by default.
 * The user must either:
 * 1. Get the MR/PR approved externally, then re-run accept
 * 2. Set auto_approve = true in [remote] config
 *
 * These tests use LAZY_MOCK_PROTECTED_BRANCH to simulate branch protection and
 * LAZY_MOCK_HAS_EXTERNAL_APPROVAL to simulate existing approvals.
 */
describe('lazy accept protected branch', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /**
   * Helper: create a task, start it, and commit a file so it's ready for accept.
   */
  async function setupBlockedTask(): Promise<string> {
    const taskId = await createTask(ctx, 'Protected branch test', 'Add a file');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

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

    const result = await ctx.lazyMocked(['accept', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_PROTECTED_BRANCH: '1', LAZY_MOCK_NEEDS_SYNC: '1' },
    });

    expectFailure(result);
    expectOutput(result, 'protection rules requiring approval');
    expectOutput(result, 'lazy submit');
  });

  // INVARIANT: Accept proceeds when MR has external approval, even without auto_approve.
  test('accept succeeds on protected branch with external approval', async () => {
    const taskId = await setupBlockedTask();

    const result = await ctx.lazyMocked(['accept', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: {
        LAZY_MOCK_PROTECTED_BRANCH: '1',
        LAZY_MOCK_HAS_EXTERNAL_APPROVAL: '1',
        LAZY_MOCK_NEEDS_SYNC: '1',
      },
    });

    expectSuccess(result);
    expectOutput(result, 'accepted and merged');
  });

  // INVARIANT: Accept proceeds on protected branch when auto_approve is configured.
  test('accept succeeds on protected branch with auto_approve config', async () => {
    const taskId = await setupBlockedTask();

    // Configure auto_approve in lazy.toml
    const configPath = join(ctx.root, 'lazy.toml');
    writeFileSync(configPath, '[remote]\nauto_approve = true\n');

    const result = await ctx.lazyMocked(['accept', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_PROTECTED_BRANCH: '1', LAZY_MOCK_NEEDS_SYNC: '1' },
    });

    expectSuccess(result);
    expectOutput(result, 'accepted and merged');
  });
});
