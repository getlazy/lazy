/**
 * Helpers for selecting turns out of a session's turn list.
 *
 * A single command can now produce several agent turns: the WORK turn plus
 * supervised follow-up turns (protected-file push-back, maintained-files nudge),
 * each recorded with turn_type 'nudge'. So the naive
 * `turns.filter(t => t.role === 'agent').pop()` no longer reliably returns the
 * right turn — depending on what you want:
 *
 *   - For the agent's task SUMMARY / work diff / SHAs → `latestWorkAgentTurn`
 *     (the first invocation's response — turn_type 'work').
 *   - For the FINAL file-violation set the human must resolve → `latestViolationTurn`
 *     (the last agent turn that re-detected violations — the push-back turn).
 */

import type { Turn } from '../types';

/** A turn whose category advances the task narrative (work, or legacy/missing). */
function isWorkAgentTurn(turn: Turn): boolean {
  // Missing turn_type means a pre-feature turn — treat as 'work'. 'ask' and
  // 'nudge' are conversational side-turns that must not stand in for the work
  // turn's SHAs/summary.
  return turn.role === 'agent' && (turn.turn_type ?? 'work') === 'work';
}

/**
 * The most recent substantive WORK agent turn (excludes 'ask' and 'nudge' turns).
 * This is the first invocation's response — it holds the agent's task summary and
 * the work-only diff SHAs. Use for "previous attempt" context and the review editor.
 */
export function latestWorkAgentTurn(turns: Turn[]): Turn | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (isWorkAgentTurn(turns[i])) return turns[i];
  }
  return undefined;
}

/**
 * The agent turn carrying the FINAL file-permission violation set for the latest
 * exchange — i.e. the most recent agent turn (work OR supervised) that recorded
 * any violations.
 *
 * WHY scan from the end across all agent turns, not just the work turn: violations
 * are re-detected after the push-back invocation, and that FINAL set is attributed
 * to the push-back turn (which sorts AFTER the work turn). Reading the work turn
 * would surface the STALE pre-push-back set. When the agent resolves everything,
 * no turn carries violations and this returns undefined (no pending violations).
 *
 * Accept-preflight and unblock-conflict-revert MUST use this so a reviewer
 * resolves the violations the agent actually left, not the ones it already fixed.
 */
export function latestViolationTurn(turns: Turn[]): Turn | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.role === 'agent' && t.violations && t.violations.length > 0) return t;
  }
  return undefined;
}
