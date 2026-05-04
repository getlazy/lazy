import { describe, test, beforeEach, afterEach } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
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
 * These tests inject gate warnings into the mock remote driver via the file
 * <protocolBase>/mock-accept-gates.json, simulating failing CI, pending
 * reviews, etc. The file is read fresh on each checkAcceptGates() call so
 * tests can vary gates without restarting the daemon.
 */
describe('lazy accept gates', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // INVARIANT: see remote-driver.test.ts — `start`/`accept` need a real daemon.
    // LAZY_MOCK_ACCEPT_GATES='[]' on the daemon activates the remote mock so
    // the daemon's accept handler resolves the mock driver (whose
    // checkAcceptGates re-reads <protocolBase>/mock-accept-gates.json per call).
    // Per-test env on lazyMocked() reaches the CLI subprocess only — NOT the
    // long-running daemon — so the file-based mechanism is required.
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: { LAZY_MOCK_ACCEPT_GATES: '[]' },
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** Write gate warnings the daemon's mock driver will pick up on next accept. */
  function setGates(gates: Array<{ gate: string; message: string }>) {
    writeFileSync(join(ctx.protocolBase, 'mock-accept-gates.json'), JSON.stringify(gates));
  }

  /**
   * Helper: create a task, start it, and commit a file so it's ready for accept.
   */
  async function setupBlockedTask(): Promise<string> {
    const taskId = await createTask(ctx, 'Gate test task', 'Add a file');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // INVARIANT: `start` launches the supervisor asynchronously via the
    // daemon — wait for reconciler to move task out of 'working' before
    // calling accept (see accept-auto-sync.test.ts for details).
    const waitResult = await ctx.lazy(['wait', taskId]);
    if (waitResult.exitCode !== 0) {
      throw new Error(`wait failed: ${waitResult.stderr}\n${waitResult.stdout}`);
    }

    // Add a file in the worktree so there's something to merge
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    writeFileSync(join(worktreePath, 'gate-test.txt'), 'content\n');

    ctx.git('-C', worktreePath, 'add', 'gate-test.txt');
    ctx.git('-C', worktreePath, 'commit', '-m', 'Add gate test file');

    return taskId;
  }

  // INVARIANT: Accept blocks when CI checks are failing.
  test('accept blocks on failing CI', async () => {
    const taskId = await setupBlockedTask();

    setGates([{ gate: 'ci', message: 'CI checks failing: lint, test' }]);

    const result = await ctx.lazy(['accept', taskId, '--yes']);

    expectFailure(result);
    expectError(result, 'Merge blocked by pre-merge gates');
    expectError(result, 'CI checks failing: lint, test');
  });

  // INVARIANT: Accept blocks when reviews are pending.
  test('accept blocks on pending reviews', async () => {
    const taskId = await setupBlockedTask();

    setGates([{ gate: 'reviews', message: 'Changes requested (status: CHANGES_REQUESTED)' }]);

    const result = await ctx.lazy(['accept', taskId, '--yes']);

    expectFailure(result);
    expectError(result, 'Merge blocked by pre-merge gates');
    expectError(result, 'Changes requested');
  });

  // INVARIANT: Accept blocks on unresolved review comments.
  test('accept blocks on unresolved comments', async () => {
    const taskId = await setupBlockedTask();

    setGates([{ gate: 'comments', message: '3 unresolved review threads' }]);

    const result = await ctx.lazy(['accept', taskId, '--yes']);

    expectFailure(result);
    expectError(result, 'Merge blocked by pre-merge gates');
    expectError(result, 'unresolved review threads');
  });

  // INVARIANT: Accept succeeds normally when no gates are failing.
  test('accept succeeds when all gates pass', async () => {
    const taskId = await setupBlockedTask();

    // No gate file written — mock returns no warnings, accept proceeds.
    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(result);
    expectOutput(result, 'accepted and merged');
  });
});
