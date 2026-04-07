import { describe, test, beforeEach, afterEach } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/**
 * Tests for accept pre-merge gates (CI, reviews, unresolved comments).
 *
 * INVARIANT: Accept should refuse to merge when pre-merge gates are failing.
 * There is no override — the user must resolve the issues on the PR/MR.
 * This prevents accidental merges of broken or unreviewed code, even when
 * the user has admin privileges that would let `gh pr merge` bypass branch
 * protection.
 *
 * These tests use LAZY_MOCK_ACCEPT_GATES to inject gate warnings into the
 * mock remote driver, simulating failing CI, pending reviews, etc.
 */
describe('lazy accept gates', () => {
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
    const taskId = await createTask(ctx, 'Gate test task', 'Add a file');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // Add a file in the worktree so there's something to merge
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    writeFileSync(join(worktreePath, 'gate-test.txt'), 'content\n');

    const gitAdd = ctx.git('-C', worktreePath, 'add', 'gate-test.txt');
    const gitCommit = ctx.git('-C', worktreePath, 'commit', '-m', 'Add gate test file');

    return taskId;
  }

  // INVARIANT: Accept blocks when CI checks are failing.
  test('accept blocks on failing CI', async () => {
    const taskId = await setupBlockedTask();

    const gates = JSON.stringify([
      { gate: 'ci', message: 'CI checks failing: lint, test' },
    ]);

    const result = await ctx.lazyMocked(['accept', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_ACCEPT_GATES: gates },
    });

    expectFailure(result);
    expectOutput(result, 'Merge blocked by pre-merge gates');
    expectOutput(result, 'CI checks failing: lint, test');
  });

  // INVARIANT: Accept blocks when reviews are pending.
  test('accept blocks on pending reviews', async () => {
    const taskId = await setupBlockedTask();

    const gates = JSON.stringify([
      { gate: 'reviews', message: 'Changes requested (status: CHANGES_REQUESTED)' },
    ]);

    const result = await ctx.lazyMocked(['accept', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_ACCEPT_GATES: gates },
    });

    expectFailure(result);
    expectOutput(result, 'Merge blocked by pre-merge gates');
    expectOutput(result, 'Changes requested');
  });

  // INVARIANT: Accept blocks on unresolved review comments.
  test('accept blocks on unresolved comments', async () => {
    const taskId = await setupBlockedTask();

    const gates = JSON.stringify([
      { gate: 'comments', message: '3 unresolved review threads' },
    ]);

    const result = await ctx.lazyMocked(['accept', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_ACCEPT_GATES: gates },
    });

    expectFailure(result);
    expectOutput(result, 'Merge blocked by pre-merge gates');
    expectOutput(result, 'unresolved review threads');
  });

  // INVARIANT: Accept succeeds normally when no gates are failing.
  test('accept succeeds when all gates pass', async () => {
    const taskId = await setupBlockedTask();

    // No LAZY_MOCK_ACCEPT_GATES — uses local driver which returns no warnings
    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(result);
    expectOutput(result, 'accepted and merged');
  });
});
