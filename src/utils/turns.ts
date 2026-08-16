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

import type { Turn, FileViolation } from '../types';

/**
 * The launch settings a supervisor response carries, in `CreateTurnOptions`
 * shape (`model` / `modelId` / `effort`).
 *
 * Apply to AGENT turns only — a supervisor-authored announcement (sync merge
 * note, nudge prompt) ran no model, so stamping one there would claim a model
 * produced text it never saw.
 *
 * Every field is omitted when the response didn't carry it. That is what keeps
 * an older supervisor (built before these fields existed) honest: its responses
 * yield turns with no labels rather than turns labelled with a guess.
 */
export function launchSettingsFromResponse(
  resp: { model?: string; model_id?: string; effort?: string; mcp_tools?: string },
): { model?: string; modelId?: string; effort?: string; mcpTools?: string } {
  return {
    ...(resp.model ? { model: resp.model } : {}),
    ...(resp.model_id ? { modelId: resp.model_id } : {}),
    ...(resp.effort ? { effort: resp.effort } : {}),
    // Not a launch setting in the strict sense — it is an OBSERVATION of what
    // the agent loaded — but it rides the same per-response path and has the
    // same "omitted means unrecorded, not zero" rule.
    ...(resp.mcp_tools ? { mcpTools: resp.mcp_tools } : {}),
  };
}

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

/**
 * The violations a reviewer still has to decide on: the `pending` entries of
 * `latestViolationTurn`.
 *
 * INVARIANT (violations-come-from-the-violation-turn): every surface that GATES
 * on "does this task have unresolved violations?" must read them through here,
 * never through `turns.filter(t => t.role === 'agent').pop()`. A supervised
 * push-back or maintained-files nudge adds a further agent turn that carries no
 * violations, so the naive `pop()` lands on the nudge reply, sees none, and lets
 * the caller through with no decision recorded — after which the daemon (which
 * DOES use `latestViolationTurn`) finds them and reverts every unapproved file.
 * That is the silent-revert bug fix-violation-turn-detection fixed: the guard
 * and the enforcement must look at the same turn.
 */
export function pendingViolations(turns: Turn[]): FileViolation[] {
  const turn = latestViolationTurn(turns);
  return turn?.violations?.filter(v => v.status === 'pending') ?? [];
}

/**
 * The model a launch inherits when the caller gave no explicit override
 * ("sticky model"): the most recent REQUEST-side turn's model.
 *
 * INVARIANT (sticky-model-is-request-side): agent turns are skipped. They carry
 * a `model` too — that is the whole point of per-turn labelling — but theirs is
 * a record of what ran, and `model_id` alongside it can be a dated snapshot. If
 * this scan read agent turns, an alias would harden into whatever concrete
 * model answered last and every later turn would be pinned to it. Sticky must
 * propagate the human/builder's REQUEST, so only their turns count.
 */
export function findStickyModel(turns: Turn[]): string | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.role === 'agent') continue;
    if (t.model) return t.model;
  }
  return undefined;
}
