/**
 * The one place that turns a turn's launch settings into human-readable labels.
 *
 * Every surface that lists turns (`lazy show`/`view`, the `lazy browse` TUI, the
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
 * the ask `[system]` turn is `actor: 'system'` and records the agent, model and
 * effort the turn ran under. Those render normally.
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
 * Lowercase and treat `.` / `_` as `-`, so `claude-opus-4.5` and
 * `claude-opus-4-5` compare as the same spelling. Dates and vendor prefixes
 * stay in the string — those are handled by the prefix/family rules below.
 */
export function normalizeModelKey(name: string): string {
  return name.trim().toLowerCase().replace(/[._]/g, '-');
}

/**
 * True when `requested` and `actual` name the same model after an obvious
 * equality, not when a short alias resolved to a dated snapshot.
 *
 * Rule (kept small on purpose — no catalog):
 *  1. Same after {@link normalizeModelKey}.
 *  2. One is a hyphen-bounded prefix of the other (`claude-opus-4-5` vs
 *     `claude-opus-4-5-20251101`). A short family name like `opus` is NOT a
 *     prefix of `claude-opus-4-5-…`, so that pair still shows as
 *     `opus → claude-opus-4-5-…` — the whole point of recording the actual id.
 */
export function modelsLookTheSame(requested: string, actual: string): boolean {
  const a = normalizeModelKey(requested);
  const b = normalizeModelKey(actual);
  if (!a || !b) return false;
  if (a === b) return true;
  return isHyphenBoundedPrefix(a, b) || isHyphenBoundedPrefix(b, a);
}

/** `prefix` matches `prefix-rest` but not `prefixX` or a mid-token `prefix`. */
function isHyphenBoundedPrefix(prefix: string, full: string): boolean {
  return full.startsWith(prefix) && full.charAt(prefix.length) === '-';
}

/**
 * The model slot of a launch label.
 *
 * - No actual id: the requested name (or `unknown`).
 * - No requested name: the actual id.
 * - Same after {@link modelsLookTheSame}: just the requested name.
 * - Otherwise: `requested → actual`, so a short alias that resolved to a
 *   concrete snapshot is visible on every surface that prints this label.
 */
export function formatTurnModelLabel(requested?: string, actual?: string): string {
  const req = requested?.trim() || undefined;
  const act = actual?.trim() || undefined;
  if (req && act) {
    return modelsLookTheSame(req, act) ? req : `${req} → ${act}`;
  }
  return req ?? act ?? UNKNOWN_LAUNCH_LABEL;
}

/**
 * Vendor tokens stripped only when a later alphabetic token remains, so
 * `claude-opus-4-5` is family `opus` but `gpt-5` stays family `gpt`.
 */
const VENDOR_ONLY_PREFIXES = new Set(['claude', 'anthropic', 'google', 'openai']);

/** Cursor's "pick for me" names — no family, and never a mismatch warning. */
const CURSOR_PICKS_NAMES = new Set(['auto', 'default']);

interface ModelHint {
  /** First non-vendor alphabetic token (`opus`, `sonnet`, `grok`, …). */
  family?: string;
  /** Version tuple after the family (`4-5-20251101` → `[4, 5]`; dates dropped). */
  version?: number[];
}

/**
 * Pull a family token and a version tuple out of a model name without a
 * catalog. `opus` → family only; `claude-opus-4-5-20251101` → opus + [4, 5];
 * `auto` → nothing (Cursor is supposed to pick).
 */
export function parseModelHint(name: string): ModelHint {
  const tokens = normalizeModelKey(name).split('-').filter(Boolean);
  if (tokens.length === 0) return {};
  if (tokens.length === 1 && CURSOR_PICKS_NAMES.has(tokens[0]!)) return {};

  const hasLaterFamily = (from: number): boolean =>
    tokens.slice(from + 1).some((t) => /^[a-z]/.test(t) && !CURSOR_PICKS_NAMES.has(t));

  let family: string | undefined;
  let familyIndex = -1;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!/^[a-z]/.test(token)) continue;
    if (CURSOR_PICKS_NAMES.has(token)) continue;
    if (VENDOR_ONLY_PREFIXES.has(token) && hasLaterFamily(i)) continue;
    family = token;
    familyIndex = i;
    break;
  }
  if (!family) return {};

  const version: number[] = [];
  for (const token of tokens.slice(familyIndex + 1)) {
    if (!/^\d+$/.test(token)) {
      if (version.length > 0) break;
      continue;
    }
    // 8+ digits is a date suffix (`20251101`), not a version component.
    if (token.length >= 8) continue;
    version.push(Number(token));
  }
  return version.length > 0 ? { family, version } : { family };
}

/** Lexicographic compare of version tuples, missing components treated as 0. */
function versionIsOlder(actual: number[], than: number[]): boolean {
  const n = Math.max(actual.length, than.length);
  for (let i = 0; i < n; i++) {
    const a = actual[i] ?? 0;
    const b = than[i] ?? 0;
    if (a < b) return true;
    if (a > b) return false;
  }
  return false;
}

/**
 * One-line warning when the actual model is a different FAMILY or an older
 * VERSION than the requested name suggests. No catalog: family and version
 * come from {@link parseModelHint}.
 *
 * - Different family (`opus` vs `sonnet` / `grok`) → warn.
 * - Both have versions and actual is older (`claude-opus-5` vs `claude-opus-4-5`) → warn.
 * - Requested is a bare family alias (`opus`) and `expectedLatest` (the
 *   profile default or `[models] default`) names a newer version of that
 *   family than what actually ran → warn. That is the "opus silently meant
 *   Opus 4.5 while the project default is opus 5" case.
 * - `auto` / `default` never warn: Cursor is supposed to pick.
 *
 * Returns `undefined` when there is nothing to call out.
 */
export function turnModelMismatchWarning(
  requested: string,
  actual: string,
  expectedLatest?: string,
): string | undefined {
  const req = requested.trim();
  const act = actual.trim();
  if (!req || !act) return undefined;

  const requestedHint = parseModelHint(req);
  if (!requestedHint.family) return undefined;

  const actualHint = parseModelHint(act);
  if (actualHint.family && actualHint.family !== requestedHint.family) {
    return `actual model ${act} is a different family than requested ${req}`;
  }

  if (requestedHint.version && actualHint.version
    && versionIsOlder(actualHint.version, requestedHint.version)) {
    return `actual model ${act} is older than requested ${req}`;
  }

  const hint = expectedLatest?.trim();
  if (!requestedHint.version && hint && actualHint.version) {
    const expectedHint = parseModelHint(hint);
    if (expectedHint.family === requestedHint.family && expectedHint.version
      && versionIsOlder(actualHint.version, expectedHint.version)) {
      return `actual model ${act} is older than requested ${req} suggests (default ${hint})`;
    }
  }
  return undefined;
}

/**
 * `['agent: claude-code', 'model: opus → claude-opus-4-5-20251101', 'effort: high']`
 *
 * Always those three labels, in that order, whatever the turn carries — except
 * for a turn no agent ran, which gets NONE. The concrete `model_id` the agent
 * self-reported is folded into the model label via {@link formatTurnModelLabel}.
 */
export function turnLaunchLabels(turn: TurnLaunchFields): string[] {
  if (turnRanNoAgent(turn)) return [];

  return [
    `agent: ${turn.agent ?? UNKNOWN_LAUNCH_LABEL}`,
    `model: ${formatTurnModelLabel(turn.model, turn.model_id)}`,
    `effort: ${turn.effort ?? UNKNOWN_LAUNCH_LABEL}`,
  ];
}

/**
 * The same three labels as one compact segment:
 * `agent: claude-code · model: opus → claude-opus-4-5-20251101 · effort: high`
 *
 * Empty string for a turn no agent ran — callers append it only when non-empty.
 *
 * Compact on purpose — these are dense listings, and a turn header that grows to
 * three lines is its own kind of unreadable.
 */
export function formatTurnLaunchLabels(turn: TurnLaunchFields): string {
  return turnLaunchLabels(turn).join(' · ');
}

/**
 * Parenthetical turn-kind label for listings (` (ask)`, ` (review)`, …).
 * Work turns (and legacy turns with no type) render nothing.
 */
export function formatTurnTypeSuffix(turn: { turn_type?: string }): string {
  if (!turn.turn_type || turn.turn_type === 'work') return '';
  return ` (${turn.turn_type.replaceAll('_', '-')})`;
}

/**
 * The mismatch warning for a turn, or `undefined` when there is nothing to
 * call out. Surfaces append this to the turn log line / report header.
 */
export function formatTurnModelWarning(
  turn: TurnLaunchFields,
  expectedLatest?: string,
): string | undefined {
  if (!turn.model || !turn.model_id) return undefined;
  return turnModelMismatchWarning(turn.model, turn.model_id, expectedLatest);
}
