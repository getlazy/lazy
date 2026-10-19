/**
 * Crash-safe redelivery of unconsumed human feedback.
 *
 * INVARIANT (AGENTS.md — never lose human feedback): when a work phase crashes
 * AFTER feedback was persisted but BEFORE the agent consumed it, resuming with
 * a generic "you were interrupted, carry on" prompt effectively throws the
 * feedback away — it survives only implicitly via turn-history injection, and
 * in practice the agent never acts on it. Every resume path must instead
 * re-deliver the unconsumed feedback verbatim.
 *
 * Consumption is tracked explicitly on the turn (`feedback_delivery`) rather
 * than inferred. "Is there an agent turn after it?" looks like a valid proxy
 * but is NOT: a crash records an agent *error* turn that consumed nothing, so
 * the proxy would mask exactly the case this exists for.
 */

import type { FeedbackItem, Turn } from '../types';

import feedbackRedeliveryText from '../prompts/feedback-redelivery.md' with { type: 'text' };
import { turnText } from './turn-content';
import { lazyFold } from '../task/wrapper-fold';

export interface PendingFeedback {
  /** The newest feedback turn the agent has not consumed. */
  turn: Turn;
  /**
   * How many OLDER unconsumed feedback turns sit behind it. They are not
   * re-delivered verbatim (the newest one is the operative instruction), but
   * the agent is told they exist and are visible in the turn history — so a
   * queue of feedback is never silently collapsed to one item.
   */
  olderPendingCount: number;
}

/**
 * The person's own words a feedback turn carries, oldest first. A turn
 * recorded before `feedback_items` existed (and a withheld turn, whose content
 * IS the words) carries its content as the single item.
 */
export function feedbackItemsOf(turn: Turn): FeedbackItem[] {
  if (turn.feedback_items && turn.feedback_items.length > 0) return turn.feedback_items;
  return [{
    text: turnText(turn),
    ...(turn.actor_email ? { actor_email: turn.actor_email } : {}),
    ...(turn.actor_name ? { actor_name: turn.actor_name } : {}),
  }];
}

/**
 * Find the newest feedback turn in a session that no agent response has
 * consumed. Returns null when there is nothing to re-deliver.
 *
 * Only turns explicitly marked `feedback_delivery: 'pending'` at creation are
 * candidates, so synthetic system notices and supervisor sync/nudge turns can
 * never trigger a redelivery.
 */
export function findPendingFeedback(turns: Turn[]): PendingFeedback | null {
  // A withheld turn (saved while its launch was refused) is owed to the NEXT unblock,
  // not to a resume: redelivering it here would hand the agent a refused member's
  // words as the interrupted turn's instruction and deliver them twice.
  const pending = turns.filter(t => t.feedback_delivery === 'pending' && t.feedback_withheld !== true);
  if (pending.length === 0) return null;

  // `turns` is stored in sequence order, but sort defensively rather than
  // trusting the caller's ordering — picking the wrong one re-delivers stale
  // instructions.
  const sorted = [...pending].sort((a, b) => a.sequence - b.sequence);
  const newest = sorted[sorted.length - 1];

  return { turn: newest, olderPendingCount: sorted.length - 1 };
}

/**
 * Render the redelivery prompt body: a short prefix explaining that this is a
 * redelivery after an interrupted turn, followed by the feedback VERBATIM.
 *
 * The feedback text is never summarized, truncated, or rewritten — the human's
 * exact words are the payload.
 */
export function buildFeedbackRedeliveryPrompt(pending: PendingFeedback): string {
  const olderNote = pending.olderPendingCount > 0
    ? ` ${pending.olderPendingCount} older piece${pending.olderPendingCount === 1 ? '' : 's'} of feedback also went unanswered` +
      " — read this task's turn history and address those too if they still apply."
    : '';

  // Function replacements, not string ones: the feedback is arbitrary human
  // text and `$&` / `$'` in a string replacement would mangle it. Verbatim
  // means verbatim. The turn's content is lazy-composed (its human parts were
  // neutralized when it was recorded); lazy's framing on either side is marked
  // so review surfaces fold it (src/task/wrapper-fold.ts).
  const [before, after = ''] = feedbackRedeliveryText.split('{{feedback}}');
  const framing = before!.replace('{{older_note}}', () => olderNote).trimEnd();
  const closing = after.trim();
  return `${lazyFold('redelivery', framing)}\n\n${turnText(pending.turn)}` +
    (closing ? `\n\n${lazyFold('redelivery', closing)}\n` : '\n');
}
