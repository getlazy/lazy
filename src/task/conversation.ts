/**
 * A task's history read as a CONVERSATION between the people and the agent.
 *
 * A review chunk (`groupTurnsIntoChunks`) is "a person acted, and everything
 * that followed" — but what followed is mostly lazy talking to the agent:
 * supervisor nudges, wrap-up steps, the low-high self-review and its revise
 * pass, syncs, recovered turns. A reader looking for "what did it say back to
 * me" had to open the chunk and scroll to its bottom. An exchange answers that
 * directly: the person's message, the agent's reply to it, and the mechanical
 * turns in between as one labelled, expandable list — never dropped.
 *
 * WHICH TURN IS THE REPLY, AND WHICH ARE MECHANICAL, IS DECIDED HERE, ONCE. The
 * daemon sends the answer on `show` (`conversation`), every surface renders it,
 * and no client re-derives it (AGENTS.md: `show` sends the answer).
 *
 * The rule:
 *   - An exchange is one review chunk; its prompt is the chunk's boundary turn
 *     (null for a leading run of automation before anybody acted).
 *   - Every supervised follow-up is recorded as a supervisor→agent pair with
 *     `turn_type: 'nudge'`, whatever it was; WHICH follow-up it was is read
 *     from the heading lazy wrote on the supervisor half
 *     (src/task/supervised-headings.ts), and the agent half takes the same kind.
 *   - A `pending_notes` pair is a person's comment handed to the running turn
 *     and the agent's answer to it. It is NOT mechanical: it is a FOLLOW-UP of
 *     the exchange, shown open, in order.
 *   - The reply is the LAST agent-role turn in the chunk that answers a person
 *     rather than lazy: a `work` or `ask` turn (or one with no type), never a
 *     recovered notice. Failing that, the chunk's last agent-role turn that is
 *     not part of a follow-up — a failure notice or a review reply is still what
 *     the person got back. No such turn → no reply yet.
 *   - Every other turn in the chunk is MECHANICAL, kept in order with a kind.
 */

import type { Turn } from '../types';
import { groupTurnsIntoChunks } from '../utils/turn-chunks';
import { supervisedKindOfContent } from './supervised-headings';
import type { SupervisedKind } from '../protocol/types';

/** What a mechanical turn was, in words a reader recognises. */
export type MechanicalKind =
  | 'nudge'
  | 'wrap-up'
  | 'self-review'
  | 'review'
  | 'sync'
  | 'pre-accept'
  | 'recovered'
  | 'resume'
  | 'agent step';

export interface ConversationMechanicalTurn {
  sequence: number;
  kind: MechanicalKind;
}

/** A person's comment delivered to the running turn, and the agent's answer. */
export interface ConversationFollowUp {
  prompt_sequence: number;
  /** Null when the agent's answer to it was not recorded. */
  reply_sequence: number | null;
}

export interface ConversationExchange {
  /** The review chunk this exchange is (`chunks[].index`). */
  chunk_index: number;
  /** The person's turn that opened it; null for a leading automation run. */
  prompt_sequence: number | null;
  /** The agent's answer to it; null while none has arrived. */
  reply_sequence: number | null;
  /** Comments handed to the agent during this exchange, with its answers, in order. Shown open. */
  follow_ups: ConversationFollowUp[];
  /** Everything else in the chunk, in order. Collapsed, never hidden. */
  mechanical: ConversationMechanicalTurn[];
  /**
   * One line describing `mechanical`, worded here so no surface words it its
   * own way — e.g. "6 mechanical turns: nudge, self-review, wrap-up, sync".
   * Null when there are none.
   */
  mechanical_label: string | null;
}

const RECOVERED_PREFIX = '[Recovered]';

/** How each supervised follow-up kind reads to a person. `pending_notes` is not mechanical. */
const SUPERVISED_MECHANICAL_KIND: Record<Exclude<SupervisedKind, 'pending_notes'>, MechanicalKind> = {
  permission_pushback: 'wrap-up',
  maintain: 'wrap-up',
  react: 'wrap-up',
  commit_leftovers: 'wrap-up',
  present: 'wrap-up',
  commit_nudge: 'nudge',
  background_nudge: 'nudge',
  low_high_review: 'self-review',
  low_high_revise: 'self-review',
  review_reask: 'self-review',
};

function isRecovered(turn: Turn): boolean {
  return turn.content.startsWith(RECOVERED_PREFIX);
}

function answersAPerson(turn: Turn): boolean {
  if (isRecovered(turn)) return false;
  const type = turn.turn_type ?? 'work';
  return type === 'work' || type === 'ask';
}

/** A supervisor-written follow-up prompt, and which kind; null for any other turn. */
function supervisedPromptKind(turn: Turn): SupervisedKind | 'unknown' | null {
  if (turn.role !== 'human' || turn.turn_type !== 'nudge') return null;
  return supervisedKindOfContent(turn.content) ?? 'unknown';
}

/** Why a turn that is not the prompt, the reply or a follow-up sits in the exchange. */
export function mechanicalKindOf(turn: Turn, supervised?: SupervisedKind | 'unknown' | null): MechanicalKind {
  if (isRecovered(turn)) return 'recovered';
  if (supervised && supervised !== 'unknown' && supervised !== 'pending_notes') {
    return SUPERVISED_MECHANICAL_KIND[supervised];
  }
  switch (turn.turn_type) {
    case 'nudge': return 'nudge';
    case 'wrap_up': return 'wrap-up';
    case 'review': return turn.review_dispatch === 'self' ? 'self-review' : 'review';
    case 'sync': return 'sync';
    case 'pre_accept': return 'pre-accept';
    default: break;
  }
  if (turn.role === 'human') {
    // A human-role turn that is not a boundary was written by automation.
    return turn.actor === 'supervisor' ? 'nudge' : 'resume';
  }
  return 'agent step';
}

export function mechanicalLabel(mechanical: ConversationMechanicalTurn[]): string | null {
  if (mechanical.length === 0) return null;
  const kinds: string[] = [];
  for (const m of mechanical) if (!kinds.includes(m.kind)) kinds.push(m.kind);
  const noun = mechanical.length === 1 ? 'mechanical turn' : 'mechanical turns';
  return `${mechanical.length} ${noun}: ${kinds.join(', ')}`;
}

export function buildConversation(turns: Turn[]): ConversationExchange[] {
  return groupTurnsIntoChunks(turns).map((chunk) => {
    // Pair each supervised prompt with the agent turn that answered it (the
    // next agent-role nudge turn), and give both halves the prompt's kind.
    const supervisedOf = new Map<Turn, SupervisedKind | 'unknown'>();
    const followUps: ConversationFollowUp[] = [];
    const inFollowUp = new Set<Turn>();
    chunk.turns.forEach((turn, i) => {
      const kind = supervisedPromptKind(turn);
      if (!kind) return;
      supervisedOf.set(turn, kind);
      const next = chunk.turns[i + 1];
      const answer = next && next.role === 'agent' && next.turn_type === 'nudge' ? next : null;
      if (answer) supervisedOf.set(answer, kind);
      if (kind === 'pending_notes') {
        inFollowUp.add(turn);
        if (answer) inFollowUp.add(answer);
        followUps.push({ prompt_sequence: turn.sequence, reply_sequence: answer ? answer.sequence : null });
      }
    });

    const agentTurns = chunk.turns.filter((t) => t.role === 'agent' && !inFollowUp.has(t));
    const reply = [...agentTurns].reverse().find(answersAPerson)
      ?? agentTurns[agentTurns.length - 1]
      ?? null;
    const mechanical = chunk.turns
      .filter((t) => t !== chunk.boundary && t !== reply && !inFollowUp.has(t))
      .map((t) => ({ sequence: t.sequence, kind: mechanicalKindOf(t, supervisedOf.get(t)) }));
    return {
      chunk_index: chunk.index,
      prompt_sequence: chunk.boundary ? chunk.boundary.sequence : null,
      reply_sequence: reply ? reply.sequence : null,
      follow_ups: followUps,
      mechanical,
      mechanical_label: mechanicalLabel(mechanical),
    };
  });
}
