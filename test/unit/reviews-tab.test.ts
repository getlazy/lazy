/**
 * The Reviews tab: the strip badge, and the column proportions the table
 * declares.
 *
 * The badge is the part that can silently drift — it is derived in the page
 * assembler while the rows are rendered in reviews-tab.ts, so a count taken
 * from "review turns" rather than "reviews that count" would send a reader to
 * a tab with fewer rows than the number on it.
 */

import { describe, test, expect } from 'bun:test';
import { reviewsTabHtml, reviewsTabCount } from '../../src/server/reviews-tab';
import { taskPageHtml } from '../../src/server/task-page';
import type { Task, Turn } from '../../src/types';
import type { ReviewReport } from '../../src/types/review-report';
import type { ReviewTurnLike } from '../../src/review/success';

const T0 = new Date('2026-09-13T08:30:00Z').getTime();

function report(over: Partial<ReviewReport> = {}): ReviewReport {
  return {
    verdict: 'Approve with comments',
    security: 'none found',
    data_integrity: 'none found',
    findings: [],
    raised_item_ids: [],
    ...over,
  };
}

function reviewTurn(sequence: number, over: Partial<ReviewTurnLike> = {}): ReviewTurnLike {
  return {
    sequence,
    role: 'agent',
    turn_type: 'review',
    review: report(),
    created_at: T0 + sequence * 60_000,
    ...over,
  };
}

function task(): Task {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    code: 'ui-reviews-tab-layout',
    goal: 'Reviews tab layout',
    prompt: 'Do the work',
    type: 'task',
    status: 'working',
    created_at: 1,
    completed_at: null,
    target: { kind: 'branch', branch: 'main' },
    branched_from_sha: null,
    close_reason: null,
    model: null,
    agent_id: 'claude-code',
    runner_type: null,
    metadata: null,
    tags: [],
    pending_sync: 0,
  } as unknown as Task;
}

function pageTurn(t: ReviewTurnLike): Turn {
  return {
    id: `turn-${t.sequence}`,
    session_id: 's-1',
    sequence: t.sequence,
    role: t.role,
    turn_type: t.turn_type,
    review: t.review,
    content: 'review',
    timestamp: t.created_at,
  } as unknown as Turn;
}

function pageHtml(turns: ReviewTurnLike[]): string {
  return taskPageHtml({
    task: task(),
    session: null,
    turns: turns.map(pageTurn),
    commits: [],
    comments: [],
    journal: [],
    raisedItems: [],
    children: [],
    promptVersions: [],
    tab: 'landing',
  });
}

function reviewsTabLink(html: string): string {
  const start = html.indexOf('data-lz-tab="reviews"');
  expect(start).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf('<a', start), html.indexOf('</a>', start));
}

describe('Reviews tab badge', () => {
  test('counts the reviews the tab lists', () => {
    const turns = [reviewTurn(1), reviewTurn(2), reviewTurn(3)];
    expect(reviewsTabCount(turns)).toBe(3);
    expect(reviewsTabLink(pageHtml(turns))).toContain('<span class="lz-tab-badge"');
    expect(reviewsTabLink(pageHtml(turns))).toContain('>3</span>');
  });

  // INVARIANT: the badge is derived from successfulReviewTurnsOf, the same
  // helper that renders the rows — badge and rows can never disagree. A FAILED
  // review (unparsed verdict or unparsed sweeps) is now in BOTH: it gates
  // accept, so hiding it was how a task with one broken review looked
  // un-reviewed and got accepted anyway.
  test('a failed review is in both the badge and the rows', () => {
    const turns = [
      reviewTurn(1),
      reviewTurn(2, { review: report({ security: 'unparsed', data_integrity: 'unparsed' }) }),
    ];
    expect(reviewsTabCount(turns)).toBe(2);
    expect(reviewsTabLink(pageHtml(turns))).toContain('>2</span>');
    expect(reviewsTabHtml('task-1', turns).match(/class="lz-reviews-when"/g) ?? []).toHaveLength(2);
  });

  test('no reviews means no badge', () => {
    const work = { sequence: 1, role: 'agent', turn_type: 'work', created_at: T0 } as ReviewTurnLike;
    expect(reviewsTabCount([work])).toBe(0);
    expect(reviewsTabLink(pageHtml([work]))).not.toContain('lz-tab-badge');
  });
});

describe('Reviews table proportions', () => {
  const html = reviewsTabHtml('task-1', [
    reviewTurn(4, {
      review: report({
        verdict: 'Request changes: the retry path swallows errors and the new flag defaults on',
        raised_item_ids: ['aaaaaaaabbbb', 'ccccccccdddd', 'eeeeeeeeffff'],
      }),
    }),
  ]);

  // INVARIANT: the columns get their width from the colgroup, not from the
  // content. Auto layout handed the row to the free-text verdict and wrapped
  // the timestamp onto two lines.
  test('the table declares its columns', () => {
    expect(html).toContain('class="table lz-reviews-table"');
    for (const col of ['when', 'verdict', 'raises', 'links']) {
      expect(html).toContain(`<col class="lz-reviews-col-${col}">`);
    }
  });

  // INVARIANT: the timestamp's date, time and zone are unbreakable tokens. At
  // phone width the column is narrower than one line, and a cell left to wrap
  // on its own broke the date at a hyphen ("2026-09-" / "13").
  test('the timestamp wraps only between its tokens', () => {
    for (const part of ['2026-09-13', '08:34:00', 'UTC']) {
      expect(html).toContain(`<span class="lz-reviews-when-part">${part}</span>`);
    }
    expect(html).toContain('title="2026-09-13 08:34:00 UTC"');
  });

  test('the verdict is not truncated away', () => {
    expect(html).toContain('the new flag defaults on</td>');
    // Wrapping shows it all; the title is the affordance when a row is dense.
    expect(html).toContain('title="Request changes: the retry path swallows');
  });

  test('every raise the review filed is reachable', () => {
    expect(html).toContain('/raised/aaaaaaaabbbb');
    expect(html).toContain('/raised/ccccccccdddd');
    expect(html).toContain('/raised/eeeeeeeeffff');
  });
});
