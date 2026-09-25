/**
 * Notify a parent task when one of its subtasks is accepted and merged.
 *
 * Design (inform-the-task-when-a-subtask-is-accepted):
 * - Signal is a **comment** on the parent, nothing else.
 * - Never auto-unblocks and never emits `child_completed` — that is what
 *   "auto-react off" means, and local comments must never start a turn
 *   (fix-comment-auto-launch / CLAUDE.md).
 * - The accept-tag SHA is included so a parent that already saw the same SHA
 *   from `lazy_wait` (when the child is already `complete`) can treat the note
 *   as idempotent.
 * - No-op when there is no parent *task* (top-level into a named/default branch).
 * - Never fails the accept: the merge already landed; a notify miss is logged
 *   and retried via {@link PARENT_ACCEPT_NOTIFY_PENDING_KEY} + reconciler sweep.
 *
 * Idempotency: if the parent already has a `[Subtask accepted]` comment that
 * names this child (by display id or full id) and, when known, the same merge
 * SHA, we skip. Safe to call from accept, remote-sync, zombie recovery, and the
 * pending-notify sweep.
 */

import type { Task, Comment } from '../types';
import type { Storage } from '../storage/interface';
import { parentTaskIdOf } from '../task-target';
import { displayId, shortId } from './identity';
import { getAcceptTagCommit } from '../git/operations';
import { logger } from '../utils/logger';

/** Task metadata: set while a parent notify is owed; cleared on success. */
export const PARENT_ACCEPT_NOTIFY_PENDING_KEY = 'parent_accept_notify_pending';

const SUBTASK_ACCEPTED_PREFIX = '[Subtask accepted]';

/**
 * True when `comment` is already the parent-notify for this child / SHA.
 *
 * Match on the child display id or full id so a comment written before the
 * accept tag existed (SHA-less) still counts once we retry with a SHA.
 */
export function isParentAcceptNotifyComment(
  comment: Pick<Comment, 'content'>,
  child: Pick<Task, 'id' | 'code'>,
  sha: string | null,
): boolean {
  const content = comment.content;
  if (!content.startsWith(SUBTASK_ACCEPTED_PREFIX)) return false;
  // Mirror displayId without requiring a full Task: code wins, else short id.
  const childRef = child.code ?? shortId(child.id);
  const namesChild =
    content.includes(childRef) ||
    content.includes(child.id) ||
    content.includes(shortId(child.id));
  if (!namesChild) return false;
  if (sha && !content.includes(sha)) {
    // An older SHA-less notify for this child still counts — do not double-post
    // when a later retry learns the accept-tag SHA.
    const hasAnyMergeSha = /\(merge [a-f0-9]{7,40}\)/.test(content);
    if (hasAnyMergeSha) return false;
  }
  return true;
}

function buildNotifyContent(child: Task, sha: string | null): string {
  const childRef = displayId(child);
  const shaClause = sha ? ` (merge ${sha})` : '';
  return (
    `${SUBTASK_ACCEPTED_PREFIX} ${childRef} was accepted and merged into this task` +
    `${shaClause}.`
  );
}

/**
 * Drop a `[Subtask accepted]` comment on the parent task, if one exists.
 *
 * Call after the accept tag exists (when this path creates one) and whenever a
 * child becomes `complete`. Safe to call more than once — skips when the parent
 * already has the matching comment; on createComment failure, stamps
 * {@link PARENT_ACCEPT_NOTIFY_PENDING_KEY} so the reconciler can retry.
 */
export async function notifyParentOfAcceptedSubtask(
  storage: Storage,
  child: Task,
  projectRoot: string,
): Promise<void> {
  const parentId = parentTaskIdOf(child);
  if (!parentId) {
    // No parent task — clear any stale pending bit (e.g. after reparent).
    await clearPendingNotify(storage, child.id);
    return;
  }

  try {
    const parent = await storage.getTask(parentId);
    if (!parent) {
      logger.warn(
        `notify-parent-accepted: parent ${shortId(parentId)} missing for accepted child ${shortId(child.id)} — skipping`,
      );
      await clearPendingNotify(storage, child.id);
      return;
    }

    const sha = await getAcceptTagCommit(child.id, projectRoot);
    const existing = await storage.getTaskComments(parentId);
    if (existing.some(c => isParentAcceptNotifyComment(c, child, sha))) {
      logger.debug(
        `notify-parent-accepted: parent ${shortId(parentId)} already notified for ${shortId(child.id)} — skip`,
      );
      await clearPendingNotify(storage, child.id);
      return;
    }

    await storage.createComment(parentId, buildNotifyContent(child, sha), 'system');
    await clearPendingNotify(storage, child.id);
    logger.info(
      `notify-parent-accepted: commented on parent ${shortId(parentId)} that ${displayId(child)} was accepted` +
        (sha ? ` at ${sha.slice(0, 8)}` : ''),
    );
  } catch (err) {
    // Accept / remote-complete already succeeded — do not fail the merge over a
    // notification miss. Stamp pending so the reconciler retries.
    try {
      await storage.updateTaskMetadata(child.id, PARENT_ACCEPT_NOTIFY_PENDING_KEY, '1');
    } catch (metaErr) {
      logger.warn(
        `notify-parent-accepted: failed to set pending flag on ${shortId(child.id)}: ` +
          `${metaErr instanceof Error ? metaErr.message : metaErr}`,
      );
    }
    logger.warn(
      `notify-parent-accepted: failed to comment on parent of ${shortId(child.id)}: ` +
        `${err instanceof Error ? err.message : err}`,
    );
  }
}

async function clearPendingNotify(storage: Storage, taskId: string): Promise<void> {
  const task = await storage.getTask(taskId);
  if (!task?.metadata?.[PARENT_ACCEPT_NOTIFY_PENDING_KEY]) return;
  await storage.updateTaskMetadata(taskId, PARENT_ACCEPT_NOTIFY_PENDING_KEY, '');
}

/**
 * Retry parent-notify for tasks that still carry the pending flag (createComment
 * failed earlier) or that are complete with an accept tag and a parent but no
 * matching comment yet.
 *
 * Called from the reconciler so a crash between endSession and notify, or a
 * transient storage failure, cannot permanently lose the signal.
 */
export async function sweepPendingParentAcceptNotifies(
  storage: Storage,
  projectRoot: string,
): Promise<number> {
  const tasks = await storage.listTasks();
  let notified = 0;
  for (const task of tasks) {
    const parentId = parentTaskIdOf(task);
    if (!parentId) continue;

    const pending = !!task.metadata?.[PARENT_ACCEPT_NOTIFY_PENDING_KEY];
    const isComplete = task.status === 'complete';
    // Pending = prior createComment failed (status already complete). Complete
    // + accept tag = cover the crash-after-status-before-notify window.
    if (!pending && !isComplete) continue;

    const sha = await getAcceptTagCommit(task.id, projectRoot);
    // Without an accept tag and without a pending flag, this complete task was
    // never on an accept path we own — skip. Pending alone is enough to retry.
    if (!pending && !sha) continue;

    const before = await storage.getTaskComments(parentId);
    if (before.some(c => isParentAcceptNotifyComment(c, task, sha))) {
      await clearPendingNotify(storage, task.id);
      continue;
    }

    await notifyParentOfAcceptedSubtask(storage, task, projectRoot);
    const after = await storage.getTaskComments(parentId);
    if (after.some(c => isParentAcceptNotifyComment(c, task, sha))) {
      notified++;
    }
  }
  return notified;
}
