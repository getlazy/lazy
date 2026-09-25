import { describe, test, expect } from 'bun:test';
import { buildChartData, toUTCDateString } from '../../src/server/throughput-chart';
import type { Task, StatusChange } from '../../src/storage';

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    code: 'chart-task',
    goal: 'Count me',
    prompt: 'Do work',
    type: 'task',
    status: 'backlog',
    created_at: 0,
    completed_at: null,
    target: { kind: 'branch', branch: 'main' },
    branched_from_sha: null,
    close_reason: null,
    model: null,
    agent_id: 'claude',
    runner_type: null,
    metadata: null,
    tags: [],
    pending_sync: 0,
    ...over,
  } as Task;
}

describe('buildChartData', () => {
  // noon UTC on 2026-09-09 — mid-window so the day is fully inside the 14 days.
  const now = Date.UTC(2026, 8, 9, 12, 0, 0);

  test('submitted transitions are their own daily series, not mixed into completed', () => {
    const submittedAt = Date.UTC(2026, 8, 8, 15, 0, 0);
    const acceptedAt = Date.UTC(2026, 8, 9, 10, 0, 0);
    const t = task({
      id: 'task-submitted',
      status: 'complete',
      created_at: Date.UTC(2026, 8, 1),
      completed_at: acceptedAt,
    });
    const history = new Map<string, StatusChange[]>([
      [t.id, [
        { status: 'backlog', timestamp: t.created_at },
        { status: 'blocked', timestamp: Date.UTC(2026, 8, 7) },
        { status: 'submitted', timestamp: submittedAt },
        { status: 'complete', timestamp: acceptedAt },
      ]],
    ]);

    const points = buildChartData([t], history, now);
    const submittedDay = points.find((p) => p.date === toUTCDateString(submittedAt));
    const acceptedDay = points.find((p) => p.date === toUTCDateString(acceptedAt));
    expect(submittedDay?.submitted).toBe(1);
    expect(submittedDay?.completed).toBe(0);
    expect(acceptedDay?.completed).toBe(1);
    expect(acceptedDay?.submitted).toBe(0);
    expect(points.every((p) => typeof p.submitted === 'number')).toBe(true);
  });

  test('a submit outside the 14-day window is not counted', () => {
    const old = Date.UTC(2026, 7, 1);
    const t = task({ id: 'old-submit', created_at: old });
    const history = new Map<string, StatusChange[]>([
      [t.id, [{ status: 'submitted', timestamp: old }]],
    ]);
    const points = buildChartData([t], history, now);
    expect(points.reduce((n, p) => n + p.submitted, 0)).toBe(0);
  });
});
