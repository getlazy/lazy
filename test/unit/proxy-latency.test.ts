/**
 * Per-request latency: time to first byte, first token and last token, derived
 * by the usage tee, recorded on the audit record, rolled up by latencyReport —
 * and the upstream connection pool the proxy rides on.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import net from 'node:net';
import { teeUsageStream } from '../../src/proxy/usage';
import { createProxyServer } from '../../src/proxy/server';
import { latencyReport, percentiles, tokensPerSecond, summarizeByEndpointModel, formatErrors } from '../../src/proxy/latency';
import { describeUpstreamFailure } from '../../src/proxy/upstream-timeout';
import type { AuditSink } from '../../src/proxy/audit';
import type { ProxyAuditRecord } from '../../src/storage/types';

const enc = new TextEncoder();

/** Run a body of timed chunks through the tee on a fake clock; return the timing. */
async function teeTimes(chunks: Array<[number, string]>, wire: 'anthropic' | 'openai') {
  let clock = 0;
  const body = new ReadableStream<Uint8Array>({
    start(c) { for (const [, text] of chunks) c.enqueue(enc.encode(text)); c.close(); },
  });
  const arrivals = chunks.map(([at]) => at);
  let i = 0;
  const now = () => (clock = i < arrivals.length ? arrivals[i++] : clock + 1);
  // Each pull calls now() once for the chunk, then once more at finish.
  let result!: { first: number | null; ended: number };
  const stream = teeUsageStream(body, true, (_u, t) => { result = { first: t.firstContentAt, ended: t.endedAt }; }, wire, now);
  await new Response(stream).text();
  return result;
}

describe('stream timing (the usage tee)', () => {
  // INVARIANT: time-to-first-token is the first CONTENT event, not message_start or a keep-alive/ping. Counting those would report a provider's handshake as its speed.
  test('anthropic: first token is the first content_block_delta', async () => {
    const t = await teeTimes([
      [10, 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n'],
      [20, 'event: ping\ndata: {"type":"ping"}\n\n'],
      [30, 'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'],
      [400, 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n'],
      [900, 'data: {"type":"message_delta","usage":{"output_tokens":9}}\n\n'],
    ], 'anthropic');
    expect(t.first).toBe(400);
    expect(t.ended).toBeGreaterThanOrEqual(900);
  });

  test('openai chat: role-only and empty-content chunks do not count', async () => {
    const t = await teeTimes([
      [10, 'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n'],
      [250, 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'],
      [300, 'data: [DONE]\n\n'],
    ], 'openai');
    expect(t.first).toBe(250);
  });

  test('openai responses: first non-empty *.delta event', async () => {
    const t = await teeTimes([
      [10, 'data: {"type":"response.created","response":{}}\n\n'],
      [120, 'data: {"type":"response.output_text.delta","delta":"x"}\n\n'],
    ], 'openai');
    expect(t.first).toBe(120);
  });

  // INVARIANT: a cancelled stream is not a completed one. Its abort time must not enter the TTLT percentiles.
  test('a client cancel is reported as not completed', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc.encode('data: {"type":"ping"}\n\n')); },
    });
    let completed = null as boolean | null;
    const stream = teeUsageStream(body, true, (_u, t) => { completed = t.completed; });
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    expect(completed).toBe(false);
  });

  test('a stream with no content event has no first-token time', async () => {
    const t = await teeTimes([[10, 'data: {"type":"ping"}\n\n']], 'anthropic');
    expect(t.first).toBeNull();
  });
});

describe('latency rollup', () => {
  const rec = (over: Partial<ProxyAuditRecord>): ProxyAuditRecord => ({
    id: 'x', seq: 1, ts: 1, role: null, taskId: null, backend: 'proxy', upstream: 'http://u', method: 'POST',
    path: '/v1/messages', endpoint: 'messages', model: 'm', tier: 'sonnet', stream: true, requestShape: null,
    toolUses: [], toolResults: [], status: 200, usage: null, stopReason: null, error: null, durationMs: 100,
    reroute: null, ...over,
  });

  test('percentiles are nearest-rank', () => {
    expect(percentiles([])).toBeNull();
    expect(percentiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual({ n: 10, p50: 5, p90: 9 });
  });

  test('tokens/s is output tokens over the whole request (TTLT)', () => {
    const usage = { inputTokens: 1, outputTokens: 100, cacheCreationInputTokens: null, cacheReadInputTokens: null };
    expect(tokensPerSecond(rec({ usage, ttftMs: 500, ttltMs: 2000 }))).toBe(50);
    expect(tokensPerSecond(rec({ usage, ttftMs: null, ttltMs: 2000 }))).toBe(50);
    expect(tokensPerSecond(rec({ usage, ttltMs: null }))).toBeNull();
  });

  // INVARIANT: records without a measurement contribute nothing to that column. An old trail must not drag a percentile to zero.
  test('legacy and failed records do not skew percentiles', () => {
    const report = latencyReport([
      rec({ ttftMs: 200, ttltMs: 1000 }),
      rec({ ttftMs: 400, ttltMs: 3000 }),
      rec({}), // legacy: only durationMs
      rec({ status: null, error: 'down' }),
    ]);
    const g = report.byModel[0];
    expect(g.requests).toBe(3);
    expect(g.ttft).toEqual({ n: 2, p50: 200, p90: 400 });
    expect(g.ttlt).toEqual({ n: 2, p50: 1000, p90: 3000 });
    expect(g.ttfb?.n).toBe(3);
  });

  test('count_tokens, cursor and error responses are not counted as timed requests', () => {
    const report = latencyReport([
      rec({ ttftMs: 200, ttltMs: 1000 }),
      rec({ endpoint: 'count_tokens', model: null }),
      rec({ endpoint: 'cursor', model: null }),
      rec({ status: 429 }),
    ]);
    expect(report.byModel).toHaveLength(1);
    expect(report.byModel[0].requests).toBe(1);
  });
});

describe('through the proxy', () => {
  const stops: Array<() => void> = [];
  afterEach(() => { while (stops.length) stops.pop()!(); });

  test('each timing reflects a fake upstream with controlled delays', async () => {
    const upstream = Bun.serve({
      port: 0, hostname: '127.0.0.1',
      async fetch() {
        await Bun.sleep(150); // → response headers
        const body = new ReadableStream<Uint8Array>({
          async start(c) {
            c.enqueue(enc.encode('data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n'));
            await Bun.sleep(200); // → first token
            c.enqueue(enc.encode('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"a"}}\n\n'));
            await Bun.sleep(300); // → last token
            c.enqueue(enc.encode('data: {"type":"message_delta","usage":{"output_tokens":40}}\n\n'));
            c.close();
          },
        });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    stops.push(() => upstream.stop(true));
    const records: ProxyAuditRecord[] = [];
    const sink: AuditSink = { append: async (r) => { records.push(r); } };
    const proxy = createProxyServer(
      { port: 0, bind: '127.0.0.1', upstream: `http://127.0.0.1:${upstream.port}` }, sink, null,
    );
    stops.push(() => proxy.stop(true));

    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4', stream: true, messages: [] }),
    });
    await res.text();
    await Bun.sleep(100);

    const r = records.find((x) => x.endpoint === 'messages')!;
    expect(r.durationMs!).toBeGreaterThanOrEqual(140);
    expect(r.durationMs!).toBeLessThan(r.ttftMs!);
    expect(r.ttftMs!).toBeGreaterThanOrEqual(340);
    expect(r.ttftMs!).toBeLessThan(r.ttltMs!);
    expect(r.ttltMs! - r.ttftMs!).toBeGreaterThanOrEqual(280);
  });

  // INVARIANT: a response the tool-use policy buffers (every /v1/messages
  // request that declares tools, with enforcement on — the default) is timed
  // as its bytes ARRIVE: TTFB at the upstream's headers, TTFT at the first
  // content event. Timing it after the buffered read recorded the whole
  // request as TTFB and no TTFT for nearly every Claude turn.
  test('the buffered (policy-enforced) path times TTFB and TTFT as the bytes arrive', async () => {
    const upstream = Bun.serve({
      port: 0, hostname: '127.0.0.1',
      async fetch() {
        await Bun.sleep(150); // → response headers
        const body = new ReadableStream<Uint8Array>({
          async start(c) {
            c.enqueue(enc.encode('data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n'));
            await Bun.sleep(200); // → first token
            c.enqueue(enc.encode('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"a"}}\n\n'));
            await Bun.sleep(300); // → last token
            c.enqueue(enc.encode('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":40}}\n\n'));
            c.close();
          },
        });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    stops.push(() => upstream.stop(true));
    const records: ProxyAuditRecord[] = [];
    const sink: AuditSink = { append: async (r) => { records.push(r); } };
    const proxy = createProxyServer(
      { port: 0, bind: '127.0.0.1', upstream: `http://127.0.0.1:${upstream.port}` }, sink, null,
    );
    stops.push(() => proxy.stop(true));

    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4', stream: true, messages: [],
        tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object' } }],
      }),
    });
    const text = await res.text();
    expect(text).toContain('text_delta');
    await Bun.sleep(100);

    const r = records.find((x) => x.endpoint === 'messages')!;
    expect(r.requestShape?.numTools).toBe(1);
    expect(r.usage?.outputTokens).toBe(40);
    expect(r.durationMs!).toBeGreaterThanOrEqual(140);
    expect(r.durationMs!).toBeLessThan(300);
    expect(r.ttftMs).not.toBeNull();
    expect(r.ttftMs!).toBeGreaterThanOrEqual(340);
    expect(r.ttftMs!).toBeLessThan(r.ttltMs!);
    expect(r.ttltMs! - r.ttftMs!).toBeGreaterThanOrEqual(280);
  });

  // INVARIANT: the proxy's upstream client keeps connections alive and reuses them per host. A fresh TCP/TLS handshake per request would add a round trip to every call; docs/proxy-latency.md records the measurement.
  test('upstream connections are reused across sequential requests', async () => {
    const backend = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ type: 'message', usage: { input_tokens: 1, output_tokens: 1 } }) });
    stops.push(() => backend.stop(true));
    let connections = 0;
    const counter = net.createServer((c) => {
      connections++;
      const u = net.connect(backend.port!, '127.0.0.1');
      c.pipe(u); u.pipe(c);
      c.on('error', () => {}); u.on('error', () => {});
    }).listen(0, '127.0.0.1');
    stops.push(() => counter.close());
    const counterPort = (counter.address() as net.AddressInfo).port;
    const sink: AuditSink = { append: async () => {} };
    const proxy = createProxyServer(
      { port: 0, bind: '127.0.0.1', upstream: `http://127.0.0.1:${counterPort}` }, sink, null,
    );
    stops.push(() => proxy.stop(true));
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm', messages: [] }),
      });
      await res.text();
    }
    expect(connections).toBe(1);
  });
});

describe('summarizeByEndpointModel', () => {
  const rec = (extra: Partial<ProxyAuditRecord>): ProxyAuditRecord => ({
    id: 'x', seq: 1, ts: 1, role: 'agent', taskId: null, backend: 'proxy', upstream: 'https://u.example.com/v1',
    method: 'POST', path: '/v1/messages', endpoint: 'messages', model: 'm', tier: null, stream: true,
    requestShape: null, toolUses: [], toolResults: [], status: 200, usage: { inputTokens: 10, outputTokens: 100, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    stopReason: null, error: null, durationMs: 50, ttftMs: 100, ttltMs: 1100, reroute: null, enforcement: null,
    ...extra,
  } as ProxyAuditRecord);

  // INVARIANT: failures are counted and classified, never dropped, and never feed timing or token totals; the same model on two endpoints (or tiers) is two rows.
  test('classifies errors, splits by endpoint and tier, sums tokens from successes only', () => {
    const rows = summarizeByEndpointModel([
      rec({ servedByEndpoint: 'a' }),
      rec({ servedByEndpoint: 'a', status: 429, usage: null }),
      rec({ servedByEndpoint: 'a', status: 529, usage: null }),
      rec({ servedByEndpoint: 'a', status: 504, usage: null }),
      rec({ servedByEndpoint: 'a', status: null, usage: null, error: describeUpstreamFailure(Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }), 'https://u', 5) }),
      rec({ servedByEndpoint: 'a', status: null, usage: null, error: 'connection refused' }),
      rec({ servedByEndpoint: 'a', ttltMs: null }), // cancelled stream
      rec({ servedByEndpoint: 'a', ttltMs: undefined }), // legacy record: not a cancel
      rec({ servedByEndpoint: 'b' }),
      rec({ servedByEndpoint: 'b', tierIndex: 1, tierProfile: 'p' }),
      // Another profile on the same endpoint, model and tier position: its own row.
      rec({ servedByEndpoint: 'b', tierIndex: 1, tierProfile: 'q' }),
      // The model-family guess is not the profile's tier: it never splits a row.
      rec({ servedByEndpoint: 'b', tier: 'sonnet' }),
    ]);
    expect(rows.length).toBe(4);
    const a = rows.find((r) => r.endpoint === 'a')!;
    expect(a.requests).toBe(8);
    expect(a.errors).toEqual({ total: 6, rateLimited: 1, serverError: 2, timeout: 1, cancelled: 1, other: 1 });
    expect(a.inputTokens).toBe(20);
    expect(a.ttlt).toEqual({ n: 1, p50: 1100, p90: 1100 });
    const b = rows.filter((r) => r.endpoint === 'b');
    expect(b.map((r) => r.tierProfile ?? '-').sort()).toEqual(['-', 'p', 'q']);
    expect(b.find((r) => r.tierIndex === null)!.requests).toBe(2);
    expect(b.find((r) => r.tierProfile === 'q')!.key).toBe('b · m · q tier 2');
    expect(formatErrors(a.errors)).toBe('6 (429×1 5xx×2 timeout×1 cancelled×1 other×1)');
  });
});
