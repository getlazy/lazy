/**
 * Web dashboard: a task's follow-ups must render in the task detail page,
 * mirroring how comments are shown. Display-only — rendering a follow-up never
 * triggers anything (it's a pure template function).
 */

import { describe, test, expect } from 'bun:test';
import { taskDetailHtml } from '../../src/server/templates';
import type { Task, FollowUp } from '../../src/types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-id-0001',
    code: 'web-followups',
    goal: 'Render follow-ups in the dashboard',
    prompt: 'do the thing',
    type: 'task',
    status: 'blocked',
    priority: 'normal',
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

function makeFollowUp(overrides: Partial<FollowUp> = {}): FollowUp {
  return {
    id: 'fu-0001',
    task_id: 'task-id-0001',
    content: 'Extract the retry helper into a shared module',
    created_at: new Date('2026-06-19T11:00:00Z').getTime(),
    ...overrides,
  };
}

describe('taskDetailHtml follow-ups section', () => {
  test('renders a Follow-ups section with each follow-up when present', () => {
    const html = taskDetailHtml(
      makeTask(),
      null,
      [],
      [],
      [],
      [],
      [makeFollowUp(), makeFollowUp({ id: 'fu-0002', content: 'Add a metrics counter' })],
      [],
      [],
    );

    expect(html).toContain('Follow-ups (2)');
    expect(html).toContain('Extract the retry helper into a shared module');
    expect(html).toContain('Add a metrics counter');
  });

  test('omits the Follow-ups section entirely when there are none', () => {
    const html = taskDetailHtml(makeTask(), null, [], [], [], [], [], [], []);
    expect(html).not.toContain('Follow-ups (');
  });

  test('escapes follow-up content (display-only, no HTML injection)', () => {
    const html = taskDetailHtml(
      makeTask(),
      null,
      [],
      [],
      [],
      [],
      [makeFollowUp({ content: '<script>alert(1)</script>' })],
      [],
      [],
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
