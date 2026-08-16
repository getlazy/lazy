/**
 * Filter and projection semantics for the proxy audit trail.
 *
 * These live in a pure module (`src/proxy/audit-query.ts`) precisely so the CLI
 * and the dashboard cannot end up with two different answers to "was this
 * request denied?" — so the predicates are pinned here, not only through the
 * rendered CLI output.
 */
import { describe, test, expect } from 'bun:test';
import {
  filterAuditRecords,
  resolveAuditRecord,
  toAuditRow,
  denialsOf,
  isFailure,
} from '../../src/proxy/audit-query';
import type { ProxyAuditRecord } from '../../src/storage/types';

function record(over: Partial<ProxyAuditRecord> = {}): ProxyAuditRecord {
  return {
    id: 'aaaaaaaa-0000-0000-0000-000000000000',
    seq: 1,
    ts: 1_000,
    role: 'agent',
    taskId: 'task-alpha',
    backend: 'proxy',
    upstream: 'https://api.anthropic.com',
    method: 'POST',
    path: '/v1/messages',
    endpoint: 'messages',
    model: 'claude-opus-5',
    tier: 'opus',
    stream: true,
    requestShape: null,
    toolUses: [],
    toolResults: [],
    status: 200,
    usage: null,
    stopReason: 'end_turn',
    error: null,
    durationMs: 100,
    reroute: null,
    enforcement: null,
    ...over,
  };
}

const DENIAL = {
  toolUseId: 'tu_1',
  name: 'mcp__claude_ai_gmail_search',
  rule: 'connector-deny-default',
  reason: 'inherited claude.ai connectors are denied by default',
};

describe('audit-query filters', () => {
  test('--since keeps records at or after the cutoff', () => {
    const records = [record({ ts: 100 }), record({ ts: 200 }), record({ ts: 300 })];
    expect(filterAuditRecords(records, { sinceMs: 200 }).map((r) => r.ts)).toEqual([200, 300]);
  });

  test('--role matches exactly but --task matches by prefix', () => {
    const records = [
      record({ role: 'agent', taskId: 'task-alpha' }),
      record({ role: 'builder', taskId: null }),
      record({ role: 'agent', taskId: 'task-beta' }),
    ];
    expect(filterAuditRecords(records, { role: 'agent' })).toHaveLength(2);
    // Exact, not prefix: 'age' must not match 'agent', or --role becomes a
    // guessing game where a typo silently returns plausible-looking data.
    expect(filterAuditRecords(records, { role: 'age' })).toHaveLength(0);
    expect(filterAuditRecords(records, { taskId: 'task-al' })).toHaveLength(1);
  });

  test('--model is a case-insensitive substring match', () => {
    const records = [record({ model: 'claude-opus-5' }), record({ model: 'claude-haiku-4-5' })];
    expect(filterAuditRecords(records, { model: 'OPUS' })).toHaveLength(1);
  });

  test('--denied selects records the policy engine acted on', () => {
    const records = [
      record({ enforcement: null }),
      record({ enforcement: [] }),
      record({ enforcement: [DENIAL] }),
    ];
    expect(filterAuditRecords(records, { denied: true })).toHaveLength(1);
    // INVARIANT: an absent `enforcement` field and an empty array both mean
    // "nothing was denied". Records predate the enforcement field, so the
    // undefined case must not be mistaken for a denial.
    expect(denialsOf(record({ enforcement: undefined }))).toEqual([]);
  });

  test('--reroutes selects failovers only', () => {
    const rerouted = record({
      reroute: {
        fromUpstream: 'https://api.anthropic.com',
        fromModel: 'claude-opus-5',
        toUpstream: 'https://fallback.example',
        toModel: 'claude-sonnet-5',
        trigger: '429',
        attempts: 2,
      },
    });
    expect(filterAuditRecords([record(), rerouted], { reroutes: true })).toHaveLength(1);
  });

  // INVARIANT: a request fails in two distinct ways and both count. A proxy
  // error leaves `status` null, while an upstream rejection leaves `error` null
  // and sets a 4xx/5xx — checking only one of the two hides half the failures,
  // including the expired-credential 401s `lazy doctor` reads from this trail.
  test('--errors covers both proxy-side errors and non-2xx upstream statuses', () => {
    const proxyError = record({ status: null, error: 'upstream unreachable' });
    const upstream401 = record({ status: 401, error: null });
    const ok = record({ status: 200, error: null });
    expect(isFailure(proxyError)).toBe(true);
    expect(isFailure(upstream401)).toBe(true);
    expect(isFailure(ok)).toBe(false);
    expect(filterAuditRecords([proxyError, upstream401, ok], { errors: true })).toHaveLength(2);
  });

  test('filters combine with AND', () => {
    const records = [
      record({ role: 'agent', enforcement: [DENIAL] }),
      record({ role: 'builder', enforcement: [DENIAL] }),
      record({ role: 'agent', enforcement: null }),
    ];
    expect(filterAuditRecords(records, { role: 'agent', denied: true })).toHaveLength(1);
  });

  test('no filters returns everything in chronological input order', () => {
    const records = [record({ ts: 3 }), record({ ts: 1 }), record({ ts: 2 })];
    expect(filterAuditRecords(records).map((r) => r.ts)).toEqual([3, 1, 2]);
  });
});

describe('resolveAuditRecord', () => {
  const records = [
    record({ id: 'abc11111-0000-0000-0000-000000000000' }),
    record({ id: 'abc22222-0000-0000-0000-000000000000' }),
    record({ id: 'def33333-0000-0000-0000-000000000000' }),
  ];

  test('resolves a unique prefix', () => {
    expect(resolveAuditRecord(records, 'abc11').record?.id).toStartWith('abc11');
  });

  test('reports ambiguity instead of picking the first match', () => {
    const res = resolveAuditRecord(records, 'abc');
    expect(res.record).toBeNull();
    expect(res.matches).toBe(2);
  });

  test('reports a miss', () => {
    expect(resolveAuditRecord(records, 'zzz')).toEqual({ record: null, matches: 0 });
  });
});

describe('toAuditRow', () => {
  test('sums all four token counters, and reports null when usage was not captured', () => {
    const withUsage = toAuditRow(
      record({
        usage: {
          inputTokens: 10,
          outputTokens: 1,
          cacheCreationInputTokens: 100,
          cacheReadInputTokens: 1000,
        },
      }),
    );
    // Cache tokens are real tokens — the row total must not quietly drop them.
    expect(withUsage.totalTokens).toBe(1111);
    expect(toAuditRow(record({ usage: null })).totalTokens).toBeNull();
  });

  test('carries the markers a listing needs without re-deriving them', () => {
    const row = toAuditRow(record({ enforcement: [DENIAL], status: 500 }));
    expect(row.denials).toBe(1);
    expect(row.failed).toBe(true);
    expect(row.rerouted).toBe(false);
  });
});
