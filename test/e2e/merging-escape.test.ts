import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/**
 * Helper to directly set a task's status in task.json.
 * Uses the same pattern as sync.test.ts for manipulating task state.
 */
function setTaskStatus(ctx: TestContext, taskId: string, status: string): void {
  const tasksDir = join(ctx.root, '.lazy', 'tasks');
  const entries = readdirSync(tasksDir);
  const fullId = entries.find(e => e.startsWith(taskId));
  if (!fullId) throw new Error(`No task directory starting with ${taskId}`);
  const taskJsonPath = join(tasksDir, fullId, 'task.json');
  const taskData = JSON.parse(readFileSync(taskJsonPath, 'utf-8'));
  taskData.status = status;
  writeFileSync(taskJsonPath, JSON.stringify(taskData, null, 2) + '\n');
}

describe('merging escape hatch', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: Users must be able to escape a stuck merging state.
  // Without this, a failed pipeline leaves the task stuck forever —
  // can't unblock, can't accept, can't give feedback.
  test('unblock on merging task moves it back to blocked', async () => {
    // Create and start a task to get a session
    const taskId = await createTask(ctx, 'Stuck merging task', 'Fix the pipeline');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // Manually set task to merging state (simulating accept → pipeline pending)
    setTaskStatus(ctx, taskId, 'merging');

    // Verify task is indeed in merging state
    const showBefore = await ctx.lazy(['show', taskId]);
    expectSuccess(showBefore);
    expectOutput(showBefore, 'merging');

    // Unblock the merging task — should move it to blocked and proceed
    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Pipeline failed, fix the test'],
      MOCK_CLAUDE_SUCCESS,
    );
    expectSuccess(unblockResult);
    expectOutput(unblockResult, 'Moving back to blocked');

    // Verify task is no longer in merging state (unblock moves it to blocked, then agent runs)
    const showAfter = await ctx.lazy(['show', taskId]);
    expectSuccess(showAfter);
    // The status line should show 'blocked' (after agent finishes), not 'merging'
    // Note: "merging" may appear in comments/notes, so check status field specifically
    const statusMatch = showAfter.stdout.match(/Status:\s+(\w+)/);
    expect(statusMatch).toBeTruthy();
    expect(statusMatch![1]).not.toBe('merging');
  });

  // INVARIANT: accept on a merging task with local driver should report status.
  // The local driver has no remote, so getPRState returns null and
  // getChecksStatus returns passed, but it shouldn't crash.
  test('accept on merging task with local driver reports pending', async () => {
    const taskId = await createTask(ctx, 'Local merging task', 'Something');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    setTaskStatus(ctx, taskId, 'merging');

    // Accept on a merging task — local driver returns null for getPRState
    // which means it falls through to the pending state message
    const acceptResult = await ctx.lazy(['accept', taskId]);
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'already in merging state');
    expectOutput(acceptResult, 'still pending');
  });

  // INVARIANT: After unblocking a merging task, the user should be able to
  // re-accept it, completing the full escape-hatch → retry cycle.
  test('full escape-hatch cycle: merging → unblock → blocked → accept', async () => {
    const taskId = await createTask(ctx, 'Full cycle task', 'Fix and retry');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // Set to merging (simulating pipeline pending)
    setTaskStatus(ctx, taskId, 'merging');

    // Escape via unblock
    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Fix the failing test'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(unblockResult);

    // Task should no longer be in merging state (agent finishes → blocked)
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    const statusMatch = showResult.stdout.match(/Status:\s+(\w+)/);
    expect(statusMatch).toBeTruthy();
    expect(statusMatch![1]).not.toBe('merging');

    // Re-accept should work (task is no longer in merging state)
    const acceptResult = await ctx.lazy(['accept', taskId]);
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'accepted and merged');
  });
});
