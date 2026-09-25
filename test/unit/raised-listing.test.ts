/**
 * Unit tests for the cross-task raised-item listing: grouping, promotion
 * hints, filters.
 *
 * INVARIANT: one listing serves both halves of the unified entity — a blocking
 * item and a non-blocking one differ by a flag and a filter, never by which
 * code path builds the row. See docs/design/raised-items-unified.md.
 */

import { describe, test, expect } from 'bun:test';
import { fingerprint, jaccardSimilarity, wordSet, groupRaisedItemsByRecurrence } from '../../src/raised/recurrence';
import { buildPromotionIndex } from '../../src/raised/promotion';
import { buildRaisedItemsListing, type RawRaisedItemRow } from '../../src/raised';
import type { RaisedItem, Task } from '../../src/types';

function stubTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    code: overrides.code ?? null,
    goal: overrides.goal ?? `goal-${id.slice(0, 8)}`,
    prompt: overrides.prompt ?? '',
    type: 'task',
    status: overrides.status ?? 'working',
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
    ...overrides,
  } as Task;
}

/** A raised item. Non-blocking by default — the flag is what a test names. */
function stubRaised(taskId: string, content: string, id = 'f1', blocking = false): RaisedItem {
  return {
    id,
    task_id: taskId,
    content,
    blocking,
    status: 'open',
    created_at: Date.now() - 2 * 24 * 60 * 60 * 1000,
  };
}

describe('raised-item grouping', () => {
  test('groups identical significant-word fingerprints', () => {
    const text = 'Extract the retry helper into a shared module';
    const { recurrenceIdFor, recurrences } = groupRaisedItemsByRecurrence(
      [
        { id: 'a', content: text },
        { id: 'b', content: text },
      ],
      (id) => (id === 'a' ? 't1' : 't2'),
    );
    expect(recurrenceIdFor.get('a')).toBe(recurrenceIdFor.get('b'));
    expect(recurrences[0].size).toBe(2);
  });

  test('merges near-duplicates by Jaccard similarity', () => {
    const a = 'Extract retry helper into shared module for all callers';
    const b = 'Extract the retry helper module into shared code for callers';
    const sim = jaccardSimilarity(wordSet(a), wordSet(b));
    expect(sim).toBeGreaterThan(0.55);

    const { recurrences } = groupRaisedItemsByRecurrence(
      [{ id: 'a', content: a }, { id: 'b', content: b }],
      (id) => (id === 'a' ? 't1' : 't2'),
    );
    expect(recurrences[0].size).toBe(2);
  });

  test('fingerprint ignores short words', () => {
    expect(fingerprint('a an the retry helper')).toContain('retry');
    expect(fingerprint('a an the retry helper')).not.toContain('the');
  });
});

describe('promotion index', () => {
  // INVARIANT: the legacy follow-up spelling stays matched forever. Tasks
  // promoted before the unification carry it in their prompt, and nothing
  // rewrites history — dropping the pattern would silently strand every one of
  // them back on the heuristic's "not promoted" answer.
  test('detects the legacy "Promoted from a follow-up on <code>" prose', () => {
    const source = stubTask('source-id', { code: 'fix-review-null' });
    const promoted = stubTask('child-id', {
      prompt: 'Promoted from a follow-up on fix-review-null (lazy_show fix-review-null).',
    });
    const index = buildPromotionIndex([source, promoted]);
    expect(index.get('source-id')).toEqual(['child-id']);
  });

  // Both endings lazy's own provenance line can have: a goal after a colon, or
  // a bare period when the originating task had none. The reference stops at
  // either — a captured "fix-review-null." matches no task and would have made
  // a real promotion look like an untracked one.
  test('detects the raised-item spelling lazy writes now, with or without a goal', () => {
    const source = stubTask('source-id', { code: 'fix-review-null' });
    for (const prompt of [
      'Promoted from raised item abc12345 on task fix-review-null: Fix the null deref.',
      'Promoted from raised item abc12345 on task fix-review-null.',
    ]) {
      const promoted = stubTask('child-id', { prompt });
      const index = buildPromotionIndex([source, promoted]);
      expect(index.get('source-id')).toEqual(['child-id']);
    }
  });
});

describe('buildRaisedItemsListing', () => {
  test('filters complete-only and sorts by recurrence size', () => {
    const complete = stubTask('t-complete', { status: 'complete', code: 'done-task' });
    const working = stubTask('t-working', { status: 'working', code: 'open-task' });
    const rows: RawRaisedItemRow[] = [
      { item: stubRaised('t-complete', 'shared retry helper module', 'f1'), task: complete },
      { item: stubRaised('t-working', 'shared retry helper module', 'f2'), task: working },
      { item: stubRaised('t-complete', 'shared retry helper module again', 'f3'), task: complete },
    ];

    const result = buildRaisedItemsListing(rows, [complete, working], {
      taskStatus: 'complete-only',
      sort: 'recurrence',
      order: 'desc',
    });

    expect(result.total).toBe(2);
    expect(result.items.every((i) => i.task_status === 'complete')).toBe(true);
    expect(result.items[0].recurrence_size).toBeGreaterThanOrEqual(2);
  });

  test('the open filter hides decided items when requested', () => {
    const task = stubTask('t1');
    const rows: RawRaisedItemRow[] = [
      {
        item: stubRaised('t1', 'open note', 'f-open'),
        task,
      },
      {
        item: { ...stubRaised('t1', 'done note', 'f-done'), status: 'acknowledged' },
        task,
      },
    ];
    const defaultAll = buildRaisedItemsListing(rows, [task]);
    expect(defaultAll.total).toBe(2);

    const openOnly = buildRaisedItemsListing(rows, [task], { state: 'open' });
    expect(openOnly.total).toBe(1);
    expect(openOnly.items[0].title).toContain('open note');

    const all = buildRaisedItemsListing(rows, [task], { state: 'all' });
    expect(all.total).toBe(2);
  });

  // INVARIANT: the gate filter is a filter over ONE listing, not a second
  // listing. Both flags are present by default — the page and `lazy raised`
  // narrow to one when the reader asks, and the unfiltered answer is the union
  // rather than either half.
  test('the blocking filter narrows one listing rather than forking it', () => {
    const task = stubTask('t1');
    const rows: RawRaisedItemRow[] = [
      { item: stubRaised('t1', 'gating scope question', 'r-gate', true), task },
      { item: stubRaised('t1', 'orthogonal retry proposal', 'r-note', false), task },
    ];

    expect(buildRaisedItemsListing(rows, [task]).total).toBe(2);
    expect(buildRaisedItemsListing(rows, [task], { blocking: 'all' }).total).toBe(2);

    const gating = buildRaisedItemsListing(rows, [task], { blocking: 'blocking' });
    expect(gating.items.map((i) => i.id)).toEqual(['r-gate']);
    expect(gating.items[0].blocking).toBe(true);

    const notes = buildRaisedItemsListing(rows, [task], { blocking: 'non-blocking' });
    expect(notes.items.map((i) => i.id)).toEqual(['r-note']);
    expect(notes.items[0].blocking).toBe(false);
  });

  // The badge leads with what gates a merge, so the two open counts are
  // reported separately — and they count the UNFILTERED set, so narrowing to
  // one gate does not make the other number vanish from the page.
  test('open counts are reported per flag and survive a gate filter', () => {
    const task = stubTask('t1');
    const rows: RawRaisedItemRow[] = [
      { item: stubRaised('t1', 'gating scope question', 'r-gate', true), task },
      { item: stubRaised('t1', 'orthogonal retry proposal', 'r-note', false), task },
      { item: { ...stubRaised('t1', 'decided note', 'r-done', false), status: 'acknowledged' }, task },
    ];

    const all = buildRaisedItemsListing(rows, [task]);
    expect(all.total_open_blocking).toBe(1);
    expect(all.total_open_non_blocking).toBe(1);

    const gating = buildRaisedItemsListing(rows, [task], { blocking: 'blocking' });
    expect(gating.total_open_blocking).toBe(1);
    expect(gating.total_open_non_blocking).toBe(1);
  });

  test('collapseExactDuplicates merges identical bodies on the same task only', () => {
    const taskA = stubTask('t1');
    const taskB = stubTask('t2');
    const text = 'Same orthogonal note';
    const rows: RawRaisedItemRow[] = [
      { item: stubRaised('t1', text, 'f1'), task: taskA },
      { item: stubRaised('t1', text, 'f2'), task: taskA },
      { item: stubRaised('t2', text, 'f3'), task: taskB },
    ];
    const result = buildRaisedItemsListing(rows, [taskA, taskB], { state: 'all', collapseExactDuplicates: true });
    expect(result.total).toBe(2);
    expect(result.items.find((i) => i.task_id === 't1')?.duplicate_count).toBe(2);
    expect(result.items.find((i) => i.task_id === 't2')?.duplicate_count).toBe(1);
  });

  // The web queue's column headers claim a direction ("most first", "newest
  // first") and hand the ordering straight to this function, so what `desc`
  // means here is what the arrow on the page means. These pin all three.
  describe('sort direction', () => {
    const taskA = stubTask('t-a', { code: 'aaa-task' });
    const taskB = stubTask('t-b', { code: 'zzz-task' });
    // The first two share a fingerprint (recurrence of 2); the third is a singleton.
    const rows: RawRaisedItemRow[] = [
      { item: { ...stubRaised('t-a', 'shared retry helper module', 'pair-old'), created_at: 100 }, task: taskA },
      { item: { ...stubRaised('t-b', 'shared retry helper module', 'pair-new'), created_at: 200 }, task: taskB },
      { item: { ...stubRaised('t-a', 'unrelated telemetry counter', 'solo'), created_at: 300 }, task: taskA },
    ];
    const order = (opts: Parameters<typeof buildRaisedItemsListing>[2]) =>
      buildRaisedItemsListing(rows, [taskA, taskB], { state: 'all', ...opts }).items.map((i) => i.id);

    test('age desc is newest first, asc is oldest first', () => {
      expect(order({ sort: 'age', order: 'desc' })).toEqual(['solo', 'pair-new', 'pair-old']);
      expect(order({ sort: 'age', order: 'asc' })).toEqual(['pair-old', 'pair-new', 'solo']);
    });

    // REGRESSION: this comparator was pre-negated, so `desc` returned the
    // SMALLEST recurrences first — the opposite of what the same word means for
    // age and task, and of what every caller that asks for it wants: the web
    // Recurring view, `lazy followups --sort recurrence`, and `lazy_raised_items`
    // with `sort: "recurrence"`. It does NOT reach the recurrence SUMMARY list
    // (`result.recurrences`), which groupRaisedItemsByRecurrence ranks biggest-first on its
    // own — so `lazy followups -c` and MCP `recurring_only`, which print
    // summaries rather than items, never showed the inverted order.
    test('recurrence desc is the biggest recurrence first', () => {
      expect(order({ sort: 'recurrence', order: 'desc' })).toEqual(['pair-new', 'pair-old', 'solo']);
      expect(order({ sort: 'recurrence', order: 'asc' })).toEqual(['solo', 'pair-old', 'pair-new']);
    });

    test('task asc is A to Z on the task code', () => {
      expect(order({ sort: 'task', order: 'asc' })).toEqual(['pair-old', 'solo', 'pair-new']);
      expect(order({ sort: 'task', order: 'desc' })).toEqual(['pair-new', 'solo', 'pair-old']);
    });
  });

  test('real promoted state wins over heuristic possibly_promoted', () => {
    const source = stubTask('t-source', { code: 'source-task' });
    const heuristicChild = stubTask('t-heuristic', {
      prompt: 'Promoted from a follow-up on source-task (lazy_show source-task).',
    });
    const promotedTask = stubTask('t-promoted', { code: 'real-promoted', status: 'backlog' });
    const item: RaisedItem = {
      ...stubRaised('t-source', 'Do the thing', 'f-promoted'),
      status: 'promoted_subtask',
      promoted_task_id: 't-promoted',
    };
    const rows: RawRaisedItemRow[] = [{ item, task: source }];
    const result = buildRaisedItemsListing(rows, [source, heuristicChild, promotedTask], { state: 'all' });
    expect(result.items[0].possibly_promoted).toBe(false);
    expect(result.items[0].promoted_task_id).toBe('t-promoted');
    expect(result.items[0].promoted_task_code).toBe('real-promoted');
    expect(result.items[0].promoted_to_task_ids).toEqual(['t-promoted']);
  });
});
