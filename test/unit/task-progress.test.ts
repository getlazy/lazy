/**
 * The daemon's live per-task token tally.
 *
 * These tests encode the design decisions in docs/design/lazy-teams.md §14.2:
 * the tally is fed from the proxy audit stream (never from the store, which has
 * nothing mid-turn), it is bounded by construction, and it self-corrects at the
 * turn boundary instead of being reset by the reconciler.
 */

import { describe, test, expect } from 'bun:test';
import { TaskProgressTracker, teeTaskProgress } from '../../src/daemon/task-progress';
import type { ProxyAuditRecord } from '../../src/storage/types';

function record(overrides: Partial<ProxyAuditRecord> = {}): ProxyAuditRecord {
  return {
    id: `r${Math.random()}`,
    seq: 1,
    ts: 1000,
    role: 'agent',
    taskId: 'task-abc',
    backend: 'anthropic',
    upstream: 'https://api.anthropic.com',
    method: 'POST',
    path: '/v1/messages',
    endpoint: 'messages',
    model: 'claude-opus-5',
    tier: 'opus',
    stream: true,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 2,
      cacheReadInputTokens: 3,
    },
    ...overrides,
  } as ProxyAuditRecord;
}

describe('TaskProgressTracker', () => {
  test('sums the four token counters of every request after the boundary', () => {
    const tracker = new TaskProgressTracker();
    tracker.record(record({ ts: 2000 }));
    tracker.record(record({ ts: 3000 }));

    const totals = tracker.since('task-abc', 1500);
    expect(totals.requests).toBe(2);
    expect(totals.inputTokens).toBe(20);
    expect(totals.outputTokens).toBe(10);
    expect(totals.cacheCreationTokens).toBe(4);
    expect(totals.cacheReadTokens).toBe(6);
    // 2 * (10 + 5 + 2 + 3)
    expect(totals.totalTokens).toBe(40);
  });

  // INVARIANT: the tally self-corrects at the turn boundary. Nothing resets it
  // when a turn ends — the caller's boundary moves past the entries instead.
  // Turn-end has several paths in the reconciler and a counter that needed a
  // call in each of them would be wrong in whichever one was forgotten.
  test('a request before the boundary belongs to a turn already recorded', () => {
    const tracker = new TaskProgressTracker();
    tracker.record(record({ ts: 1000 }));
    tracker.record(record({ ts: 5000 }));

    // Mid-turn: both are ahead of an old boundary.
    expect(tracker.since('task-abc', 500).requests).toBe(2);
    // The first turn was reconciled at t=2000: only the later request is live.
    expect(tracker.since('task-abc', 2000).requests).toBe(1);
    // Everything reconciled: the live figure falls back to zero on its own.
    expect(tracker.since('task-abc', 9000).requests).toBe(0);
    expect(tracker.since('task-abc', 9000).totalTokens).toBe(0);
  });

  test('one task never sees another task’s traffic', () => {
    const tracker = new TaskProgressTracker();
    tracker.record(record({ ts: 2000, taskId: 'aaaa1111' }));
    tracker.record(record({ ts: 2000, taskId: 'bbbb2222' }));

    expect(tracker.since('aaaa1111', 0).requests).toBe(1);
    expect(tracker.since('bbbb2222', 0).requests).toBe(1);
  });

  // The proxy records whatever the `x-lazy-task-id` header carried, which may be
  // a short id while the caller holds the full one. Same allowance the audit
  // aggregation in src/proxy/aggregate.ts makes.
  test('matches a short id against a full one, in either direction', () => {
    const tracker = new TaskProgressTracker();
    tracker.record(record({ ts: 2000, taskId: 'abcd1234' }));

    expect(tracker.since('abcd1234ef567890', 0).requests).toBe(1);
    expect(tracker.since('abcd', 0).requests).toBe(1);
    expect(tracker.since('9999', 0).requests).toBe(0);
  });

  test('a request with no usage still counts as a request', () => {
    const tracker = new TaskProgressTracker();
    tracker.record(record({ ts: 2000, usage: null }));

    const totals = tracker.since('task-abc', 0);
    expect(totals.requests).toBe(1);
    expect(totals.totalTokens).toBe(0);
  });

  test('traffic with no task on it is not counted anywhere', () => {
    const tracker = new TaskProgressTracker();
    tracker.record(record({ ts: 2000, taskId: null }));

    expect(tracker.size).toBe(0);
    expect(tracker.since('task-abc', 0).requests).toBe(0);
  });

  // INVARIANT: bounded by construction. A daemon runs for weeks; this holds a
  // ring per task and an LRU over tasks, and folds evicted entries into an
  // aggregate rather than dropping them.
  test('keeps counting past the ring capacity without growing', () => {
    const tracker = new TaskProgressTracker();
    for (let i = 0; i < 2000; i++) tracker.record(record({ ts: 2000 + i }));

    const totals = tracker.since('task-abc', 0);
    expect(totals.requests).toBe(2000);
    expect(totals.totalTokens).toBe(2000 * 20);
  });

  test('tracks a bounded number of tasks at once', () => {
    const tracker = new TaskProgressTracker();
    for (let i = 0; i < 500; i++) tracker.record(record({ ts: 2000 + i, taskId: `t${i}` }));

    expect(tracker.size).toBeLessThanOrEqual(64);
    // The most recent task is still there; the oldest were evicted.
    expect(tracker.since('t499', 0).requests).toBe(1);
    expect(tracker.since('t0', 0).requests).toBe(0);
  });
});

describe('teeTaskProgress', () => {
  test('passes every record through to the real sink, unchanged', async () => {
    const seen: ProxyAuditRecord[] = [];
    const tracker = new TaskProgressTracker();
    const sink = teeTaskProgress({ append: async (r) => { seen.push(r); } }, tracker);

    const rec = record({ ts: 2000 });
    await sink.append(rec);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(rec);
    expect(tracker.since('task-abc', 0).requests).toBe(1);
  });

  // The audit log is the sink that matters; the tally is a side effect. A sink
  // failure must still reach the queue that knows how to report it.
  test('a failing sink still fails, and the tally still counted', async () => {
    const tracker = new TaskProgressTracker();
    const sink = teeTaskProgress({ append: async () => { throw new Error('disk full'); } }, tracker);

    await expect(sink.append(record({ ts: 2000 }))).rejects.toThrow('disk full');
    expect(tracker.since('task-abc', 0).requests).toBe(1);
  });
});
