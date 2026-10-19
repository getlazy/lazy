/**
 * When a task starts, sync its children that were waiting for it.
 *
 * A child reparented onto (or synced with) a parent that had not started yet
 * has nothing to merge — the parent's branch is cut at start — so its sync is
 * left queued (`pending_sync`) and reported as "waiting for the parent"
 * (src/task/unstarted-parent.ts). The moment the parent's branch exists, those
 * queued syncs can run, so the start NUDGES the sync retry loop to tick now
 * with their backoff cleared.
 *
 * Deliberately a nudge, not a sync run from here: the start is somebody's
 * request, and anything awaited from it inherits that request's context — in
 * Teams the merge commit would be authored as whoever pressed Start on the
 * parent. The loop's tick runs in the daemon's own context, like every other
 * daemon-started sync, and never races a second sync of the same child.
 */

import type { Storage } from '../storage';
import { logger } from '../utils/logger';
import { parentTaskIdOf } from '../task-target';
import { isSyncDispatchable } from '../task/sync-dispatch';
import { isLinkedTask } from '../task/linked';
import { shortId } from '../task/identity';
import { nudgeSyncRetry } from './sync-retry';

/** The children of `parentId` with a queued sync that can be dispatched now. */
export async function childrenAwaitingSync(storage: Storage, parentId: string) {
  const tasks = await storage.listTasksWithOptions({ nonTerminalOnly: true });
  return tasks.filter(t =>
    parentTaskIdOf(t) === parentId && t.pending_sync > 0 && isSyncDispatchable(t.status) && !isLinkedTask(t),
  );
}

/**
 * Nudge the sync retry loop for every child of `parentId` that was waiting on
 * it. Never throws: on any failure the loop's next tick picks them up anyway.
 */
export async function syncChildrenAfterParentStart(projectRoot: string, storage: Storage, parentId: string): Promise<void> {
  try {
    const children = await childrenAwaitingSync(storage, parentId);
    if (children.length === 0) return;
    if (nudgeSyncRetry(projectRoot, children.map(c => c.id))) {
      logger.info(`Parent ${shortId(parentId)} started: syncing ${children.length} waiting child task(s) now`);
    }
  } catch (err) {
    logger.warn(`Could not list the children waiting on ${shortId(parentId)} to start: ${err instanceof Error ? err.message : String(err)}. The sync retry loop will pick them up.`);
  }
}
