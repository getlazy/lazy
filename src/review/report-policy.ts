/**
 * Presentation policy for structured turn-report sections.
 *
 * Storage and MCP keep the agent's array order — that is the authoring
 * contract, and `lazy_show` over MCP returns it unchanged. Human-facing
 * renderers (web, `lazy show`, the review TUI) then apply a tier order across
 * kinds, preserving agent order WITHIN a tier.
 *
 * INVARIANT (narrowed 2026-09, engineer-approved): agent order is no longer
 * the reading order. The renderer ranks kinds so a reviewer sees what the
 * product does before how it was done. See review-presentation-docs-first.
 *
 * Seam: pass an alternate {@link ReportPolicy} (later from `[review]` config)
 * without touching renderers. This task ships no lazy.toml key.
 *
 * Legacy `what_was_done`: every report in the store today uses that kind.
 * It is the pre-split narrative of "what this task did", so it ranks and
 * surfaces with behavior (Landing, labelled "What was done") — not with
 * `implementation`. Treating it as implementation emptied Landing for every
 * existing task. Do not migrate stored reports.
 */

import type { TurnReportSection, TurnReportSectionKind } from '../types';

/** Rank bucket a section falls into. */
export type ReportSectionTier =
  | 'behavior_change'
  | 'capabilities_lost'
  | 'how_to_verify'
  | 'implementation'
  | 'commentary';

export type ReportSurface = 'landing' | 'changes' | 'full';

export interface ReportPolicy {
  /** Canonical kind → tier. Unknown kinds return null (sorted last). */
  tierOf(kind: TurnReportSectionKind): ReportSectionTier | null;
  /** Display order of tiers. Screenshots already render above the report. */
  tierOrder: readonly ReportSectionTier[];
}

/**
 * Default reading order: what changed for you, then what broke, then how to
 * check, then how it was done, then anything else.
 */
export const DEFAULT_REPORT_TIER_ORDER: readonly ReportSectionTier[] = [
  'behavior_change',
  'capabilities_lost',
  'how_to_verify',
  'implementation',
  'commentary',
] as const;

export const DEFAULT_REPORT_POLICY: ReportPolicy = {
  tierOf(kind) {
    // Pre-split narrative: same bucket as behavior so Landing still answers
    // "what did this task do" for every stored report.
    if (kind === 'what_was_done') return 'behavior_change';
    if (kind === 'behavior_change') return 'behavior_change';
    if (kind === 'capabilities_lost') return 'capabilities_lost';
    if (kind === 'how_to_verify') return 'how_to_verify';
    if (kind === 'implementation') return 'implementation';
    if (kind === 'commentary') return 'commentary';
    return null;
  },
  tierOrder: DEFAULT_REPORT_TIER_ORDER,
};

/** Human labels — display only. Legacy keeps its original heading. */
export const REPORT_SECTION_LABELS: Record<TurnReportSectionKind, string> = {
  capabilities_lost: 'Capabilities lost or still missing',
  behavior_change: 'What changed for you',
  implementation: 'How it was done',
  what_was_done: 'What was done',
  how_to_verify: 'How to verify',
  commentary: 'Commentary',
};

const LANDING_TIERS: ReadonlySet<ReportSectionTier> = new Set([
  'behavior_change',
  'capabilities_lost',
]);

const CHANGES_TIERS: ReadonlySet<ReportSectionTier> = new Set([
  'implementation',
  'commentary',
]);

/**
 * Stable sort: tier rank, then original index. Does not mutate `sections`.
 */
export function orderReportSections(
  sections: readonly TurnReportSection[],
  policy: ReportPolicy = DEFAULT_REPORT_POLICY,
): TurnReportSection[] {
  const rank = new Map(policy.tierOrder.map((t, i) => [t, i]));
  return sections
    .map((s, i) => ({
      s,
      i,
      r: rank.get(policy.tierOf(s.kind) ?? ('' as ReportSectionTier)) ?? 999,
    }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.s);
}

/** Sections a given tab/surface should render, already in policy order. */
export function sectionsForSurface(
  sections: readonly TurnReportSection[],
  surface: ReportSurface,
  policy: ReportPolicy = DEFAULT_REPORT_POLICY,
): TurnReportSection[] {
  const ordered = orderReportSections(sections, policy);
  if (surface === 'full') return ordered;
  const wanted = surface === 'landing' ? LANDING_TIERS : CHANGES_TIERS;
  return ordered.filter((s) => {
    const tier = policy.tierOf(s.kind);
    return tier != null && wanted.has(tier);
  });
}

export function reportHasBehaviorChange(sections: readonly TurnReportSection[]): boolean {
  return sections.some((s) => s.kind === 'behavior_change');
}

/** New-kind `implementation` only — not a stored `what_was_done`. */
export function reportHasImplementation(sections: readonly TurnReportSection[]): boolean {
  return sections.some((s) => s.kind === 'implementation');
}

/**
 * Notice on Landing: the agent used the new kinds and wrote how-it-was-done
 * without saying what changed. A legacy `what_was_done` report is not that.
 */
export function reportDeclaresNoBehavior(sections: readonly TurnReportSection[]): boolean {
  return reportHasImplementation(sections) && !reportHasBehaviorChange(sections);
}
