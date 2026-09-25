/**
 * The task page's `Review:` header item.
 *
 * The engineer's complaint on 2026-09-21 was in two halves: a value they had
 * not chosen, and a line that explained nothing. This covers the second half on
 * the web surface — the clauses and the provenance come from the daemon's
 * payload, and the page adds no wording of its own.
 */

import { describe, test, expect } from 'bun:test';
import { reviewItemHtml } from '../../src/server/task-page';
import {
  resolveReviewSettingsWithSources,
  reviewSettingsView,
  type ReviewSettings,
} from '../../src/review/mode';

const project: ReviewSettings = { mode: 'low_high', auto_fix: false, gate: 'auto' };

describe('the Review header item', () => {
  test('renders the line, with every clause and its provenance as the tooltip', () => {
    const view = reviewSettingsView(resolveReviewSettingsWithSources({
      parent: { review_mode: 'separate', review_mode_source: 'task' },
      parentCode: 'release-v022',
      project,
    }));
    const html = reviewItemHtml(view);

    expect(html).toContain('Review: separate, gate auto, auto-fix off');
    // What each value means…
    expect(html).toContain('a reviewer runs in its own session after the final');
    // …and where it came from, which is the half the bare line could not answer.
    expect(html).toContain('inherited from release-v022');
    expect(html).toContain('project default');
  });

  // The pointer is the daemon's, built through src/docs/links.ts — the page
  // never composes a docs URL, so a configured mirror or disabled pointers are
  // honoured here for free.
  test('links to the page that explains the vocabulary', () => {
    const html = reviewItemHtml(reviewSettingsView(resolveReviewSettingsWithSources({ project })));
    expect(html).toContain('/review-paradigm#reading-the-review-line');
  });

  // Absent settings drop the item rather than rendering a guess — the same rule
  // the launch identity follows when config cannot be read.
  test('an absent view renders nothing', () => {
    expect(reviewItemHtml(null)).toBe('');
    expect(reviewItemHtml(undefined)).toBe('');
  });
});
