/**
 * Web dashboard: a task's `[serve]` mapping renders on the task detail page in
 * the SAME shape and wording `lazy show` prints (src/cli/commands/show.ts), so
 * the two surfaces can never disagree about what a task is serving.
 *
 * INVARIANT: additive. A project that declares no ports renders exactly the
 * HTML it rendered before — no Serving row at all.
 *
 * INVARIANT: the detail page resolves this for ONE task. The task LIST does
 * not, because the live mapping costs a runtime call per task and a list render
 * would pay it N times for information the human has not asked for yet.
 */

import { describe, test, expect } from 'bun:test';
import { taskDetailHtml, taskListHtml } from '../../src/server/templates';
import type { TaskServeState } from '../../src/serve/discovery';
import type { Task } from '../../src/types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-id-0002',
    code: 'web-serve',
    goal: 'Render serve ports in the dashboard',
    prompt: 'do the thing',
    type: 'task',
    status: 'blocked',
    created_at: new Date('2026-08-14T10:00:00Z').getTime(),
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

const binding = (containerPort: number, hostPort: number) => ({
  containerPort,
  hostAddress: '127.0.0.1',
  hostPort,
});

const declared = [
  { name: 'web', port: 3000 },
  { name: '5173', port: 5173 },
];

const published: TaskServeState = {
  declared,
  services: [
    { name: 'web', port: 3000, binding: binding(3000, 49154), url: 'http://127.0.0.1:49154' },
    { name: '5173', port: 5173, binding: binding(5173, 49155), url: 'http://127.0.0.1:49155' },
  ],
  unavailable: null,
  containerName: 'lazy-web-serve',
  runnerType: 'docker',
};

const detail = (serve?: TaskServeState | null): string =>
  taskDetailHtml(makeTask(), null, [], [], [], [], [], [], [], null, null, undefined, serve);

describe('dashboard task detail: serving', () => {
  test('links each published service at its loopback host port', () => {
    const html = detail(published);
    expect(html).toContain('Serving');
    expect(html).toContain('href="http://127.0.0.1:49154"');
    expect(html).toContain('href="http://127.0.0.1:49155"');
    expect(html).toContain('web');
  });

  test('a stopped container lists the declared services without inventing URLs', () => {
    const html = detail({ ...published, services: [], unavailable: 'not-running' });
    expect(html).toContain('Serving');
    expect(html).toContain('(container not running)');
    expect(html).not.toContain('http://127.0.0.1:');
  });

  test('a runner with no container says where the services actually are', () => {
    const html = detail({
      ...published,
      services: [],
      unavailable: 'no-container-runner',
      runnerType: 'host-process',
    });
    expect(html).toContain("host-process runner — services are on this machine's own ports");
  });

  // A container created BEFORE a [serve] edit publishes what it was created
  // with, so a declared service can legitimately have no binding. Saying so is
  // the whole point — the alternative is a human staring at a URL that never
  // answers.
  test('a declared service with no binding is reported as unpublished', () => {
    const html = detail({
      ...published,
      services: [
        { name: 'web', port: 3000, binding: binding(3000, 49154), url: 'http://127.0.0.1:49154' },
        { name: '5173', port: 5173, binding: null, url: null },
      ],
    });
    expect(html).toContain('(not published — restart to pick up [serve])');
  });

  test('renders nothing when the project declares no ports', () => {
    const empty: TaskServeState = {
      declared: [],
      services: [],
      unavailable: null,
      containerName: '',
      runnerType: '',
    };
    expect(detail(empty)).not.toContain('Serving');
    expect(detail(null)).not.toContain('Serving');
    expect(detail(undefined)).not.toContain('Serving');
  });
});

describe('dashboard task list', () => {
  // INVARIANT: the list does not resolve serve state. It has no parameter for
  // it on purpose — see the file header.
  test('does not render serving information', () => {
    const html = taskListHtml([{ task: makeTask(), session: null }], '');
    expect(html).not.toContain('Serving');
  });

  test('offers New task on the list and on the empty state', () => {
    const withTasks = taskListHtml([{ task: makeTask(), session: null }], '');
    expect(withTasks).toContain('href="/tasks/new"');
    expect(withTasks).toContain('New task');
    const empty = taskListHtml([], '');
    expect(empty).toContain('href="/tasks/new"');
    expect(empty).toContain('New task');
  });
});
