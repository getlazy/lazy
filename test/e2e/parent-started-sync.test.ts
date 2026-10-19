/**
 * When a task starts, children whose sync was waiting for it merge at once —
 * the start nudges the sync retry loop instead of waiting for its interval.
 * Driven in-process with a loop whose interval is an hour, nudged well before
 * its first scheduled tick, so only the nudge can have done the merge.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { readTaskJson, writeTaskJson, setTaskStatus, findFullTaskId } from '../helpers/storage';
import { initDaemonStorage, closeAllStorage, getOrCreateStorage } from '../../src/daemon/rpc-handlers';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { pinConfig } from '../helpers/pin-config';
import { syncChildrenAfterParentStart, childrenAwaitingSync } from '../../src/daemon/parent-started-sync';
import { taskTarget } from '../../src/task-target';
import { startSyncRetryLoop } from '../../src/daemon/sync-retry';

// Calls production code in-process in a daemonless project — see AGENTS.md.
enableInProcessTestMode();

describe('syncing children when their parent starts', () => {
  let ctx: TestContext;
  let restoreConfig: () => void;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    restoreConfig = pinConfig(ctx.root);
    initDaemonStorage(ctx.root);
  });

  afterEach(async () => {
    await closeAllStorage();
    restoreConfig();
    await ctx.cleanup();
  });

  // INVARIANT: a parent's start drains its children's queued syncs itself; the
  // retry loop is only the backstop.
  test('merges the parent branch into a waiting child and clears its queue', async () => {
    const childId = await createTask(ctx, 'Child', 'Do work');
    expectSuccess(await ctx.lazyMocked(['start', childId, '--yes'], MOCK_CLAUDE_SUCCESS));
    setTaskStatus(ctx.root, childId, 'blocked');

    const parentId = await createTask(ctx, 'Parent', 'Parent work');
    const storage = await getOrCreateStorage();
    const parentFull = findFullTaskId(ctx.root, parentId);
    await storage.updateTaskTarget(findFullTaskId(ctx.root, childId), taskTarget(parentFull));
    const child = readTaskJson(ctx.root, childId);
    child.pending_sync = 1;
    writeTaskJson(ctx.root, childId, child);

    // The parent's branch, as its start would cut it, one commit ahead of main.
    writeFileSync(join(ctx.root, 'parent.txt'), 'x\n');
    expect(ctx.git('add', 'parent.txt').exitCode).toBe(0);
    expect(ctx.git('commit', '-m', 'parent base').exitCode).toBe(0);
    const baseSha = ctx.git('rev-parse', 'HEAD').stdout.trim();
    const parentRef = (readTaskJson(ctx.root, parentId) as any).metadata.task_ref;
    expect(ctx.git('branch', `lazy/${parentRef}`).exitCode).toBe(0);

    expect((await childrenAwaitingSync(storage, parentFull)).map(t => t.id)).toEqual([findFullTaskId(ctx.root, childId)]);

    // Interval of an hour; its first scheduled tick is 2s out. The nudge must
    // land the merge before then.
    const stop = startSyncRetryLoop(ctx.root, 3600);
    try {
      const nudgedAt = Date.now();
      await syncChildrenAfterParentStart(ctx.root, storage, parentFull);

      const childRef = (readTaskJson(ctx.root, childId) as any).metadata.task_ref;
      let merged = false;
      while (Date.now() - nudgedAt < 1_800) {
        merged = ctx.git('merge-base', '--is-ancestor', baseSha, `lazy/${childRef}`).exitCode === 0
          && (readTaskJson(ctx.root, childId) as any).pending_sync === 0;
        if (merged) break;
        await Bun.sleep(50);
      }
      expect(merged).toBe(true);
    } finally {
      stop();
    }
  });
});
