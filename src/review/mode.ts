/**
 * HOW a task gets reviewed — the one vocabulary, read by every surface.
 *
 * Three modes, and the DEFAULT is the fast one (engineer decision, 2026-09-21,
 * reversing the 2026-09-19 "human time first, tokens second" default after the
 * first cluster run under it):
 *
 *   "The performance per token is just down the drain. We proclaimed that
 *    human's time is most important, but if we spend so many tokens that we
 *    have to keep pausing, which leads to hours of empty waiting, then we
 *    aren't advancing. Money is also limited, same as time, same as attention.
 *    Low-high should be the default option if reviewing is enabled: less token
 *    usage and less re-reading of what is already in context. Fast first,
 *    ponderously slow as an optimization on quality."
 *
 * The evidence: `landing-release` ran 8–12 children concurrently under the
 * separate-reviewer cycle on 2026-09-20; every child went three or more rounds
 * of review + fix at ~30 minutes each, the org spend limit was hit twice,
 * crashing the driver and its children both times, and after four hours two of
 * thirteen children had landed.
 *
 * - `off` — a final triggers no review of any kind. The task parks reviewable
 *   and accept is not gated on a review, because there is none to gate on.
 * - `low_high` (DEFAULT) — the writer's own session reviews itself: the draft
 *   runs at `draft_effort`, a hostile read-only self-review at `review_effort`,
 *   then one revise pass. No second container, no second context re-reading a
 *   diff that is already warm. Its outcome is RECORDED AS A REVIEW — the same
 *   report shape every other review has, written by `recordLowHighSelfReview`
 *   — which under the default gate does not hold a merge and under
 *   `gate = "always"` does.
 * - `separate` — the daemon dispatches a reviewer in its own session after the
 *   final, and its verdict gates accept. The optimization you opt into when
 *   quality is worth 3–4x the wall-clock and the tokens.
 *
 * Every setting here is resolved per TASK, with THREE LEVELS of inheritance:
 *
 *     project config  →  parent task  →  task
 *
 * and an explicit `--review*` on the command doing the resolving beats all
 * three. A task that says nothing inherits its parent's value, which is what
 * lets a cluster driver set a mode ONCE on itself and have its children follow
 * unless they override. A top-level task inherits the project's.
 *
 * ONLY A CHOICE IS INHERITED. The parent level contributes what somebody
 * explicitly SET on the parent — never a value the parent merely ended up with:
 * not its legacy `low_high_loop` flag, and not a value pinned on it by an
 * earlier launch with no record of who decided it. The old resolver pinned
 * `low_high_loop = "off"` on every task alive, so reading that as a decision
 * put every new task under an existing hub into `separate` on a project whose
 * default is `low_high` — a whole tree in an arm nobody picked (engineer
 * report, 2026-09-21). See {@link reviewSettingsChosenBy}.
 *
 * The resolved values are PERSISTED on the task, the way agent / model / effort
 * are (sticky per task, last action wins): whichever launch path resolves first
 * writes them back, so a project default changed later moves new tasks and
 * leaves running ones exactly where they were. That is also what makes the
 * parent level cheap to read — a parent's persisted values already encode its
 * own inheritance, so a child reads one level, never a chain.
 */

import { docsUrl } from '../docs/links';

/** The three ways a task can be reviewed, as written in lazy.toml and metadata. */
export const REVIEW_MODES = ['off', 'low_high', 'separate'] as const;

export type ReviewMode = (typeof REVIEW_MODES)[number];

/**
 * The project default when nothing says otherwise — FAST FIRST.
 *
 * INVARIANT: this is `low_high`, not `separate`. See the module header for the
 * decision and the run that produced it.
 */
export const DEFAULT_REVIEW_MODE: ReviewMode = 'low_high';

/**
 * WHEN a recorded review holds the merge — the master switch over the mode rule.
 *
 * - `auto` (DEFAULT) — the mode decides for a review the DAEMON dispatched:
 *   `separate` gates, `low_high` and `off` do not. A review a person or a
 *   driver ASKED for gates whatever the mode says (see {@link reviewGateApplies}).
 * - `always` — any recorded review gates, `low_high`'s own self-review
 *   included. For a project that wants the fast shape and still wants a bad
 *   self-review to stop a merge. This is not a promise the vocabulary makes
 *   alone: it holds because the self-review is recorded as a real review turn
 *   (`recordLowHighSelfReview`, src/utils/reconcile.ts), which is what
 *   `successfulReviewTurnsOf` can see — and it does not hold a merge on
 *   findings the revise pass already APPLIED, which the same recorder marks.
 * - `never` — nothing gates, in any mode, however the review was started. The
 *   one setting that also switches off a manual review's gate, because a human
 *   who writes `never` has said exactly that.
 */
export const REVIEW_GATES = ['auto', 'always', 'never'] as const;

export type ReviewGate = (typeof REVIEW_GATES)[number];

/** The gate a project gets when it says nothing: the mode decides. */
export const DEFAULT_REVIEW_GATE: ReviewGate = 'auto';

/** Whether `[review] auto_fix` is on when nothing says otherwise. */
export const DEFAULT_REVIEW_AUTO_FIX = false;

/** Task metadata key carrying the task's own resolved mode. */
export const REVIEW_MODE_METADATA_KEY = 'review_mode';

/** Task metadata key carrying the task's own resolved auto-fix choice. */
export const REVIEW_AUTO_FIX_METADATA_KEY = 'review_auto_fix';

/** Task metadata key carrying the task's own resolved gate. */
export const REVIEW_GATE_METADATA_KEY = 'review_gate';

/**
 * Task metadata keys recording WHERE each pinned value came from.
 *
 * The pinned values above are EFFECTIVE values — whatever the task ended up
 * running under, written on its first launch so later turns cannot change arm.
 * That makes them useless for two questions, and these three answer both:
 *
 * 1. "Why is this task in this arm?" — the engineer's actual question when a
 *    `Review:` line surprised them. A value alone cannot say whether a person
 *    chose it, a parent supplied it, or the project default landed there.
 * 2. "May a CHILD inherit this?" — only a CHOICE is inheritable. A value that
 *    merely records what a parent itself defaulted to is not a decision anyone
 *    made about its children, and inheriting one is how a whole tree ends up in
 *    an arm nobody picked (see {@link reviewSettingsChosenBy}).
 *
 * Same shape as `effort_explicit`: the value says what, the marker says whether
 * anybody meant it.
 */
export const REVIEW_MODE_SOURCE_METADATA_KEY = 'review_mode_source';
export const REVIEW_AUTO_FIX_SOURCE_METADATA_KEY = 'review_auto_fix_source';
export const REVIEW_GATE_SOURCE_METADATA_KEY = 'review_gate_source';

/** True when `value` is one of the three gates. */
export function isReviewGate(value: unknown): value is ReviewGate {
  return typeof value === 'string' && (REVIEW_GATES as readonly string[]).includes(value);
}

/** The gate spellings, for usage text and error messages. */
export const REVIEW_GATE_INPUTS = REVIEW_GATES;

/** Parse a gate from a command line, a form or metadata. Null for anything else. */
export function parseReviewGate(value: unknown): ReviewGate | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return isReviewGate(normalized) ? normalized : null;
}

/**
 * Parse an on/off setting from a command line, a form or metadata.
 *
 * Deliberately narrow — `on`/`off`, `true`/`false`, `yes`/`no`, `1`/`0` — and
 * null for anything else, so a typo is refused by name rather than read as
 * "off" and silently switching a project's fix rounds off.
 */
export function parseReviewToggle(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  switch (value.trim().toLowerCase()) {
    case 'on': case 'true': case 'yes': case '1': return true;
    case 'off': case 'false': case 'no': case '0': return false;
    default: return null;
  }
}

/** The on/off spellings, for usage text and error messages. */
export const REVIEW_TOGGLE_INPUTS = ['on', 'off'] as const;

/**
 * HOW a recorded review turn came to exist.
 *
 * - `auto` — the daemon dispatched a REVIEWER after a final (final-turn design
 *   §8). Whether it gates is the `auto` gate's mode question.
 * - `self` — the writer's own session reviewed itself, inside a `low_high`
 *   work turn. It follows the same mode rule as `auto` (nobody asked for it
 *   either), but it is a DIFFERENT KIND of review, and two places need to tell
 *   them apart: the dispatch dedup, which must not read a self-review as "this
 *   final has been reviewed" when somebody escalates the task to `separate`;
 *   and the disregarded-review notice, which stays quiet for it because the
 *   revise pass already acted on what it found.
 * - `manual` — somebody ASKED for it: `lazy review`, or a driver's
 *   `lazy_review`. Nobody spends a review turn they did not want, so its
 *   findings gate whatever mode the task is in.
 */
export type ReviewDispatch = 'auto' | 'self' | 'manual';

/**
 * How a stored review turn was started.
 *
 * ABSENT MEANS `manual`, which is the GATING direction — the only direction a
 * gate may fail in. Turns recorded before the field existed have no value, and
 * every one of them belongs to a task that was (in the pre-`[review]` world)
 * effectively in `separate` mode, so reading them as gating is both the safe
 * answer and the one that preserves what they already did.
 */
export function reviewDispatchOf(turn: { review_dispatch?: string } | undefined | null): ReviewDispatch {
  if (turn?.review_dispatch === 'auto') return 'auto';
  if (turn?.review_dispatch === 'self') return 'self';
  return 'manual';
}

/** The writer reviewing its own work, in its own session (`low_high` mode). */
export function isSelfReview(turn: { review_dispatch?: string } | undefined | null): boolean {
  return reviewDispatchOf(turn) === 'self';
}

/**
 * Does a review recorded like this hold the merge?
 *
 * The one rule, read by the accept gate, by the web disclosure row, and by the
 * notice accept prints when it is disregarding a review. It answers only
 * "does this review COUNT" — what the review then says (findings above medium,
 * a sweep naming an uncovered issue, a failed verdict) is
 * `reviewIssuesAwaitingWork`'s question, not this one's.
 */
export function reviewGateApplies(
  gate: ReviewGate,
  mode: ReviewMode,
  dispatch: ReviewDispatch,
): boolean {
  switch (gate) {
    case 'never':
      return false;
    case 'always':
      return true;
    case 'auto':
      // A review somebody ASKED for always counts: `lazy review` and
      // `lazy_review` are deliberate acts, and silently ignoring what one found
      // because the task is in the fast mode would make the command a no-op at
      // exactly the moment it was reached for. The two nobody asked for —
      // `auto` and `self` — follow the mode.
      return dispatch === 'manual' || mode === 'separate';
  }
}

/** True when `value` is one of the three modes. */
export function isReviewMode(value: unknown): value is ReviewMode {
  return typeof value === 'string' && (REVIEW_MODES as readonly string[]).includes(value);
}

/**
 * Accept both spellings of every mode: TOML and metadata use `low_high`, while
 * humans on a command line and in a web form type `low-high`.
 *
 * Returns null for anything else, so every surface refuses an invalid value
 * with its own message rather than silently picking a mode for the user.
 */
export function parseReviewMode(value: unknown): ReviewMode | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/-/g, '_');
  return isReviewMode(normalized) ? normalized : null;
}

/** The CLI/MCP spellings, for usage text and error messages. */
export const REVIEW_MODE_INPUTS = ['off', 'low-high', 'separate'] as const;

/**
 * What a task carried BEFORE `[review] mode` existed, read as a mode.
 *
 * `low_high_loop` (and, before its own rename, `ivan_loop`) was persisted as
 * 'on' | 'off' on EVERY task by the old resolver — including 'off' for every
 * task that never opted into the experiment. So an existing task reads back as
 * `separate`, which is exactly what it was doing: no in-session loop, and the
 * daemon dispatching a reviewer after its final.
 *
 * INVARIANT: this maps 'off' to `separate` and not to the new default. Reading
 * it as `low_high` would move every in-flight task into a different review arm
 * the moment this code shipped, which is the silent arm-flip the per-task
 * persistence exists to prevent.
 */
export function reviewModeFromLegacyMetadata(value: unknown): ReviewMode | null {
  if (value === 'on') return 'low_high';
  if (value === 'off') return 'separate';
  return null;
}

/** Metadata shape this module reads — structural, so it stays free of storage types. */
export interface ReviewModeMetadataLike {
  review_mode?: string;
  review_auto_fix?: string;
  review_gate?: string;
  review_mode_source?: string;
  review_auto_fix_source?: string;
  review_gate_source?: string;
  low_high_loop?: string;
  ivan_loop?: string;
}

/**
 * Where one resolved review setting came from.
 *
 * - `task` — somebody CHOSE it for this task: `--review*` on create / start /
 *   edit, the MCP equivalent, or the web form. The only origin a CHILD may
 *   inherit.
 * - `parent` — inherited from the parent task's choice (carries its code).
 * - `project` — the `[review]` default, because nothing else said anything.
 * - `legacy` — read off the pre-`[review]` `low_high_loop` / `ivan_loop` flag
 *   this task already carried. Its own arm, never a child's (see
 *   {@link reviewSettingsChosenBy}).
 * - `pinned` — this task already carried the value, with no record of who
 *   decided it: a task launched before the source markers existed. Effective,
 *   but not evidence of a choice, so it is not inheritable either.
 */
export const REVIEW_SETTING_ORIGINS = ['task', 'parent', 'project', 'legacy', 'pinned'] as const;

export type ReviewSettingOrigin = (typeof REVIEW_SETTING_ORIGINS)[number];

/** One setting's provenance — `parent` additionally names the parent's code. */
export interface ReviewSettingSource {
  origin: ReviewSettingOrigin;
  /** The parent task's code, when `origin` is `parent` and the code is known. */
  parent?: string;
}

/** Provenance for all three settings, resolved alongside the values. */
export interface ReviewSettingsSources {
  mode: ReviewSettingSource;
  auto_fix: ReviewSettingSource;
  gate: ReviewSettingSource;
}

/** The stored spelling of a source: `task`, `project`, `legacy`, `parent:<code>`. */
export function encodeReviewSource(source: ReviewSettingSource): string {
  return source.origin === 'parent' && source.parent
    ? `parent:${source.parent}`
    : source.origin;
}

/** Read a stored source back. Null for anything unrecognised — never a guess. */
export function parseReviewSource(value: unknown): ReviewSettingSource | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.startsWith('parent:')) {
    const parent = trimmed.slice('parent:'.length).trim();
    return parent ? { origin: 'parent', parent } : { origin: 'parent' };
  }
  return (REVIEW_SETTING_ORIGINS as readonly string[]).includes(trimmed)
    ? { origin: trimmed as ReviewSettingOrigin }
    : null;
}

/** How a human reads a source: "project default", "inherited from <code>", … */
export function reviewSourceLabel(source: ReviewSettingSource): string {
  switch (source.origin) {
    case 'task':
      return 'set on this task';
    case 'parent':
      return source.parent ? `inherited from ${source.parent}` : 'inherited from the parent task';
    case 'project':
      return 'project default';
    case 'legacy':
      return 'recorded on this task before [review] existed';
    case 'pinned':
      return 'already recorded on this task, with no choice on record';
  }
}

/** The three settings that decide how a task is reviewed, all resolved. */
export interface ReviewSettings {
  mode: ReviewMode;
  auto_fix: boolean;
  gate: ReviewGate;
}

/** A partial set of settings — what a `--review*` flag or a form supplies. */
export interface ReviewSettingsOverrides {
  mode?: ReviewMode;
  auto_fix?: boolean;
  gate?: ReviewGate;
}

/** True when any setting is present — i.e. there is something to write. */
export function hasReviewOverrides(o: ReviewSettingsOverrides | undefined | null): boolean {
  return Boolean(o && (o.mode !== undefined || o.auto_fix !== undefined || o.gate !== undefined));
}

/** What a task's own metadata SAYS, with nothing inherited or defaulted in. */
export function reviewSettingsStatedBy(
  metadata: ReviewModeMetadataLike | undefined | null,
): ReviewSettingsOverrides {
  const own = parseReviewMode(metadata?.review_mode)
    // The legacy per-task flag is read at THIS level, not as a separate one:
    // it is the same thing the task said about itself, in the old spelling.
    ?? reviewModeFromLegacyMetadata(metadata?.low_high_loop ?? metadata?.ivan_loop);
  const autoFix = parseReviewToggle(metadata?.review_auto_fix);
  const gate = parseReviewGate(metadata?.review_gate);
  return {
    ...(own ? { mode: own } : {}),
    ...(autoFix !== null ? { auto_fix: autoFix } : {}),
    ...(gate ? { gate } : {}),
  };
}

/** The recorded source of each value a task's metadata states, per key. */
export function reviewSourcesStatedBy(
  metadata: ReviewModeMetadataLike | undefined | null,
): Partial<ReviewSettingsSources> {
  const recorded = (key: keyof ReviewModeMetadataLike): ReviewSettingSource =>
    // No marker means the value predates the markers: it is in force, but
    // nobody's choice is on record for it. `pinned`, never `task`.
    parseReviewSource(metadata?.[key]) ?? { origin: 'pinned' };
  const stated = reviewSettingsStatedBy(metadata);
  const legacyMode = parseReviewMode(metadata?.review_mode) === null && stated.mode !== undefined;
  return {
    ...(stated.mode !== undefined
      ? { mode: legacyMode ? { origin: 'legacy' as const } : recorded('review_mode_source') }
      : {}),
    ...(stated.auto_fix !== undefined ? { auto_fix: recorded('review_auto_fix_source') } : {}),
    ...(stated.gate !== undefined ? { gate: recorded('review_gate_source') } : {}),
  };
}

/**
 * Does a value with this source descend from somebody's explicit CHOICE?
 *
 * `task` is the choice itself. `parent` is that same choice one or more
 * generations down — the marker records WHOSE choice it was, so passing it on
 * again says exactly as much as it did the first time.
 *
 * `project`, `legacy` and `pinned` are not choices and stop at the task that
 * holds them.
 */
export function reviewSourceIsChosen(source: ReviewSettingSource | undefined): boolean {
  return source?.origin === 'task' || source?.origin === 'parent';
}

/**
 * What a task's metadata records somebody CHOOSING — the inheritable subset.
 *
 * INVARIANT: a parent contributes to a child only what a person or a driver
 * explicitly set on it (`--review*`, the MCP tools, the web form) — or what it
 * inherited from an ancestor who did. Inheritance is the whole chain, not one
 * generation: a hub started with `--review separate` must reach its
 * grandchildren, or a deep tree silently drops to LESS review than a human
 * asked for, which is the worst direction for this setting to fail in.
 *
 * What is excluded is anything nobody chose:
 *
 * - the legacy `low_high_loop` / `ivan_loop` flag, which the old resolver
 *   pinned as 'off' on EVERY task including ones nobody configured. Read as a
 *   choice, it put every new task under an existing hub into `separate` on a
 *   project whose default is `low_high` — the bug this function exists for
 *   (engineer report, 2026-09-21). It still decides the task's OWN arm, which
 *   is what {@link reviewSettingsStatedBy} is for.
 * - a value `pinned` by an earlier launch with no source marker, which is the
 *   same thing one generation later: the launch resolver writes what it
 *   RESOLVED, so a hub's pinned `separate` may be nothing but the legacy flag
 *   or a project default wearing a current key.
 * - a `project` default, which every task resolves for itself anyway. Passing
 *   one down would freeze a whole subtree against a default the project may
 *   still change.
 */
export function reviewSettingsChosenBy(
  metadata: ReviewModeMetadataLike | undefined | null,
): ReviewSettingsOverrides {
  const stated = reviewSettingsStatedBy(metadata);
  const sources = reviewSourcesStatedBy(metadata);
  return {
    ...(reviewSourceIsChosen(sources.mode) && stated.mode !== undefined
      ? { mode: stated.mode }
      : {}),
    ...(reviewSourceIsChosen(sources.auto_fix) && stated.auto_fix !== undefined
      ? { auto_fix: stated.auto_fix }
      : {}),
    ...(reviewSourceIsChosen(sources.gate) && stated.gate !== undefined
      ? { gate: stated.gate }
      : {}),
  };
}

/**
 * The settings a task runs under, WRITING NOTHING.
 *
 * Per key, independently: explicit override > the task's own recorded value >
 * the PARENT task's recorded value > the project. Per key rather than
 * all-or-nothing, so a child that overrides only the mode still inherits its
 * parent's gate — the alternative would make one flag silently reset the other
 * two to the project default.
 *
 * The parent level reads the parent's PERSISTED values and does not walk the
 * tree: the parent pinned its own settings the same way — value AND the marker
 * naming who chose it — so one lookup already carries the whole chain, and a
 * choice made on a hub reaches its grandchildren through each generation that
 * pinned it. A grandparent that changes its mind AFTER a descendant launched
 * does not reach it, which is the same stickiness `--effort` has.
 */
export function resolveReviewSettings(input: ReviewResolutionInput): ReviewSettings {
  return resolveReviewSettingsWithSources(input).settings;
}

/** What {@link resolveReviewSettingsWithSources} needs to answer. */
export interface ReviewResolutionInput {
  /** What the command doing the resolving was told, if anything. */
  overrides?: ReviewSettingsOverrides | null;
  /** The task's own metadata. */
  own?: ReviewModeMetadataLike | null;
  /** The parent task's metadata, when this task has a parent. */
  parent?: ReviewModeMetadataLike | null;
  /** The parent's code, for naming it in the resolved provenance. */
  parentCode?: string | null;
  /** `[review]` from the project root's lazy.toml. */
  project: ReviewSettings;
}

/** The resolved settings plus, per key, where each one came from. */
export interface ReviewSettingsResolution {
  settings: ReviewSettings;
  sources: ReviewSettingsSources;
}

/**
 * {@link resolveReviewSettings}, and WHY each value won.
 *
 * The provenance is resolved here rather than reconstructed by a surface: it
 * falls straight out of the precedence chain, and a second derivation would be
 * a second copy of the rule that is free to disagree with the value it explains.
 * It is the answer to "why is this task in this arm", which is the question a
 * `Review:` line on its own could never answer.
 */
export function resolveReviewSettingsWithSources(
  input: ReviewResolutionInput,
): ReviewSettingsResolution {
  const own = reviewSettingsStatedBy(input.own);
  const ownSources = reviewSourcesStatedBy(input.own);
  // Only what the PARENT chose — see `reviewSettingsChosenBy` for why a parent's
  // legacy flag and its merely-pinned values stop here.
  const parent = reviewSettingsChosenBy(input.parent);
  const parentSources = reviewSourcesStatedBy(input.parent);
  const o = input.overrides ?? {};
  // WHO chose an inherited value, at any depth. When the parent holds the value
  // by inheritance itself, its marker already names the ancestor who decided —
  // keep that name rather than overwriting it with the immediate parent's, so
  // "inherited from <hub>" stays true however many generations down it is read.
  const inheritedFrom = (key: keyof ReviewSettings): ReviewSettingSource => {
    const via = parentSources[key];
    const chooser = via?.origin === 'parent' ? via.parent : input.parentCode;
    return { origin: 'parent', ...(chooser ? { parent: chooser } : {}) };
  };
  const pick = <K extends keyof ReviewSettings>(
    key: K,
  ): { value: ReviewSettings[K]; source: ReviewSettingSource } => {
    const override = o[key] as ReviewSettings[K] | undefined;
    if (override !== undefined) return { value: override, source: { origin: 'task' } };
    const ownValue = own[key] as ReviewSettings[K] | undefined;
    if (ownValue !== undefined) {
      return { value: ownValue, source: ownSources[key] ?? { origin: 'pinned' } };
    }
    const parentValue = parent[key] as ReviewSettings[K] | undefined;
    if (parentValue !== undefined) return { value: parentValue, source: inheritedFrom(key) };
    return { value: input.project[key], source: { origin: 'project' } };
  };

  const mode = pick('mode');
  const autoFix = pick('auto_fix');
  const gate = pick('gate');
  return {
    settings: { mode: mode.value, auto_fix: autoFix.value, gate: gate.value },
    sources: { mode: mode.source, auto_fix: autoFix.source, gate: gate.source },
  };
}

/**
 * The metadata writes for the settings that were ACTUALLY SUPPLIED.
 *
 * Distinct from {@link reviewSettingsMetadata}, which records a fully resolved
 * triple: this one writes only what somebody stated, so the rest stays
 * inherited and a later change to the parent or the project still reaches this
 * task. A create that pinned all three would silently freeze a task against the
 * project default the moment it was created with one flag.
 */
export function reviewOverrideMetadata(o: ReviewSettingsOverrides): Record<string, string> {
  // Each value carries a `task` source marker: this IS somebody choosing, which
  // is the one origin a child may inherit and the one a surface may describe as
  // "set on this task".
  return {
    ...(o.mode !== undefined
      ? { [REVIEW_MODE_METADATA_KEY]: o.mode, [REVIEW_MODE_SOURCE_METADATA_KEY]: 'task' }
      : {}),
    ...(o.auto_fix !== undefined
      ? {
        [REVIEW_AUTO_FIX_METADATA_KEY]: o.auto_fix ? 'on' : 'off',
        [REVIEW_AUTO_FIX_SOURCE_METADATA_KEY]: 'task',
      }
      : {}),
    ...(o.gate !== undefined
      ? { [REVIEW_GATE_METADATA_KEY]: o.gate, [REVIEW_GATE_SOURCE_METADATA_KEY]: 'task' }
      : {}),
  };
}

/** What was set, for a confirmation line. Empty string when nothing was. */
export function describeReviewOverrides(o: ReviewSettingsOverrides): string {
  const parts: string[] = [];
  if (o.mode !== undefined) parts.push(o.mode === 'low_high' ? 'low-high' : o.mode);
  if (o.gate !== undefined) parts.push(`gate ${o.gate}`);
  if (o.auto_fix !== undefined) parts.push(`auto-fix ${o.auto_fix ? 'on' : 'off'}`);
  return parts.join(', ');
}

/** The metadata writes that record a resolved set. Keys match what is read. */
export function reviewSettingsMetadata(s: ReviewSettings): Record<string, string> {
  return {
    [REVIEW_MODE_METADATA_KEY]: s.mode,
    [REVIEW_AUTO_FIX_METADATA_KEY]: s.auto_fix ? 'on' : 'off',
    [REVIEW_GATE_METADATA_KEY]: s.gate,
  };
}

/**
 * The metadata writes that record WHERE a resolved set came from.
 *
 * Written by the launch alongside {@link reviewSettingsMetadata}, so a pinned
 * value never again loses the reason it holds — which is what keeps a project
 * default or an inherited value from reading, one generation later, as a
 * decision somebody made.
 */
export function reviewSourcesMetadata(sources: ReviewSettingsSources): Record<string, string> {
  return {
    [REVIEW_MODE_SOURCE_METADATA_KEY]: encodeReviewSource(sources.mode),
    [REVIEW_AUTO_FIX_SOURCE_METADATA_KEY]: encodeReviewSource(sources.auto_fix),
    [REVIEW_GATE_SOURCE_METADATA_KEY]: encodeReviewSource(sources.gate),
  };
}

/**
 * The mode a task is in, WRITING NOTHING.
 *
 * Precedence: explicit override > the task's own recorded mode > the legacy
 * per-task flag > the project default. The one rule — the persisting twin
 * (`resolveAndPersistReviewMode`) is this plus the write-back, and every
 * read-only caller (the accept gate, the dispatch decision, `lazy show`) uses
 * this one so no read can change which arm a task is in.
 */
export function resolveReviewMode(
  metadata: ReviewModeMetadataLike | undefined | null,
  configDefault: ReviewMode,
  override?: ReviewMode,
): ReviewMode {
  // No PARENT level here, deliberately. This is the read every gate and
  // dispatch decision makes, and by then the task has launched, so its own
  // value is pinned and the parent has nothing left to contribute. Inheritance
  // belongs to the RESOLVING call (`resolveReviewSettings`), which runs once,
  // on a path that has the parent in hand.
  return override ?? reviewSettingsStatedBy(metadata).mode ?? configDefault;
}

/**
 * The settings a task runs under, read from what it has already recorded.
 *
 * The read-only counterpart of the resolving call, for every surface asking
 * "what is this task doing" rather than "what should it do from now on" —
 * the accept gate, the dispatch decision, `lazy show`. Same no-parent-level
 * reasoning as {@link resolveReviewMode}.
 */
export function reviewSettingsOf(
  metadata: ReviewModeMetadataLike | undefined | null,
  project: ReviewSettings,
  parent?: ReviewParentContext,
): ReviewSettings {
  return resolveReviewSettings({
    own: metadata,
    parent: parent?.metadata,
    parentCode: parent?.code,
    project,
  });
}

/**
 * The parent a read-only surface has in hand, when it has one.
 *
 * Optional on every read, and it changes nothing for a task that has LAUNCHED:
 * such a task has all three values pinned, so its own level answers first. It
 * matters for a task that has NOT launched yet, where the parent level is the
 * difference between showing what the task will run under and showing the
 * project default it never had.
 */
export interface ReviewParentContext {
  metadata?: ReviewModeMetadataLike | null;
  code?: string | null;
}

/**
 * {@link reviewSettingsOf}, plus where each value came from.
 *
 * Read-only, so for a launched task the provenance is whatever it RECORDED —
 * the launch wrote it there at the same moment it pinned the values. A task
 * launched before the markers existed reads back as `pinned`, which says
 * exactly what is known: the value is in force and nobody's choice is on
 * record.
 *
 * An UNLAUNCHED task has recorded nothing, so pass its parent: without it a
 * backlog child of a hub that chose `separate` reads "low-high (project
 * default)" while starting it resolves `separate` — a provenance claim that is
 * false on exactly the tasks a human inspects BEFORE starting them.
 */
export function reviewSettingsResolutionOf(
  metadata: ReviewModeMetadataLike | undefined | null,
  project: ReviewSettings,
  parent?: ReviewParentContext,
): ReviewSettingsResolution {
  return resolveReviewSettingsWithSources({
    own: metadata,
    parent: parent?.metadata,
    parentCode: parent?.code,
    project,
  });
}

/** The mode's spelling on a command line and in a form. */
export function reviewModeSpelling(mode: ReviewMode): string {
  return mode === 'low_high' ? 'low-high' : mode;
}

/** What a mode MEANS, in plain words — no jargon, no file names. */
export function reviewModeMeaning(mode: ReviewMode): string {
  switch (mode) {
    case 'off':
      return 'nobody reviews this task; a final triggers no review';
    case 'low_high':
      return 'the writer reviews its own work in its own session, then revises';
    case 'separate':
      return 'a reviewer runs in its own session after the final, and gates your accept';
  }
}

/** What a gate MEANS, in plain words. */
export function reviewGateMeaning(gate: ReviewGate): string {
  switch (gate) {
    case 'auto':
      return 'the mode decides whether a review holds the merge; a review you asked for always does';
    case 'always':
      return 'any recorded review holds the merge, the self-review included';
    case 'never':
      return 'no review holds the merge, in any mode';
  }
}

/** What the auto-fix switch MEANS, in plain words. */
export function reviewAutoFixMeaning(autoFix: boolean): string {
  return autoFix
    ? 'a review that finds something starts a fix round by itself'
    : 'a review that finds something parks the task instead of starting a fix round';
}

/** One line naming the mode for a human, in the spelling they type. */
export function reviewModeLabel(mode: ReviewMode): string {
  return `${reviewModeSpelling(mode)} (${reviewModeMeaning(mode)})`;
}

/** One line naming the gate for a human. */
export function reviewGateLabel(gate: ReviewGate): string {
  return `${gate} (${reviewGateMeaning(gate)})`;
}

/** One setting, said in plain words, with where it came from. */
export interface ReviewSettingExplanation {
  /** Which setting: `mode`, `gate` or `auto-fix`. */
  key: 'mode' | 'gate' | 'auto-fix';
  /** The value as a human types it: `low-high`, `auto`, `off`. */
  value: string;
  /** What that value means, in plain words. */
  meaning: string;
  /** Where it came from, in plain words: "project default", "inherited from …". */
  origin: string;
  /** The same source, machine-readable: `task`, `project`, `parent:<code>`, … */
  source: string;
}

/**
 * The `Review:` line, unpacked — one clause per value, each saying what it
 * means and WHERE IT CAME FROM.
 *
 * Composed once here and rendered by `lazy show`, the task page and
 * `lazy_show`, for the same reason the line itself is: three surfaces wording
 * a rule three ways is three chances to word it wrong. The provenance is the
 * half that answers the question a surprised human actually has — "why would
 * review be separate, I was explicit about this?" — which no amount of
 * describing the value can answer (engineer report, 2026-09-21).
 */
export function reviewSettingsExplanations(
  s: ReviewSettings,
  sources: ReviewSettingsSources,
): ReviewSettingExplanation[] {
  return [
    {
      key: 'mode',
      value: reviewModeSpelling(s.mode),
      meaning: reviewModeMeaning(s.mode),
      origin: reviewSourceLabel(sources.mode),
      source: encodeReviewSource(sources.mode),
    },
    {
      key: 'gate',
      value: s.gate,
      meaning: reviewGateMeaning(s.gate),
      origin: reviewSourceLabel(sources.gate),
      source: encodeReviewSource(sources.gate),
    },
    {
      key: 'auto-fix',
      value: s.auto_fix ? 'on' : 'off',
      meaning: reviewAutoFixMeaning(s.auto_fix),
      origin: reviewSourceLabel(sources.auto_fix),
      source: encodeReviewSource(sources.auto_fix),
    },
  ];
}

/** One explanation as a sentence: `mode low-high — … (project default)`. */
export function reviewExplanationLine(e: ReviewSettingExplanation): string {
  return `${e.key} ${e.value} — ${e.meaning} (${e.origin})`;
}

/** The one-line summary every surface renders for a task's review settings. */
export function reviewSettingsLine(s: ReviewSettings): string {
  return `${reviewModeSpelling(s.mode)}, gate ${s.gate}, auto-fix ${s.auto_fix ? 'on' : 'off'}`;
}

/**
 * Everything a surface needs to render a task's review settings: the values,
 * the one-line summary, the per-value provenance, the plain-words clauses, and
 * the docs pointer.
 *
 * Composed ONCE, in the daemon, and sent whole — `lazy show`, the task page and
 * `lazy_show` render it rather than each assembling their own. The rule about
 * sending the ANSWER rather than the rule (CLAUDE.md) applies to provenance
 * exactly as it does to the line: a client re-deriving "where did this come
 * from" would be re-implementing the precedence chain in another language.
 */
export interface ReviewSettingsView extends ReviewSettings {
  line: string;
  /** Per key, the encoded source: `task`, `project`, `parent:<code>`, … */
  sources: { mode: string; gate: string; auto_fix: string };
  explanations: ReviewSettingExplanation[];
  /** The public page explaining the line, or null when doc pointers are off. */
  docs_url: string | null;
}

export function reviewSettingsView(resolution: ReviewSettingsResolution): ReviewSettingsView {
  const { settings, sources } = resolution;
  return {
    ...settings,
    line: reviewSettingsLine(settings),
    sources: {
      mode: encodeReviewSource(sources.mode),
      gate: encodeReviewSource(sources.gate),
      auto_fix: encodeReviewSource(sources.auto_fix),
    },
    explanations: reviewSettingsExplanations(settings, sources),
    docs_url: docsUrl('review-line'),
  };
}

/** The view for a task, read from what it has recorded. */
export function reviewSettingsViewOf(
  metadata: ReviewModeMetadataLike | undefined | null,
  project: ReviewSettings,
  parent?: ReviewParentContext,
): ReviewSettingsView {
  return reviewSettingsView(reviewSettingsResolutionOf(metadata, project, parent));
}
