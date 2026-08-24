/**
 * The one place that turns a turn's launch settings into human-readable labels.
 *
 * Every surface that lists turns (`lazy show`/`view`, the `lazy review` TUI, the
 * web task page and turn page) renders the SAME three facts in the SAME order:
 * which agent ran the turn, which model, and at which reasoning effort. Before
 * this existed each surface picked its own subset — `show` printed the model
 * only when it differed from the task's, `review` and the web UI printed nothing
 * — so "which agent ran turn N?" had no answer anywhere.
 *
 * INVARIANT: an absent field renders as `unknown`, never as the task's current
 * setting and never as the configured default. `Turn.agent`, `Turn.effort` and
 * `Turn.mcp_tools` are all "absent means unknown" fields — a task's agent, model
 * and effort can each be switched mid-flight, so back-filling a turn from
 * today's task record would confidently mislabel exactly the turns a reviewer is
 * trying to tell apart. See the doc comments on `Turn.agent` / `Turn.effort`.
 *
 * INVARIANT: "nothing ran" is NOT "we lost the record". Lazy writes turns of its
 * own — the supervisor's nudge prompts and sync merge notes, the daemon's
 * `[system]` resume notices. No agent invocation produced that text, so there
 * was never anything to record, and labelling them `unknown` would report
 * phantom missing data on the turns that are working exactly as designed (and
 * they are not rare — a nudge lands on most tasks). Those render no labels at
 * all. `unknown` is reserved for its real meaning: a turn that DID run something
 * we failed to record, i.e. one written before these fields existed.
 */

/**
 * The subset of a turn these labels are derived from.
 *
 * `actor` is here for the not-applicable rule only — it says who AUTHORED the
 * turn's content, which is how a lazy-written turn is told apart from an
 * unlabelled one that really did run an agent.
 */
export interface TurnLaunchFields {
  agent?: string;
  model?: string;
  model_id?: string;
  effort?: string;
  actor?: string;
}

/** Rendered for a launch field of a turn that ran, but did not record it. */
export const UNKNOWN_LAUNCH_LABEL = 'unknown';

/**
 * Rendered where a surface has a dedicated slot to fill (the web turn page's
 * "Ran As" row) and cannot simply omit the labels.
 */
export const NO_LAUNCH_LABEL = 'not applicable — written by lazy, no agent ran';

/**
 * True when this turn's content was authored by lazy itself and no agent
 * invocation is attributed to it: the supervisor's own announcements
 * (`actor: 'supervisor'` — nudge prompts, sync merge notes) and the daemon's
 * `[system]` notices.
 *
 * Deliberately narrow: it applies only when the turn carries NO launch field at
 * all. Some lazy-authored turns do belong to a launch and are stamped for it —
 * the pre-accept `[system]` turn is `actor: 'system'` and records the agent,
 * model and effort the validation ran under. Those render normally.
 *
 * This is not a heuristic that can misfire on old stores: a supervisor- or
 * system-authored turn has never carried launch labels in ANY version of lazy,
 * so an absent label there always means "nothing ran", never "recorded before
 * the field existed".
 */
export function turnRanNoAgent(turn: TurnLaunchFields): boolean {
  const lazyAuthored = turn.actor === 'supervisor' || turn.actor === 'system';
  const hasAnyLabel = Boolean(turn.agent || turn.model || turn.model_id || turn.effort);
  return lazyAuthored && !hasAnyLabel;
}

/**
 * `['agent: claude-code', 'model: opus (claude-opus-4-6-20260101)', 'effort: high']`
 *
 * Always those three labels, in that order, whatever the turn carries — except
 * for a turn no agent ran, which gets NONE. The concrete `model_id` the agent
 * self-reported is folded into the model label, and only when it says something
 * the requested alias does not.
 */
export function turnLaunchLabels(turn: TurnLaunchFields): string[] {
  if (turnRanNoAgent(turn)) return [];

  let model: string;
  if (turn.model) {
    model = turn.model_id && turn.model_id !== turn.model
      ? `${turn.model} (${turn.model_id})`
      : turn.model;
  } else {
    // No requested model recorded. A self-reported concrete id is still the most
    // specific thing known about this turn, so prefer it over `unknown`.
    model = turn.model_id ?? UNKNOWN_LAUNCH_LABEL;
  }
  return [
    `agent: ${turn.agent ?? UNKNOWN_LAUNCH_LABEL}`,
    `model: ${model}`,
    `effort: ${turn.effort ?? UNKNOWN_LAUNCH_LABEL}`,
  ];
}

/**
 * The same three labels as one compact segment:
 * `agent: claude-code · model: opus · effort: high`
 *
 * Empty string for a turn no agent ran — callers append it only when non-empty.
 *
 * Compact on purpose — these are dense listings, and a turn header that grows to
 * three lines is its own kind of unreadable.
 */
export function formatTurnLaunchLabels(turn: TurnLaunchFields): string {
  return turnLaunchLabels(turn).join(' · ');
}
