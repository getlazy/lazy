import { describe, expect, test } from 'bun:test';
import { durableTurnUsage } from '../../src/daemon/token-stats';
import type { Turn } from '../../src/types';

function turn(over: Partial<Turn>): Turn {
  return { role: 'agent', sequence: 1, timestamp: 1, ...over } as Turn;
}

describe('durableTurnUsage', () => {
  // INVARIANT: token stats read durable per-turn usage, not only the bounded proxy
  // trail. The trail rotates, so a completed turn's tokens must survive it.
  test('sums agent-turn usage per model', () => {
    const usage = { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 2, cacheReadTokens: 3 };
    const got = durableTurnUsage([
      turn({ model_id: 'claude-sonnet-5-5', usage }),
      turn({ sequence: 2, model_id: 'claude-sonnet-5-5', usage }),
      turn({ role: 'human', usage }),
    ]);
    expect(got).toEqual({ total: 40, turnsWithUsage: 2, agentTurns: 2, byModel: { 'claude-sonnet-5-5': 40 } });
  });

  // INVARIANT: no reported usage is null (unknown), never a fabricated zero.
  test('returns null when no turn reported usage', () => {
    expect(durableTurnUsage([turn({})])).toBeNull();
  });
});

import { aggregateUsage } from '../../src/proxy/aggregate';
import type { ProxyAuditRecord } from '../../src/storage/types';

describe('short-id attribution and windows', () => {
  // INVARIANT: the proxy stamps records with the task CODE, so a caller passes every form the
  // task answers to and matches EXACTLY (a prefix rule filed `fix-a-b` under `fix-a`).
  test('aggregateUsage taskIds matches code-attributed records exactly', () => {
    const mk = (taskId: string, n: number) => ({ id: taskId, seq: 1, ts: 1, role: 'agent', taskId, model: 'm',
      usage: { inputTokens: n, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } }) as unknown as ProxyAuditRecord;
    const r = aggregateUsage([mk('fix-a', 7), mk('fix-a-b', 100)], { taskIds: ['2d89b696-aaaa', '2d89b696', 'fix-a'] });
    expect(r.totals.totalTokens).toBe(7);
  });

  // INVARIANT: durable usage honours the --since window so it never mixes with windowed trail totals.
  test('durableTurnUsage respects sinceMs and counts agent turns', () => {
    const usage = { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 };
    const got = durableTurnUsage([turn({ timestamp: 1, usage }), turn({ sequence: 2, timestamp: 10, usage }), turn({ sequence: 3, timestamp: 11 })], 5);
    expect(got).toMatchObject({ total: 2, turnsWithUsage: 1, agentTurns: 2 });
  });
});
