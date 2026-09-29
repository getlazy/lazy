import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask, disablePreAccept, startAndReconcile } from '../helpers/fixtures';
import { seedFinal } from '../helpers/final';
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

  // INVARIANT (turn-end-dirty-worktree-loss): the refusal NAMES the paths.
  // This is the last thing standing between work an agent left loose and a
  // merge that drops it, and an unnamed "uncommitted changes" reads like lint —
  // the cheapest way past it is to discard and retry, which IS the loss. Four
  // tasks left their end-of-turn docs uncommitted and every one was caught only
  // by a human running `git status` by hand; this runs it for them.
  test('the accept refusal names the uncommitted paths and says they are not on the branch', async () => {
    const taskId = await createTask(ctx, 'Accept names dirty paths', 'Add a file');
    await startAndReconcile(ctx, taskId);

    const worktreePath = worktreePathFor(ctx.root, taskId);
    writeFileSync(join(worktreePath, 'docs-note.md'), 'the doc nobody committed\n');
    writeFileSync(join(worktreePath, 'second.txt'), 'and another\n');

    const acceptResult = await ctx.lazy(['accept', taskId]);
    expectFailure(acceptResult, 1);
    expectError(acceptResult, 'docs-note.md');
    expectError(acceptResult, 'second.txt');
    expectError(acceptResult, 'None of it is on the branch');
  });


  // INVARIANT (submodule-gitdir-config-guard): accept refuses by name while a
  // submodule git dir inside the task's gitdir carries config git would run.
  // Left to runGit alone, the dirty check above reads the refused git as
  // "clean", so accept would proceed and could drop loose work.
  test('accept refuses while a submodule git dir carries a planted fsmonitor', async () => {
    const taskId = await createTask(ctx, 'Accept with planted submodule config', 'Add a file');
    await startAndReconcile(ctx, taskId);
    seedFinal(ctx, taskId);

    const worktreePath = worktreePathFor(ctx.root, taskId);
    const gitdir = readFileSync(join(worktreePath, '.git'), 'utf-8').replace(/^gitdir: /, '').trim();
    const sub = join(gitdir, 'modules', 'lib');
    mkdirSync(join(sub, 'objects'), { recursive: true });
    mkdirSync(join(sub, 'refs'), { recursive: true });
    writeFileSync(join(sub, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(sub, 'config'), '[core]\n\tbare = false\n\tfsmonitor = /tmp/payload.sh\n');

    const acceptResult = await ctx.lazy(['accept', taskId]);
    expectFailure(acceptResult, 1);
    expectError(acceptResult, 'core.fsmonitor');
    expectError(acceptResult, 'lazy doctor --repair-git-pointers');
  });
  test('accept succeeds when worktree is clean', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'Accept test with clean worktree', 'Add a file');

    // Reconcile too: accept/close refuse a task that is still 'working', and
    // only a reconcile pass moves it to 'blocked'.
    await startAndReconcile(ctx, taskId);

    // Fixture setup, not the subject (see test/helpers/final.ts).
    seedFinal(ctx, taskId);

    // 2. Worktree should be clean — accept should succeed
    const acceptResult = await ctx.lazy(['accept', taskId]);
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'accepted');
  });

  // INVARIANT (nested-git-dir-in-worktree): accept refuses while the worktree
  // holds a nested repository its base branch does not have, NAMING it — even
  // when the task hid it from `git status` so the dirty gate cannot see it.
  // Its config would run for whoever opens that folder with git or an IDE.
  test('accept refuses a worktree holding a planted nested repository, naming it', async () => {
    const taskId = await createTask(ctx, 'Accept test with nested repo', 'Add a file');
    await startAndReconcile(ctx, taskId);

    const worktreePath = worktreePathFor(ctx.root, taskId);
    mkdirSync(join(worktreePath, 'sub', '.git'), { recursive: true });
    writeFileSync(join(worktreePath, 'sub', '.git', 'config'), '[core]\n\tfsmonitor = /tmp/payload.sh\n');
    // Hidden from the dirty gate, as a task hiding it would.
    appendFileSync(join(ctx.root, '.git', 'info', 'exclude'), '\nsub/\n');

    const acceptResult = await ctx.lazy(['accept', taskId]);
    expectFailure(acceptResult, 1);
    expectError(acceptResult, 'nested git repositories');
    expectError(acceptResult, 'sub/.git');
    expectError(acceptResult, 'lazy doctor --repair-git-pointers');
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
