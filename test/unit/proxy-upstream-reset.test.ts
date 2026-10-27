/**
 * The proxy's answer to an upstream connection reset, and the message that
 * names who failed.
 *
 * Reproduction (Bun 1.4.4, 2026-10-25): an HTTP/1.1 upstream that drops a
 * pooled keep-alive connection when the proxy's next request crosses it makes
 * Bun's fetch throw `ECONNRESET: The socket connection was closed
 * unexpectedly…` within ~1 ms, before any response. That reached Claude Code
 * as a 502 and an 8-second client backoff. A raw `net` server is used because
 * Bun.serve gives no control over WHEN a keep-alive socket is dropped.
 */

import { describe, test, expect } from 'bun:test';
import net from 'node:net';
import { createProxyServer } from '../../src/proxy/server';
import type { AuditSink } from '../../src/proxy/audit';
import type { ProxyAuditRecord } from '../../src/storage/types';
import {
  classifyFetchFailure,
  describeAttributedFailure,
  fetchReplayingStaleConnection,
  providerName,
} from '../../src/proxy/upstream-failure';
import { classifyCommonFailureSignals } from '../../src/agent/failure-taxonomy';

type Mode = 'reset-idle-reuse' | 'reset-always' | 'reset-after-headers';

/** A keep-alive upstream that misbehaves in one chosen way. Counts connections and requests. */
async function misbehavingUpstream(mode: Mode, idleMs = 300) {
  const stats = { connections: 0, requests: 0 };
  const server = net.createServer((sock) => {
    stats.connections++;
    let lastAnswered = 0;
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const len = Number(/content-length:\s*(\d+)/i.exec(buf.slice(0, end))?.[1] ?? 0);
      if (buf.length < end + 4 + len) return;
      buf = '';
      stats.requests++;
      if (mode === 'reset-always' || (mode === 'reset-idle-reuse' && lastAnswered && Date.now() - lastAnswered > idleMs)) {
        sock.resetAndDestroy();
        return;
      }
      if (mode === 'reset-after-headers') {
        sock.write('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{"partial":');
        setTimeout(() => sock.resetAndDestroy(), 20);
        return;
      }
      const body = JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 1 } });
      sock.write(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\nconnection: keep-alive\r\n\r\n${body}`);
      lastAnswered = Date.now();
    });
    sock.on('error', () => { /* the test provokes resets on purpose */ });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, stats, close: () => server.close() };
}

async function withProxy(upstream: string, fn: (port: number, records: ProxyAuditRecord[]) => Promise<void>) {
  const records: ProxyAuditRecord[] = [];
  const sink: AuditSink = { append: async (r) => { records.push(r); } };
  const proxy = createProxyServer({ port: 0, bind: '127.0.0.1', upstream }, sink, null);
  try {
    await fn(proxy.port!, records);
  } finally {
    proxy.stop(true);
  }
}

const send = (port: number) => fetch(`http://127.0.0.1:${port}/v1/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] }),
});

describe('upstream connection reset before any response', () => {
  // INVARIANT: a reset on a reused pooled connection, before any response
  // header, is replayed ONCE on a fresh connection and the client never sees
  // it. Without the replay, every such race became a 502 the client backed off
  // from for seconds — the "502 ECONNRESET … Retrying in 8s" people saw.
  test('the idle-pooled-connection race is replayed once and succeeds', async () => {
    const up = await misbehavingUpstream('reset-idle-reuse');
    try {
      await withProxy(up.url, async (port, records) => {
        expect((await send(port)).status).toBe(200);
        await Bun.sleep(600); // past the upstream's idle reap
        const res = await send(port);
        expect(res.status).toBe(200);
        await res.text();
        // 1st request, the reset one on the pooled socket, the replay on a new socket.
        expect(up.stats.requests).toBe(3);
        expect(up.stats.connections).toBe(2);
        await Bun.sleep(50);
        expect(records.every((r) => r.status === 200)).toBe(true);
        // The hidden replay stays observable in the audit trail.
        expect(records.at(-1)!.replayedReset?.code).toBe('ECONNRESET');
        expect(records[0]!.replayedReset).toBeUndefined();
      });
    } finally {
      up.close();
    }
  }, 15000);

  // INVARIANT: never more than one replay, and a persistent reset is reported
  // NAMING the upstream and how far in it failed — never as a bare Bun message.
  test('a reset that repeats is replayed exactly once, then reported with who failed', async () => {
    const up = await misbehavingUpstream('reset-always');
    try {
      await withProxy(up.url, async (port, records) => {
        const res = await send(port);
        expect(res.status).toBe(502);
        const body = await res.json() as { error: { message: string } };
        expect(body.error.message).toContain(`127.0.0.1:${up.url.split(':').at(-1)}`);
        expect(body.error.message).toContain('reset the connection');
        expect(body.error.message).toContain('retried once on a fresh connection');
        expect(body.error.message).not.toMatch(/^ECONNRESET/);
        expect(up.stats.requests).toBe(2);
        await Bun.sleep(50);
        const rec = records.at(-1)!;
        expect(rec.status).toBeNull();
        expect(rec.failure?.kind).toBe('reset');
        expect(rec.failure?.replayed).toBe(true);
        expect(typeof rec.failure?.afterMs).toBe('number');
      });
    } finally {
      up.close();
    }
  }, 15000);

  // INVARIANT: once response headers arrived, nothing is replayed — the
  // upstream may already have acted on the request.
  test('a reset after response headers is never replayed', async () => {
    const up = await misbehavingUpstream('reset-after-headers');
    try {
      await withProxy(up.url, async (port, records) => {
        const res = await send(port);
        expect(res.status).toBe(200);
        await res.text().catch(() => '');
        await Bun.sleep(100);
        expect(up.stats.requests).toBe(1);
        // INVARIANT: a stream the provider broke is recorded as the provider's
        // failure mid-response — never as a client cancel with no error.
        const rec = records.at(-1)!;
        expect(rec.failure?.kind).toBe('reset');
        expect(rec.failure?.midResponse).toBe(true);
        expect(rec.error).toContain('after the response had started');
      });
    } finally {
      up.close();
    }
  }, 15000);
});

describe('upstream failure after the response started', () => {
  // INVARIANT: with tool enforcement on (the default), the proxy buffers the
  // response; a provider reset while reading it is answered with a 502 NAMING
  // THE PROVIDER and audited — never "lazy's proxy failed" with no record.
  test('a reset while the enforced body is read names the provider and is audited', async () => {
    const up = await misbehavingUpstream('reset-after-headers');
    try {
      await withProxy(up.url, async (port, records) => {
        const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-x', messages: [], tools: [{ name: 'Bash', input_schema: { type: 'object' } }] }),
        });
        expect(res.status).toBe(502);
        const body = await res.json() as { error: { message: string } };
        expect(body.error.message).toContain('reset the connection');
        expect(body.error.message).toContain('after the response had started');
        expect(body.error.message).not.toContain("lazy's proxy failed");
        expect(up.stats.requests).toBe(1);
        await Bun.sleep(50);
        const rec = records.at(-1)!;
        expect(rec.status).toBe(200);
        expect(rec.failure).toMatchObject({ kind: 'reset', midResponse: true });
      });
    } finally {
      up.close();
    }
  }, 15000);
});

describe('fetchReplayingStaleConnection', () => {
  const reset = () => Object.assign(new TypeError('ECONNRESET: closed unexpectedly'), { code: 'ECONNRESET' });

  // INVARIANT: a streamed (non-buffered) body is never replayed — the first
  // attempt consumed it.
  test('a non-replayable request is attempted exactly once', async () => {
    let calls = 0;
    await expect(fetchReplayingStaleConnection(async () => { calls++; throw reset(); }, { replayable: false })).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test('only a reset is replayed, and only once', async () => {
    let calls = 0;
    await expect(fetchReplayingStaleConnection(async () => { calls++; throw reset(); }, { replayable: true })).rejects.toThrow();
    expect(calls).toBe(2);
    calls = 0;
    const refused = Object.assign(new TypeError('Unable to connect'), { code: 'ECONNREFUSED' });
    await expect(fetchReplayingStaleConnection(async () => { calls++; throw refused; }, { replayable: true })).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe('attributed failure messages', () => {
  // INVARIANT: a duration in an attributed message never reads as an HTTP
  // status. The agent failure taxonomy matches a bare 401/403 as fatal auth
  // (and 429/503/529 as overload), so "401 ms" would stop a task for good on
  // a transient reset.
  test.each([401, 403, 429, 503, 529])('a reset %pms in stays a transient network failure', (ms) => {
    const { message } = describeAttributedFailure(
      Object.assign(new TypeError('ECONNRESET: closed'), { code: 'ECONNRESET' }),
      { upstream: 'https://api.anthropic.com' }, 1800, ms,
    );
    const failure = classifyCommonFailureSignals({ message: `API Error: 502 ${JSON.stringify({ error: { message } })}` }, ['claude']);
    expect(failure?.class).toBe('transient_network');
  });

  const reset = Object.assign(new TypeError('ECONNRESET: The socket connection was closed unexpectedly.'), { code: 'ECONNRESET' });

  test('each provider kind is named', () => {
    expect(providerName('https://api.anthropic.com')).toBe('Anthropic');
    expect(providerName('https://chatgpt.com/backend-api/codex')).toBe('OpenAI');
    expect(providerName('https://api.openai.com')).toBe('OpenAI');
    expect(providerName('https://api2.cursor.sh')).toBe('Cursor');
    expect(providerName('http://gpu-box:11434', 'ollama-local')).toBe('endpoint ollama-local');
    expect(providerName('http://gpu-box:11434', 'builtin:anthropic')).toBe('gpu-box');
  });

  test('a reset names provider, host, profile, credential and timing', () => {
    const { message, failure } = describeAttributedFailure(reset, {
      upstream: 'https://api.anthropic.com', profile: 'code-builder', credential: 'CLAUDE_CODE_OAUTH_TOKEN',
    }, 1800, 4);
    expect(message).toStartWith('Anthropic (api.anthropic.com, profile `code-builder`, credential `CLAUDE_CODE_OAUTH_TOKEN`) reset the connection 4ms into the request');
    expect(failure).toMatchObject({ kind: 'reset', code: 'ECONNRESET', provider: 'Anthropic', afterMs: 4, replayed: false });
  });

  test('refused, DNS, TLS and timeout failures each say what happened', () => {
    const at = (err: unknown, upstream: string, endpoint?: string) =>
      describeAttributedFailure(err, { upstream, endpoint }, 30, 1).message;
    expect(at(Object.assign(new TypeError('Unable to connect'), { code: 'ECONNREFUSED' }), 'http://gpu:11434', 'ollama'))
      .toStartWith('endpoint ollama (gpu:11434, endpoint `ollama`) refused the connection');
    expect(at(Object.assign(new TypeError('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' }), 'https://chatgpt.com'))
      .toContain('OpenAI (chatgpt.com): the host name could not be resolved');
    expect(at(Object.assign(new TypeError('self signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }), 'https://api2.cursor.sh'))
      .toContain('Cursor (api2.cursor.sh): the TLS handshake failed');
    const timeout = Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
    expect(at(timeout, 'https://api.anthropic.com')).toStartWith('Anthropic (api.anthropic.com): no response from');
    expect(classifyFetchFailure(timeout).kind).toBe('timeout');
  });
});
