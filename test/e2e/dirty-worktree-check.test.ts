import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask, disablePreAccept, startAndReconcile } from '../helpers/fixtures';
import { worktreePathFor } from '../helpers/storage';

/**
 * Tests that accept and close both refuse to proceed if the worktree
 * has uncommitted changes. This is the hardest gate to prevent data loss.
 */
describe('dirty worktree check — hard gate for accept/close', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    // Daemonless suite: no runner exists to execute the pre-accept agent turn,
    // and these tests assert on the dirty gate, not on pre-accept.
    disablePreAccept(ctx.root);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // ========== ACCEPT TESTS ==========

  test('accept refuses task with uncommitted changes in worktree', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'Accept test with dirty worktree', 'Add a file');

    // Reconcile too: accept/close refuse a task that is still 'working', and
    // only a reconcile pass moves it to 'blocked'.
    await startAndReconcile(ctx, taskId);

    // 2. Make an uncommitted change in the worktree
    const worktreePath = worktreePathFor(ctx.root, taskId);
    const worktreeFile = join(worktreePath, 'uncommitted.txt');
    writeFileSync(worktreeFile, 'uncommitted content\n');

    // 3. Try to accept — should fail because worktree is dirty
    const acceptResult = await ctx.lazy(['accept', taskId]);
    expectFailure(acceptResult, 1);
    expectError(acceptResult, 'uncommitted changes');
    expectError(acceptResult, 'Commit or stash changes before running accept');
  });

  test('accept succeeds when worktree is clean', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'Accept test with clean worktree', 'Add a file');

    // Reconcile too: accept/close refuse a task that is still 'working', and
    // only a reconcile pass moves it to 'blocked'.
    await startAndReconcile(ctx, taskId);

    // 2. Worktree should be clean — accept should succeed
    const acceptResult = await ctx.lazy(['accept', taskId]);
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'accepted');
  });

  // ========== CLOSE TESTS ==========
  // `lazy abandon` was removed; `lazy close` is its direct successor (same
  // --reason/--yes contract, same dirty-worktree gate, same abandoned status).

  test('close refuses task with uncommitted changes in worktree', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'Close test with dirty worktree', 'Some work');

    // Reconcile too: accept/close refuse a task that is still 'working', and
    // only a reconcile pass moves it to 'blocked'.
    await startAndReconcile(ctx, taskId);

    // 2. Make an uncommitted change in the worktree
    const worktreePath = worktreePathFor(ctx.root, taskId);
    const worktreeFile = join(worktreePath, 'uncommitted.txt');
    writeFileSync(worktreeFile, 'uncommitted content\n');

    // 3. Try to close — should fail because worktree is dirty
    const closeResult = await ctx.lazy(['close', taskId, '--reason', 'Test close', '--yes']);
    expectFailure(closeResult, 1);
    expectError(closeResult, 'uncommitted changes');
    expectError(closeResult, 'Commit or stash your changes');
  });

  test('close succeeds when worktree is clean', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'Close test with clean worktree', 'Some work');

    // Reconcile too: accept/close refuse a task that is still 'working', and
    // only a reconcile pass moves it to 'blocked'.
    await startAndReconcile(ctx, taskId);

    // 2. Worktree should be clean — close should succeed
    const closeResult = await ctx.lazy(['close', taskId, '--reason', 'Test close', '--yes']);
    expectSuccess(closeResult);
    // `close` prints "closed"; the resulting status is 'abandoned'.
    expectOutput(closeResult, 'closed');
    expectOutput(await ctx.lazy(['show', taskId]), 'abandoned');
  });

  test('close on task without session succeeds', async () => {
    // 1. Create a task without starting it (no worktree)
    const taskId = await createTask(ctx, 'Close test without session', 'Some work');

    // 2. Close should succeed (no worktree to check)
    const closeResult = await ctx.lazy(['close', taskId, '--reason', 'Not started']);
    expectSuccess(closeResult);
    // `close` prints "closed"; the resulting status is 'abandoned'.
    expectOutput(closeResult, 'closed');
    expectOutput(await ctx.lazy(['show', taskId]), 'abandoned');
  });

  // ========== EDGE CASES ==========

  test('dirty check catches staged but uncommitted changes', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'Staged changes test', 'Add a file');

    // Reconcile too: accept/close refuse a task that is still 'working', and
    // only a reconcile pass moves it to 'blocked'.
    await startAndReconcile(ctx, taskId);

    // 2. Create a staged (but not committed) change
    const worktreePath = worktreePathFor(ctx.root, taskId);
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

    // Reconcile too: accept/close refuse a task that is still 'working', and
    // only a reconcile pass moves it to 'blocked'.
    await startAndReconcile(ctx, taskId);

    // 2. Make an uncommitted change in the worktree
    const worktreePath = worktreePathFor(ctx.root, taskId);
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
