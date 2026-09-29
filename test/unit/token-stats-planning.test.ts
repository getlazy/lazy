import { describe, expect, test } from 'bun:test';
import { aggregateUsage } from '../../src/proxy/aggregate';
import { planningActivityAt, summarizeModels, type TaskPlanningRow } from '../../src/daemon/token-stats';
import type { ProxyAuditRecord } from '../../src/storage/types';

function audit(taskId: string, inputTokens: number): ProxyAuditRecord {
  return {
    id: taskId, seq: 1, ts: 1, role: 'agent', taskId, backend: 'proxy',
    upstream: 'https://api.anthropic.com', method: 'POST', path: '/v1/messages',
    endpoint: 'messages', model: 'opus', tier: null, stream: false, requestShape: null,
    toolUses: [], toolResults: [], status: 200,
    usage: { inputTokens, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    stopReason: 'end_turn', error: null, durationMs: 1, reroute: null,
  };
}

function row(taskId: string, outcome: TaskPlanningRow['outcome'], feedbackRounds: number, tokens: number): TaskPlanningRow {
  return { taskId, code: taskId, taskType: 'task', outcome, models: ['opus'], requestedModels: ['opus'], efforts: ['high'], harnesses: ['claude-code'], feedbackRounds, turnWallClockMs: 100, tokens, modelTokens: { opus: tokens } };
}

describe('token planning rollup', () => {
  test('joins fixture spend to outcomes and computes model planning rates', () => {
    const spend = aggregateUsage([audit('a', 100), audit('b', 200), audit('c', 300)]);
    const tokens = (id: string) => spend.byTask.find(group => group.key === id)!.totalTokens;
    const result = summarizeModels([
      row('a', 'accepted', 0, tokens('a')),
      row('b', 'accepted', 2, tokens('b')),
      row('c', 'rejected', 1, tokens('c')),
    ], 3)[0];
    expect(result).toEqual({
      model: 'opus', taskCount: 3, sample: 'sufficient', acceptRate: 2 / 3,
      averageRounds: 1, firstPassRate: 1 / 3, tokensPerAcceptedTask: 150,
    });
  });

  test('withholds rates below the minimum sample', () => {
    const result = summarizeModels([row('a', 'accepted', 0, 10)], 3)[0];
    expect(result.sample).toBe('insufficient data');
    expect(result.acceptRate).toBeNull();
    expect(result.averageRounds).toBeNull();
    expect(result.firstPassRate).toBeNull();
  });

  test('does not duplicate a multi-model task total into every model', () => {
    const mixed = row('mixed', 'accepted', 0, 300);
    mixed.models = ['opus', 'sonnet'];
    mixed.modelTokens = { opus: 100, sonnet: 200 };
    const results = summarizeModels([mixed], 1);
    expect(results.find(row => row.model === 'opus')?.tokensPerAcceptedTask).toBe(100);
    expect(results.find(row => row.model === 'sonnet')?.tokensPerAcceptedTask).toBe(200);
  });

  test('uses durable completion or turn activity to decide a planning window', () => {
    expect(planningActivityAt(5_000, [])).toBe(5_000);
    expect(planningActivityAt(2_000, [{ timestamp: 7_000 } as any])).toBe(7_000);
    expect(planningActivityAt(null, [])).toBe(0);
  });
});
