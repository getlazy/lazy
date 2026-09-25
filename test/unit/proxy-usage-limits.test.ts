/**
 * Usage-limit capture: the proxy records allowlisted rate-limit / utilization
 * response headers per credential, and the daemon keeps the latest reading.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createProxyServer, type ProxyCredentialDeps } from '../../src/proxy/server';
import { TargetCredentials, anthropicPlacement } from '../../src/proxy/target-credentials';
import type { CredentialGrant } from '../../src/proxy/credential-broker';
import type { AuditSink } from '../../src/proxy/audit';
import type { ProxyAuditRecord } from '../../src/storage/types';
import {
  captureUsageLimitHeaders,
  foldUsageLimits,
  usageLimitCredentialKey,
  usageWindows,
  UsageLimitTracker,
} from '../../src/proxy/usage-limits';

const UNIFIED = {
  'anthropic-ratelimit-unified-status': 'allowed_warning',
  'anthropic-ratelimit-unified-5h-utilization': '0.912',
  'anthropic-ratelimit-unified-5h-reset': '1790000000',
  'anthropic-ratelimit-unified-5h-status': 'allowed_warning',
  'anthropic-ratelimit-unified-7d-utilization': '0.3',
  'anthropic-ratelimit-unified-7d-reset': '1790500000',
  'anthropic-ratelimit-unified-7d-status': 'allowed',
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
};

describe('captureUsageLimitHeaders', () => {
  // INVARIANT: only allowlisted header NAMES are recorded, and no value that
  // looks like a secret. Responses carry cookies and org/request ids; the
  // audit log is pasted into bug reports.
  test('records only allowlisted names, never cookies, ids or secret-looking values', () => {
    const h = new Headers({
      ...UNIFIED,
      'Retry-After': '30',
      'x-ratelimit-remaining-tokens': '1000',
      'set-cookie': 'session=abc',
      'request-id': 'req_0123456789',
      'anthropic-organization-id': 'org-uuid',
      'cf-ray': '8a1b2c',
      'content-type': 'application/json',
      // Allowlisted names carrying secret-shaped values are refused too.
      'anthropic-ratelimit-bogus': 'sk-ant-oat01-' + 'A'.repeat(60),
      'x-ratelimit-jwt': 'eyJhbGciOi.eyJzdWIi.sig',
      'x-codex-long': '1'.repeat(200),
    });
    const got = captureUsageLimitHeaders(h)!;
    expect(Object.keys(got).sort()).toEqual(
      [...Object.keys(UNIFIED), 'retry-after', 'x-ratelimit-remaining-tokens'].sort(),
    );
    expect(got['retry-after']).toBe('30');
    expect(JSON.stringify(got)).not.toMatch(/sk-ant|eyJ|session|org-uuid|req_/);
  });

  test('null when the response carries no usage-limit headers', () => {
    expect(captureUsageLimitHeaders(new Headers({ 'content-type': 'text/plain' }))).toBeNull();
  });

  test('credential keys never carry the secret', () => {
    expect(usageLimitCredentialKey({ userId: 'u1', credentialLabel: 'X', upstream: 'https://a' })).toBe('user:u1');
    expect(usageLimitCredentialKey({ credentialLabel: 'CLAUDE_CODE_OAUTH_TOKEN', upstream: 'https://a' }))
      .toBe('credential:CLAUDE_CODE_OAUTH_TOKEN');
    expect(usageLimitCredentialKey({ upstream: 'https://api.anthropic.com/v1' })).toBe('upstream:https://api.anthropic.com');
  });
});

describe('usageWindows', () => {
  test('subscription windows become percent used plus reset', () => {
    const w = usageWindows(UNIFIED, 0);
    expect(w).toEqual([
      // The overall status is a window of its own, with no percentage (see below).
      { name: 'unified', usedPercent: null, resetsAt: null, status: 'allowed_warning' },
      { name: 'unified-5h', usedPercent: 91.2, resetsAt: 1790000000_000, status: 'allowed_warning' },
      { name: 'unified-7d', usedPercent: 30, resetsAt: 1790500000_000, status: 'allowed' },
    ]);
  });

  // INVARIANT: a subscription STATUS that comes without a utilization header —
  // per window, or the overall `unified-status` — still becomes a window, so
  // a `rejected` pauses even when no percentage came with it. The overage
  // status is not a usage window: `rejected` there only means paid overage is
  // off, and must never pause anything.
  test('a status with no utilization is a window of its own; overage status is not', () => {
    const w = usageWindows({
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-reset': '1790000000',
      'anthropic-ratelimit-unified-7d-status': 'rejected',
      'anthropic-ratelimit-unified-overage-status': 'rejected',
    }, 0);
    expect(w).toEqual([
      { name: 'unified', usedPercent: null, resetsAt: 1790000000_000, status: 'rejected' },
      { name: 'unified-7d', usedPercent: null, resetsAt: null, status: 'rejected' },
    ]);
  });

  test('api-key limit/remaining pairs become percent used', () => {
    const w = usageWindows({
      'anthropic-ratelimit-tokens-limit': '1000',
      'anthropic-ratelimit-tokens-remaining': '250',
      'anthropic-ratelimit-tokens-reset': '2026-09-23T10:00:00Z',
    }, 0);
    expect(w).toEqual([{ name: 'tokens', usedPercent: 75, resetsAt: Date.parse('2026-09-23T10:00:00Z'), status: null }]);
  });
});

function rec(over: Partial<ProxyAuditRecord>): ProxyAuditRecord {
  return {
    id: 'x', seq: 1, ts: 1, role: null, taskId: null, backend: 'proxy', upstream: 'https://api.anthropic.com',
    method: 'POST', path: '/v1/messages', endpoint: 'messages', model: null, tier: null, stream: null,
    requestShape: null, toolUses: [], toolResults: [], status: 200, usage: null, stopReason: null,
    error: null, durationMs: 1, reroute: null, enforcement: null, ...over,
  };
}

describe('UsageLimitTracker', () => {
  // INVARIANT: one latest reading per credential; an older record (e.g. seeded
  // from the log after live traffic) never overwrites a newer one.
  test('keeps the latest reading per credential', () => {
    const t = new UsageLimitTracker();
    t.observe(rec({ ts: 10, credential: 'credential:A', usageLimitHeaders: { 'retry-after': '1' } }));
    t.observe(rec({ ts: 30, credential: 'credential:A', usageLimitHeaders: { 'retry-after': '3' } }));
    t.observe(rec({ ts: 20, credential: 'credential:A', usageLimitHeaders: { 'retry-after': '2' } }));
    t.observe(rec({ ts: 5, credential: 'user:bob', usageLimitHeaders: { 'retry-after': '9' } }));
    t.observe(rec({ ts: 99, credential: 'user:bob', usageLimitHeaders: null }));
    const r = t.readings();
    expect(r.map((x) => [x.credential, x.headers['retry-after']])).toEqual([
      ['credential:A', '3'],
      ['user:bob', '9'],
    ]);
  });

  test('fold over pre-capture records yields nothing', () => {
    expect(foldUsageLimits([rec({})])).toEqual([]);
  });
});

describe('proxy capture (fake upstream)', () => {
  let upstream: ReturnType<typeof Bun.serve>;
  let proxy: ReturnType<typeof createProxyServer>;
  const records: ProxyAuditRecord[] = [];
  const tracker = new UsageLimitTracker();
  let proxyPort = 0;

  beforeAll(() => {
    upstream = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const body = (await req.json()) as { stream?: boolean; model?: string };
        if (body.model === 'limited') {
          return Response.json(
            { type: 'error', error: { type: 'rate_limit_error', message: 'x' } },
            { status: 429, headers: { 'retry-after': '120', 'anthropic-ratelimit-unified-status': 'rejected', 'set-cookie': 'a=b' } },
          );
        }
        if (body.model === 'early') {
          // Headers now, body held open: the audit record (written when the
          // stream drains) cannot exist while this test looks.
          const stream = new ReadableStream({
            async start(c) {
              c.enqueue(new TextEncoder().encode(': open\n\n'));
              await new Promise((r) => setTimeout(r, 300));
              c.close();
            },
          });
          return new Response(stream, { headers: { 'content-type': 'text/event-stream', ...UNIFIED } });
        }
        const sse =
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":0}}}\n\n' +
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n' +
          'event: message_stop\ndata: {"type":"message_stop"}\n\n';
        return new Response(sse, { headers: { 'content-type': 'text/event-stream', 'set-cookie': 's=1', ...UNIFIED } });
      },
    });
    const sink: AuditSink = { append: async (r) => { records.push(r); } };
    proxy = createProxyServer(
      { port: 0, bind: '127.0.0.1', upstream: `http://127.0.0.1:${upstream.port}` },
      sink,
      null,
      { usageLimits: tracker },
    );
    proxyPort = proxy.port!;
  });

  afterAll(() => {
    upstream.stop(true);
    void proxy.stop(true);
  });

  async function send(model: string, stream: boolean): Promise<Response> {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream, max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
    });
    await res.text();
    await new Promise((r) => setTimeout(r, 30));
    return res;
  }

  test('a streamed response updates the live view before its body is read', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'early', stream: true, max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
    });
    // Headers are in; the body has not been consumed, so the audit record
    // (enqueued when the stream drains) cannot exist yet.
    expect(records.find((r) => r.model === 'early')).toBeUndefined();
    expect(tracker.readings().find((r) => r.model === 'early')).toBeDefined();
    await res.text();
  });

  test('a streamed response records its usage-limit headers', async () => {
    await send('claude-sonnet', true);
    const r = records.at(-1)!;
    expect(r.usageLimitHeaders).toEqual(Object.fromEntries(Object.entries(UNIFIED).sort()));
    expect(r.credential).toMatch(/^upstream:http:\/\/127\.0\.0\.1:/);
    expect(JSON.stringify(r.usageLimitHeaders)).not.toContain('s=1');
    const reading = tracker.readings()[0];
    expect(reading.windows.find((w) => w.name === 'unified-5h')?.usedPercent).toBe(91.2);
  });

  test('a 429 records retry-after and becomes the latest reading', async () => {
    const res = await send('limited', false);
    expect(res.status).toBe(429);
    const r = records.at(-1)!;
    expect(r.status).toBe(429);
    expect(r.usageLimitHeaders).toEqual({ 'anthropic-ratelimit-unified-status': 'rejected', 'retry-after': '120' });
    const latest = tracker.readings();
    expect(latest).toHaveLength(1);
    expect(latest[0].status).toBe(429);
  });
});

const PLACEHOLDER = 'sk-ant-api03-lazy-usage-placeholder';
const PRIMARY_SECRET = 'sk-ant-oat01-PRIMARY-REAL-SECRET';
const FALLBACK_SECRET = 'sk-ant-api03-FALLBACK-REAL-SECRET';
const CURSOR_PLACEHOLDER = 'key_lazy_usagegrant';
const CURSOR_SECRET = 'key_real_cursor_usage_secret';

function grant(token: string, envKey: string): CredentialGrant {
  return { token, role: 'agent', taskId: 'task-7', label: 'lazy-task-7', envKey, createdAt: new Date(0).toISOString() };
}

describe('proxy capture with injected credentials', () => {
  let primary: ReturnType<typeof Bun.serve>;
  let fallback: ReturnType<typeof Bun.serve>;
  let cursor: ReturnType<typeof Bun.serve>;
  let proxy: ReturnType<typeof createProxyServer>;
  const records: ProxyAuditRecord[] = [];
  const tracker = new UsageLimitTracker();
  let primaryStatus = 200;

  beforeAll(() => {
    primary = Bun.serve({
      port: 0, hostname: '127.0.0.1',
      fetch() {
        if (primaryStatus === 429) {
          return new Response('limited', {
            status: 429,
            headers: { 'anthropic-ratelimit-unified-status': 'rejected', 'retry-after': '3600' },
          });
        }
        return Response.json({ type: 'message' }, {
          headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.5' },
        });
      },
    });
    fallback = Bun.serve({
      port: 0, hostname: '127.0.0.1',
      fetch: () => Response.json({ type: 'message' }, { headers: { 'anthropic-ratelimit-tokens-remaining': '10' } }),
    });
    cursor = Bun.serve({
      port: 0, hostname: '127.0.0.1',
      fetch: () => new Response('slow down', { status: 429, headers: { 'retry-after': '42', 'set-cookie': 'c=1' } }),
    });
    const primaryUrl = `http://127.0.0.1:${primary.port}`;
    const fallbackUrl = `http://127.0.0.1:${fallback.port}`;
    const cursorUrl = `http://127.0.0.1:${cursor.port}`;
    const targets = new TargetCredentials();
    targets.set(primaryUrl, async () => ({
      kind: 'credential', placement: anthropicPlacement('CLAUDE_CODE_OAUTH_TOKEN', PRIMARY_SECRET), label: 'CLAUDE_CODE_OAUTH_TOKEN',
    }));
    targets.set(fallbackUrl, async () => ({
      kind: 'credential', placement: anthropicPlacement('ANTHROPIC_API_KEY', FALLBACK_SECRET), label: 'ANTHROPIC_API_KEY',
    }));
    targets.set(cursorUrl, async () => ({
      kind: 'credential', placement: { kind: 'in-place', value: CURSOR_SECRET }, label: 'CURSOR_API_KEY',
    }));
    const credentials: ProxyCredentialDeps = {
      lookup: async (t) =>
        t === PLACEHOLDER ? grant(PLACEHOLDER, 'ANTHROPIC_API_KEY')
          : t === CURSOR_PLACEHOLDER ? grant(CURSOR_PLACEHOLDER, 'CURSOR_API_KEY') : null,
      targets,
    };
    proxy = createProxyServer(
      {
        port: 0, bind: '127.0.0.1', upstream: primaryUrl,
        fallbacks: [{ upstream: fallbackUrl }], retryAfterThreshold: 0, cursorUpstream: cursorUrl,
      },
      { append: async (r) => { records.push(r); } },
      credentials,
      { usageLimits: tracker },
    );
  });

  afterAll(() => {
    primary.stop(true);
    fallback.stop(true);
    cursor.stop(true);
    void proxy.stop(true);
  });

  async function send(): Promise<Response> {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': PLACEHOLDER },
      body: JSON.stringify({ model: 'claude-opus', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
    });
    await res.text();
    await new Promise((r) => setTimeout(r, 30));
    return res;
  }

  // INVARIANT: a reading is keyed by the credential's LABEL, never by the
  // secret lazy injected nor the placeholder the agent presented.
  test('keys an injected credential by its label, never the secret or placeholder', async () => {
    primaryStatus = 200;
    await send();
    const r = records.at(-1)!;
    expect(r.credential).toBe('credential:CLAUDE_CODE_OAUTH_TOKEN');
    const text = JSON.stringify(records) + JSON.stringify(tracker.readings());
    for (const secret of [PRIMARY_SECRET, FALLBACK_SECRET, PLACEHOLDER]) expect(text).not.toContain(secret);
  });

  // INVARIANT: the primary's 429 that triggers a failover is the "limit
  // reached" signal; it must be recorded even though the response is discarded.
  test('a failover keeps the primary 429 reading under the primary credential', async () => {
    primaryStatus = 429;
    const res = await send();
    expect(res.status).toBe(200);
    const r = records.at(-1)!;
    expect(r.credential).toBe('credential:ANTHROPIC_API_KEY');
    expect(r.reroute?.fromCredential).toBe('credential:CLAUDE_CODE_OAUTH_TOKEN');
    expect(r.reroute?.fromStatus).toBe(429);
    expect(r.reroute?.fromUsageLimitHeaders).toEqual({
      'anthropic-ratelimit-unified-status': 'rejected', 'retry-after': '3600',
    });
    const primaryReading = tracker.readings().find((x) => x.credential === 'credential:CLAUDE_CODE_OAUTH_TOKEN')!;
    expect(primaryReading.status).toBe(429);
    // And a restart's seed from the audit log reproduces it.
    const seeded = foldUsageLimits(records).find((x) => x.credential === 'credential:CLAUDE_CODE_OAUTH_TOKEN')!;
    expect(seeded.headers['retry-after']).toBe('3600');
  });

  test('the cursor route records its usage-limit headers under the cursor credential', async () => {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/_lazy/cursor/${CURSOR_PLACEHOLDER}/v1/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(429);
    await res.text();
    await new Promise((r) => setTimeout(r, 30));
    const r = records.at(-1)!;
    expect(r.backend).toBe('cursor');
    expect(r.credential).toBe('credential:CURSOR_API_KEY');
    expect(r.usageLimitHeaders).toEqual({ 'retry-after': '42' });
    expect(JSON.stringify(r)).not.toContain(CURSOR_SECRET);
  });
});

describe('usageLimits RPC', () => {
  // INVARIANT: the readings name every member's credential and utilization, so
  // a member's user token is refused — control plane only, like
  // listUserCredentials. The check precedes any config/log read.
  test('refuses a user token', async () => {
    const { handleUsageLimits } = await import('../../src/daemon/rpc-handlers');
    await expect(
      handleUsageLimits('/nonexistent', { kind: 'user', email: 'm@example.com' } as never),
    ).rejects.toThrow(/usageLimits is a control-plane operation/);
  });
});
