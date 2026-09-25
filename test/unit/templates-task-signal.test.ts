/**
 * Web task page signal hierarchy (task-page-signal):
 *   - Top of /tasks/:id shows goal, status, and parent only.
 *   - Token usage, agent, model, branch, session, ids live in a collapsed
 *     Metadata <details> — not a second front-and-center Details/Session block.
 *   - Task code stays in the h1; it is not repeated as a labeled Code row.
 *
 * Pure template rendering — no schema or storage changes.
 */

import { describe, test, expect } from 'bun:test';
import { taskDetailHtml } from '../../src/server/templates';
import type { Task, Session } from '../../src/types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    code: 'signal-demo',
    goal: 'Lead with goal status and parent',
    prompt: 'do the thing',
    type: 'task',
    status: 'blocked',
    created_at: new Date('2026-08-25T10:00:00Z').getTime(),
    completed_at: null,
    target: { kind: 'task' as const, parentTaskId: 'parent-task-id-01' },
    branched_from_sha: 'deadbeefcafef00d',
    close_reason: null,
    model: 'claude-opus-4-8',
    agent_id: 'claude',
    runner_type: null,
    metadata: null,
    tags: [],
    pending_sync: 0,
    ...overrides,
  };
}

function makeParent(): Task {
  return makeTask({
    id: 'parent-task-id-01',
    code: 'parent-task',
    goal: 'Umbrella parent',
    target: { kind: 'branch' as const, branch: 'main' },
  });
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-signal',
    task_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    agent_id: 'claude',
    runner_type: null,
    started_at: new Date('2026-08-25T10:05:00Z').getTime(),
    ended_at: null,
    outcome: null,
    git_branch: 'lazy/signal-demo',
    git_start_sha: 'abcdef0123456789',
    agent_session_id: null,
    last_interaction_at: new Date('2026-08-25T11:00:00Z').getTime(),
    total_duration_ms: 3_600_000,
    total_usage: {
      inputTokens: 1200,
      outputTokens: 340,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    container_name: null,
    container_agent_id: null,
    interrupt_reason: null,
    interrupt_exit_code: null,
    interrupt_at: null,
    interrupt_logs: null,
    consecutive_interruptions: 0,
    auto_resumed: false,
    user_stopped: false,
    upstream_merge_sha: null,
    ...overrides,
  };
}

describe('taskDetailHtml signal hierarchy', () => {
  test('leads with goal, status, and parent — not a Details heading', () => {
    const html = taskDetailHtml(
      makeTask(),
      makeSession(),
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      makeParent(),
    );

    expect(html).toContain('class="task-signal"');
    expect(html).toContain('class="task-goal">Lead with goal status and parent</');
    expect(html).toContain('class="tag tag-warning">blocked</');
    // The parent link names the parent by its code, like every task URL.
    expect(html).toContain('Parent <a href="/tasks/parent-task">parent-task</a>');

    // The old front-and-center sections are gone.
    expect(html).not.toContain('<h2>Details</h2>');
    expect(html).not.toContain('<h2>Session');
  });

  test('demotes agent, model, tokens, branch, and ids into collapsed Metadata', () => {
    const html = taskDetailHtml(
      makeTask(),
      makeSession(),
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      makeParent(),
      null,
      'main',
    );

    expect(html).toContain('<details class="detail-section task-metadata">');
    expect(html).toContain('<summary>Metadata</summary>');
    // Collapsed by default — no open attribute on the details element.
    expect(html).not.toMatch(/<details[^>]*\sopen[\s>]/);

    // Secondary fields still present for drill-down.
    expect(html).toContain('Token Usage');
    expect(html).toContain('1.2k in, 340 out');
    expect(html).toContain('Start SHA');
    expect(html).toContain('Agent');
    expect(html).toContain('Model');
    expect(html).toContain('Branch');
    expect(html).toContain('lazy/signal-demo');
    expect(html).toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

    // Code is already in the h1 — not repeated as a labeled row.
    expect(html).toContain('<h1>Task signal-demo</h1>');
    expect(html).not.toContain('<span class="detail-label">Code</span>');
    expect(html).not.toContain('<span class="detail-label">Goal</span>');
    expect(html).not.toContain('<span class="detail-label">Parent</span>');
  });

  test('omits the parent line when the task has no parent', () => {
    const html = taskDetailHtml(
      makeTask({ target: { kind: 'branch', branch: 'main' } }),
      null,
      [],
      [],
      [],
      [],
      [],
      [],
      [],
    );
    expect(html).toContain('class="task-signal"');
    expect(html).not.toContain('class="task-parent"');
    expect(html).toContain('Not started');
  });
});
