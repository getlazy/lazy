import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { createTask, disablePreAccept, startAndReconcile, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
// setTaskStatus lives in the shared helper, which is the ONE place that knows
// tasks live at lazy.toml's external_path — the local copy this suite carried
// hardcoded <root>/.lazy/tasks and died with ENOENT once storage moved.
import { setTaskStatus, setTaskMetadata, readTaskStatus, readTaskJson } from '../helpers/storage';
import { runReconcile } from '../helpers/reconcile';

/**
 * Seed the exact field wedge: a task in `merging` carrying the in-flight marker
 * a LOCAL merge phase stamps, with no accept running anywhere. That is what a
 * daemon killed mid-accept leaves behind.
 */
function strandInMerging(root: string, taskId: string, priorStatus = 'blocked'): void {
  setTaskStatus(root, taskId, 'merging');
  setTaskMetadata(root, taskId, 'accept_in_flight_from', priorStatus);
}

describe('merging escape hatch', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    // Daemonless suite: no runner exists to execute the pre-accept agent turn,
    // and these tests assert on the merging escape hatch, not on pre-accept.
    disablePreAccept(ctx.root);
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
    await startAndReconcile(ctx, taskId);

    // Manually set task to merging state (simulating accept → pipeline pending)
    setTaskStatus(ctx.root, taskId, 'merging');

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
    expectOutput(unblockResult, 'Task was in merging state. Moved back to blocked.');

    // Verify task is no longer in merging state (unblock moves it to blocked, then agent runs)
    const showAfter = await ctx.lazy(['show', taskId]);
    expectSuccess(showAfter);
    // The status line should show 'blocked' (after agent finishes), not 'merging'
    // Note: "merging" may appear in comments/notes, so check status field specifically
    const statusMatch = showAfter.stdout.match(/Status:\s+(\w+)/);
    expect(statusMatch).toBeTruthy();
    expect(statusMatch![1]).not.toBe('merging');
  });

  // REGRESSION (fix-stranded-merging): a task stranded in `merging` by a dead
  // accept was inescapable — reject, close and submit all refused, and nothing
  // swept it back. One task in the field sat wedged for two weeks. Each of the
  // three now recovers the task first and then does its job.
  test('reject escapes a task stranded in merging', async () => {
    const taskId = await createTask(ctx, 'Wedged task', 'Something');
    await startAndReconcile(ctx, taskId);
    strandInMerging(ctx.root, taskId);

    const result = await ctx.lazy(['reject', taskId, '--reason', 'not what I wanted', '--yes']);
    expectSuccess(result);
    expect(readTaskStatus(ctx.root, taskId)).toBe('abandoned');
  });

  test('close escapes a task stranded in merging and keeps the reason', async () => {
    const taskId = await createTask(ctx, 'Wedged task', 'Something');
    await startAndReconcile(ctx, taskId);
    strandInMerging(ctx.root, taskId);

    const result = await ctx.lazy(['close', taskId, '--reason', 'abandoning this line of work', '--yes']);
    expectSuccess(result);
    expect(readTaskStatus(ctx.root, taskId)).toBe('abandoned');
    // Never lose human feedback: the reason the human typed must survive the
    // recovery, not be orphaned by a refusal.
    expect(readTaskJson(ctx.root, taskId).close_reason).toBe('abandoning this line of work');
  });

  // The reconciler is the prevention half: a stranded merge with no live owner
  // is returned to a real resting state without the human knowing any incantation.
  test('the reconciler sweeps a stranded merging task back to a resting state', async () => {
    const taskId = await createTask(ctx, 'Wedged task', 'Something');
    await startAndReconcile(ctx, taskId);
    strandInMerging(ctx.root, taskId);

    await runReconcile(ctx.root, ctx.protocolBase);

    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
    // The marker is the record of a merge in flight; a swept task has none.
    expect(readTaskJson(ctx.root, taskId).metadata?.accept_in_flight_from ?? '').toBe('');
  });

  // INVARIANT: accept on a merging task with the local driver must not crash or
  // strand the task. There is no remote pipeline to wait on, so the merge simply
  // completes. (This used to assert an "already in merging state ... still
  // pending" message, but that was CLI-layer text removed when accept became a
  // thin RPC wrapper over the daemon — f7dd25ba. The behavior it guarded, "don't
  // blow up on a merging task", is what is asserted now.)
  test('accept on merging task with local driver completes the merge', async () => {
    const taskId = await createTask(ctx, 'Local merging task', 'Something');
    await startAndReconcile(ctx, taskId);

    setTaskStatus(ctx.root, taskId, 'merging');

    // Accept on a merging task — local driver returns null for getPRState
    // which means it falls through to the pending state message
    const acceptResult = await ctx.lazy(['accept', taskId]);
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'accepted and merged');
    expectOutput(await ctx.lazy(['show', taskId]), 'complete');
  });

  // INVARIANT: After unblocking a merging task, the user should be able to
  // re-accept it, completing the full escape-hatch → retry cycle.
  test('full escape-hatch cycle: merging → unblock → blocked → accept', async () => {
    const taskId = await createTask(ctx, 'Full cycle task', 'Fix and retry');
    await startAndReconcile(ctx, taskId);

    // Set to merging (simulating pipeline pending)
    setTaskStatus(ctx.root, taskId, 'merging');

    // Escape via unblock
    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Fix the failing test'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(unblockResult);
    // `unblock` launches the agent and returns; only a reconcile pass records
    // the response and moves the task working → blocked, which accept requires.
    await runReconcile(ctx.root, ctx.protocolBase);

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
