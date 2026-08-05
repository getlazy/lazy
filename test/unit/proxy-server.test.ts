/**
 * Integration tests for the passthrough proxy server.
 *
 * Starts the proxy with a mock upstream (in-process Bun.serve), sends
 * requests through it, and verifies:
 *   - Response is streamed through correctly
 *   - content-encoding / content-length are stripped
 *   - Audit records are written with correct fields
 *   - Lazy hint headers (x-lazy-role, x-lazy-task-id) are stripped before forwarding
 *   - Forward errors produce a 502 with a JSON error body
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createProxyServer } from '../../src/proxy/server';
import type { Storage } from '../../src/storage/interface';
import type { ProxyAuditRecord } from '../../src/storage/types';

// ---- Mock storage ----

function createMockStorage() {
  const records: ProxyAuditRecord[] = [];
  const storage = {
    appendAuditRecord: async (r: ProxyAuditRecord) => { records.push(r); },
    listAuditRecords: async () => records,
  } as unknown as Storage;
  return { storage, records };
}

// ---- Helpers ----

function findFreePort(): number {
  // Use a random port in 40000–49999 range
  return 40000 + Math.floor(Math.random() * 10000);
}

// ---- Tests ----

type ForwardedRequest = { headers: Record<string, string>; body: unknown };

describe('proxy server', () => {
  let mockUpstream: ReturnType<typeof Bun.serve>;
  let proxyServer: ReturnType<typeof Bun.serve>;
  let proxyPort: number;
  let upstreamPort: number;
  let mockStorage: ReturnType<typeof createMockStorage>;
  let lastForwardedRequest: ForwardedRequest | null = null;

  beforeAll(async () => {
    // Start a mock upstream that echoes requests back as JSON
    upstreamPort = findFreePort();
    mockUpstream = Bun.serve({
      port: upstreamPort,
      hostname: '127.0.0.1',
      async fetch(req) {
        const body = req.method !== 'GET' ? await req.json().catch(() => null) : null;
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => { headers[k] = v; });
        lastForwardedRequest = { headers, body };
        return Response.json({ type: 'message', model: body?.model ?? 'test', forwarded: true });
      },
    });

    proxyPort = findFreePort();
    mockStorage = createMockStorage();
    proxyServer = createProxyServer(
      { port: proxyPort, bind: '127.0.0.1', upstream: `http://127.0.0.1:${upstreamPort}` },
      mockStorage.storage,
    );

    // Give servers a moment to bind
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  afterAll(() => {
    mockUpstream.stop();
    proxyServer.stop();
  });

  test('forwards a POST request and returns the upstream response', async () => {
    const body = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 100,
    };
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(resp.status).toBe(200);
    const data = await resp.json() as Record<string, unknown>;
    expect(data.forwarded).toBe(true);
    expect(data.model).toBe('claude-sonnet-4-6');
  });

  test('strips x-lazy-role and x-lazy-task-id before forwarding', async () => {
    // Cast widens the assignment so TS doesn't narrow the variable's flow type
    // to the literal `null`, which otherwise makes the later `?.headers` access
    // resolve against `never` (a real tsc quirk, reproduced in isolation).
    lastForwardedRequest = null as ForwardedRequest | null;
    await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-lazy-role': 'agent',
        'x-lazy-task-id': 'task-abc123',
      },
      body: JSON.stringify({ messages: [], model: 'test' }),
    });
    expect(lastForwardedRequest?.headers['x-lazy-role']).toBeUndefined();
    expect(lastForwardedRequest?.headers['x-lazy-task-id']).toBeUndefined();
  });

  test('strips stale content-length from upstream response when it differs from actual body', async () => {
    // The proxy strips content-encoding and content-length from upstream responses.
    // The purpose: real Anthropic gzips its responses; Bun's fetch auto-decodes gzip, but
    // the original compressed-size content-length header would be wrong for the decoded body.
    // Stripping prevents clients from seeing a stale length. When Bun can infer the
    // correct length for small responses, it may re-add it — that is fine and correct.
    // What we verify here: when the upstream sends a WRONG content-length (stale/mismatched),
    // the proxy's stripping prevents forwarding it.
    const upstreamWithWrongLength = Bun.serve({
      port: findFreePort(),
      hostname: '127.0.0.1',
      async fetch() {
        const body = JSON.stringify({ ok: true });
        return new Response(body, {
          headers: {
            'content-type': 'application/json',
            'content-length': '99999', // deliberately wrong (stale compressed size)
          },
        });
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const up = (upstreamWithWrongLength as unknown as { port: number }).port;
    const ms = createMockStorage();
    const p = createProxyServer(
      { port: findFreePort(), bind: '127.0.0.1', upstream: `http://127.0.0.1:${up}` },
      ms.storage,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const pp = (p as unknown as { port: number }).port;
    const resp = await fetch(`http://127.0.0.1:${pp}/v1/messages`, {
      method: 'POST',
      body: '{}',
    });
    // The wrong "99999" content-length should NOT be forwarded to the client.
    // (Bun may or may not add the correct length for the actual body, but 99999 is gone.)
    expect(resp.headers.get('content-length')).not.toBe('99999');
    const data = await resp.json();
    expect((data as { ok: boolean }).ok).toBe(true);
    upstreamWithWrongLength.stop();
    p.stop();
  });

  test('writes an audit record for each request', async () => {
    const before = mockStorage.records.length;
    await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-lazy-role': 'builder',
        'x-lazy-task-id': 'audit-task',
      },
      body: JSON.stringify({ model: 'claude-opus-4-8', messages: [], max_tokens: 50 }),
    });
    // Give the async audit queue a moment to flush
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockStorage.records.length).toBeGreaterThan(before);
    const record = mockStorage.records[mockStorage.records.length - 1];
    expect(record.method).toBe('POST');
    expect(record.path).toBe('/v1/messages');
    expect(record.endpoint).toBe('messages');
    expect(record.model).toBe('claude-opus-4-8');
    expect(record.tier).toBe('opus');
    expect(record.role).toBe('builder');
    expect(record.taskId).toBe('audit-task');
    expect(record.status).toBe(200);
  });

  test('extracts tool_use blocks into the audit record', async () => {
    const before = mockStorage.records.length;
    const body = {
      model: 'claude-sonnet-4-6',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu-1', name: 'Read', input: { path: '/etc/hosts' } },
            { type: 'tool_use', id: 'tu-2', name: 'Bash', input: { command: 'ls -la' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu-1', content: '127.0.0.1 localhost' },
          ],
        },
      ],
    };
    await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const record = mockStorage.records[mockStorage.records.length - 1];
    expect(record.toolUses).toHaveLength(2);
    expect(record.toolUses[0]).toMatchObject({ name: 'Read', path: '/etc/hosts' });
    expect(record.toolUses[1]).toMatchObject({ name: 'Bash', command: 'ls -la' });
    expect(record.toolResults).toHaveLength(1);
    expect(record.toolResults[0].contentPreview).toBe('127.0.0.1 localhost');
  });

  test('returns 502 when upstream is unreachable', async () => {
    const badPort = findFreePort(); // nothing listening here
    const ms = createMockStorage();
    const badProxy = createProxyServer(
      { port: findFreePort(), bind: '127.0.0.1', upstream: `http://127.0.0.1:${badPort}` },
      ms.storage,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const pp = (badProxy as unknown as { port: number }).port;
    const resp = await fetch(`http://127.0.0.1:${pp}/v1/messages`, {
      method: 'POST',
      body: '{}',
    });
    expect(resp.status).toBe(502);
    const data = await resp.json() as { error?: { type?: string } };
    expect(data.error?.type).toBe('proxy_error');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ms.records.length).toBe(1);
    expect(ms.records[0].error).not.toBeNull();
    expect(ms.records[0].status).toBeNull();
    badProxy.stop();
  });
});

/** The OS-assigned port of a started Bun server (typed access to `.port`). */
function portOf(server: ReturnType<typeof Bun.serve>): number {
  return (server as unknown as { port: number }).port;
}

// ---- Smart routing / failover ----

/**
 * A controllable mock upstream: each instance decides its own response per
 * request via a handler. Records how many requests it saw and their bodies so
 * tests can assert whether a target was hit and with which model.
 */
function createControllableUpstream(
  handler: (req: { body: Record<string, unknown> | null; count: number }) => Response | Promise<Response>,
) {
  const requests: { body: Record<string, unknown> | null }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const body = req.method !== 'GET' ? (await req.json().catch(() => null)) : null;
      requests.push({ body });
      return handler({ body, count: requests.length });
    },
  });
  const port = portOf(server);
  return { server, requests, port, url: `http://127.0.0.1:${port}` };
}

async function waitForFlush(ms = 60) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('proxy smart routing (failover)', () => {
  test('429 with a fallback configured reroutes to the fallback and audits the reroute', async () => {
    const primary = createControllableUpstream(() =>
      Response.json({ type: 'error', error: { type: 'rate_limit_error' } }, { status: 429 }),
    );
    const fallback = createControllableUpstream(({ body }) =>
      Response.json({ type: 'message', ok: true, model: body?.model }),
    );
    const ms = createMockStorage();
    const proxy = createProxyServer(
      {
        port: 0,
        bind: '127.0.0.1',
        upstream: primary.url,
        fallbacks: [{ upstream: fallback.url, model: 'qwen-local' }],
      },
      ms.storage,
    );
    await waitForFlush(20);
    const pp = portOf(proxy);

    const resp = await fetch(`http://127.0.0.1:${pp}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-8', messages: [] }),
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { ok: boolean; model: string };
    expect(data.ok).toBe(true);
    // Fallback's model override was applied to the re-sent body.
    expect(data.model).toBe('qwen-local');
    expect(primary.requests.length).toBe(1);
    expect(fallback.requests.length).toBe(1);

    await waitForFlush();
    const record = ms.records[ms.records.length - 1];
    expect(record.status).toBe(200);
    expect(record.upstream).toBe(fallback.url);
    // Reroute metadata records original + fallback target/model and the trigger.
    expect(record.reroute).not.toBeNull();
    expect(record.reroute?.fromUpstream).toBe(primary.url);
    expect(record.reroute?.fromModel).toBe('claude-opus-4-8');
    expect(record.reroute?.toUpstream).toBe(fallback.url);
    expect(record.reroute?.toModel).toBe('qwen-local');
    expect(record.reroute?.trigger).toBe('429');
    expect(record.reroute?.attempts).toBe(2);

    proxy.stop();
    primary.server.stop();
    fallback.server.stop();
  });

  test('529 (overloaded) with a fallback reroutes', async () => {
    const primary = createControllableUpstream(() =>
      Response.json({ type: 'error', error: { type: 'overloaded_error' } }, { status: 529 }),
    );
    const fallback = createControllableUpstream(() => Response.json({ ok: true }));
    const ms = createMockStorage();
    const proxy = createProxyServer(
      { port: 0, bind: '127.0.0.1', upstream: primary.url, fallbacks: [{ upstream: fallback.url }] },
      ms.storage,
    );
    await waitForFlush(20);
    const pp = portOf(proxy);

    const resp = await fetch(`http://127.0.0.1:${pp}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-opus-4-8', messages: [] }),
    });
    expect(resp.status).toBe(200);
    await waitForFlush();
    const record = ms.records[ms.records.length - 1];
    expect(record.reroute?.trigger).toBe('529');
    // No model override on the fallback → original wire model preserved in audit.
    expect(record.reroute?.toModel).toBe('claude-opus-4-8');

    proxy.stop();
    primary.server.stop();
    fallback.server.stop();
  });

  // INVARIANT: No silent fallback. A 429 with NO fallback chain configured must
  // propagate the upstream error unchanged — the proxy never invents a failover
  // target or waits. This is the fail-hard behavior CLAUDE.md mandates; changing
  // it (e.g. auto-retrying or auto-routing) would violate the no-silent-fallback
  // rule and requires explicit human approval.
  test('429 WITHOUT a fallback propagates the error unchanged (no silent fallback)', async () => {
    const primary = createControllableUpstream(() =>
      Response.json({ type: 'error', error: { type: 'rate_limit_error' } }, { status: 429 }),
    );
    const ms = createMockStorage();
    const proxy = createProxyServer(
      { port: 0, bind: '127.0.0.1', upstream: primary.url },
      ms.storage,
    );
    await waitForFlush(20);
    const pp = portOf(proxy);

    const resp = await fetch(`http://127.0.0.1:${pp}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-opus-4-8', messages: [] }),
    });
    // The 429 is forwarded verbatim, not swallowed or rerouted.
    expect(resp.status).toBe(429);
    expect(primary.requests.length).toBe(1);
    await waitForFlush();
    const record = ms.records[ms.records.length - 1];
    expect(record.status).toBe(429);
    // No reroute occurred — the field is null.
    expect(record.reroute).toBeNull();
    expect(record.upstream).toBe(primary.url);

    proxy.stop();
    primary.server.stop();
  });

  test('unreachable primary with a fallback reroutes; audit trigger is "unreachable"', async () => {
    const deadPort = findFreePort(); // nothing listening
    const fallback = createControllableUpstream(() => Response.json({ ok: true }));
    const ms = createMockStorage();
    const proxy = createProxyServer(
      {
        port: 0,
        bind: '127.0.0.1',
        upstream: `http://127.0.0.1:${deadPort}`,
        fallbacks: [{ upstream: fallback.url }],
      },
      ms.storage,
    );
    await waitForFlush(20);
    const pp = portOf(proxy);

    const resp = await fetch(`http://127.0.0.1:${pp}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-opus-4-8', messages: [] }),
    });
    expect(resp.status).toBe(200);
    expect(fallback.requests.length).toBe(1);
    await waitForFlush();
    const record = ms.records[ms.records.length - 1];
    expect(record.reroute?.trigger).toBe('unreachable');
    expect(record.status).toBe(200);

    proxy.stop();
    fallback.server.stop();
  });

  test('all targets unreachable still yields a 502 with an error audit record', async () => {
    const deadA = findFreePort();
    const deadB = findFreePort();
    const ms = createMockStorage();
    const proxy = createProxyServer(
      {
        port: 0,
        bind: '127.0.0.1',
        upstream: `http://127.0.0.1:${deadA}`,
        fallbacks: [{ upstream: `http://127.0.0.1:${deadB}` }],
      },
      ms.storage,
    );
    await waitForFlush(20);
    const pp = portOf(proxy);

    const resp = await fetch(`http://127.0.0.1:${pp}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-opus-4-8', messages: [] }),
    });
    expect(resp.status).toBe(502);
    await waitForFlush();
    const record = ms.records[ms.records.length - 1];
    expect(record.status).toBeNull();
    expect(record.error).not.toBeNull();
    // A reroute WAS attempted (2 targets), so the reroute metadata is present.
    expect(record.reroute?.attempts).toBe(2);
    expect(record.reroute?.trigger).toBe('unreachable');

    proxy.stop();
  });

  test('429 with a short Retry-After waits and retries the primary before failing over', async () => {
    // Primary 429s on the first hit with Retry-After: 0 (below threshold), then
    // succeeds on the retry. The fallback must NEVER be hit — the primary
    // recovered within the wait window.
    const primary = createControllableUpstream(({ count }) => {
      if (count === 1) {
        return Response.json(
          { type: 'error', error: { type: 'rate_limit_error' } },
          { status: 429, headers: { 'retry-after': '0' } },
        );
      }
      return Response.json({ ok: true, recovered: true });
    });
    const fallback = createControllableUpstream(() => Response.json({ ok: true, fromFallback: true }));
    const ms = createMockStorage();
    const proxy = createProxyServer(
      {
        port: 0,
        bind: '127.0.0.1',
        upstream: primary.url,
        fallbacks: [{ upstream: fallback.url }],
        retryAfterThreshold: 5,
      },
      ms.storage,
    );
    await waitForFlush(20);
    const pp = portOf(proxy);

    const resp = await fetch(`http://127.0.0.1:${pp}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-opus-4-8', messages: [] }),
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { recovered?: boolean; fromFallback?: boolean };
    expect(data.recovered).toBe(true);
    expect(data.fromFallback).toBeUndefined();
    // Primary hit twice (429 then success); fallback untouched.
    expect(primary.requests.length).toBe(2);
    expect(fallback.requests.length).toBe(0);
    await waitForFlush();
    const record = ms.records[ms.records.length - 1];
    // Primary recovered → NOT a reroute.
    expect(record.reroute).toBeNull();
    expect(record.upstream).toBe(primary.url);

    proxy.stop();
    primary.server.stop();
    fallback.server.stop();
  });

  test('429 with a Retry-After above the threshold fails over immediately (no wait)', async () => {
    // Retry-After: 3600 is far above the threshold → the proxy must not wait; it
    // fails over to the fallback right away. Primary is hit exactly once.
    const primary = createControllableUpstream(() =>
      Response.json(
        { type: 'error', error: { type: 'rate_limit_error' } },
        { status: 429, headers: { 'retry-after': '3600' } },
      ),
    );
    const fallback = createControllableUpstream(() => Response.json({ ok: true, fromFallback: true }));
    const ms = createMockStorage();
    const proxy = createProxyServer(
      {
        port: 0,
        bind: '127.0.0.1',
        upstream: primary.url,
        fallbacks: [{ upstream: fallback.url }],
        retryAfterThreshold: 5,
      },
      ms.storage,
    );
    await waitForFlush(20);
    const pp = portOf(proxy);

    const resp = await fetch(`http://127.0.0.1:${pp}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-opus-4-8', messages: [] }),
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { fromFallback?: boolean };
    expect(data.fromFallback).toBe(true);
    // Primary hit once only — no wait/retry, straight to failover.
    expect(primary.requests.length).toBe(1);
    expect(fallback.requests.length).toBe(1);

    proxy.stop();
    primary.server.stop();
    fallback.server.stop();
  });

  // INVARIANT: A response that already began streaming successfully is never
  // rerouted mid-stream. Failover keys ONLY on the upstream status line; once a
  // 200 body starts flowing, an error partway through the stream is the client's
  // to see — silently swapping to a fallback mid-turn would corrupt the
  // conversation and hide the failure. Do not add mid-stream rerouting.
  test('a successful (200) response is streamed through and never rerouted even with a fallback set', async () => {
    let primaryHits = 0;
    const primary = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch() {
        primaryHits++;
        // Stream a couple of chunks then end — a normal successful turn.
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('event: message_start\n'));
            controller.enqueue(new TextEncoder().encode('data: {"ok":true}\n\n'));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const primaryUrl = `http://127.0.0.1:${portOf(primary)}`;
    const fallback = createControllableUpstream(() => Response.json({ ok: true, fromFallback: true }));
    const ms = createMockStorage();
    const proxy = createProxyServer(
      { port: 0, bind: '127.0.0.1', upstream: primaryUrl, fallbacks: [{ upstream: fallback.url }] },
      ms.storage,
    );
    await waitForFlush(20);
    const pp = portOf(proxy);

    const resp = await fetch(`http://127.0.0.1:${pp}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-opus-4-8', messages: [] }),
    });
    expect(resp.status).toBe(200);
    const text = await resp.text();
    expect(text).toContain('message_start');
    expect(primaryHits).toBe(1);
    // Fallback never touched; no reroute recorded.
    expect(fallback.requests.length).toBe(0);
    await waitForFlush();
    const record = ms.records[ms.records.length - 1];
    expect(record.reroute).toBeNull();

    proxy.stop();
    primary.stop();
    fallback.server.stop();
  });
});
