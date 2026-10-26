/**
 * Questions asked of a task's agent while it is mid-turn — the Chat's queue.
 *
 * A chat message (any review-surface ask) sent while the task is `working` or
 * `pairing` used to be answered from the task's stored record by a throwaway
 * one-shot, because the live session was busy. That broke the conversation:
 * the agent that was doing the work never saw the question. Now it WAITS: the
 * question is saved as `queued`, shown as waiting for the agent to finish its
 * turn, and dispatched — as the same read-only ask, run by the same code path
 * — once the task parks.
 *
 * Three rules, all load-bearing:
 *
 * 1. **It dispatches an ASK, never a work turn.** Nothing here starts, resumes
 *    or unblocks a task; the dispatch is `launchAskTask` through the review
 *    service's per-task chain, with every read-only guarantee that carries
 *    (read-only toolset, daemon-route refusal, supervisor write check). This is
 *    not the comment auto-launch AGENTS.md forbids: no comment is read and no
 *    turn the person did not ask for is started.
 * 2. **It runs as the person who typed it.** The owner the asking request
 *    carried is captured onto the comment when it is queued, and the dispatch
 *    runs inside that owner's request scope (`runAsTurnOwnerRequest`), so the
 *    turn bills and names them — never nobody, never whoever touched the task
 *    last. A question asked by nobody stays asked by nobody.
 * 3. **A stopped task is not woken.** `user_stopped` means "do not run this
 *    without me"; an ask's completed turn would lift the stop. The question
 *    stays queued until the stop ends.
 */

import type { Storage } from '../storage/interface';
import type { ReviewComment, Session, Task } from '../types';
import { getPendingTurnOwner, type PendingTurnOwner } from './turn-owner';
import { isUserStopped } from '../task/user-stop';

/** Task metadata flag: this task has at least one queued question. */
export const QUEUED_ASKS_METADATA_KEY = 'chat_asks_queued';

/** Statuses whose turn will end on its own, so a question can wait for it. */
const MID_TURN_STATUSES = new Set(['working', 'pairing']);

/**
 * Should a question asked NOW wait for the task's turn to finish? Only when
 * the agent's live session is busy and will come back: a task mid-turn with a
 * resumable session. Anything else is answered at once, as before.
 */
export function shouldQueueAsk(task: Task, session: Session | null): boolean {
  return MID_TURN_STATUSES.has(task.status)
    && session !== null && !session.ended_at && !!session.agent_session_id;
}

/** Mark a question queued, capturing who asked it from the current request. */
export async function queueAsk(storage: Storage, task: Task, comment: ReviewComment): Promise<ReviewComment> {
  const owner = getPendingTurnOwner(task.id);
  const queued = await storage.updateReviewComment(task.id, comment.id, {
    askState: 'queued',
    askError: null,
    askOwner: owner ? { email: owner.email, ...(owner.name ? { name: owner.name } : {}), spendable: owner.spendable } : null,
  });
  await storage.updateTaskMetadata(task.id, QUEUED_ASKS_METADATA_KEY, '1');
  return queued;
}

/** The owner a queued question was asked by, or null for nobody. */
export function queuedAskOwner(comment: ReviewComment): PendingTurnOwner | null {
  if (!comment.ask_owner_email) return null;
  return {
    email: comment.ask_owner_email,
    ...(comment.ask_owner_name ? { name: comment.ask_owner_name } : {}),
    spendable: comment.ask_owner_spendable === true,
  };
}

/** A queued question still waiting: not withdrawn, oldest first. */
export function waitingQueuedAsks(comments: ReviewComment[]): ReviewComment[] {
  return comments
    .filter((c) => c.role === 'human' && c.ask_state === 'queued' && !c.withdrawn_at)
    .sort((a, b) => a.created_at - b.created_at);
}

/**
 * May the queued questions on this task go out now? The turn they waited for
 * has ended (the task is no longer mid-turn or interrupted, which auto-resumes
 * into another turn), nothing else holds the task's turn slot, and nobody
 * stopped it.
 */
export function mayDispatchQueuedAsks(task: Task, session: Session | null): boolean {
  if (MID_TURN_STATUSES.has(task.status) || task.status === 'interrupted') return false;
  // Any record, settled or not: a settled one still holds the slot briefly.
  if (task.in_flight_turn) return false;
  if (session && isUserStopped(session)) return false;
  return true;
}
