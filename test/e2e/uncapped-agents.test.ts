/**
 * E2E pins for the remove-reaper-cap-sweep world:
 *
 *  1. Agent starts are UNCAPPED — the 9th concurrent start (one past the old
 *     default cap of 8) launches immediately; no task ever enters a queue.
 *  2. A blocked task's container is NOT reaped while idle — its session keeps
 *     `container_name` across reconcile ticks. The container lives until the
 *     task reaches a terminal state (accept/reject/close still clean up).
 *
 * Both were removed by explicit engineer decision (2026-08-14): the DX cost of
 * the cap/queue and the idle reaper outweighed the rare Docker launch-storm
 * incidents they prevented.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, expectOutputExcludes } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { readTaskStatus, readSessionJson } from '../helpers/storage';

describe('uncapped agent starts + no idle reaper', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // `start` needs a real daemon: it launches the supervisor asynchronously
    // and the daemon reconciler is what moves the task out of 'working'.
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT (remove-reaper-cap-sweep): no agent concurrency cap. The old cap
  // defaulted to 8, so the 9th start with all previous containers still live
  // used to print "queued (8/8 agents running)" and park the task in the
  // removed 'queued' status. Now every start launches immediately.
  test('the 9th concurrent start launches immediately instead of queueing', async () => {
    const taskIds: string[] = [];
    for (let i = 0; i < 9; i++) {
      taskIds.push(await createTask(ctx, `Uncapped task ${i}`, 'Some work'));
    }

    // Start all 9 without waiting for any turn to finish, so all previous
    // containers are still counted as live when the 9th launches.
    for (const taskId of taskIds) {
      const result = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
      expectSuccess(result);
      expectOutput(result, 'Started task');
      expectOutputExcludes(result, 'queued');
    }

    // No task is parked: each is working (or already settled), never 'queued'.
    for (const taskId of taskIds) {
      expect(readTaskStatus(ctx.root, taskId)).not.toBe('queued');
    }

    // Let the turns settle so daemon teardown is clean.
    for (const taskId of taskIds) {
      await ctx.lazy(['wait', taskId]);
    }
  }, 180_000);

  // INVARIANT (remove-reaper-cap-sweep): no idle reaper. A blocked task keeps
  // its warm container (session.container_name stays set) across reconcile
  // ticks — under the old reaper with idle_grace_minutes=0 the first tick after
  // blocking cleared it. The test daemon reconciles every 5s, so 12s covers at
  // least two full ticks.
  test('a blocked task keeps its container across reconcile ticks', async () => {
    const taskId = await createTask(ctx, 'Idle survivor', 'Some work');
    const start = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
    expectSuccess(start);

    const wait = await ctx.lazy(['wait', taskId]);
    expectSuccess(wait);
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');

    const before = readSessionJson(ctx.root, taskId);
    expect(before?.container_name).toBeTruthy();

    // Sit idle across at least two reconcile ticks.
    await new Promise((resolve) => setTimeout(resolve, 12_000));

    const after = readSessionJson(ctx.root, taskId);
    expect(after?.container_name).toBe(before!.container_name);
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
  }, 60_000);
});
