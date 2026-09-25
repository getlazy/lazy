/**
 * Web dashboard: a task's raised items must render in the task detail page,
 * mirroring how comments are shown. Display-only — rendering a raised item
 * never triggers anything (it's a pure template function).
 *
 * Blocking and non-blocking items render in ONE section: the flag is a
 * property of the item, not a second kind of thing. See
 * docs/design/raised-items-unified.md.
 */

import { describe, test, expect } from 'bun:test';
import { taskDetailHtml } from '../../src/server/templates';
import { raisedGateBadgeHtml } from '../../src/server/raised-badges';
import type { Task, RaisedItem } from '../../src/types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-id-0001',
    code: 'web-raised',
    goal: 'Render raised items in the dashboard',
    prompt: 'do the thing',
    type: 'task',
    status: 'blocked',
    created_at: new Date('2026-06-19T10:00:00Z').getTime(),
    completed_at: null,
    target: { kind: 'branch' as const, branch: 'main' },
    branched_from_sha: null,
    close_reason: null,
    model: null,
    agent_id: 'claude-code',
    runner_type: null,
    metadata: null,
    tags: [],
    pending_sync: 0,
    ...overrides,
  };
}

function makeRaisedItem(overrides: Partial<RaisedItem> = {}): RaisedItem {
  return {
    id: 'raised-0001',
    task_id: 'task-id-0001',
    content: 'Extract the retry helper into a shared module',
    created_at: new Date('2026-06-19T11:00:00Z').getTime(),
    status: 'open',
    blocking: false,
    ...overrides,
  };
}

function render(raisedItems: RaisedItem[]): string {
  return taskDetailHtml(makeTask(), null, [], [], [], [], raisedItems, [], []);
}

describe('taskDetailHtml raised-items section', () => {
  test('renders a Raised items section with each item when present', () => {
    const html = render([
      makeRaisedItem(),
      makeRaisedItem({ id: 'raised-0002', content: 'Add a metrics counter' }),
    ]);

    expect(html).toContain('Raised items (2)');
    expect(html).toContain('Extract the retry helper into a shared module');
    expect(html).toContain('Add a metrics counter');
  });

  // INVARIANT: one list, one section — the blocking flag is rendered as a
  // marker on the item, never as a separate section or a separate entity.
  test('blocking and non-blocking items share one section, each labelled', () => {
    const html = render([
      makeRaisedItem({ id: 'raised-b', content: 'How far should this go?', blocking: true }),
      makeRaisedItem({ id: 'raised-n', content: 'Unrelated cleanup idea', blocking: false }),
    ]);

    expect(html).toContain('Raised items (2)');
    // The label is whatever the shared vocabulary says it is (🛑 Blocking /
    // ⚠️ FYI as of ui-raised-rendering), asserted as the badge the one renderer
    // emits so this can never drift from it. The INVARIANT above is about
    // STRUCTURE — one section, marker on the item — not about the spelling,
    // which moved when these two tags stopped being unstyled lowercase text.
    expect(html).toContain(raisedGateBadgeHtml(true));
    expect(html).toContain(raisedGateBadgeHtml(false));
    // Exactly one section heading, not one per flag.
    expect(html.match(/Raised items \(/g)?.length).toBe(1);
  });

  test('omits the Raised items section entirely when there are none', () => {
    expect(render([])).not.toContain('Raised items (');
  });

  test('escapes raised-item content (display-only, no HTML injection)', () => {
    const html = render([makeRaisedItem({ content: '<script>alert(1)</script>' })]);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
