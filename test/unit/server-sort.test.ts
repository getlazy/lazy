/**
 * Unit tests: ordering for the server-rendered listings.
 *
 * Three pages hang off the shared `?sort=` module, so a change there silently
 * re-orders all of them. These tests pin the three things that were previously
 * implicit in the task list's own copy of the logic — which fields are
 * accepted, what a click on a header asks for next, and that everything
 * reaching an href is escaped — plus the review queue's comparator, whose job
 * is to produce the SAME order twice for the same data, and the raised-items
 * queue's split between the ordering the service owns and the four columns the
 * page ranks itself.
 */

import { describe, test, expect } from 'bun:test';
import { parseSortParam, nextSortParam, sortHeadersHtml, type SortConfig } from '../../src/server/sort';
import { TASK_LIST_COLUMNS, TASK_LIST_SORT_FIELDS, taskListHtml, type TaskWithSession } from '../../src/server/templates';
import { sortReviewQueue } from '../../src/server/review';
import {
  DEFAULT_RAISED_SORT,
  defaultRaisedSort,
  raisedListOptions,
  raisedListSort,
  raisedInboxHtml,
  orderRaisedForDisplay,
  parseRaisedSort,
  type RaisedSortField,
} from '../../src/server/raised';
import type { ReviewQueueEntry } from '../../src/server/review-actions';
import type { ListedRaisedItem, ListRaisedItemsResult } from '../../src/raised';
import type { Task } from '../../src/types';

/** One row, so the list renders its header instead of the empty state. */
function oneTask(): TaskWithSession[] {
  const task: Task = {
    id: 'abcd1234ef567890',
    code: 'demo-task',
    goal: 'Render a header',
    prompt: 'Do work',
    type: 'task',
    status: 'blocked',
    created_at: 0,
    completed_at: null,
    target: { kind: 'branch', branch: 'main' },
    branched_from_sha: null,
    close_reason: null,
    model: null,
    agent_id: 'claude-code',
    metadata: null,
    runner_type: null,
    tags: [],
    pending_sync: 0,
  };
  return [{ task, session: null, turnCount: 0 }];
}

/** A queue row. Every field has a default, so a test names only what it ranks on. */
function entry(over: Partial<ReviewQueueEntry> & { code: string }): ReviewQueueEntry {
  return {
    id: over.code.padEnd(16, '0'),
    goal: 'Some goal',
    status: 'blocked',
    type: 'task',
    updatedAt: 1000,
    hasSession: true,
    commentCount: 0,
    pendingAsks: 0,
    pendingComments: 0,
    lastActiveAt: 1000,
    descendantCount: 0,
    ...over,
  };
}

const codes = (entries: ReviewQueueEntry[]) => entries.map((e) => e.code);

const FIELDS = ['created', 'goal', 'last_active'] as const;
type Field = (typeof FIELDS)[number];
const FALLBACK: SortConfig<Field> = { field: 'created', direction: 'desc' };

describe('parseSortParam', () => {
  test('a bare field is ascending, a leading dash is descending', () => {
    expect(parseSortParam('goal', FIELDS, FALLBACK)).toEqual({ field: 'goal', direction: 'asc' });
    expect(parseSortParam('-goal', FIELDS, FALLBACK)).toEqual({ field: 'goal', direction: 'desc' });
  });

  // A hand-edited URL, a stale bookmark, or a link copied from the other
  // listing page must still render. Falling back beats throwing on a GET whose
  // only crime is a typo.
  test('anything unrecognised falls back rather than throwing', () => {
    for (const bad of [null, undefined, '', 'nonsense', '-nonsense', '-', 'GOAL', 'goal ']) {
      expect(parseSortParam(bad, FIELDS, FALLBACK)).toEqual(FALLBACK);
    }
  });

  // INVARIANT: the column list is the source of truth for what `?sort=` accepts.
  // The task list rendered a sortable Turns header that its validFields array
  // did not list, so clicking it silently fell back to created-desc with no
  // error anywhere. Deriving one from the other is what makes that
  // unrepresentable — this test fails if they are ever split again.
  test('every rendered task-list column is a field the parser accepts', () => {
    for (const column of TASK_LIST_COLUMNS) {
      expect(TASK_LIST_SORT_FIELDS).toContain(column.field);
      expect(parseSortParam(`-${column.field}`, TASK_LIST_SORT_FIELDS, { field: 'created', direction: 'desc' }))
        .toEqual({ field: column.field, direction: 'desc' });
    }
  });

  test('turns is sortable, not a dead header', () => {
    const parsed = parseSortParam('-turns', TASK_LIST_SORT_FIELDS, { field: 'created', direction: 'desc' });
    expect(parsed).toEqual({ field: 'turns', direction: 'desc' });
  });
});

describe('nextSortParam', () => {
  // These three cases reproduce the task list's pre-extraction rules exactly:
  // an inactive column starts descending, and the active one toggles.
  test('a new column starts descending', () => {
    expect(nextSortParam('goal', { field: 'created', direction: 'desc' })).toBe('-goal');
    expect(nextSortParam('goal', { field: 'created', direction: 'asc' })).toBe('-goal');
  });

  test('the active column toggles instead of re-asking for what it shows', () => {
    expect(nextSortParam('goal', { field: 'goal', direction: 'desc' })).toBe('goal');
    expect(nextSortParam('goal', { field: 'goal', direction: 'asc' })).toBe('-goal');
  });
});

describe('sortHeadersHtml', () => {
  const columns = [
    { field: 'goal' as const, label: 'Goal' },
    { field: 'last_active' as const, label: 'Last activity' },
  ];

  test('marks the active column and points the arrow the way the rows run', () => {
    const html = sortHeadersHtml(columns, { field: 'last_active', direction: 'desc' }, p => `/x?sort=${p}`);
    expect(html).toContain('<a href="/x?sort=last_active" class="sort-link sort-active">Last activity ▼</a>');
    expect(html).toContain('<a href="/x?sort=-goal" class="sort-link">Goal</a>');
    expect(html).not.toContain('Goal ▼');
  });

  test('an ascending column shows the opposite arrow', () => {
    const html = sortHeadersHtml(columns, { field: 'goal', direction: 'asc' }, p => `/x?sort=${p}`);
    expect(html).toContain('Goal ▲');
    expect(html).toContain('href="/x?sort=-goal" class="sort-link sort-active"');
  });

  // The href is built by the caller, which is free to fold in its own query
  // params, so the escaping has to happen here rather than being assumed.
  test('the href is escaped, whatever the caller put in it', () => {
    const html = sortHeadersHtml(columns, { field: 'goal', direction: 'asc' }, p => `/x?filter="><script>&sort=${p}`);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });
});

describe('the task list header, end to end', () => {
  // REGRESSION: `filter` comes straight off the query string, and the task
  // list used to interpolate it raw into every sort link's href — so
  // /tasks?filter="><script>… broke out of the attribute and executed on a
  // signed-in reviewer's page. It is encoded and escaped now; a "simplification"
  // back to a bare ${filter} fails here.
  test('a hostile ?filter= cannot break out of a sort link', () => {
    const html = taskListHtml(oneTask(), '"><script>alert(1)</script>', 'created', 'desc');
    expect(html).not.toContain('<script>alert(1)</script>');
    // The header still works — it is encoded into the href, not dropped.
    expect(html).toContain('sort=-status');
  });

  test('sorting by created shows no arrow — no column claims an order it is not in', () => {
    const html = taskListHtml(oneTask(), '', 'created', 'desc');
    expect(html).not.toContain('▼');
    expect(html).not.toContain('sort-active');
  });

  test('the active column is the one the page was sorted by', () => {
    const html = taskListHtml(oneTask(), 'blocked', 'last_active', 'desc');
    expect(html).toContain('Last Active ▼');
    expect(html).toContain('class="sort-link sort-active"');
  });

  test('the filter bar includes Submitted next to the other statuses', () => {
    const html = taskListHtml(oneTask(), 'submitted', 'last_active', 'desc');
    expect(html).toContain('>Submitted<');
    expect(html).toContain('/tasks?filter=submitted');
    expect(html).toContain('filter=submitted&sort=-last_active" class="btn btn-sm active"');
  });
});

describe('sortReviewQueue', () => {
  test('leaves the caller\'s array alone', () => {
    const entries = [entry({ code: 'bbb' }), entry({ code: 'aaa' })];
    const sorted = sortReviewQueue(entries, { field: 'task', direction: 'asc' });
    expect(codes(entries)).toEqual(['bbb', 'aaa']);
    expect(codes(sorted)).toEqual(['aaa', 'bbb']);
  });

  // INVARIANT: the same data renders in the same order twice. Every field falls
  // through to the same two tiebreaks (most recently updated, then label), so
  // rows that tie on the sorted column cannot swap places between two loads of
  // the page — which is what makes "did anything change?" answerable by eye.
  test('ties break on updatedAt, then on the label', () => {
    const entries = [
      entry({ code: 'ccc', type: 'task', updatedAt: 500 }),
      entry({ code: 'aaa', type: 'task', updatedAt: 900 }),
      entry({ code: 'bbb', type: 'task', updatedAt: 900 }),
    ];
    // Every row has the same type, so the sort field itself decides nothing.
    expect(codes(sortReviewQueue(entries, { field: 'type', direction: 'asc' }))).toEqual([
      'aaa',
      'bbb',
      'ccc',
    ]);
    expect(codes(sortReviewQueue(entries, { field: 'type', direction: 'desc' }))).toEqual([
      'aaa',
      'bbb',
      'ccc',
    ]);
  });

  test('equal subtask counts keep a stable order in both directions', () => {
    const entries = [
      entry({ code: 'bbb', descendantCount: 3, updatedAt: 100 }),
      entry({ code: 'aaa', descendantCount: 3, updatedAt: 100 }),
      entry({ code: 'hub', descendantCount: 12, updatedAt: 100 }),
    ];
    expect(codes(sortReviewQueue(entries, { field: 'subtasks', direction: 'desc' }))).toEqual([
      'hub',
      'aaa',
      'bbb',
    ]);
    expect(codes(sortReviewQueue(entries, { field: 'subtasks', direction: 'asc' }))).toEqual([
      'aaa',
      'bbb',
      'hub',
    ]);
  });

  // INVARIANT: a task whose agent never ran sinks to the bottom whichever way
  // the column points. Sorting oldest-first is a request to see the stalest
  // real activity, not to have "no activity at all" claim the top of the page.
  test('never-active tasks sink in both directions', () => {
    const entries = [
      entry({ code: 'never', lastActiveAt: null, hasSession: false }),
      entry({ code: 'old', lastActiveAt: 100 }),
      entry({ code: 'recent', lastActiveAt: 900 }),
    ];
    expect(codes(sortReviewQueue(entries, { field: 'last_active', direction: 'desc' }))).toEqual([
      'recent',
      'old',
      'never',
    ]);
    expect(codes(sortReviewQueue(entries, { field: 'last_active', direction: 'asc' }))).toEqual([
      'old',
      'recent',
      'never',
    ]);
  });

  test('two never-active tasks still order deterministically', () => {
    const entries = [
      entry({ code: 'bbb', lastActiveAt: null, updatedAt: 100 }),
      entry({ code: 'aaa', lastActiveAt: null, updatedAt: 100 }),
    ];
    expect(codes(sortReviewQueue(entries, { field: 'last_active', direction: 'desc' }))).toEqual([
      'aaa',
      'bbb',
    ]);
  });

  test('the default order is newest activity first', () => {
    const entries = [entry({ code: 'old', lastActiveAt: 1 }), entry({ code: 'new', lastActiveAt: 2 })];
    expect(codes(sortReviewQueue(entries))).toEqual(['new', 'old']);
  });
});

/** One raised-item listing row. Every field has a default; a test names what it ranks on. */
function raised(over: Partial<ListedRaisedItem> & { id: string }): ListedRaisedItem {
  return {
    task_id: 'task-0000000000000001',
    task_code: 'some-task',
    task_goal: 'Do a thing',
    task_status: 'blocked',
    content: 'A raised item body',
    blocking: false,
    title: 'A raised item',
    status: 'open',
    resolution: null,
    resolved_at: null,
    resolved_by: null,
    resolved_by_email: null,
    resolved_by_name: null,
    flagged_by: null,
    flagged_by_email: null,
    flagged_by_name: null,
    unresolved_by: null,
    unresolved_by_email: null,
    unresolved_by_name: null,
    created_at: 1000,
    session_id: null,
    recurrence_id: `recurrence-${over.id}`,
    recurrence_size: 1,
    possibly_promoted: false,
    promoted_to_task_ids: [],
    promoted_task_id: null,
    promoted_task_code: null,
    age_days: 1,
    duplicate_count: 1,
    duplicate_ids: [over.id],
    ...over,
  };
}

const ids = (items: ListedRaisedItem[]) => items.map((i) => i.id);

function listing(items: ListedRaisedItem[]): ListRaisedItemsResult {
  return {
    total: items.length,
    total_open_blocking: items.filter((i) => i.blocking && i.status === 'open').length,
    total_open_non_blocking: items.filter((i) => !i.blocking && i.status === 'open').length,
    items,
    recurrences: [],
  };
}

describe('the raised-items queue sort', () => {
  // INVARIANT: same rule as the task list's Turns header — the column array is
  // what `?sort=` accepts, so a header can never link at a field the parser
  // drops on the floor.
  test('every rendered header link resolves to its own column', () => {
    const html = raisedInboxHtml(listing([raised({ id: 'ri-1' })]), {});
    const hrefs = [...html.matchAll(/<th><a href="([^"]*)" class="sort-link/g)].map((m) =>
      m[1]!.replace(/&amp;/g, '&'),
    );
    // Header order is the column order, and a link that resolved to another
    // column's field — or to none, silently falling back — would be the dead
    // header the shared module exists to make unrepresentable. Gate is a real
    // sortable column, not decoration: the flag is what the page is ranked on
    // when a reviewer wants what holds up a merge first.
    //
    // `recurrence` was `cluster` until 2026-09-20. The word was given to the
    // TASK TYPE that replaced `loop` — a cluster of tasks running concurrently
    // under a driver — and lazy may only spell it one thing, so what this
    // listing groups is a RECURRENCE everywhere now (column `REC`,
    // `lazy raised -r`, `?recurring=1`). The grouping itself did not change.
    const expected: RaisedSortField[] = ['title', 'blocking', 'age', 'recurrence', 'task', 'status', 'decision'];
    expect(hrefs).toHaveLength(expected.length);
    hrefs.forEach((href, i) => {
      const param = new URL(href, 'http://x').searchParams.get('sort');
      expect(parseRaisedSort(param).field).toBe(expected[i]!);
    });
  });

  test('the default is age, newest first — what listRaisedItems itself defaults to', () => {
    expect(DEFAULT_RAISED_SORT).toEqual({ field: 'age', direction: 'desc' });
    expect(parseRaisedSort(null)).toEqual({ field: 'age', direction: 'desc' });
    expect(parseRaisedSort('nonsense')).toEqual({ field: 'age', direction: 'desc' });
  });

  // The Recurring-only view exists to answer "what keeps coming back", and
  // `lazy raised -r` has always ranked it that way. Its default has to match
  // or the filter link would silently re-rank the page it lands on.
  test('the recurring view defaults to recurrence size instead', () => {
    expect(defaultRaisedSort(true)).toEqual({ field: 'recurrence', direction: 'desc' });
    expect(parseRaisedSort(null, { recurringOnly: true })).toEqual({ field: 'recurrence', direction: 'desc' });
    // An explicit choice still wins over the view's default.
    expect(parseRaisedSort('age', { recurringOnly: true })).toEqual({ field: 'age', direction: 'asc' });
  });

  // INVARIANT: ordering the service owns stays in the service. The page maps its
  // column onto listRaisedItems' own sort/order rather than re-implementing the
  // comparator, so the header arrow cannot disagree with the rows underneath.
  test('a service-ranked column is passed through to listRaisedItems', () => {
    expect(raisedListSort({ field: 'age', direction: 'asc' })).toEqual({ sort: 'age', order: 'asc' });
    expect(raisedListSort({ field: 'recurrence', direction: 'desc' })).toEqual({ sort: 'recurrence', order: 'desc' });
    expect(raisedListSort({ field: 'task', direction: 'asc' })).toEqual({ sort: 'task', order: 'asc' });
  });

  // The service has no ordering for these four, so it is asked for its default
  // and the page ranks on top of it — which is what makes the tiebreak below
  // newest-first rather than arbitrary.
  test('a page-ranked column still asks the service for newest first', () => {
    for (const field of ['title', 'blocking', 'status', 'decision'] as const) {
      expect(raisedListSort({ field, direction: 'asc' })).toEqual({ sort: 'age', order: 'desc' });
    }
  });

  // INVARIANT: `/raised` asks for the WHOLE listing. Ranking title, gate, status
  // and decision on the page is only correct because nothing was truncated
  // first — over a service-truncated page it would rank the wrong rows while
  // the header arrow claimed otherwise. This test is the guard the comment
  // alone could not be: adding paging to the page's options makes it fail, and
  // the fix is to teach listRaisedItems those orderings, not to loosen it.
  test('the page asks for no limit or offset', () => {
    const views = [
      { state: 'open' as const, blocking: 'all' as const, recurringOnly: false, sort: DEFAULT_RAISED_SORT },
      { state: 'all' as const, blocking: 'blocking' as const, status: 'complete-only' as const, recurringOnly: false, sort: { field: 'title' as const, direction: 'asc' as const } },
      { state: 'all' as const, blocking: 'non-blocking' as const, recurringOnly: true, sort: defaultRaisedSort(true) },
    ];
    for (const view of views) {
      const options = raisedListOptions(view);
      expect(options.limit).toBeUndefined();
      expect(options.offset).toBeUndefined();
      expect(Object.keys(options)).not.toContain('limit');
      expect(Object.keys(options)).not.toContain('offset');
    }
  });

  // The filters and the order travel together into the service request, so the
  // rows a link asks for are the rows its page renders. The gate filter is one
  // of those filters: it reaches the service, never a post-filter on the page.
  test('the view becomes the service request', () => {
    expect(raisedListOptions({ state: 'all', blocking: 'all', status: 'complete-only', recurringOnly: false, sort: { field: 'task', direction: 'asc' } }))
      .toEqual({ taskStatus: 'complete-only', minRecurrenceSize: undefined, sort: 'task', order: 'asc', state: 'all', blocking: 'all', collapseExactDuplicates: true });
    // Recurring is the recurrence-size filter as well as the recurrence-size order.
    expect(raisedListOptions({ state: 'open', blocking: 'blocking', recurringOnly: true, sort: defaultRaisedSort(true) }))
      .toEqual({ taskStatus: undefined, minRecurrenceSize: 2, sort: 'recurrence', order: 'desc', state: 'open', blocking: 'blocking', collapseExactDuplicates: true });
  });

  test('rows the service ordered are returned untouched', () => {
    const items = [raised({ id: 'b' }), raised({ id: 'a' })];
    for (const field of ['age', 'recurrence', 'task'] as const) {
      expect(orderRaisedForDisplay(items, { field, direction: 'asc' })).toBe(items);
    }
  });

  test('title, task status and decision rank alphabetically, both ways', () => {
    const items = [
      raised({ id: 'c', title: 'Zebra', task_status: 'working', status: 'promoted_subtask' }),
      raised({ id: 'a', title: 'Apple', task_status: 'blocked', status: 'dismissed' }),
      raised({ id: 'b', title: 'Mango', task_status: 'complete', status: 'open' }),
    ];
    for (const field of ['title', 'status', 'decision'] as const satisfies readonly RaisedSortField[]) {
      expect(ids(orderRaisedForDisplay(items, { field, direction: 'asc' }))).toEqual(['a', 'b', 'c']);
      expect(ids(orderRaisedForDisplay(items, { field, direction: 'desc' }))).toEqual(['c', 'b', 'a']);
    }
  });

  // INVARIANT: ascending Gate puts BLOCKING first. The arrow has to mean the
  // useful thing on this column — what holds up a merge is what the reviewer
  // opened the page for — so it is not alphabetical on the word.
  test('the gate column ranks blocking first ascending, and reverses', () => {
    const items = [
      raised({ id: 'note', blocking: false, created_at: 3000 }),
      raised({ id: 'gate', blocking: true, created_at: 2000 }),
      raised({ id: 'note2', blocking: false, created_at: 1000 }),
    ];
    expect(ids(orderRaisedForDisplay(items, { field: 'blocking', direction: 'asc' })))
      .toEqual(['gate', 'note', 'note2']);
    expect(ids(orderRaisedForDisplay(items, { field: 'blocking', direction: 'desc' })))
      .toEqual(['note', 'note2', 'gate']);
  });

  // INVARIANT: the page's own ranking is stable, so rows that tie on a
  // categorical column keep the newest-first order the service returned rather
  // than shuffling between two loads of the same page.
  test('ties keep the order the service returned', () => {
    const items = [
      raised({ id: 'newest', created_at: 3000 }),
      raised({ id: 'middle', created_at: 2000 }),
      raised({ id: 'oldest', created_at: 1000 }),
    ];
    expect(ids(orderRaisedForDisplay(items, { field: 'status', direction: 'desc' })))
      .toEqual(['newest', 'middle', 'oldest']);
  });

  test('the caller\'s array is left alone', () => {
    const items = [raised({ id: 'b', title: 'Zebra' }), raised({ id: 'a', title: 'Apple' })];
    orderRaisedForDisplay(items, { field: 'title', direction: 'asc' });
    expect(ids(items)).toEqual(['b', 'a']);
  });
});

describe('the raised-items page header and filters', () => {
  const rows = listing([raised({ id: 'ri-1' })]);

  test('the page says what it is sorted by, in words', () => {
    expect(raisedInboxHtml(rows, {})).toContain('Sorted by <strong>age</strong>, newest first');
    expect(raisedInboxHtml(rows, { sort: { field: 'recurrence', direction: 'desc' } }))
      .toContain('Sorted by <strong>recurrence</strong>, most first');
    expect(raisedInboxHtml(rows, { sort: { field: 'title', direction: 'asc' } }))
      .toContain('Sorted by <strong>title</strong>, A to Z');
  });

  test('the active column carries the arrow and toggles on click', () => {
    const html = raisedInboxHtml(rows, { sort: { field: 'age', direction: 'desc' } });
    expect(html).toContain('class="sort-link sort-active">Age ▼</a>');
    // Clicking the active column asks for the other direction — and `age` asc
    // is not the default, so it has to be spelled out in the href.
    expect(html).toContain('href="/raised?sort=age"');
  });

  // Filters and sort are one query string: a reader who sorted by title and then
  // clicks "All" must not be silently re-ordered, and a header click must not
  // drop the filter they are looking through.
  test('filter links carry a chosen sort and header links carry the filter', () => {
    const html = raisedInboxHtml(rows, {
      state: 'all',
      sort: { field: 'title', direction: 'asc' },
    });
    expect(html).toContain('href="/raised?all=1&amp;recurring=1&amp;sort=title"');
    expect(html).toContain('href="/raised?all=1&amp;status=complete-only&amp;sort=title"');
    expect(html).toContain('href="/raised?all=1&amp;sort=-task"');
  });

  // INVARIANT: the gate filter is part of that same query string. Narrowing to
  // blocking items must not throw away the order the reader chose, and a header
  // click from inside that filter must not silently widen it back to both
  // kinds — which is exactly how a unified page loses the split it exists for.
  test('the gate filter travels with the sort in both directions', () => {
    const html = raisedInboxHtml(rows, {
      blocking: 'blocking',
      sort: { field: 'title', direction: 'asc' },
    });
    expect(html).toContain('href="/raised?gate=non-blocking&amp;sort=title"');
    expect(html).toContain('href="/raised?gate=blocking&amp;sort=-task"');
  });

  test('the default order is left out of the URL rather than pinned into it', () => {
    const html = raisedInboxHtml(rows, { state: 'all' });
    expect(html).toContain('href="/raised?all=1"');
    expect(html).not.toContain('sort=-age');
  });

  // A filter link from a default-ordered page lands on the TARGET view's
  // default, which for Recurring is recurrence size — that view's whole point.
  test('switching to Recurring from the default order does not pin age onto it', () => {
    const html = raisedInboxHtml(rows, {});
    expect(html).toContain('href="/raised?recurring=1"');
  });

  test('the empty state still offers the filters', () => {
    const html = raisedInboxHtml(
      { total: 0, total_open_blocking: 0, total_open_non_blocking: 0, items: [], recurrences: [] },
      {},
    );
    expect(html).toContain('No raised items match this filter.');
    expect(html).toContain('href="/raised?all=1"');
    expect(html).toContain('href="/raised?gate=blocking"');
    expect(html).not.toContain('Sorted by');
  });
});
