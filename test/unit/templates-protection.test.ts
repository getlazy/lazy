/**
 * Web dashboard: protection markers render from the SAME shared vocabulary the
 * CLI uses (src/protection/status.ts) — `[P]` / `[P][A]` on the task list, a
 * `Protected` row on the task detail page. Display-only: the dashboard reports
 * gates and never opens one (there is no web or MCP write surface for
 * `lazy protect` / `lazy approve`).
 *
 * INVARIANT: additive. A project that protects nothing renders exactly the HTML
 * it rendered before — no badge, no legend, no Protected row.
 */

import { describe, test, expect } from 'bun:test';
import { taskListHtml, taskDetailHtml } from '../../src/server/templates';
import type { TaskProtectionStatus } from '../../src/protection/status';
import type { Task } from '../../src/types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-id-0001',
    code: 'web-protection',
    goal: 'Render protection in the dashboard',
    prompt: 'do the thing',
    type: 'task',
    status: 'blocked',
    priority: 'normal',
    created_at: new Date('2026-08-04T10:00:00Z').getTime(),
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

const gated: TaskProtectionStatus = {
  enabled: true,
  gated: true,
  taskGate: null,
  branchGate: { branch: 'main', source: 'default-branch' },
  targetBranch: 'main',
  pendingApproval: null,
};

const gatedWithApproval: TaskProtectionStatus = {
  ...gated,
  pendingApproval: { approvedAt: '2026-08-04T11:00:00Z' },
};

describe('dashboard task list', () => {
  test('badges a protected task and explains the marker in a legend', () => {
    const html = taskListHtml([{ task: makeTask(), session: null, protection: gated }], '');
    expect(html).toContain('[P]');
    expect(html).toContain('needs `lazy approve`');
    expect(html).toContain('protected — accepting needs');
  });

  test('a pending approval shows the second marker', () => {
    const html = taskListHtml([{ task: makeTask(), session: null, protection: gatedWithApproval }], '');
    expect(html).toContain('[P][A]');
    expect(html).toContain('approval pending');
  });

  test('an unprotected project gets no badge and no legend', () => {
    const html = taskListHtml([{ task: makeTask(), session: null }], '');
    expect(html).not.toContain('[P]');
    expect(html).not.toContain('protected — accepting needs');
  });
});

describe('dashboard task detail', () => {
  const detail = (protection?: TaskProtectionStatus | null): string =>
    taskDetailHtml(makeTask(), null, [], [], [], [], [], [], [], null, protection);

  test('renders a Protected row with the same summary the CLI prints', () => {
    const html = detail(gated);
    expect(html).toContain('Protected');
    expect(html).toContain('yes (branch gate)');
    expect(html).toContain('the repo default branch');
  });

  test('reports a pending approval instead of demanding another', () => {
    const html = detail(gatedWithApproval);
    expect(html).toContain('Approval pending');
    expect(html).not.toContain('No approval recorded');
  });

  test('says nothing when the task is not protected', () => {
    expect(detail(null)).not.toContain('Protected');
    expect(detail(undefined)).not.toContain('Protected');
  });
});
