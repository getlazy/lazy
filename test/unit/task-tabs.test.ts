/**
 * The task-page tab slug set is closed and disjoint from the non-tab
 * sub-routes, so a future `/tasks/:id/artifacts` cannot quietly become a tab
 * and a tab cannot shadow `edit` / `actions` / `prompts`.
 *
 * INVARIANT: the tabs under `/tasks/:id` are Landing (bare path) plus
 * the slugs in TASK_TAB_SLUGS (Changes … Current review). The reserved
 * non-tab first segments are TASK_NON_TAB_SEGMENTS. `turns`, `shell`,
 * `commits` and `comments` are shared on purpose (index + leaf) and are
 * therefore tabs, not in the non-tab-segment list.
 */

import { describe, test, expect } from 'bun:test';
import {
  TASK_TAB_SLUGS,
  TASK_TAB_ORDER,
  TASK_TAB_KEY_INDEX,
  TASK_NON_TAB_SEGMENTS,
  TASK_NON_TAB_ROUTES,
  isTaskTabSlug,
  isTaskNonTabSegment,
  parseTaskTabSegment,
  taskTabHref,
  relocatedReviewPath,
  taskTabStripHtml,
  taskTabSwitchScript,
} from '../../src/server/task-tabs';
import { bundledStylesheet } from '../../src/server/styles';

describe('task tab slug set', () => {
  test('the slug set is exactly the named tabs', () => {
    expect([...TASK_TAB_SLUGS]).toEqual([
      'regions',
      'changes',
      'verify',
      'turns',
      'commits',
      'reviews',
      'subtasks',
      'raised',
      'comments',
      'journal',
      'stats',
      'shell',
      'services',
      'review',
    ]);
  });

  test('Landing is the bare path and is first in reading order', () => {
    expect(TASK_TAB_ORDER[0]).toBe('landing');
    expect(TASK_TAB_ORDER[TASK_TAB_ORDER.length - 1]).toBe('review');
    expect(TASK_TAB_ORDER).toHaveLength(15);
    // INVARIANT: Regions comes before Changes, and Verify before both.
    // That is the reading order for a large branch — what was I asked to
    // check, what units of work are in here, then the diff itself. Regions
    // began as a strip buried at the top of Changes, which put the map
    // after the territory.
    expect(TASK_TAB_ORDER.indexOf('verify')).toBeLessThan(TASK_TAB_ORDER.indexOf('regions'));
    expect(TASK_TAB_ORDER.indexOf('regions')).toBeLessThan(TASK_TAB_ORDER.indexOf('changes'));
    expect(taskTabHref('abc', 'regions')).toBe('/tasks/abc/regions');
    // Stats is an insight surface read on purpose, not a review step: it sits
    // after Journal and takes no digit key, so adding it moved nothing.
    expect(TASK_TAB_ORDER).toContain('stats');
    expect(taskTabHref('abc', 'stats')).toBe('/tasks/abc/stats');
    expect(TASK_TAB_ORDER).toContain('commits');
    expect(TASK_TAB_ORDER).toContain('reviews');
    expect(TASK_TAB_ORDER).toContain('comments');
    expect(TASK_TAB_ORDER).toContain('journal');
    expect(taskTabHref('abc', 'comments')).toBe('/tasks/abc/comments');
    expect(taskTabHref('abc', 'journal')).toBe('/tasks/abc/journal');
    expect(taskTabHref('abc', 'landing')).toBe('/tasks/abc');
    expect(taskTabHref('abc', 'changes')).toBe('/tasks/abc/changes');
    expect(taskTabHref('abc', 'commits')).toBe('/tasks/abc/commits');
    expect(taskTabHref('abc', 'reviews')).toBe('/tasks/abc/reviews');
  });

  // INVARIANT: a tab slug must never be a reserved non-tab first segment.
  // `turns`, `shell`, and `commits` are tabs that also host a leaf — they
  // are in the slug set and NOT in TASK_NON_TAB_SEGMENTS.
  test('tab slugs are disjoint from the non-tab first segments', () => {
    const overlap = TASK_TAB_SLUGS.filter((slug) => isTaskNonTabSegment(slug));
    expect(overlap).toEqual([]);
    for (const segment of TASK_NON_TAB_SEGMENTS) {
      expect(isTaskTabSlug(segment)).toBe(false);
    }
  });

  test('the reserved non-tab routes are exactly the design-doc list', () => {
    expect([...TASK_NON_TAB_ROUTES]).toEqual([
      'edit',
      'turns/:seq',
      'commits/:id',
      'prompts/:version',
      'actions/:verb',
      'container/start',
      'container/ensure',
      'container/state',
      'comments/add',
      'comments/:commentId/edit',
      'shell/ws',
      'watch/ws',
      'live-status',
    ]);
    // First segments of those routes that are ONLY leaves (not also a tab).
    expect([...TASK_NON_TAB_SEGMENTS]).toEqual([
      'edit',
      'prompts',
      'actions',
      'container',
      'watch',
      'live-status',
    ]);
  });

  test('parseTaskTabSegment accepts only the closed set', () => {
    expect(parseTaskTabSegment(undefined)).toBe('landing');
    expect(parseTaskTabSegment('')).toBe('landing');
    expect(parseTaskTabSegment('changes')).toBe('changes');
    expect(parseTaskTabSegment('commits')).toBe('commits');
    expect(parseTaskTabSegment('review')).toBe('review');
    expect(parseTaskTabSegment('edit')).toBeNull();
    expect(parseTaskTabSegment('artifacts')).toBeNull();
  });

  test('digit keys are 1–9; Services, Reviews, Commits, Comments, Journal and Stats have none; Current review is 9', () => {
    expect(TASK_TAB_KEY_INDEX.landing).toBe(0);
    expect(TASK_TAB_KEY_INDEX.verify).toBe(1);
    expect(TASK_TAB_KEY_INDEX.regions).toBe(2);
    expect(TASK_TAB_KEY_INDEX.changes).toBe(3);
    expect(TASK_TAB_KEY_INDEX.shell).toBe(7);
    expect(TASK_TAB_KEY_INDEX.review).toBe(8);
    expect(TASK_TAB_KEY_INDEX.services).toBeUndefined();
    // INVARIANT: nine digit keys, more tabs than digits. Commits lost its
    // number when Regions gained one — of the unnumbered tabs it is the one a
    // reviewer reaches for least, and the bracket keys still reach all of them.
    expect(TASK_TAB_KEY_INDEX.commits).toBeUndefined();
    expect(TASK_TAB_KEY_INDEX.comments).toBeUndefined();
    expect(TASK_TAB_KEY_INDEX.journal).toBeUndefined();
    expect(TASK_TAB_KEY_INDEX.stats).toBeUndefined();
    expect(Object.keys(TASK_TAB_KEY_INDEX)).toHaveLength(9);
  });
});

describe('relocatedReviewPath', () => {
  test('moves the page and every action under /tasks/:id/review', () => {
    expect(relocatedReviewPath('/review/abc')).toBe('/tasks/abc/review');
    expect(relocatedReviewPath('/review/abc/draft')).toBe('/tasks/abc/review/draft');
    expect(relocatedReviewPath('/review/abc/comment/x/withdraw')).toBe(
      '/tasks/abc/review/comment/x/withdraw',
    );
    expect(relocatedReviewPath('/review/abc/session/start')).toBe(
      '/tasks/abc/review/session/start',
    );
  });

  test('leaves the queue and the JSON API alone', () => {
    expect(relocatedReviewPath('/review')).toBeNull();
    expect(relocatedReviewPath('/api/review/abc/threads')).toBeNull();
  });
});

describe('taskTabStripHtml', () => {
  test('every tab is a real link; Current review carries its own class', () => {
    const html = taskTabStripHtml({ taskId: 't1', current: 'landing' });
    expect(html).toContain('href="/tasks/t1"');
    expect(html).toContain('href="/tasks/t1/changes"');
    expect(html).toContain('href="/tasks/t1/commits"');
    expect(html).toContain('href="/tasks/t1/review"');
    expect(html).toContain('lz-tab-review');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('data-lz-tab="landing"');
    expect(html).toContain('data-lz-tab="commits"');
    expect(html).toContain('>Summary');
    expect(html).toContain('>Commits');
    expect(html).not.toContain('>Landing');
  });

  test('Services and Commits have no digit key; Regions is 3; Current review is 9', () => {
    const html = taskTabStripHtml({ taskId: 't1', current: 'commits' });
    expect(html).toContain('data-lz-tab="regions" data-lz-tab-index="2"');
    expect(html).toContain('title="Regions (3)"');
    expect(html).not.toMatch(/data-lz-tab="commits"[^>]*data-lz-tab-index/);
    expect(html).toContain('title="Current review (9)"');
    expect(html).toContain('data-lz-tab="services"');
    expect(html).not.toMatch(/data-lz-tab="services"[^>]*data-lz-tab-index/);
    expect(html).toContain('title="Services"');
    expect(html).not.toContain('title="Services (');
  });

  test('hides Shell when the runner has no container', () => {
    const html = taskTabStripHtml({ taskId: 't1', current: 'landing', hideShell: true });
    expect(html).not.toContain('data-lz-tab="shell"');
    expect(html).toContain('data-lz-tab="services"');
    expect(html).toContain('data-lz-tab="commits"');
  });
});

describe('taskTabSwitchScript', () => {
  const script = taskTabSwitchScript();

  // INVARIANT: a live terminal mounted under a verification step lives in the
  // Verify tab body. Replacing that node on a tab click would destroy it.
  test('caches tab bodies instead of replacing the current one', () => {
    expect(script).toContain('data-lz-tab-bodies');
    expect(script).toContain("nextBody.setAttribute('data-lz-tab-path'");
    expect(script).toContain('host.appendChild(nextBody)');
    expect(script).toContain('b.hidden = true');
    expect(script).not.toContain('curBody.replaceWith');
  });

  // A slow tab (Turns, Subtasks) used to swallow the click with no feedback.
  // The island starts the page-wide bar and marks the pressed tab pending.
  test('marks the pressed tab pending and drives the nav-progress bar', () => {
    expect(script).toContain('lzNavProgress');
    expect(script).toContain('startProgress(pendingTabFor(href))');
    expect(script).toContain('stopProgress()');
  });
});

describe('tab strip layout', () => {
  const css = bundledStylesheet();

  // INVARIANT: every tab in the strip is on screen. The strip wraps onto as
  // many rows as it needs; it must never clip or scroll tabs out of sight,
  // because a tab a reviewer cannot see is a tab they do not know exists.
  test('the strip wraps instead of scrolling tabs out of view', () => {
    const strip = css.match(/\.lz-tabs\s*\{[^}]*\}/)?.[0] ?? '';
    expect(strip).toMatch(/flex-wrap:\s*wrap/);
    expect(strip).not.toMatch(/overflow-x/);
    // The old single-row scrolling strip is gone from the CSS and the markup.
    expect(css).not.toContain('.lz-tabs-scroll');
    // INVARIANT: every tab is a DIRECT child of the strip. A wrapper around
    // the non-review tabs is one full-width flex line, which parks Current
    // review on a row of its own even when the whole strip fits across.
    expect(taskTabStripHtml({ taskId: 't1', current: 'landing' })).not.toContain('<div');
  });

  // INVARIANT: Current review is set apart by COLOUR, never by
  // `margin-left: auto` or sticky positioning. An auto margin consumes the
  // flex line's free space, so Chromium breaks the line before it and Current
  // review takes a whole row to itself even when the strip fits across;
  // sticky was only there to hold it over a scrolling row that no longer
  // exists. Colour is the one marker that looks right wherever the wrap puts
  // it — a left-hand rule reads as a stray divider when it starts a row.
  test('Current review is set apart without costing a row', () => {
    const review = css.match(/\.lz-tab-review\s*\{[^}]*\}/)?.[0] ?? '';
    expect(review).toMatch(/color:\s*var\(--color-accent\)/);
    expect(review).not.toMatch(/margin-left:\s*auto/);
    expect(review).not.toMatch(/position:\s*sticky/);
  });
});
