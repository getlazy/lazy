/**
 * A SLOW upstream must not be reaped, and must not be reported as a broken one.
 *
 * Provenance: on 2026-09-16 every Pi turn on a local Ollama died four to six
 * minutes in with `502 proxy_error "The operation timed out."`, and the turn
 * record said only that the agent crashed. Two independent timers were in play,
 * both verified against Bun 1.4.2 while fixing it:
 *
 *  1. Bun's `fetch` carries a DEFAULT timeout lazy never chose (it fired at
 *     ~360s here, 255–298s in the incident). That is what actually killed those
 *     turns — the proxy turned the rejection into its ordinary "upstream
 *     unreachable" 502. lazy now sets `timeout: false` plus its own configurable
 *     `AbortSignal`, so the ceiling is one lazy picked and names.
 *  2. `Bun.serve`'s `idleTimeout` reaps a connection whose RESPONSE BODY has
 *     written nothing for that long — capped at 255s, so no number fixes it.
 *     Keep-alive SSE comment frames fix it instead.
 *
 * Timings here are small on purpose (an `idleTimeout` of 5s, keep-alives every
 * 150ms) — but never below 5s for `idleTimeout`, which degenerates into a hard
 * ~4s request deadline at 2–4.
 */

import { describe, test, expect } from 'bun:test';
import { createProxyServer } from '../../src/proxy/server';
import type { AuditSink } from '../../src/proxy/audit';
import type { ProxyAuditRecord } from '../../src/storage/types';
import { withSseKeepAlive, isSseContentType } from '../../src/proxy/keepalive';
import {
  describeUpstreamFailure,
  isUpstreamTimeout,
  upstreamFetchOptions,
} from '../../src/proxy/upstream-timeout';

function collectingSink(): { sink: AuditSink; records: ProxyAuditRecord[] } {
  const records: ProxyAuditRecord[] = [];
  return { sink: { append: async (r) => { records.push(r); } }, records };
}

function freePort(): number {
  return 40000 + Math.floor(Math.random() * 10000);
}

describe('keep-alive framing for a silent SSE body', () => {
  // INVARIANT: a silent SSE response body is kept warm with comment frames.
  // Bun.serve reaps a connection whose response body has written no bytes for
  // `idleTimeout` seconds, and the cap of 255 means a local model that goes
  // minutes between tokens cannot be accommodated by raising the number. This
  // test is the control-vs-treatment pair: the unwrapped body is really torn
  // down, so the wrapper is demonstrably what saves the response.
  test('an unwrapped silent body is reaped by Bun.serve; a wrapped one survives', async () => {
    const silentFor = 9000; // > the 5s idleTimeout below
    const serve = (wrap: boolean) =>
      Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        idleTimeout: 5,
        fetch() {
          const body = new ReadableStream<Uint8Array>({
            async start(controller) {
              await Bun.sleep(silentFor);
              controller.enqueue(new TextEncoder().encode('data: {"real":true}\n\n'));
              controller.close();
            },
          });
          return new Response(wrap ? withSseKeepAlive(body, 150) : body, {
            headers: { 'content-type': 'text/event-stream' },
          });
        },
      });

    const bare = serve(false);
    let bareError: string | null = null;
    try {
      const res = await fetch(`http://127.0.0.1:${bare.port}/`);
      await res.text();
    } catch (err) {
      bareError = err instanceof Error ? err.message : String(err);
    } finally {
      bare.stop(true);
    }
    expect(bareError).toContain('closed unexpectedly');

    const kept = serve(true);
    try {
      const res = await fetch(`http://127.0.0.1:${kept.port}/`);
      const text = await res.text();
      expect(text).toContain('data: {"real":true}');
      // Keep-alives are SSE COMMENTS: no event, no data, ignored by every
      // spec-compliant parser on both wires the proxy fronts.
      expect(text).toContain(': lazy-proxy keepalive');
      expect(text.split('\n').filter((l) => l.startsWith('data:')).length).toBe(1);
    } finally {
      kept.stop(true);
    }
  }, 30000);

  test('a fast body is passed through byte-for-byte, with no keep-alive added', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: a\n\n'));
        controller.enqueue(new TextEncoder().encode('data: b\n\n'));
        controller.close();
      },
    });
    const text = await new Response(withSseKeepAlive(source, 5000)).text();
    expect(text).toBe('data: a\n\ndata: b\n\n');
  });

  test('a broken upstream stream surfaces as an error, never a truncated body', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: a\n\n'));
        controller.error(new Error('upstream exploded'));
      },
    });
    await expect(new Response(withSseKeepAlive(source, 5000)).text()).rejects.toThrow(
      'upstream exploded',
    );
  });

  test('only SSE bodies are eligible for framing', () => {
    expect(isSseContentType('text/event-stream')).toBe(true);
    expect(isSseContentType('text/event-stream; charset=utf-8')).toBe(true);
    expect(isSseContentType('application/json')).toBe(false);
    expect(isSseContentType(null)).toBe(false);
  });
});

describe('the upstream ceiling is lazy\'s, not Bun\'s', () => {
  // INVARIANT: every outgoing upstream request disables Bun's default fetch
  // timeout and supplies lazy's own. Bun's default is undocumented, varies by
  // platform and version (255–360s observed), and cannot be reported to a
  // human: a slow local model aborted by it is indistinguishable from an
  // upstream that is down.
  test('options disable Bun\'s default and carry lazy\'s bound', () => {
    const bounded = upstreamFetchOptions(90);
    expect(bounded.timeout).toBe(false);
    expect(bounded.signal).toBeInstanceOf(AbortSignal);

    const unbounded = upstreamFetchOptions(0);
    expect(unbounded.timeout).toBe(false);
    expect(unbounded.signal).toBeUndefined();
  });

  test('the bound is what aborts, at the time lazy asked for', async () => {
    const stall = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      idleTimeout: 0,
      async fetch() { await Bun.sleep(60000); return new Response('never'); },
    });
    const started = Date.now();
    try {
      await fetch(`http://127.0.0.1:${stall.port}/`, {
        method: 'POST',
        body: 'x',
        ...upstreamFetchOptions(1),
      } as RequestInit);
      throw new Error('expected the bounded fetch to abort');
    } catch (err) {
      expect(isUpstreamTimeout(err)).toBe(true);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      stall.stop(true);
    }
  }, 30000);

  test('a timeout is reported as a timeout, naming the upstream and the knob', () => {
    const err = new DOMException('The operation timed out.', 'TimeoutError');
    const described = describeUpstreamFailure(err, 'http://localhost:11434', 1800);
    expect(described).toContain('http://localhost:11434');
    expect(described).toContain('1800s');
    expect(described).toContain('upstream_timeout');
    // A non-timeout failure is passed through verbatim — no invented diagnosis.
    expect(describeUpstreamFailure(new Error('ECONNREFUSED'), 'http://x', 1800)).toBe('ECONNREFUSED');
  });
});

describe('a slow upstream still gets its real response through the proxy', () => {
  // INVARIANT: an upstream that is merely slow must produce its REAL response,
  // not a 502. This is the shape of the incident, at test speed: the upstream
  // says nothing for longer than the client would otherwise tolerate, then
  // streams a normal SSE answer.
  test('the client receives the upstream body, and the audit record is clean', async () => {
    const upstreamPort = freePort();
    const upstream = Bun.serve({
      port: upstreamPort,
      hostname: '127.0.0.1',
      idleTimeout: 0,
      async fetch() {
        await Bun.sleep(1200); // prefill: no bytes at all for a while
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(enc.encode(
              'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":11,"output_tokens":0}}}\n\n',
            ));
            controller.enqueue(enc.encode(
              'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n',
            ));
            controller.close();
          },
        });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      },
    });

    const { sink, records } = collectingSink();
    const proxyPort = freePort();
    const proxy = createProxyServer(
      {
        port: proxyPort,
        bind: '127.0.0.1',
        upstream: `http://127.0.0.1:${upstreamPort}`,
        upstreamTimeoutSeconds: 60,
      },
      sink,
      null,
    );
    await Bun.sleep(50);

    try {
      const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'qwen3.8:27b-mlx', stream: true, messages: [] }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('message_start');
      expect(text).toContain('message_delta');

      // Give the tee's completion callback a moment to enqueue the record.
      await Bun.sleep(100);
      const record = records.at(-1)!;
      expect(record.status).toBe(200);
      expect(record.error).toBeNull();
      // INVARIANT: keep-alive frames are lazy's own bytes and must never reach
      // the usage scanner — they are injected OUTSIDE the tee for this reason.
      // Usage here is the upstream's, unchanged.
      expect(record.usage?.inputTokens).toBe(11);
      expect(record.usage?.outputTokens).toBe(7);
    } finally {
      proxy.stop(true);
      upstream.stop(true);
    }
  }, 30000);

  test('an upstream past the ceiling is audited and reported as a timeout, not a mystery', async () => {
    const upstreamPort = freePort();
    const upstream = Bun.serve({
      port: upstreamPort,
      hostname: '127.0.0.1',
      idleTimeout: 0,
      async fetch() { await Bun.sleep(60000); return new Response('never'); },
    });

    const { sink, records } = collectingSink();
    const proxyPort = freePort();
    const proxy = createProxyServer(
      {
        port: proxyPort,
        bind: '127.0.0.1',
        upstream: `http://127.0.0.1:${upstreamPort}`,
        upstreamTimeoutSeconds: 1,
      },
      sink,
      null,
    );
    await Bun.sleep(50);

    try {
      const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'qwen3.8:27b-mlx', stream: true, messages: [] }),
      });
      expect(res.status).toBe(502);
      const body = await res.json() as { error: { message: string } };
      expect(body.error.message).toContain('within 1s');
      expect(body.error.message).toContain('upstream_timeout');

      const record = records.at(-1)!;
      expect(record.status).toBeNull();
      expect(record.error).toContain('within 1s');
    } finally {
      proxy.stop(true);
      upstream.stop(true);
    }
  }, 30000);
});
