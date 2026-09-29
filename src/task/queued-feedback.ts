/**
 * Feedback a HUMAN wrote that no prompt has carried yet.
 *
 * One rule, read by accept (which refuses on it) and by the "Before you can
 * accept" disclosure every surface renders (`buildAcceptGate`), so the list can
 * never name a refusal accept does not make, nor miss one it does.
 *
 * Counts:
 * - task comments (`lazy comment`, the web Comments tab) past the delivery
 *   cutoff (`buildNotesState`) whose actor is a human — or unrecorded, which
 *   is how comments were written before actors were;
 * - web-review comments still `pending_delivery` (those are human by
 *   construction — `isPendingDelivery` requires it; the caller counts them).
 *
 * Not counted: builder, agent, system and supervisor comments (a cluster's
 * "[Subtask added]" notes, a driver's steering), and comments imported from a
 * forge. Those are not a reviewer's own words, and gating on them would wedge
 * the automations that write them.
 *
 * Nor are lazy's own bookkeeping records, written under the acting human's
 * actor but addressed to nobody: `[Accepted]`, `[Submitted]`, `[Reparented]`
 * and `[Re-parented]` (see BOOKKEEPING_COMMENT_PREFIXES). Counting them refused
 * the accept of every reopened, submitted or reparented task on lazy's own
 * record. A `[Reopened]` or `[Rejected]` reason still counts — it tells the
 * agent why — and so does "Pipeline/checks failed", which the agent should hear.
 * The match is on text, so a human comment that happens to start with one of
 * these prefixes is not counted either.
 */

import type { Comment, Session, Storage, Turn } from '../storage';
import { isPendingDelivery } from '../server/review-actions';
import { actorRole } from '../actor-ref';
import { buildNotesState } from './show-sections';

/** Prefixes of comments lazy writes as records of its own actions. Writers use these. */
export const ACCEPTED_COMMENT_PREFIX = '[Accepted] ';
export const SUBMITTED_COMMENT_PREFIX = '[Submitted] ';
export const REPARENTED_COMMENT_PREFIX = '[Reparented] ';
export const STALE_PARENT_COMMENT_PREFIX = '[Re-parented] ';
const BOOKKEEPING_COMMENT_PREFIXES = [
  ACCEPTED_COMMENT_PREFIX,
  SUBMITTED_COMMENT_PREFIX,
  REPARENTED_COMMENT_PREFIX,
  STALE_PARENT_COMMENT_PREFIX,
];

export function isHumanFeedbackComment(c: Comment): boolean {
  if (c.source === 'remote') return false;
  if (BOOKKEEPING_COMMENT_PREFIXES.some((p) => c.content.startsWith(p))) return false;
  const role = actorRole(c.actor);
  return role === undefined || role === 'human';
}

export function queuedHumanFeedbackCount(input: {
  session: Pick<Session, 'notes_delivered_through'> | null | undefined;
  turns: Turn[];
  comments: Comment[];
  /** Web-review comments passing `isPendingDelivery`. */
  pendingReviewComments: number;
}): number {
  const queued = new Set(buildNotesState(input.session, input.turns, input.comments).queued_ids);
  return countQueuedHumanFeedback(input.comments.filter((c) => queued.has(c.id)), input.pendingReviewComments);
}

/**
 * The counting step of the rule, for a caller that already resolved WHICH task
 * comments are queued through `buildNotesState` (the task page does, to list
 * them): the human-written ones, plus the queued web-review comments.
 */
export function countQueuedHumanFeedback(queuedTaskComments: readonly Comment[], pendingReviewComments: number): number {
  return queuedTaskComments.filter(isHumanFeedbackComment).length + pendingReviewComments;
}

/**
 * The count accept refuses on, read straight from the store — what the accept
 * gate itself calls, and what every surface offering Accept (the task page's
 * Current review, the review island's live poll) calls, so the "merge without
 * delivering" box appears exactly when accept would refuse without it.
 */
export async function queuedHumanFeedbackForTask(storage: Storage, taskId: string): Promise<number> {
  const session = await storage.getSessionByTaskId(taskId);
  const [turns, comments, reviewComments] = await Promise.all([
    session ? storage.getSessionTurns(session.id) : Promise.resolve([] as Turn[]),
    storage.getTaskComments(taskId),
    storage.getTaskReviewComments(taskId),
  ]);
  return queuedHumanFeedbackCount({
    session,
    turns,
    comments,
    pendingReviewComments: reviewComments.filter(isPendingDelivery).length,
  });
}
