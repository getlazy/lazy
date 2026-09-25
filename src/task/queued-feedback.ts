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

import type { Comment, Session, Turn } from '../storage';
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
  const notes = input.comments.filter((c) => queued.has(c.id) && isHumanFeedbackComment(c)).length;
  return notes + input.pendingReviewComments;
}
