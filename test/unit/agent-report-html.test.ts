/**
 * Agent report renderer: subset of sections per tab surface, and the
 * explicit "no behavioral change" notice on Landing.
 */

import { describe, test, expect } from 'bun:test';
import { agentReportHtml } from '../../src/server/review';
import type { TurnReport } from '../../src/types';

function report(sections: TurnReport['sections']): TurnReport {
  return {
    id: 'rep-1',
    task_id: 'task-1',
    session_id: 'sess-1',
    turn_sequence: 3,
    sections,
    created_at: 0,
  };
}

describe('agentReportHtml surfaces', () => {
  const mixed = report([
    { kind: 'implementation', body: 'moved soAndSo' },
    { kind: 'behavior_change', body: 'the page now splits the report' },
    { kind: 'capabilities_lost', body: 'nothing lost' },
  ]);

  test('landing shows behavior then capabilities_lost, not implementation', () => {
    const html = agentReportHtml('task-1', null, mixed, { surface: 'landing' });
    expect(html).toContain('data-kind="behavior_change"');
    expect(html).toContain('data-kind="capabilities_lost"');
    expect(html).not.toContain('data-kind="implementation"');
    expect(html.indexOf('data-kind="behavior_change"')).toBeLessThan(
      html.indexOf('data-kind="capabilities_lost"'),
    );
    expect(html).toContain('What changed for you');
  });

  test('changes shows implementation only', () => {
    const html = agentReportHtml('task-1', null, mixed, { surface: 'changes' });
    expect(html).toContain('data-kind="implementation"');
    expect(html).toContain('moved soAndSo');
    expect(html).not.toContain('data-kind="behavior_change"');
    expect(html).toContain('How it was done');
  });

  test('full ranks behavior above implementation', () => {
    const html = agentReportHtml('task-1', null, mixed, { surface: 'full' });
    expect(html.indexOf('data-kind="behavior_change"')).toBeLessThan(
      html.indexOf('data-kind="implementation"'),
    );
  });

  test('Landing notice when implementation is present and behavior_change is not', () => {
    const html = agentReportHtml(
      'task-1',
      null,
      report([{ kind: 'implementation', body: 'moved soAndSo' }]),
      { surface: 'landing', showNoBehaviorNotice: true },
    );
    expect(html).toContain('Agent declared no behavioral change.');
    expect(html).not.toContain('data-kind="implementation"');
  });

  test('legacy what_was_done renders on Landing, not the no-behavior notice', () => {
    const html = agentReportHtml(
      'task-1',
      null,
      report([{ kind: 'what_was_done', body: 'legacy work' }]),
      { surface: 'landing', showNoBehaviorNotice: true },
    );
    expect(html).toContain('data-kind="what_was_done"');
    expect(html).toContain('legacy work');
    expect(html).toContain('What was done');
    expect(html).not.toContain('Agent declared no behavioral change.');
  });

  test('legacy what_was_done does not render on Changes', () => {
    const html = agentReportHtml(
      'task-1',
      null,
      report([{ kind: 'what_was_done', body: 'legacy work' }]),
      { surface: 'changes' },
    );
    expect(html).toBe('');
  });
});
