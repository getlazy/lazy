import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/**
 * Tests that accept, reject, and close all refuse to proceed if the worktree
 * has uncommitted changes. This is the hardest gate to prevent data loss.
 */
describe('dirty worktree check — hard gate for accept/reject/close', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // ========== ACCEPT TESTS ==========

  test('accept refuses task with uncommitted changes in worktree', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'Accept test with dirty worktree', 'Add a file');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // 2. Make an uncommitted change in the worktree
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    const worktreeFile = join(worktreePath, 'uncommitted.txt');
    writeFileSync(worktreeFile, 'uncommitted content\n');

    // 3. Try to accept — should fail because worktree is dirty
    const acceptResult = await ctx.lazy(['accept', taskId]);
    expectFailure(acceptResult, 1);
    expectError(acceptResult, 'uncommitted changes');
    expectError(acceptResult, 'Commit or stash your changes');
  });

  test('accept succeeds when worktree is clean', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'Accept test with clean worktree', 'Add a file');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // 2. Worktree should be clean — accept should succeed
    const acceptResult = await ctx.lazy(['accept', taskId]);
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'accepted');
  });

  // ========== REJECT TESTS ==========

  test('reject refuses task with uncommitted changes in worktree', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'Reject test with dirty worktree', 'Some work');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // 2. Make an uncommitted change in the worktree
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    const worktreeFile = join(worktreePath, 'uncommitted.txt');
    writeFileSync(worktreeFile, 'uncommitted content\n');

    // 3. Try to reject — should fail because worktree is dirty
    const rejectResult = await ctx.lazy(['reject', taskId, '--reason', 'Test rejection', '--yes']);
    expectFailure(rejectResult, 1);
    expectError(rejectResult, 'uncommitted changes');
    expectError(rejectResult, 'Commit or stash your changes');
  });

  test('reject succeeds when worktree is clean', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'Reject test with clean worktree', 'Some work');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // 2. Worktree should be clean — reject should succeed
    const rejectResult = await ctx.lazy(['reject', taskId, '--reason', 'Test rejection', '--yes']);
    expectSuccess(rejectResult);
    expectOutput(rejectResult, 'rejected');
  });

  // ========== CLOSE TESTS ==========

  test('close refuses task with uncommitted changes in worktree', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'Close test with dirty worktree', 'Some work');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // 2. Make an uncommitted change in the worktree
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    const worktreeFile = join(worktreePath, 'uncommitted.txt');
    writeFileSync(worktreeFile, 'uncommitted content\n');

    // 3. Try to close — should fail because worktree is dirty
    const closeResult = await ctx.lazy(['close', taskId, '--reason', 'Test close']);
    expectFailure(closeResult, 1);
    expectError(closeResult, 'uncommitted changes');
    expectError(closeResult, 'Commit or stash your changes');
  });

  test('close succeeds when worktree is clean', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'Close test with clean worktree', 'Some work');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // 2. Worktree should be clean — close should succeed
    const closeResult = await ctx.lazy(['close', taskId, '--reason', 'Test close']);
    expectSuccess(closeResult);
    expectOutput(closeResult, 'closed');
  });

  test('close on task without session succeeds', async () => {
    // 1. Create a task without starting it (no worktree)
    const taskId = await createTask(ctx, 'Close test without session', 'Some work');

    // 2. Close should succeed (no worktree to check)
    const closeResult = await ctx.lazy(['close', taskId, '--reason', 'Not started']);
    expectSuccess(closeResult);
    expectOutput(closeResult, 'closed');
  });

  // ========== EDGE CASES ==========

  test('dirty check catches staged but uncommitted changes', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'Staged changes test', 'Add a file');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // 2. Create a staged (but not committed) change
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    const worktreeFile = join(worktreePath, 'staged.txt');
    writeFileSync(worktreeFile, 'staged content\n');

    const gitAdd = await ctx.git('-C', worktreePath, 'add', 'staged.txt');
    expect(gitAdd.exitCode).toBe(0);

    // 3. Try to accept — should fail (staged changes are uncommitted)
    const acceptResult = await ctx.lazy(['accept', taskId]);
    expectFailure(acceptResult, 1);
    expectError(acceptResult, 'uncommitted changes');
  });

  test('dirty check is first gate before pairing lock in accept', async () => {
    // This test verifies that we check for dirty worktree before checking pairing lock.
    // If someone tries to accept with uncommitted changes while pairing, they should get
    // the "uncommitted changes" error first, not the "pairing lock" error.

    // 1. Create and start a task
    const taskId = await createTask(ctx, 'Dirty before pairing test', 'Add a file');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // 2. Make an uncommitted change in the worktree
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    const worktreeFile = join(worktreePath, 'uncommitted.txt');
    writeFileSync(worktreeFile, 'uncommitted content\n');

    // 3. Create a pairing lock
    const lockDir = join(ctx.root, '.lazy', 'locks');
    Bun.spawnSync(['mkdir', '-p', lockDir]);
    const lockFile = join(lockDir, `${taskId}.lock`);
    writeFileSync(lockFile, 'pairing-lock');

    // 4. Try to accept — should fail with uncommitted changes error, not pairing error
    const acceptResult = await ctx.lazy(['accept', taskId]);
    expectFailure(acceptResult, 1);
    expectError(acceptResult, 'uncommitted changes');
  });
});
