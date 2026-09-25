/**
 * "Lazy closed this PR/MR itself" — a marker that keeps lazy's own close from
 * being read as somebody else's.
 *
 * When a reparent cannot move a task's PR onto its new target, lazy CLOSES the
 * PR (./review-retarget.ts) and the task goes on living. Remote-sync, though,
 * reads a CLOSED PR on a live task as the task having been closed on the forge,
 * and abandons it and moves its children away. Dropping the task's PR record
 * straight after the close avoids that — but only when lazy can CONFIRM the
 * close; when the forge's answer cannot be read, the record has to stay (the
 * wrong-base guards need it to see a PR that may still be open), and then the
 * next pass that reads CLOSED would terminate a live task over lazy's own act.
 *
 * INVARIANT: the marker is written BEFORE lazy asks the forge to close the PR,
 * so no crash between the close and the record can leave an unmarked close. A
 * marked task whose PR reads CLOSED is lazy's own close, and is SETTLED here —
 * PR record and marker dropped, a still-`submitted` task moved to `blocked`
 * under its lifecycle lock — never abandoned, and its children never moved.
 * An UNMARKED close is still somebody else's, and still ends the task. Submit
 * never REUSES a marked record without asking the forge first (closed → dropped
 * and a new PR opened; open → marker cleared; unreadable → refused). The
 * marker is cleared wherever the record is dropped or a new PR is recorded.
 */

import type { Storage } from '../storage';
import type { Task } from '../types';
import type { RepositoryDriver } from '../remote/driver';
import { withTaskLifecycleLock } from './task-lifecycle-lock';
import { logger } from '../utils/logger';

/** Task metadata: set to the PR's URL (or `closed`) while lazy is closing a PR it could not move. */
export const LAZY_CLOSED_REVIEW_KEY = 'lazy_closed_review';

/** Task metadata keys a driver records a PR/MR under, current and legacy. */
export const REMOTE_REF_KEYS = [
  'github_remote_ref_id', 'github_remote_ref_url',
  'gitlab_remote_ref_id', 'gitlab_remote_ref_url',
  'remote_ref_id', 'remote_ref_url',
  'github_pr_number', 'github_pr_url',
] as const;

/** Did lazy itself close (or start closing) this task's PR? */
export function lazyClosedReview(task: Pick<Task, 'metadata'>): boolean {
  return !!task.metadata?.[LAZY_CLOSED_REVIEW_KEY];
}

/** Clear the marker, when a task has one (a new PR was recorded, or the record dropped). */
export async function clearLazyClosedReview(storage: Storage, task: Pick<Task, 'id' | 'metadata'>): Promise<void> {
  if (lazyClosedReview(task)) await storage.updateTaskMetadata(task.id, LAZY_CLOSED_REVIEW_KEY, '');
}

/**
 * Drop the PR record and the marker of a PR lazy closed itself — the record
 * half of settling, with no status write. Remote-sync reads a CLOSED PR on a
 * live task as the task having been closed on the forge, and would abandon it;
 * with the record gone there is nothing for it to read. Reads the record fresh
 * (the caller's copy can predate the marker it just wrote) and mirrors the
 * cleared keys into the caller's `task.metadata`.
 */
export async function dropLazyClosedRecord(storage: Storage, task: Task): Promise<void> {
  const current = (await storage.getTask(task.id)) ?? task;
  for (const key of REMOTE_REF_KEYS) {
    if (current.metadata?.[key]) await storage.updateTaskMetadata(task.id, key, '');
    if (task.metadata?.[key]) task.metadata[key] = '';
  }
  await clearLazyClosedReview(storage, current);
  if (task.metadata?.[LAZY_CLOSED_REVIEW_KEY]) task.metadata[LAZY_CLOSED_REVIEW_KEY] = '';
}

/** A copy of `task` as it reads once its PR record is dropped — for read-only callers. */
export function withoutReviewRecord(task: Task): Task {
  const metadata = { ...task.metadata };
  for (const key of [...REMOTE_REF_KEYS, LAZY_CLOSED_REVIEW_KEY]) {
    if (metadata[key]) metadata[key] = '';
  }
  return { ...task, metadata };
}

/**
 * What a marked task's recorded PR is on the forge, before anything REUSES the
 * record (a resubmit). `none` = no marker, nothing to check; `closed` = the
 * forge confirms lazy's close (or it merged), so the record is dead; `open` =
 * the close never happened and the PR is live; `unknown` = the forge could not
 * say. Read-only: the caller decides what to do.
 */
export async function markedRecordState(
  driver: RepositoryDriver,
  task: Task,
): Promise<'none' | 'closed' | 'open' | 'unknown'> {
  if (!lazyClosedReview(task) || !driver.hasRemoteRef(task)) return 'none';
  let state: string | null;
  try {
    state = await driver.getPRState(task);
  } catch (err) {
    // A forge that errors is a forge that could not say: the caller treats
    // `unknown` as "refuse and keep the marker", never as closed.
    logger.warn(`Could not read the state of ${task.id}'s PR/MR lazy closed: ${err instanceof Error ? err.message : err}`);
    return 'unknown';
  }
  if (state === 'CLOSED' || state === 'MERGED') return 'closed';
  if (state === 'OPEN') return 'open';
  return 'unknown';
}

/** Submit's refusal while the forge cannot confirm lazy's close of the recorded PR. */
export function unconfirmedCloseRefusal(taskDisplayId: string, url: string): string {
  return (
    `Task ${taskDisplayId}'s PR/MR (${url}) was closed by lazy when it could not be moved to the ` +
    `task's new target, and the forge has not confirmed that close: its state cannot be read right now. ` +
    `Submitting now could reuse a PR/MR that is still open against the old branch. ` +
    `Retry once the forge answers; if the PR/MR turns out to be closed, a new one is opened against the current target.`
  );
}

/**
 * Finish lazy's own close of `task`'s PR: drop the PR record and the marker,
 * and move a task that is STILL `submitted` to `blocked`. The status write is
 * decided on a fresh read under the task's lifecycle lock (the lock unblock
 * claims the task under), so a task somebody unblocked meanwhile keeps
 * running. Returns the clause describing what happened to the status.
 */
export async function settleLazyClosedReview(storage: Storage, task: Task): Promise<string> {
  await dropLazyClosedRecord(storage, task);
  // INVARIANT: the `submitted → blocked` write is decided on a FRESH read under
  // the task's lifecycle lock. The task was read before forge round-trips; a
  // person can have unblocked it meanwhile, and `working → blocked` is a valid
  // edge, so writing from the stale read would mark a running task blocked and
  // invite a second unblock onto the same worktree. Callers never hold this
  // task's lock (reparent releases its own first; accept and close hold the
  // PARENT's; remote-sync holds none), so this cannot deadlock.
  return await withTaskLifecycleLock(task.id, async () => {
    const fresh = await storage.getTask(task.id);
    if (fresh?.status === 'submitted') {
      await storage.updateTaskStatus(task.id, 'blocked', 'system');
      return ' and the task is back to blocked';
    }
    return fresh && fresh.status !== task.status
      ? ` (the task is now ${fresh.status}, so its status was left alone)`
      : '';
  });
}
