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

/**
 * The launch settings a supervisor response carries, in `CreateTurnOptions`
 * shape (`agent` / `model` / `modelId` / `effort`).
 *
 * Apply to AGENT turns only — a supervisor-authored announcement (sync merge
 * note, nudge prompt) ran no model, so stamping one there would claim a model
 * produced text it never saw. That is not a technicality: a CLEAN sync merge
 * invokes no `claude -p` at all, so its announcement is the only turn the
 * exchange writes, and labelling it would put a model spend in the record where
 * nothing was spent. The adjacent reply turn is where a real invocation's
 * labels live.
 *
 * Every field is omitted when the response didn't carry it. That is what keeps
 * an older supervisor (built before these fields existed) honest: its responses
 * yield turns with no labels rather than turns labelled with a guess.
 */
export function launchSettingsFromResponse(
  resp: { agent?: string; model?: string; model_id?: string; effort?: string; mcp_tools?: string },
): { agent?: string; model?: string; modelId?: string; effort?: string; mcpTools?: string } {
  return {
    ...(resp.agent ? { agent: resp.agent } : {}),
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
  // Missing turn_type means a pre-feature turn — treat as 'work'. 'ask',
  // 'nudge', and 'review' are side-turns that must not stand in for the work
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
 * exchange — i.e. the most recent agent turn (work OR supervised) that recorded a
 * violations field, including an explicit empty array.
 *
 * WHY scan from the end across all agent turns, not just the work turn: violations
 * are re-detected after the push-back (and later react) invocation, and that FINAL
 * set is attributed to that follow-up turn (which sorts AFTER the work turn).
 * Reading the work turn would surface the STALE pre-push-back set.
 *
 * WHY treat `violations: []` as authoritative: a later re-detect that found nothing
 * (push-back resolved everything, or a react follow-up cleaned protected edits)
 * must supersede an earlier non-empty set. Field ABSENT (maintain nudge, plain
 * agent reply) is not a re-detect — those turns are skipped so a prior pending
 * set still stands. Matches the reconciler rule "last response with
 * `violations !== undefined` wins."
 *
 * This answers the PER-TURN question — "what did the most recent scan see" —
 * and nothing more. It is NOT the gate: what a task still owes is resolved
 * across all turns, and against the task's own changes, by
 * src/protection/outstanding.ts. Its two former companions
 * (`violationRecords`, `pendingViolations`) were deleted for reading like one.
 */
export function latestViolationTurn(turns: Turn[]): Turn | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.role === 'agent' && t.violations !== undefined) return t;
  }
  return undefined;
}

// REMOVED (move-file-approval-to-accept): `violationRecords(turns)` and
// `pendingViolations(turns)` — "the records on the latest violation turn" and
// "the pending ones".
//
// Every gate that read them now reads src/protection/outstanding.ts, because
// ONE turn's record is not the answer to "what does this task still owe". Since
// the reviewer's decision moved to accept, a conflict task runs many turns
// before anyone decides: the newest record replaces the older one, and a later
// turn that touched nothing protected records an empty set. Both silently
// dropped an earlier turn's unapproved file. The outstanding set is resolved
// across all turns and, where git can run, re-detected over the task's own
// changes.
//
// Deleted rather than left exported with corrected comments: two
// well-documented helpers sitting beside the real answer are exactly what the
// per-turn read would be rebuilt from. `latestViolationTurn` stays — the
// per-turn push-back genuinely does ask "what did the most recent scan see".

// REMOVED (fix-unblock-sticky-model): `findStickyModel(turns)` — the model a
// launch inherited by scanning back to the most recent request-side turn.
//
// INVARIANT (edited-task-model-wins): a launch resolves its model as
// `override > task.model > config default`, with NO scan of previous turns
// between the first two. Every path that accepts an explicit override already
// PERSISTS it into `task.model`, so the scan carried nothing task.model did
// not already carry — but because it outranked task.model, `lazy edit --model`
// on a started task was a silent no-op for the very next unblock, which is the
// case `lazy edit` documents model as editable FOR. Do not reintroduce it.
//
// The last variant of it took a `currentAgentId` and skipped request turns from
// a DIFFERENT agent (INVARIANT sticky-model-is-same-agent, fix-agent-switch-
// resolution), because model ids are not portable across agents. That guard has
// no subject any more: `switchTaskAgent` (src/daemon/agent-switch.ts)
// re-resolves the model for the new agent and writes it into `task.model`, so
// the single source a launch reads is already agent-correct.
//
// INVARIANT (turn-labels-are-not-launch-inputs, fix-turn-model-continuity): the
// rule above is not specific to unblock — NO launch path reads a turn's `model`,
// `model_id`, `effort` or `agent` back. Every turn type resolves what it runs on
// through `resolveTurnLaunchIdentity` (src/daemon/launch-identity.ts), whose
// task-record rung is the same `task.model` / `task.metadata.effort` /
// `task.agent_id` that overrides are persisted into. The fields written onto a
// turn are a RECORD of what ran, for humans and for review; a scan that feeds
// them back into the next launch is a second, competing answer to "what does
// this turn run on", and the one above outranked the task record. Do not
// reintroduce a history scan here or anywhere else.
