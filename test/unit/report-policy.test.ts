/**
 * Presentation policy for structured turn reports.
 *
 * INVARIANT (narrowed 2026-09, engineer-approved): storage and MCP keep the
 * agent's array order. Human-facing renderers apply a tier order across kinds
 * and keep agent order WITHIN a tier. See review-presentation-docs-first and
 * src/review/report-policy.ts. This is a human-approved change to the old
 * "never reorder by kind" invariant.
 */

import { describe, test, expect } from 'bun:test';
import {
  DEFAULT_REPORT_POLICY,
  orderReportSections,
  reportDeclaresNoBehavior,
  reportHasBehaviorChange,
  reportHasImplementation,
  REPORT_SECTION_LABELS,
  sectionsForSurface,
} from '../../src/review/report-policy';
import type { TurnReportSection } from '../../src/types';

function section(kind: TurnReportSection['kind'], body: string): TurnReportSection {
  return { kind, body };
}

describe('orderReportSections', () => {
  test('ranks behavior above implementation even when the agent wrote code first', () => {
    const ordered = orderReportSections([
      section('implementation', 'moved soAndSo'),
      section('behavior_change', 'the page now splits the report'),
      section('commentary', 'note'),
      section('capabilities_lost', 'nothing lost'),
      section('how_to_verify', 'open the page'),
    ]);
    expect(ordered.map((s) => s.kind)).toEqual([
      'behavior_change',
      'capabilities_lost',
      'how_to_verify',
      'implementation',
      'commentary',
    ]);
  });

  test('what_was_done ranks with behavior and keeps the stored kind', () => {
    const ordered = orderReportSections([
      section('how_to_verify', 'run it'),
      section('what_was_done', 'legacy body'),
    ]);
    expect(ordered.map((s) => s.kind)).toEqual(['what_was_done', 'how_to_verify']);
    expect(REPORT_SECTION_LABELS.what_was_done).toBe('What was done');
    expect(REPORT_SECTION_LABELS.implementation).toBe('How it was done');
  });

  // INVARIANT (narrowed 2026-09): agent order is preserved WITHIN a tier so
  // two commentary blocks stay in the order the agent authored them.
  test('preserves agent order within a tier', () => {
    const ordered = orderReportSections([
      section('commentary', 'second in time, first in array'),
      section('behavior_change', 'behavior'),
      section('commentary', 'later commentary'),
    ]);
    expect(ordered.map((s) => s.body)).toEqual([
      'behavior',
      'second in time, first in array',
      'later commentary',
    ]);
  });

  test('does not mutate the input array', () => {
    const input = [
      section('implementation', 'how'),
      section('behavior_change', 'what'),
    ];
    const copy = [...input];
    orderReportSections(input);
    expect(input).toEqual(copy);
  });
});

describe('sectionsForSurface', () => {
  const mixed = [
    section('implementation', 'how'),
    section('behavior_change', 'what'),
    section('capabilities_lost', 'lost'),
    section('how_to_verify', 'check'),
    section('commentary', 'aside'),
    section('what_was_done', 'legacy how'),
  ];

  test('landing keeps behavior, legacy what_was_done, and capabilities_lost', () => {
    expect(sectionsForSurface(mixed, 'landing').map((s) => s.kind)).toEqual([
      'behavior_change',
      'what_was_done',
      'capabilities_lost',
    ]);
  });

  test('changes keeps implementation and commentary, not legacy what_was_done', () => {
    expect(sectionsForSurface(mixed, 'changes').map((s) => s.kind)).toEqual([
      'implementation',
      'commentary',
    ]);
  });

  test('full is the policy-ordered whole report', () => {
    expect(sectionsForSurface(mixed, 'full').map((s) => s.kind)).toEqual([
      'behavior_change',
      'what_was_done',
      'capabilities_lost',
      'how_to_verify',
      'implementation',
      'commentary',
    ]);
  });

  test('an alternate policy can reorder without touching renderers', () => {
    const inverted = {
      ...DEFAULT_REPORT_POLICY,
      tierOrder: [...DEFAULT_REPORT_POLICY.tierOrder].reverse(),
    };
    expect(orderReportSections([
      section('behavior_change', 'b'),
      section('commentary', 'c'),
    ], inverted).map((s) => s.kind)).toEqual(['commentary', 'behavior_change']);
  });
});

describe('reportHasBehaviorChange / reportHasImplementation / reportDeclaresNoBehavior', () => {
  test('legacy what_was_done is neither a declared behavior nor new implementation', () => {
    const sections = [section('what_was_done', 'old')];
    expect(reportHasBehaviorChange(sections)).toBe(false);
    expect(reportHasImplementation(sections)).toBe(false);
    expect(reportDeclaresNoBehavior(sections)).toBe(false);
  });

  test('behavior_change is the only kind that counts as a declared change', () => {
    expect(reportHasBehaviorChange([section('implementation', 'x')])).toBe(false);
    expect(reportHasBehaviorChange([section('behavior_change', 'x')])).toBe(true);
  });

  test('no-behavior notice is only for new-kind implementation without behavior_change', () => {
    expect(reportDeclaresNoBehavior([section('implementation', 'how')])).toBe(true);
    expect(reportDeclaresNoBehavior([
      section('implementation', 'how'),
      section('behavior_change', 'what'),
    ])).toBe(false);
  });
});
