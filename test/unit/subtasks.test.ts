/**
 * Subtasks grouping: every real status lands in exactly one group, Done and
 * Closed start collapsed, Backlog collapses above 20, and the renderer
 * has no cap.
 *
 * INVARIANT: Landing's rollup and the Subtasks tab share {@link groupSubtasks}
 * so the two surfaces cannot disagree about the counts.
 */

import { describe, test, expect } from 'bun:test';
import type { Task, TaskStatus } from '../../src/types';
import {
  BACKLOG_COLLAPSE_AFTER,
  groupSubtasks,
  hubRollupHtml,
  subtaskGroupFor,
  subtasksSectionHtml,
} from '../../src/server/subtasks';

function child(id: string, status: TaskStatus, goal: string = status): Task {
  return {
    id,
    code: id.slice(0, 8),
    goal,
    prompt: '',
    type: 'task',
    status,
    created_at: 1_000,
    completed_at: status === 'complete' || status === 'abandoned' ? 2_000 : null,
    target: { kind: 'task', parentTaskId: 'parent' },
    branched_from_sha: null,
    close_reason: null,
    model: null,
    agent_id: 'claude-code',
    runner_type: null,
    metadata: null,
    tags: [],
    pending_sync: 0,
  };
}

describe('subtaskGroupFor', () => {
  const cases: Array<[TaskStatus, ReturnType<typeof subtaskGroupFor>]> = [
    ['blocked', 'needs-you'],
    ['conflict', 'needs-you'],
    ['working', 'active'],
    ['pairing', 'active'],
    ['interrupted', 'active'],
    ['merging', 'active'],
    ['backlog', 'backlog'],
    ['submitted', 'backlog'],
    ['zombie', 'backlog'],
    ['complete', 'done'],
    ['abandoned', 'closed'],
  ];
  for (const [status, group] of cases) {
    test(`${status} → ${group}`, () => {
      expect(subtaskGroupFor(status)).toBe(group);
    });
  }
});

describe('groupSubtasks', () => {
  test('Done and Closed start collapsed; Backlog collapses only above the threshold', () => {
    const smallBacklog = groupSubtasks([
      child('b1', 'blocked'),
      child('w1', 'working'),
      ...Array.from({ length: BACKLOG_COLLAPSE_AFTER }, (_, i) => child(`bl${i}`, 'backlog')),
      child('d1', 'complete'),
      child('c1', 'abandoned'),
    ]);
    expect(smallBacklog.find((g) => g.id === 'needs-you')!.collapsed).toBe(false);
    expect(smallBacklog.find((g) => g.id === 'active')!.collapsed).toBe(false);
    expect(smallBacklog.find((g) => g.id === 'backlog')!.collapsed).toBe(false);
    expect(smallBacklog.find((g) => g.id === 'done')!.collapsed).toBe(true);
    expect(smallBacklog.find((g) => g.id === 'closed')!.collapsed).toBe(true);

    const bigBacklog = groupSubtasks(
      Array.from({ length: BACKLOG_COLLAPSE_AFTER + 1 }, (_, i) => child(`x${i}`, 'backlog')),
    );
    expect(bigBacklog.find((g) => g.id === 'backlog')!.collapsed).toBe(true);
  });
});

describe('subtasksSectionHtml', () => {
  test('a 301-child list renders every row with no cap or pagination', () => {
    const children = Array.from({ length: 301 }, (_, i) =>
      child(`child-${String(i).padStart(3, '0')}`, i < 2 ? 'blocked' : 'complete', `Goal ${i}`),
    );
    const html = subtasksSectionHtml({
      parentId: 'parent',
      children,
      subtreeCounts: new Map([['child-000', 12]]),
    });
    expect(html).toContain('Subtasks (301)');
    expect(html).toContain('Needs you (2)');
    expect(html).toContain('Done (299)');
    expect((html.match(/<tr data-lz-subtasks-row/g) ?? []).length).toBe(301);
    expect(html).not.toContain('truncated');
    expect(html).not.toContain('Load more');
    expect(html).not.toContain('page=');
    // 12 nested under that child, linking into THAT child's Subtasks tab. Every
    // other row has nothing nested and renders a dash that does not link — a
    // click could only ever cost a page load to be told the tab is empty.
    expect(html).toContain('href="/tasks/child-000/subtasks"');
    expect(html).toContain('>12</a>');
    expect(html).not.toContain('href="/tasks/child-001/subtasks"');
    expect(html).toContain('lz-subtasks-count-none');
    expect(html).toContain('id="subtasks-needs-you"');
    expect(html).toContain('id="subtasks-done"');
    // Done starts collapsed; Needs you does not.
    expect(html).toMatch(/id="subtasks-needs-you"[^>]* open/);
    expect(html).not.toMatch(/id="subtasks-done"[^>]* open/);
    // Progressive filter is present but hidden until JS unhides it.
    expect(html).toContain('data-lz-subtasks-filter');
    expect(html).toContain('hidden');
  });
});

describe('hubRollupHtml', () => {
  test('each non-zero count links into the matching group on Subtasks', () => {
    const html = hubRollupHtml('hub-id', [
      child('a', 'blocked'),
      child('b', 'working'),
      child('c', 'complete'),
    ]);
    expect(html).toContain('href="/tasks/hub-id/subtasks"');
    expect(html).toContain('3 subtasks');
    expect(html).toContain('/subtasks#subtasks-needs-you');
    expect(html).toContain('1 need you');
    expect(html).toContain('/subtasks#subtasks-active');
    expect(html).toContain('1 active');
    expect(html).toContain('/subtasks#subtasks-done');
    expect(html).toContain('1 done');
  });
});

describe('subtask ordering and navigation', () => {
  // INVARIANT: each group is sorted by Updated descending — completion time,
  // else creation time — which is the default the engineer asked for.
  test('each group is sorted by Updated, newest first', () => {
    const old = { ...child('aaaaaaaa-old', 'complete'), completed_at: 1_000 };
    const mid = { ...child('bbbbbbbb-mid', 'complete'), completed_at: 5_000 };
    const fresh = { ...child('cccccccc-new', 'complete'), completed_at: 9_000 };
    const done = groupSubtasks([old, fresh, mid]).find((g) => g.id === 'done')!;
    expect(done.tasks.map((t) => t.id)).toEqual([fresh.id, mid.id, old.id]);

    const html = subtasksSectionHtml({ parentId: 'p', children: [old, fresh, mid] });
    expect(html.indexOf('cccccccc')).toBeLessThan(html.indexOf('bbbbbbbb'));
    expect(html.indexOf('bbbbbbbb')).toBeLessThan(html.indexOf('aaaaaaaa'));
    expect(html).toContain('aria-sort="descending" data-lz-sort="num"');
  });

  test('the jump bar links every non-empty group, and only those', () => {
    const html = subtasksSectionHtml({
      parentId: 'p',
      children: [child('a1', 'blocked'), child('d1', 'complete'), child('d2', 'complete')],
    });
    expect(html).toContain('href="#subtasks-needs-you" data-lz-subtasks-jump');
    expect(html).toContain('href="#subtasks-done" data-lz-subtasks-jump');
    expect(html).not.toContain('href="#subtasks-active"');
  });
});
