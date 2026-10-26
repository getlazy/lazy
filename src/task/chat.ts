/**
 * A task's CHAT: the person's own words and the agent's answers, nothing else.
 *
 * A chat message is an ASK — a read-only turn that resumes the task agent's
 * own session (the same context that did the work, exactly as `lazy chat`
 * does), answers in text and changes nothing. So the chat is not a new store:
 * it is a READING of what asks already record, decided here once and sent on
 * `show` (`chat`) so no surface strips templates or picks turns on its own
 * side (AGENTS.md: `show` sends the answer).
 *
 * The rule:
 *   - Every `ask` turn is one message: the human half is the person's words,
 *     the agent half is the answer. Lazy's framing never shows — new asks
 *     record the person's words as the turn's content (`AskTaskParams.chatText`)
 *     and keep the framed prompt in `prompt`; asks recorded before that carried
 *     the review surface's framing in their content, and `chatTextOf` recovers
 *     the reviewer's latest message from it.
 *   - A question asked from the review surface (a line, the report, or the task
 *     as a whole) is ALSO a review comment. Where its answer names a turn, the
 *     turn is the message and the comment only adds WHERE it was asked
 *     (`about`). A question answered from the task's stored record — its
 *     session could not be resumed — records no turn, so its review comments
 *     are the message. A question still queued or one that failed is shown
 *     from its comment, with its state.
 *   - Supervisor nudges, wrap-up, reviews, syncs and work turns are NOT chat:
 *     they are the conversation view's (src/task/conversation.ts).
 */

import type { ReviewComment, Turn } from '../types';
import { isTaskLevelReviewAnchor } from '../review/task-level-anchor';
import { isProseReviewAnchor, proseAnchorReviewerWhere } from '../review/prose-anchor';
import { askFailureSummary, isAskFailureContent } from './ask-failure';
import taskAskTemplate from '../prompts/review-task-ask.md' with { type: 'text' };
import commentAskTemplate from '../prompts/review-comment-ask.md' with { type: 'text' };
import proseAskTemplate from '../prompts/review-prose-ask.md' with { type: 'text' };

export interface ChatMessage {
  /** Stable per message: `turn:<sequence>` or `comment:<id>`. */
  id: string;
  from: 'person' | 'agent';
  /** Exactly what the person typed, or the agent's answer. Never lazy's framing. */
  text: string;
  /** ms since epoch. */
  at: number;
  actor_name: string | null;
  actor_email: string | null;
  /** Session turn number of the ask, when it ran as a turn. */
  turn_number: number | null;
  /**
   * Person messages only: `pending` while the answer has not arrived, `queued`
   * while it waits for the agent to finish its current turn, `failed` when the
   * ask did not run (see `error`), `answered` otherwise.
   */
  state: 'pending' | 'queued' | 'answered' | 'failed' | null;
  error: string | null;
  /** Where it was asked from, in words ("on src/a.ts:12", "on the report"); null for the task as a whole. */
  about: string | null;
  /** Agent messages only: answered from the task's stored record, not its live session. */
  from_record: boolean;
  /**
   * Person messages only: who sent the question — a person, or the builder or
   * another task's agent asking over MCP, so an agent's question never reads as
   * a person's own words. Null on agent messages.
   */
  asked_by: 'person' | 'builder' | 'agent' | null;
}

/** First line of each review ask template — how a framed legacy ask is recognised. */
const FRAMED_OPENINGS = [taskAskTemplate, commentAskTemplate, proseAskTemplate]
  .map((t) => t.split('\n')[0]!.split('{{')[0]!.trim())
  .filter((line) => line.length > 0);

const REVIEWER_LINE = '**Reviewer:** ';
const ANSWER_INSTRUCTION = "\n\nAnswer the reviewer's latest message";

/**
 * The person's words in an ask turn's content. A turn written by the review
 * surface before asks recorded the words separately carries the whole framed
 * thread; its latest reviewer message is what the person typed.
 */
export function chatTextOf(content: string): string {
  const trimmed = content.trim();
  if (!FRAMED_OPENINGS.some((opening) => trimmed.startsWith(opening))) return trimmed;
  const at = trimmed.lastIndexOf(REVIEWER_LINE);
  if (at < 0) return trimmed;
  const rest = trimmed.slice(at + REVIEWER_LINE.length);
  const end = rest.indexOf(ANSWER_INSTRUCTION);
  return (end >= 0 ? rest.slice(0, end) : rest).trim();
}

function aboutOf(comment: ReviewComment): string | null {
  if (isTaskLevelReviewAnchor(comment.file, comment.line)) return null;
  if (isProseReviewAnchor(comment.file)) return proseAnchorReviewerWhere(comment.file);
  return `on ${comment.file}:${comment.line}`;
}

function turnNumberOf(sequence: number): number {
  return Math.floor(sequence / 2) + 1;
}

/** Who asked, from the turn's channel. Anything else (a person, unknown) is a person. */
function askedByOf(turn: Turn): 'person' | 'builder' | 'agent' {
  const role = typeof turn.actor === 'string' ? turn.actor : null;
  return role === 'builder' ? 'builder' : role === 'agent' ? 'agent' : 'person';
}

function isAsk(comment: ReviewComment): boolean {
  return comment.role === 'human' && (comment.intent ?? 'ask') === 'ask' && !comment.withdrawn_at;
}

/**
 * Build the chat. `turns` are the task's session turns; `reviewComments` its
 * review comments (both as stored). Ordered by time.
 */
export function buildChat(turns: Turn[], reviewComments: ReviewComment[]): ChatMessage[] {
  const asks = reviewComments.filter(isAsk);
  const askByTurn = new Map<number, ReviewComment>();
  for (const c of asks) if (c.turn_number != null) askByTurn.set(c.turn_number, c);

  const out: ChatMessage[] = [];
  const askTurns = turns.filter((t) => t.turn_type === 'ask');
  const agentBySeq = new Map(askTurns.filter((t) => t.role === 'agent').map((t) => [t.sequence, t]));
  /** Unanswered human ask turns' words — a queued comment with the same words IS that turn. */
  const pendingWords = new Set<string>();

  for (const turn of askTurns) {
    // Numbered from the AGENT half, as ask results and review comments are, so
    // both halves of one ask always carry the same number.
    const number = turnNumberOf(turn.role === 'human' ? turn.sequence + 1 : turn.sequence);
    const comment = askByTurn.get(number) ?? null;
    if (turn.role === 'human') {
      const reply = agentBySeq.get(turn.sequence + 1) ?? null;
      // A crash / watchdog / abandoned notice is not an answer: the question
      // reads "not answered", with one line of why, and no agent message.
      const failed = reply !== null && isAskFailureContent(reply.content);
      const answered = reply !== null && !failed;
      const text = chatTextOf(turn.content);
      if (!reply) pendingWords.add(text);
      out.push({
        id: `turn:${turn.sequence}`,
        from: 'person',
        text,
        at: turn.timestamp,
        actor_name: turn.actor_name ?? null,
        actor_email: turn.actor_email ?? null,
        turn_number: number,
        state: failed ? 'failed' : answered ? 'answered' : 'pending',
        error: failed ? askFailureSummary(reply!.content) : null,
        about: comment ? aboutOf(comment) : null,
        from_record: false,
        asked_by: askedByOf(turn),
      });
    } else {
      if (isAskFailureContent(turn.content)) continue;
      out.push({
        id: `turn:${turn.sequence}`,
        from: 'agent',
        text: turn.content.trim(),
        at: turn.timestamp,
        actor_name: null,
        actor_email: null,
        turn_number: number,
        state: null,
        error: null,
        about: null,
        from_record: false,
        asked_by: null,
      });
    }
  }

  // Review-surface asks that have no turn of their own.
  const askTurnNumbers = new Set(askTurns.map((t) => turnNumberOf(t.sequence)));
  for (const c of asks) {
    if (c.turn_number != null && askTurnNumbers.has(c.turn_number)) continue;
    if (c.ask_state === 'pending' && pendingWords.has(c.content.trim())) continue;
    const state = c.ask_state === 'failed' ? 'failed'
      : c.ask_state === 'answered' ? 'answered'
      : c.ask_state === 'queued' ? 'queued'
      : 'pending';
    out.push({
      id: `comment:${c.id}`,
      from: 'person',
      text: c.content.trim(),
      at: c.created_at,
      actor_name: null,
      actor_email: null,
      turn_number: null,
      state,
      error: state === 'failed' ? c.ask_error ?? null : null,
      about: aboutOf(c),
      from_record: false,
      // The review surface is a person's.
      asked_by: 'person',
    });
    // Its answer: the first agent reply in the same thread after it and before
    // the thread's next human message.
    const nextHuman = reviewComments
      .filter((r) => r.thread_id === c.thread_id && r.role === 'human' && r.created_at > c.created_at)
      .reduce((min, r) => Math.min(min, r.created_at), Infinity);
    const reply = reviewComments
      .filter((r) =>
        r.thread_id === c.thread_id && r.role === 'agent'
        && r.created_at >= c.created_at && r.created_at < nextHuman
        && (r.turn_number == null || !askTurnNumbers.has(r.turn_number)))
      .sort((a, b) => a.created_at - b.created_at)[0];
    if (reply && state === 'answered') {
      out.push({
        id: `comment:${reply.id}`,
        from: 'agent',
        text: reply.content.trim(),
        at: reply.created_at,
        actor_name: null,
        actor_email: null,
        turn_number: null,
        state: null,
        error: null,
        about: null,
        from_record: reply.turn_number == null,
        asked_by: null,
      });
    }
  }

  return out.sort((a, b) => a.at - b.at || (a.from === b.from ? 0 : a.from === 'person' ? -1 : 1));
}
