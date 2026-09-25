/**
 * Seed a new task from part of a stored builder conversation.
 *
 * A decision reached with the builder — "we should split the reaper out", "the
 * proxy needs to fail closed" — is written down exactly once, in a transcript
 * nobody re-reads. Turning it into a task meant reading it back and retyping
 * the brief. Promotion lifts the passage instead.
 *
 * WHICH PART OF THE TRANSCRIPT, and why a range:
 *
 * A builder conversation runs to hundreds of messages across unrelated topics,
 * so the whole transcript is never the brief — a task seeded from it would say
 * everything and mean nothing. The human picks a consecutive MESSAGE RANGE (the
 * exchange where the decision was made) and the seeded prompt is those messages
 * VERBATIM. Verbatim, not summarised: the words the human and the builder
 * already agreed on are better brief material than a paraphrase of them, and
 * anything a summariser would drop is exactly the detail worth keeping. A
 * drafting one-shot was considered and left out — it costs a model call and a
 * wait to produce text the human then edits anyway.
 *
 * This module owns only the TEXT and the RANGE — what the new task's goal, code
 * and prompt should say, and which messages they come from. Creating the task
 * (parentage, code allocation, prompt version) is the shared seeding path in
 * src/raised/promote-task.ts, the same one raised-item and discussion promotion
 * use.
 *
 * THE DURABLE LINK is a metadata key on the promoted TASK, never a field on the
 * conversation record: capture blind-writes a whole StoredConversation whenever
 * a session grows (see src/import/conversation-storage.ts), so anything written
 * onto that record is lost the next time the builder says a word. Reading the
 * link is therefore a scan of tasks, and it is derived the way loop progress is
 * — nothing to drift.
 */

import { defaultPromotedGoal, defaultPromotedCode } from '../raised/promote-task';
import type { StoredConversation, StoredMessage } from '../storage/types';
import type { Task } from '../types';

/**
 * Task metadata key holding "which conversation, and which part of it".
 *
 * Value shape: `<session-uuid>#<from>-<to>`, with 1-based inclusive message
 * numbers — the same numbers the transcript surfaces show, so a human reading
 * `3f9a01b2-…#12-18` can go find those messages.
 */
export const CONVERSATION_PROMOTION_METADATA_KEY = 'promoted_from_conversation';

/** A consecutive slice of a transcript, in 1-based inclusive message numbers. */
export interface MessageRange {
  from: number;
  to: number;
}

/** A task that was promoted out of a given conversation, and from where. */
export interface ConversationPromotion {
  task: Task;
  range: MessageRange;
}

export function formatMessageRange(range: MessageRange): string {
  return range.from === range.to ? `${range.from}` : `${range.from}–${range.to}`;
}

/** `<session>#<from>-<to>` — the stored form of the link. */
export function encodeConversationPromotion(sessionId: string, range: MessageRange): string {
  return `${sessionId}#${range.from}-${range.to}`;
}

/** Parse a stored link, or null when the value is not one lazy wrote. */
export function decodeConversationPromotion(
  value: string | null | undefined,
): { sessionId: string; range: MessageRange } | null {
  if (!value) return null;
  const match = /^([^#\s]+)#(\d+)-(\d+)$/.exec(value.trim());
  if (!match) return null;
  const from = Number(match[2]);
  const to = Number(match[3]);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from) return null;
  return { sessionId: match[1]!, range: { from, to } };
}

/**
 * Every task promoted out of this conversation, oldest first.
 *
 * This is what stops the same passage being promoted twice unnoticed: the
 * transcript page and the promote form both show it, so the second promoter
 * sees the first one's task before creating a duplicate of it.
 */
export function conversationPromotions(tasks: readonly Task[], sessionId: string): ConversationPromotion[] {
  const found: ConversationPromotion[] = [];
  for (const task of tasks) {
    const link = decodeConversationPromotion(task.metadata?.[CONVERSATION_PROMOTION_METADATA_KEY]);
    if (!link || link.sessionId !== sessionId) continue;
    found.push({ task, range: link.range });
  }
  return found.sort((a, b) => a.range.from - b.range.from);
}

/** Do two ranges share at least one message? */
export function rangesOverlap(a: MessageRange, b: MessageRange): boolean {
  return a.from <= b.to && b.from <= a.to;
}

/**
 * Turn a requested range into one this transcript actually has.
 *
 * REFUSES rather than clamps. An offset past the end of a paged transcript is a
 * stale link and clamping it is kind; a promote range past the end means the
 * human is about to seed a task from messages they think they selected and did
 * not, and the task would be created before anyone noticed.
 */
export function resolveMessageRange(
  conv: Pick<StoredConversation, 'messages'>,
  requested: { from?: number | null; to?: number | null },
): MessageRange {
  const total = conv.messages.length;
  if (total === 0) {
    throw new Error('This conversation has no messages to promote.');
  }
  const from = requested.from ?? 1;
  const to = requested.to ?? from;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) {
    throw new Error('Message numbers must be whole numbers.');
  }
  if (from < 1 || to < 1) {
    throw new Error('Message numbers start at 1.');
  }
  if (to < from) {
    throw new Error(`Message range ${from}-${to} ends before it starts.`);
  }
  if (from > total || to > total) {
    throw new Error(
      `This conversation has ${total} message${total === 1 ? '' : 's'}, ` +
      `so messages ${from}–${to} do not all exist.`,
    );
  }
  return { from, to };
}

/** The messages a range names. */
export function messagesInRange(conv: Pick<StoredConversation, 'messages'>, range: MessageRange): StoredMessage[] {
  return conv.messages.slice(range.from - 1, range.to);
}

/**
 * Default goal: the first sentence of the first thing the HUMAN said in the range.
 *
 * The human's own words, for the reason the discussion promoter picks the
 * reviewer's question — a goal lifted out of the middle of a model's reply
 * reads like something nobody decided. Falls back to the builder's side, then
 * to the conversation summary, so a range with no usable sentence still
 * promotes instead of failing on an empty goal.
 */
export function defaultConversationGoal(
  conv: Pick<StoredConversation, 'messages' | 'summary'>,
  range: MessageRange,
): string {
  const selected = messagesInRange(conv, range);
  const candidates = [
    ...selected.filter(m => m.role === 'user').map(m => m.text),
    ...selected.map(m => m.text),
    conv.summary,
  ];
  for (const candidate of candidates) {
    const goal = defaultPromotedGoal(candidate ?? '');
    if (goal.trim().length >= 12) return goal;
  }
  return defaultPromotedGoal(conv.summary || 'Follow up on a builder conversation');
}

/** Default kebab-case code for the promoted task, or undefined when none derives. */
export function defaultConversationCode(goal: string): string | undefined {
  return defaultPromotedCode(goal);
}

/** How a message is labelled in the seeded prompt. */
function messageLabel(msg: StoredMessage): string {
  return msg.role === 'user' ? 'Human' : 'Builder';
}

/**
 * The seeded prompt: the selected messages verbatim, plus where they came from.
 *
 * The provenance line is prose for whoever reads the task; the machine link is
 * the task's `promoted_from_conversation` metadata. Both are written, because
 * prose survives a copy-paste into a new task and metadata survives an edit of
 * the prompt.
 */
export function buildConversationTaskPrompt(
  conv: Pick<StoredConversation, 'messages' | 'sessionId'>,
  range: MessageRange,
): string {
  const body = messagesInRange(conv, range)
    .map(msg => {
      const text = msg.text.trim();
      return `**${messageLabel(msg)}:**\n\n${text || '_(this message recorded no text)_'}`;
    })
    .join('\n\n');

  const total = conv.messages.length;
  const provenance =
    `Promoted from builder conversation ${conv.sessionId} ` +
    `(message${range.from === range.to ? '' : 's'} ${formatMessageRange(range)} of ${total}).`;

  return `${body}\n\n---\n\n${provenance}`;
}
