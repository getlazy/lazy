/**
 * Provider health — "is it the provider or is it us?" — folded from the proxy
 * audit records, rendered for the CLI and the dashboard.
 */
import { describe, test, expect } from 'bun:test';
import type { ProxyAuditRecord } from '../../src/storage/types';
import {
  ProviderHealthTracker,
  describeFailureCounts,
  summarizeProviderHealth,
} from '../../src/proxy/provider-health';
import { CLIENT_ABORT_MESSAGE } from '../../src/proxy/upstream-timeout';
import { renderProviderHealth } from '../../src/cli/commands/limits';
import { providerHealthBoxHtml } from '../../src/server/provider-health-box';

const NOW = 1_800_000_000_000;
let n = 0;
function rec(over: Partial<ProxyAuditRecord>): ProxyAuditRecord {
  n++;
  return {
    id: `r${n}`, seq: n, ts: NOW - 60_000, role: 'agent', taskId: 't', backend: 'proxy',
    upstream: 'https://api.anthropic.com', method: 'POST', path: '/v1/messages', endpoint: 'messages',
    model: 'm', tier: null, stream: true, requestShape: null, toolUses: [], toolResults: [],
    status: 200, usage: null, stopReason: null, error: null, durationMs: 10, reroute: null,
    ...over,
  };
}

describe('provider health summary', () => {
  test('counts requests and failures by kind per provider', () => {
    const rows = summarizeProviderHealth([
      rec({}),
      rec({ status: null, error: 'Anthropic … reset', failure: { kind: 'reset', code: 'ECONNRESET', afterMs: 2, provider: 'Anthropic', replayed: true } }),
      rec({ status: 529 }),
      rec({ status: 429 }),
      rec({ status: 503 }),
      rec({ status: null, error: 'no response from x within 30s', failure: { kind: 'timeout', code: 'ETIMEDOUT', afterMs: 30000, provider: 'Anthropic', replayed: false } }),
      rec({ upstream: 'https://chatgpt.com/backend-api/codex', status: 200 }),
      rec({ upstream: 'https://api2.cursor.sh', backend: 'cursor', status: null, error: 'Cursor … refused', failure: { kind: 'refused', code: 'ECONNREFUSED', afterMs: 1, provider: 'Cursor', replayed: false } }),
    ], NOW);
    const anthropic = rows.find((r) => r.provider === 'Anthropic')!;
    expect(anthropic.requests).toBe(6);
    expect(anthropic.failures).toMatchObject({ reset: 1, timeout: 1, overloaded: 1, rate_limited: 1, server_error: 1 });
    expect(anthropic.lastFailureAt).toBe(NOW - 60_000);
    expect(rows.find((r) => r.provider === 'OpenAI')!.requests).toBe(1);
    expect(rows.find((r) => r.provider === 'Cursor')!.failures.connect).toBe(1);
    expect(rows[0]!.provider).toBe('Anthropic'); // most failures first
  });

  // INVARIANT: lazy's own refusals and a client that hung up are never counted
  // against a provider — that would blame the wrong party.
  test("lazy's refusals and client aborts are not provider failures", () => {
    const rows = summarizeProviderHealth([
      rec({ status: 401, error: 'no credential', refusedCredential: { key: 'k', userId: null, profile: null } }),
      rec({ status: 401, authDenial: 'unknown_session_token', error: 'x' }),
      rec({ status: null, error: CLIENT_ABORT_MESSAGE }),
    ], NOW);
    expect(rows).toEqual([]);
  });

  // INVARIANT: lazy's own answers that carry a provider-like status are not
  // the provider's failures: a transient credential 503, "every tier full" 429,
  // a path refusal 403. A real tier refusal from the upstream still counts.
  test("lazy's own status-bearing refusals are not counted", () => {
    const rows = summarizeProviderHealth([
      rec({ status: 503, error: 'credential unavailable: token refresh timed out' }),
      rec({ status: 429, error: 'every tier full: every tier of agent profile "x" is full' }),
      rec({ status: 403, error: 'path refused: /v1/files' }),
    ], NOW);
    expect(rows).toEqual([]);
    const [row] = summarizeProviderHealth([rec({ status: 429, error: 'tier refused: tier 1 refused for capacity' })], NOW);
    expect(row!.failures.rate_limited).toBe(1);
  });

  test('a provider failure after the response started is counted even with a 200 status', () => {
    const [row] = summarizeProviderHealth([
      rec({ status: 200, error: 'x', failure: { kind: 'reset', code: 'ECONNRESET', afterMs: 900, provider: 'Anthropic', replayed: false, midResponse: true } }),
    ], NOW);
    expect(row!.failures.reset).toBe(1);
  });

  // INVARIANT: one named endpoint's successes and failures are ONE row.
  test('a named endpoint groups successes and failures under its name', () => {
    const at = { upstream: 'http://gpu:11434', endpointName: 'ollama-local' };
    const rows = summarizeProviderHealth([
      rec(at),
      rec({ ...at, status: null, error: 'refused', failure: { kind: 'refused', code: 'ECONNREFUSED', afterMs: 1, provider: 'gpu', replayed: false } }),
    ], NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: 'endpoint ollama-local', requests: 2 });
  });

  // INVARIANT: memory is bounded by the window even when nobody reads it.
  test('observing alone keeps the window bounded', () => {
    const t = new ProviderHealthTracker();
    for (let i = 0; i < 500; i++) t.observe(rec({ ts: NOW + i * 60_000 }), NOW + i * 60_000);
    expect(t.size).toBeLessThanOrEqual(61);
  });

  test('a record without the structured cause is classified from its text', () => {
    const [row] = summarizeProviderHealth([
      rec({ status: null, error: 'ECONNRESET: The socket connection was closed unexpectedly.' }),
    ], NOW);
    expect(row!.failures.reset).toBe(1);
  });

  test('the window is an hour and a record is folded once', () => {
    const t = new ProviderHealthTracker();
    const old = rec({ ts: NOW - 2 * 3600_000, status: 529 });
    const fresh = rec({ status: 529 });
    t.observe(old, NOW);
    t.observe(fresh, NOW);
    t.observe(fresh, NOW);
    expect(t.summary(NOW)[0]!.requests).toBe(1);
    expect(t.summary(NOW + 3600_000)).toEqual([]);
  });
});

describe('provider health rendering', () => {
  const rows = summarizeProviderHealth([rec({}), rec({ status: 529, error: 'upstream: overloaded_error: Overloaded' })], NOW);

  test('CLI names the provider, counts and the last failure', () => {
    const text = renderProviderHealth(rows, NOW).join('\n');
    expect(text).toContain('Model providers, last hour');
    expect(text).toContain('Anthropic (api.anthropic.com)');
    expect(text).toContain('2 requests');
    expect(text).toContain('1 529 overloaded');
    expect(text).toContain('last failure 1 min ago');
    expect(describeFailureCounts(rows[0]!)).toBe('1 529 overloaded');
  });

  test('dashboard box renders one row per provider', () => {
    const html = providerHealthBoxHtml(rows, NOW);
    expect(html).toContain('id="provider-health"');
    expect(html).toContain('data-provider="Anthropic"');
    expect(html).toContain('overloaded_error');
    expect(providerHealthBoxHtml([], NOW)).toBe('');
  });
});
