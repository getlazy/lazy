import { describe, test, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { runReconcile } from '../helpers/reconcile';
import { expectSuccess, expectFailure, expectOutput, expectOutputExcludes } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/**
 * Resolve the tasks directory for a test project. Test projects init with
 * external storage (external_path in lazy.toml), so tasks live OUTSIDE the
 * repo; fall back to the in-repo .lazy/tasks layout when no external_path.
 * Mirrors protocol.test.ts#tasksDirFor.
 */
function tasksDirFor(root: string): string {
  const toml = readFileSync(join(root, 'lazy.toml'), 'utf-8');
  const m = toml.match(/^external_path\s*=\s*"(.+)"/m);
  if (m && m[1]) return join(m[1], 'tasks');
  return join(root, '.lazy', 'tasks');
}

/**
 * Find the full task UUID from a short (8-char) prefix.
 */
function findFullTaskId(root: string, shortId: string): string {
  const tasksDir = tasksDirFor(root);
  const dirs = readdirSync(tasksDir);
  const match = dirs.find(d => d.startsWith(shortId));
  if (!match) throw new Error(`Task directory not found for ${shortId}`);
  return match;
}

/**
 * Directly set a task's session to ended/accepted state without
 * updating the task status. This simulates the bug where accept
 * updates the session but crashes before updating the task status.
 */
function simulateInconsistentAccept(root: string, shortId: string): void {
  const fullId = findFullTaskId(root, shortId);
  const sessionPath = join(tasksDirFor(root), fullId, 'session.json');
  if (!existsSync(sessionPath)) throw new Error(`Session not found for ${shortId}`);

  const session = JSON.parse(readFileSync(sessionPath, 'utf-8'));
  session.ended_at = new Date().toISOString().replace('Z', '').replace('T', ' ').split('.')[0];
  session.outcome = 'accepted';
  writeFileSync(sessionPath, JSON.stringify(session, null, 2));
  // Intentionally do NOT update task.json status — it remains 'blocked'
}

describe('lazy unblock', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    disablePreAccept(ctx.root);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /**
   * This suite is daemonless and asserts only on blocked/active LIST membership
   * after accept/reject — the pre-accept turn ([automation.pre_accept], on by
   * default) is pure noise here, and with no daemon there is nothing to run an
   * agent turn against (accept would fail trying to launch a real runner).
   * Suites that exercise the pre-accept step itself live in pre-accept.test.ts.
   *
   * The generated lazy.toml already has a bare [automation] table, so appending
   * the sub-table is valid TOML.
   */
  function disablePreAccept(root: string): void {
    const configPath = join(root, 'lazy.toml');
    const existing = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, `${existing}\n[automation.pre_accept]\nenabled = false\n`);
  }

  /**
   * Start a task and drive one reconcile pass so it lands in `blocked`.
   *
   * `lazy start` returns as soon as the agent is launched; post-v0.11 ONLY the
   * daemon's reconcile loop transitions working → blocked when the response
   * lands. Daemonless suites must drive that pass themselves (same pattern as
   * protocol.test.ts / auto-resume.test.ts) — without it the task stays
   * `working` and every later assertion sees an empty blocked list.
   */
  async function startAndReconcile(taskId: string): Promise<void> {
    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);
    await runReconcile(ctx.root, ctx.protocolBase);
  }

  test('shows usage when no task ID provided', async () => {
    const result = await ctx.lazy(['unblock']);
    expectFailure(result);
    expectOutput(result, 'Usage:');
  });

  test('usage mentions lazy loop for sequential review', async () => {
    const result = await ctx.lazy(['unblock']);
    expectOutput(result, 'lazy loop');
  });

  test('blocked tasks with sessions appear in blocked list', async () => {
    // Create and start two tasks so they have sessions
    const taskId1 = await createTask(ctx, 'First blocked', 'Do work');
    const taskId2 = await createTask(ctx, 'Second blocked', 'Do work');

    await startAndReconcile(taskId1);
    await startAndReconcile(taskId2);

    // Both tasks should now be blocked (after agent finishes they go to blocked)
    const blockedResult = await ctx.lazy(['blocked']);
    expectSuccess(blockedResult);
    expectOutput(blockedResult, 'First blocked');
    expectOutput(blockedResult, 'Second blocked');
  });

  test('unstarted tasks are backlog and do not appear in blocked list', async () => {
    // Create a task but don't start it — it will be backlog (not blocked).
    // Backlog tasks don't have sessions and don't appear in the blocked list.
    const taskId = await createTask(ctx, 'Unstarted task');

    const blockedResult = await ctx.lazy(['blocked']);
    expectSuccess(blockedResult);
    // Should NOT appear in blocked list since it's backlog
    expectOutput(blockedResult, 'No blocked tasks');

    // Verify the task has backlog status via show
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'backlog');
    expectOutput(showResult, 'not started');
  });

  test('accepted task does not appear in blocked list', async () => {
    const taskId = await createTask(ctx, 'Accept blocked', 'Do work');
    await startAndReconcile(taskId);

    // Verify it appears in blocked
    let blockedResult = await ctx.lazy(['blocked']);
    expectSuccess(blockedResult);
    expectOutput(blockedResult, 'Accept blocked');

    // Accept the task
    const acceptResult = await ctx.lazy(['accept', taskId]);
    expectSuccess(acceptResult);

    // Now it should NOT appear in blocked
    blockedResult = await ctx.lazy(['blocked']);
    expectSuccess(blockedResult);
    expectOutputExcludes(blockedResult, 'Accept blocked');
  });

  test('rejected task does not appear in blocked list', async () => {
    const taskId = await createTask(ctx, 'Reject blocked', 'Do work');
    await startAndReconcile(taskId);

    // Verify it appears in blocked
    let blockedResult = await ctx.lazy(['blocked']);
    expectSuccess(blockedResult);
    expectOutput(blockedResult, 'Reject blocked');

    // Reject the task
    const rejectResult = await ctx.lazy(['reject', taskId, '--yes', '--reason', 'Not needed']);
    expectSuccess(rejectResult);

    // Now it should NOT appear in blocked
    blockedResult = await ctx.lazy(['blocked']);
    expectSuccess(blockedResult);
    expectOutputExcludes(blockedResult, 'Reject blocked');
  });

  test('rejected task does not appear in active list', async () => {
    const taskId = await createTask(ctx, 'Reject active', 'Do work');
    await startAndReconcile(taskId);

    // Verify it appears in active
    let activeResult = await ctx.lazy(['active']);
    expectSuccess(activeResult);
    expectOutput(activeResult, 'Reject active');

    // Reject the task
    const rejectResult = await ctx.lazy(['reject', taskId, '--yes', '--reason', 'Bad approach']);
    expectSuccess(rejectResult);

    // Now it should NOT appear in active
    activeResult = await ctx.lazy(['active']);
    expectSuccess(activeResult);
    expectOutputExcludes(activeResult, 'Reject active');
  });

  test('self-heals inconsistent state: session accepted but task still blocked', async () => {
    // Create and start two tasks
    const taskId1 = await createTask(ctx, 'Inconsistent', 'Do work');
    const taskId2 = await createTask(ctx, 'Still blocked', 'Do work');

    await startAndReconcile(taskId1);
    await startAndReconcile(taskId2);

    // Both should appear in blocked
    let blockedResult = await ctx.lazy(['blocked']);
    expectSuccess(blockedResult);
    expectOutput(blockedResult, 'Inconsistent');
    expectOutput(blockedResult, 'Still blocked');

    // Simulate the inconsistent state: session accepted but task still blocked
    simulateInconsistentAccept(ctx.root, taskId1);

    // After self-healing, only the truly blocked task should appear
    blockedResult = await ctx.lazy(['blocked']);
    expectSuccess(blockedResult);
    expectOutputExcludes(blockedResult, 'Inconsistent');
    expectOutput(blockedResult, 'Still blocked');

    // Active should also exclude it
    const activeResult = await ctx.lazy(['active']);
    expectSuccess(activeResult);
    expectOutputExcludes(activeResult, 'Inconsistent');
    expectOutput(activeResult, 'Still blocked');

    // The task should now show as complete (self-healed)
    const showResult = await ctx.lazy(['show', taskId1]);
    expectSuccess(showResult);
    expectOutput(showResult, 'complete');
  });

  test('accepted task with two tasks: only non-accepted appears', async () => {
    const taskId1 = await createTask(ctx, 'First accept', 'Do work');
    const taskId2 = await createTask(ctx, 'Second stays', 'Do work');

    await startAndReconcile(taskId1);
    await startAndReconcile(taskId2);

    // Accept first task
    const acceptResult = await ctx.lazy(['accept', taskId1]);
    expectSuccess(acceptResult);

    // Only second task should appear in blocked
    const blockedResult = await ctx.lazy(['blocked']);
    expectSuccess(blockedResult);
    expectOutputExcludes(blockedResult, 'First accept');
    expectOutput(blockedResult, 'Second stays');

    // Only second task should appear in active
    const activeResult = await ctx.lazy(['active']);
    expectSuccess(activeResult);
    expectOutputExcludes(activeResult, 'First accept');
    expectOutput(activeResult, 'Second stays');
  });
});
