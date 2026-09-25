/**
 * Structured agent-review findings on the task page: verdict and the two
 * required statements first, findings grouped by category, file+line jumps
 * into Changes, PR comment links when posted. An unparsed report never
 * looks like a clean pass.
 */

import { describe, test, expect } from 'bun:test';
import {
  findingChangesHref,
  reviewFindingTurnsOf,
  reviewFindingsSectionHtml,
  reviewReportHtml,
} from '../../src/server/review-findings';
import { UNPARSED_REVIEW_LABEL } from '../../src/review/parse-report';
import type { ReviewReport } from '../../src/types/review-report';
import { anchorDomId, fileSectionId } from '../../src/server/review-diff';

const clean: ReviewReport = {
  verdict: 'clean',
  security: 'none found',
  data_integrity: 'none found',
  findings: [],
};

describe('findingChangesHref', () => {
  test('file+line jumps to the new-side diff anchor', () => {
    const href = findingChangesHref('abc', { file: 'src/foo.ts', line: 12, severity: 'low', category: 'style', summary: 'x' });
    expect(href).toBe(`/tasks/abc/changes#${anchorDomId({ file: 'src/foo.ts', side: 'new', line: 12 })}`);
  });

  test('file-only jumps to the file section', () => {
    const href = findingChangesHref('abc', { file: 'src/foo.ts', severity: 'low', category: 'style', summary: 'x' });
    expect(href).toBe(`/tasks/abc/changes#${fileSectionId('src/foo.ts')}`);
  });

  test('a whole-change finding has no href', () => {
    expect(findingChangesHref('abc', { severity: 'low', category: 'style', summary: 'x' })).toBeNull();
  });
});

describe('reviewReportHtml', () => {
  test('leads with verdict then the two required statements', () => {
    const html = reviewReportHtml('t1', clean);
    const verdictAt = html.indexOf('Verdict');
    const securityAt = html.indexOf('Security');
    const integrityAt = html.indexOf('Data integrity');
    expect(verdictAt).toBeGreaterThan(0);
    expect(securityAt).toBeGreaterThan(verdictAt);
    expect(integrityAt).toBeGreaterThan(securityAt);
    expect(html).toContain('clean');
    expect(html).toContain('none found');
    expect(html).toContain('Findings: none');
  });

  test('groups findings by category and links file+line into Changes', () => {
    const html = reviewReportHtml('t1', {
      verdict: 'needs_work',
      security: 'none found',
      data_integrity: 'A write is not atomic.',
      findings: [
        { file: 'src/store.ts', line: 40, severity: 'high', category: 'data-integrity', summary: 'Partial write on crash.' },
        { file: 'src/ui.ts', line: 8, severity: 'low', category: 'style', summary: 'Unused import.' },
        { severity: 'medium', category: 'correctness', summary: 'Empty input is ignored.' },
      ],
    });
    expect(html).toContain('data-category="data-integrity"');
    expect(html).toContain('data-category="correctness"');
    expect(html).toContain('data-category="style"');
    expect(html).toContain(`/tasks/t1/changes#${anchorDomId({ file: 'src/store.ts', side: 'new', line: 40 })}`);
    expect(html).toContain('src/store.ts:40');
    expect(html).toContain('change as a whole');
    expect(html).toContain('Partial write on crash.');
    // Security group is omitted when empty; data-integrity is not.
    expect(html).not.toContain('data-category="security"');
  });

  test('an unparsed report is a failed review and never Findings: none', () => {
    const html = reviewReportHtml('t1', {
      verdict: 'Looks fine.',
      security: 'unparsed',
      data_integrity: 'unparsed',
      findings: [],
    });
    expect(html).toContain(UNPARSED_REVIEW_LABEL);
    expect(html).toContain('lz-findings-failed');
    expect(html).not.toContain('Findings: none');
  });

  // A verdict outside {clean, needs_work, needs_human} fails the review too —
  // the daemon acts on that word, so one it cannot read is not a pass.
  test('a verdict outside the closed set is a failed review', () => {
    const html = reviewReportHtml('t1', { ...clean, verdict: 'approve' });
    expect(html).toContain(UNPARSED_REVIEW_LABEL);
    expect(html).toContain('lz-findings-failed');
  });

  // INVARIANT: a FAILED review still SHOWS its findings. They are the issue
  // store — what the fixer is handed — so hiding them because the verdict line
  // was unreadable would hide the only actionable part of the review.
  test('a failed review still renders the findings it did record', () => {
    const html = reviewReportHtml('t1', {
      verdict: 'approve',
      security: 'none found',
      data_integrity: 'none found',
      findings: [
        { file: 'src/store.ts', line: 40, severity: 'high', category: 'data-integrity', summary: 'Partial write on crash.' },
      ],
    });
    expect(html).toContain(UNPARSED_REVIEW_LABEL);
    expect(html).toContain('lz-findings-failed');
    expect(html).toContain('Partial write on crash.');
    expect(html).not.toContain('Findings: none');
  });

  test('escapes reviewer text', () => {
    const html = reviewReportHtml('t1', {
      verdict: '<script>x</script>',
      security: 'none found',
      data_integrity: 'none found',
      findings: [
        { file: 'a.ts', line: 1, severity: 'low', category: 'style', summary: '<b>bold</b>' },
      ],
    });
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(html).not.toContain('<script>x</script>');
  });

  // INVARIANT: a review never reaches a PR/MR, so the card never links to one
  // (engineer decision, 2026-09-21). This replaces the old tests for the
  // summary link and the index-aligned per-finding comment links, which
  // existed only because findings were posted as PR comments.
  test('links nothing to a PR — the review lives on the task', () => {
    const html = reviewReportHtml('t1', {
      verdict: 'needs_work',
      security: 'none found',
      data_integrity: 'none found',
      findings: [
        { file: 'a.ts', line: 1, severity: 'high', category: 'correctness', summary: 'first' },
        { file: 'b.ts', line: 2, severity: 'low', category: 'style', summary: 'second' },
      ],
    });
    expect(html).not.toContain('PR summary');
    expect(html).not.toContain('PR comment');
    expect(html).not.toContain('lz-finding-pr');
    expect(html).toContain('first');
    expect(html).toContain('second');
  });
});

describe('reviewFindingTurnsOf', () => {
  test('keeps agent review turns with a report, newest first', () => {
    const turns = reviewFindingTurnsOf([
      { sequence: 1, role: 'human', turn_type: 'review' },
      { sequence: 2, role: 'agent', turn_type: 'review', review: clean },
      { sequence: 3, role: 'agent', turn_type: 'work' },
      { sequence: 4, role: 'agent', turn_type: 'review', review: { ...clean, verdict: 'later' } },
    ]);
    expect(turns.map((t) => t.sequence)).toEqual([4, 2]);
    expect(turns[0]?.review.verdict).toBe('later');
  });

  // INVARIANT: a FAILED review is LISTED. The raise-era rule hid it — a review
  // with no parseable sweeps and no raises "never happened" — which is how a
  // task with one broken review looked un-reviewed to every surface and to the
  // accept gate. It gates now, so it must also be visible.
  test('keeps a failed review, so the failure is not invisible', () => {
    const turns = reviewFindingTurnsOf([
      {
        sequence: 2,
        role: 'agent',
        turn_type: 'review',
        review: { ...clean, security: 'unparsed', data_integrity: 'unparsed' },
      },
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.sequence).toBe(2);
  });

  test('keeps unparsed reviews that filed raises', () => {
    const turns = reviewFindingTurnsOf([
      {
        sequence: 2,
        role: 'agent',
        turn_type: 'review',
        review: {
          ...clean,
          security: 'unparsed',
          data_integrity: 'unparsed',
          raised_item_ids: ['aaaaaaaa'],
        },
      },
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.sequence).toBe(2);
  });

  test('empty when there are no review reports', () => {
    expect(reviewFindingsSectionHtml('t', [])).toBe('');
    expect(reviewFindingTurnsOf([{ sequence: 1, role: 'agent', turn_type: 'work' }])).toEqual([]);
  });
});
