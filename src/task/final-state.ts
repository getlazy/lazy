/**
 * THE resolver for "has this task been declared done, and does that claim still
 * stand?"
 *
 * Every surface goes through `resolveFinalState` — `lazy show`, `lazy_show`,
 * the web review page, and (from slice 2) the accept gate. Same rule the
 * project already applies to the diff base (`resolveTaskDiffBase`), the current
 * prompt (`currentPromptOf`) and the notes cutoff (`resolveNotesCutoff`): the
 * answer is computed once, server-side, and clients render it. `show` sends the
 * ANSWER, never the inputs for a client to re-derive.
 *
 * INVARIANT (final-turn design §2.2/§2.3): a final is not a stored boolean and
 * is never recomputed from anything but the turn records. No counter, no flag —
 * a flag would drift the first time a turn was recovered, a task reopened or a
 * session reset, which is the same argument `cluster-progress.ts` makes for
 * deriving a cluster's k-of-n from its children.
 */

import type { FinalClaim, Turn, TurnType } from '../types';

/**
 * A turn that moved the branch after a final was declared, and what it was.
 *
 * The material for the "head has since moved" LABEL, resolved here so no
 * surface composes it from raw turns.
 */
export interface FinalHeadMove {
  /** Sequence of the turn that moved it. */
  sequence: number;
  /** Turn type, defaulted to 'work' the way the field's own convention does. */
  turn_type: TurnType;
  /** Short human phrase: "a sync", "a wrap-up step", … */
  label: string;
  /** HEAD after that turn. */
  end_sha: string;
}

/** The answer: a final that still stands, plus everything a surface must say about it. */
export interface FinalState {
  claim: FinalClaim;
  /** Sequence of the turn that carries the claim. */
  turn_sequence: number;
  /**
   * HEAD as the TURN RECORDS know it — the newest non-null `end_sha` at or
   * after the declaring turn, or the claim's own SHA when no later turn
   * recorded one.
   *
   * Deliberately not a git read: this resolver is pure over the records so that
   * every surface (including a remote one holding only a `show` payload) gets
   * the same answer, and so it can never throw or fetch. A branch moved outside
   * lazy — a human committing in the worktree without a turn — is therefore
   * invisible here, which is the same blind spot every turn-derived surface has.
   */
  head_sha: string;
  /** True when {@link head_sha} differs from the claim's SHA. */
  head_moved: boolean;
  /** What moved it, oldest first. Empty unless {@link head_moved}. */
  moved_by: FinalHeadMove[];
}

/** A turn's effective type: absent means 'work', per the field's own convention. */
function turnTypeOf(turn: Pick<Turn, 'turn_type'>): TurnType {
  return turn.turn_type ?? 'work';
}

/**
 * Did this turn move the branch?
 *
 * Unknown SHAs (a turn recorded before the four-SHA model, or one whose window
 * could not be read) answer FALSE — "I cannot tell" must not be reported to a
 * reviewer as "the head moved", which would put a label on every pre-existing
 * task.
 */
function movedTheBranch(turn: Pick<Turn, 'start_sha' | 'end_sha'>): boolean {
  return Boolean(turn.start_sha && turn.end_sha && turn.start_sha !== turn.end_sha);
}

/**
 * INVARIANT (final-turn design §2.3, decided by `loop-final-turn` on
 * 2026-09-15): ONLY AN AGENT WORK TURN THAT PRODUCED COMMITS UN-FINALS. The
 * predicate is spelled HERE, exhaustively, and nowhere else — it is the whole
 * rule, so a second copy at a call site is a second rule.
 *
 * All three must hold: `role === 'agent'`, the turn's type is `work` (absent
 * counts as `work`), and it moved the branch. Everything else carries the final
 * forward: `sync`, `ask`, `nudge`, `review` and `pre_accept` turns, the
 * supervised wrap-up invocations, and a work turn that committed nothing.
 *
 * Why it is the TURN and not the head: the wrap-up steps commit by design and
 * run AFTER the claim is recorded, so under a strict `final.sha === HEAD` rule
 * every task whose wrap-up changed anything became un-acceptable the instant
 * its wrap-up succeeded — and the remedy would commit again. A cluster, whose
 * contract mandates a sync before every child, would likewise pay a finalize
 * turn for obeying its own contract. Honesty about a moved head is bought with
 * a LABEL ({@link FinalState.moved_by}), never with a refusal.
 */
export function turnUnFinals(
  turn: Pick<Turn, 'role' | 'turn_type' | 'start_sha' | 'end_sha'>,
): boolean {
  return turn.role === 'agent' && turnTypeOf(turn) === 'work' && movedTheBranch(turn);
}

/** How a head move is described to a reviewer, from the turn that made it. */
function moveLabel(turn: Pick<Turn, 'role' | 'turn_type' | 'actor'>): string {
  switch (turnTypeOf(turn)) {
    case 'sync':
      return 'a sync';
    case 'nudge':
      return 'a supervised follow-up';
    case 'review':
      return 'a review turn';
    case 'pre_accept':
      return 'a pre-accept turn';
    case 'wrap_up':
      return 'a wrap-up turn';
    case 'ask':
      return 'an ask turn';
    default:
      // A work turn that reaches this function did NOT un-final (or we would
      // never have got here), so it is somebody else's commit landing on the
      // branch — a human pairing, or a child accepted into a hub.
      return turn.role === 'agent' ? 'an agent turn' : 'a commit outside an agent work turn';
  }
}

/**
 * Whether this task has a final that still stands, and what to say about it.
 *
 * Returns null when nobody has declared the work done, or when an agent work
 * turn with commits has run since the newest claim.
 *
 * `turns` must be the task's session turns in SEQUENCE order — the order every
 * `getSessionTurns` caller already gets.
 */
export function resolveFinalState(turns: readonly Turn[]): FinalState | null {
  let declaring: Turn | null = null;
  let declaringIndex = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!;
    if (turn.final) {
      declaring = turn;
      declaringIndex = i;
      break;
    }
  }
  if (!declaring?.final) return null;

  const after = turns.slice(declaringIndex + 1);
  if (after.some(turnUnFinals)) return null;

  const moved_by: FinalHeadMove[] = [];
  let head_sha = declaring.final.sha;
  for (const turn of after) {
    if (!movedTheBranch(turn)) continue;
    moved_by.push({
      sequence: turn.sequence,
      turn_type: turnTypeOf(turn),
      label: moveLabel(turn),
      end_sha: turn.end_sha!,
    });
    head_sha = turn.end_sha!;
  }
  // The declaring turn's own window counts too: `lazy_final` is called mid-turn,
  // so the agent may commit after it — a real head move, and one the reviewer is
  // owed, but not an un-final (the claim and those commits are the same turn).
  if (declaring.end_sha && declaring.end_sha !== head_sha && moved_by.length === 0) {
    head_sha = declaring.end_sha;
  }

  return {
    claim: declaring.final,
    turn_sequence: declaring.sequence,
    head_sha,
    head_moved: head_sha !== declaring.final.sha,
    moved_by,
  };
}

/**
 * The one-line "head has since moved" label, or null when the claim is still at
 * the head.
 *
 * Composed here rather than in each surface, so the CLI, the web page and a
 * remote client cannot each word it differently.
 */
export function finalHeadMovedLabel(state: FinalState): string | null {
  if (!state.head_moved) return null;
  const causes = state.moved_by.length > 0
    ? [...new Set(state.moved_by.map((m) => m.label))].join(', ')
    : 'later commits on this turn';
  return `declared final at ${state.claim.sha.substring(0, 8)}; head has since moved (${causes})`;
}
