/**
 * Rollup arithmetic over the proxy audit trail (src/proxy/aggregate.ts).
 */
import { describe, test, expect } from 'bun:test';
import { aggregateUsage, UNATTRIBUTED } from '../../src/proxy/aggregate';
import type { ProxyAuditRecord, ProxyTokenUsage } from '../../src/storage/types';

function record(over: Partial<ProxyAuditRecord>): ProxyAuditRecord {
  return {
    id: 'id', seq: 1, ts: 1_000, role: null, taskId: null, backend: 'proxy',
    upstream: 'https://api.anthropic.com', method: 'POST', path: '/v1/messages',
    endpoint: 'messages', model: null, tier: null, stream: null, requestShape: null,
    toolUses: [], toolResults: [], status: 200, usage: null, stopReason: null,
    error: null, durationMs: 10, reroute: null,
    ...over,
  };
}

function usage(input: number, output: number, write = 0, read = 0): ProxyTokenUsage {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheCreationInputTokens: write,
    cacheReadInputTokens: read,
  };
}

describe('aggregateUsage', () => {
  test('sums totals and counts records without usage separately', () => {
    const report = aggregateUsage([
      record({ usage: usage(10, 20, 30, 40) }),
      record({ usage: usage(1, 2, 3, 4) }),
      record({ usage: null, error: 'unreachable', status: null }),
    ]);
    expect(report.totals.requests).toBe(3);
    expect(report.totals.withUsage).toBe(2);
    expect(report.totals.inputTokens).toBe(11);
    expect(report.totals.outputTokens).toBe(22);
    expect(report.totals.cacheCreationInputTokens).toBe(33);
    expect(report.totals.cacheReadInputTokens).toBe(44);
    expect(report.totals.totalTokens).toBe(110);
  });

  test('breaks down by role, task and model, ranked by total tokens', () => {
    const report = aggregateUsage([
      record({ role: 'agent', taskId: 'aaa', model: 'opus', usage: usage(100, 0) }),
      record({ role: 'builder', taskId: 'bbb', model: 'sonnet', usage: usage(1, 0) }),
      record({ role: 'agent', taskId: 'ccc', model: 'opus', usage: usage(50, 0) }),
    ]);
    expect(report.byRole.map((g) => [g.key, g.totalTokens])).toEqual([
      ['agent', 150],
      ['builder', 1],
    ]);
    expect(report.byModel.map((g) => g.key)).toEqual(['opus', 'sonnet']);
    expect(report.byTask.map((g) => g.key)).toEqual(['aaa', 'ccc', 'bbb']);
    expect(report.byRole[0].requests).toBe(2);
  });

  // INVARIANT: traffic we cannot attribute is surfaced, not dropped. A record
  // with no role/task header is a real request that cost real tokens; hiding it
  // would make the rollup silently under-report.
  test('groups records with no role/task/model under a visible label', () => {
    const report = aggregateUsage([record({ usage: usage(5, 5) })]);
    expect(report.byRole[0].key).toBe(UNATTRIBUTED);
    expect(report.byTask[0].key).toBe(UNATTRIBUTED);
    expect(report.byModel[0].key).toBe(UNATTRIBUTED);
    expect(report.totals.totalTokens).toBe(10);
  });

  test('filters by since, role and task-id prefix', () => {
    const records = [
      record({ ts: 1_000, role: 'agent', taskId: 'add-proxy-usage', usage: usage(10, 0) }),
      record({ ts: 5_000, role: 'agent', taskId: 'add-proxy-usage', usage: usage(20, 0) }),
      record({ ts: 5_000, role: 'builder', taskId: 'other-task', usage: usage(40, 0) }),
    ];
    expect(aggregateUsage(records, { sinceMs: 2_000 }).totals.totalTokens).toBe(60);
    expect(aggregateUsage(records, { role: 'agent' }).totals.totalTokens).toBe(30);
    expect(aggregateUsage(records, { taskId: 'add-proxy' }).totals.requests).toBe(2);
  });

  test('reports the observed time window and an empty report for no records', () => {
    const report = aggregateUsage([record({ ts: 300 }), record({ ts: 100 }), record({ ts: 200 })]);
    expect(report.firstTs).toBe(100);
    expect(report.lastTs).toBe(300);

    const empty = aggregateUsage([]);
    expect(empty.totals.requests).toBe(0);
    expect(empty.firstTs).toBeNull();
    expect(empty.byRole).toEqual([]);
  });

  test('treats null usage fields as zero without corrupting the sum', () => {
    const report = aggregateUsage([
      record({
        usage: {
          inputTokens: 7,
          outputTokens: null,
          cacheCreationInputTokens: null,
          cacheReadInputTokens: 3,
        },
      }),
    ]);
    expect(report.totals.totalTokens).toBe(10);
    expect(report.totals.outputTokens).toBe(0);
  });
});
