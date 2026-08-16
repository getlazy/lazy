/**
 * The port through which the web layer performs mutations.
 *
 * INVARIANT: all mutations go through the daemon. The web handler runs
 * in-process with the daemon and calls these methods, which are implemented in
 * src/daemon/review-service.ts — it never touches git, locks, or Storage writes
 * directly. This file lives in src/server/ (not src/daemon/) because
 * src/daemon/server.ts already imports src/server; the reverse import would be
 * a module cycle.
 *
 * When no implementation is injected (a Storage-only web handler, as in unit
 * tests), the mutating routes answer 503 rather than half-working.
 */

import type { FileViolation, ReviewComment, ReviewCommentIntent, TaskStatus, TaskType } from '../types';

/**
 * Statuses in which the agent's session can be resumed for a read-only ask.
 *
 * Lives here, in the shared port, because BOTH sides need it and neither may
 * import the other: the daemon gates dispatch on it, and the web page has to
 * warn the reviewer *before* they type a question that cannot be answered yet.
 * Two copies of this set would drift into a UI that promises what the daemon
 * then refuses.
 */
export const ASKABLE_STATUSES: ReadonlySet<string> = new Set(['blocked', 'conflict']);

/**
 * Why an ask cannot be dispatched right now, or null when it can.
 *
 * The wording is shown to the reviewer verbatim in two places (the comment box
 * and the failed comment's own state line), and stored as `ask_error`, so it
 * must always name the current status and say plainly that the words are kept.
 */
export function askUnavailableReason(status: string): string | null {
  if (ASKABLE_STATUSES.has(status)) return null;
  return (
    `Task is ${status} — the agent can only answer while the task is blocked or in conflict. ` +
    `Your question is saved; re-send it once the task is blocked.`
  );
}

/**
 * Why this task cannot be accepted given the reviewer's recorded decisions, or
 * null when it can.
 *
 * PRESENTATION, NOT A GATE. acceptTaskPreflight remains the only enforcer, and
 * its own message stays as it is because it is right for the CLI ("use
 * --approve-file"). That advice is useless in a browser, so the web layer
 * renders the same rule in its own terms before relaying a 409 the reviewer
 * cannot act on. If the two ever disagree the daemon wins — it is the one that
 * refuses the merge.
 */
export function acceptBlockedByViolations(violations: readonly FileViolation[]): string | null {
  const rejected = violations.filter((v) => v.status !== 'approved').map((v) => v.file);
  if (rejected.length === 0) return null;
  return (
    `Task cannot be accepted with outstanding violations of protected files: ${rejected.join(', ')}. ` +
    `Mark every one ✅ to accept, or unblock instead — unblock reverts the ⛔ files and lets the agent continue.`
  );
}

/** Has the reviewer retracted this message? */
export function isWithdrawn(c: ReviewComment): boolean {
  return c.withdrawn_at != null;
}

/**
 * A change request that is durable, not withdrawn, and still waiting to ride
 * the next unblock work turn.
 *
 * Lives in the shared port because both sides need exactly this predicate and
 * neither may import the other: the daemon decides what an unblock carries and
 * what the queue counts, and the page renders the reviewer's queued list from
 * it. Two copies drifted apart is precisely how a withdrawn comment would show
 * up in one place and not the other.
 */
export function isPendingDelivery(c: ReviewComment): boolean {
  return (
    c.role === 'human' &&
    c.intent === 'comment' &&
    c.delivery_state === 'pending_delivery' &&
    !isWithdrawn(c)
  );
}

/**
 * Why this message cannot be withdrawn, or null when it can.
 *
 * ONE definition, three surfaces: the daemon refuses with it, the page renders
 * it in place of the Withdraw button, and the route relays it. The rule is
 * "nothing that has reached the agent" — a reviewer must never be told a
 * message was taken back when the agent has already read it.
 *
 * A question already in flight is refused rather than allowed-and-marked:
 * the ask turn is running, the answer will land, and a UI that said "withdrawn"
 * over a conversation still happening would be a lie the reviewer acts on.
 */
export function withdrawRefusalReason(c: ReviewComment): string | null {
  if (c.role !== 'human') return 'Only your own messages can be withdrawn.';
  if (isWithdrawn(c)) return 'This message is already withdrawn.';
  if (c.intent === 'comment') {
    if (c.delivery_state === 'delivered') {
      return (
        'This comment was already delivered to the agent' +
        (c.delivered_turn ? ` in turn ${c.delivered_turn}` : '') +
        ' — it cannot be withdrawn. Say so in your next unblock message instead.'
      );
    }
    return null;
  }
  // Ask intent (including legacy messages written before intents existed,
  // which were asks).
  if (c.ask_state === 'pending') {
    return (
      'This question has already been sent to the agent and may be answered at any moment — ' +
      'it cannot be withdrawn. Wait for the answer, then say so in the thread.'
    );
  }
  // Only a FAILED ask can be withdrawn — it is the one ask state that means the
  // question never reached the agent. Anything else (answered, or a message old
  // enough to predate ask states) is treated as already read: the conversation
  // happened, and withdrawal is not the tool for taking back something said.
  if (c.ask_state !== 'failed') {
    return 'The agent has already answered this question — the conversation happened, so it cannot be withdrawn.';
  }
  return null;
}

export interface ReviewQueueEntry {
  id: string;
  code: string | null;
  goal: string;
  status: TaskStatus;
  type: TaskType;
  updatedAt: number;
  hasSession: boolean;
  commentCount: number;
  /** Questions awaiting an agent answer. */
  pendingAsks: number;
  /** Change requests waiting to ride the next unblock turn. */
  pendingComments: number;
}

export interface PostReviewCommentInput {
  /** Omitted for a new thread; set to the root comment's id for a reply. */
  threadId?: string;
  file: string;
  line: number;
  side: 'old' | 'new';
  content: string;
  /**
   * 'ask' dispatches a read-only question now; 'comment' accumulates for the
   * next unblock. Defaults to 'ask' when absent.
   */
  intent?: ReviewCommentIntent;
  /** The diff line's text, captured so the thread still reads sensibly if the diff moves. */
  anchorSnippet?: string;
}

/**
 * Deliberately loose: the web layer only ever surfaces warnings and redirects,
 * and must not depend on the daemon's lifecycle result shapes (that would pull
 * src/daemon types into src/server and reintroduce the coupling this port
 * exists to avoid).
 */
export interface UnblockResult {
  warnings?: string[];
}

export interface AcceptResult {
  status?: string;
  prUrl?: string;
  warnings?: string[];
}

export interface ReviewActions {
  /** Blocked tasks awaiting review, newest activity first is the caller's job. */
  listQueue(): Promise<ReviewQueueEntry[]>;
  /** Full unified diff of the task's branch. */
  getDiff(taskId: string): Promise<string>;
  /** All anchored review comments for a task, oldest first. */
  listComments(taskId: string): Promise<ReviewComment[]>;
  /**
   * Persist an anchored comment. An 'ask' is then dispatched to the agent as a
   * read-only ask (the reply lands in the same thread); a 'comment' is not
   * dispatched at all and waits for the next unblock. Either way this returns
   * as soon as the comment is durable.
   */
  postComment(taskId: string, input: PostReviewCommentInput): Promise<ReviewComment>;
  /**
   * Re-dispatch a question whose ask failed (most often: it was asked while the
   * task was working, so there was no session to resume).
   *
   * The reviewer's words are never re-entered — the comment already exists and
   * is reused as-is. Returns as soon as the retry is queued; a retry that is
   * still impossible records the reason on the comment again rather than
   * throwing it away.
   */
  retryAsk(taskId: string, commentId: string): Promise<ReviewComment>;
  /**
   * Retract one of the reviewer's own messages before it reaches the agent.
   *
   * Allowed only where nothing has been read by anyone: a queued comment still
   * in `pending_delivery`, or a question whose ask failed (by definition never
   * delivered). Refused — with a reason the reviewer sees — for a delivered
   * comment, a question already in flight, an answered question, and anything
   * the agent wrote. See {@link withdrawRefusalReason}.
   *
   * The record survives; it is retracted, not deleted.
   */
  withdrawComment(taskId: string, commentId: string): Promise<ReviewComment>;
  /**
   * Resume the agent with feedback, carrying every undelivered comment into the
   * same work turn. Queued behind any in-flight asks, so the conversation
   * finishes before the work starts.
   *
   * Protected-file decisions are NOT passed here. They are durable state set by
   * {@link setViolationDecision}; this reads them back so the reviewer's answer
   * is applied whether they decided one minute or one day ago.
   */
  unblock(taskId: string, message: string): Promise<UnblockResult>;
  /** Accept the task's work and merge it into the parent. */
  accept(taskId: string, reason?: string): Promise<AcceptResult>;
  /**
   * Record the reviewer's ⛔/✅ decision on one protected file the agent changed
   * without permission, and return the task's violations as they now stand.
   *
   * The decision is DURABLE the moment it is made, which is what lets a single
   * control drive it: there is one ⛔/✅ per file on the page because there is
   * one stored answer per file, not because copies are kept in sync.
   *
   * `approved: false` restores the file to `pending` rather than writing
   * `rejected`. Only unblock writes `rejected`, at the moment it actually
   * reverts the file — and every gate in the daemon keys off `pending`, so
   * storing `rejected` early would make `lazy accept` see nothing outstanding
   * and merge the very changes the reviewer had refused.
   */
  setViolationDecision(taskId: string, file: string, approved: boolean): Promise<FileViolation[]>;
}
