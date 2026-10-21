/**
 * A client that gives up must take its upstream request with it.
 *
 * Provenance: a Pi request aborted at its 300s idle timeout was still running
 * upstream 19 minutes later, holding Ollama Cloud's only concurrency slot.
 */

import { describe, test, expect } from 'bun:test';
import { createProxyServer } from '../../src/proxy/server';
import type { AuditSink } from '../../src/proxy/audit';
import type { ProxyAuditRecord } from '../../src/storage/types';

describe('client disconnect aborts the upstream request', () => {
  // INVARIANT: an upstream request has no reader once the client disconnects, and
  // keeping it alive costs a concurrency slot and billed tokens.
  test('stalled upstream is aborted promptly and audited as a client disconnect', async () => {
    let upstreamAborted = false;
    let upstreamHits = 0;
    const upstream = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        upstreamHits++;
        req.signal.addEventListener('abort', () => { upstreamAborted = true; });
        return new Promise<Response>(() => {}); // never answers
      },
    });
    const records: ProxyAuditRecord[] = [];
    const sink: AuditSink = { append: async (r) => { records.push(r); } };
    const proxy = createProxyServer(
      {
        port: 0,
        bind: '127.0.0.1',
        upstream: `http://127.0.0.1:${upstream.port}`,
        upstreamTimeoutSeconds: 60,
      },
      sink,
      null,
    );
    await Bun.sleep(50);
    try {
      const ac = new AbortController();
      const p = fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm', stream: true, messages: [] }),
        signal: ac.signal,
      }).catch(() => null);
      await Bun.sleep(300);
      ac.abort();
      await p;
      for (let i = 0; i < 40 && (!upstreamAborted || records.length === 0); i++) await Bun.sleep(50);

      expect(upstreamAborted).toBe(true);
      expect(upstreamHits).toBe(1); // no failover / retry
      expect(records.at(-1)!.error).toContain('client disconnected');
    } finally {
      proxy.stop(true);
      upstream.stop(true);
    }
  }, 30000);
});

describe('client disconnect never fails over', () => {
  // INVARIANT: a client abort is not an upstream failure. Failing over would send
  // a second billed request to a fallback for a reader that no longer exists.
  test('aborting while the primary stalls sends nothing to the fallback', async () => {
    let primaryAborted = false;
    let fallbackHits = 0;
    const primary = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        req.signal.addEventListener('abort', () => { primaryAborted = true; });
        return new Promise<Response>(() => {});
      },
    });
    const fallback = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch() { fallbackHits++; return new Response('{}', { status: 200 }); },
    });
    const records: ProxyAuditRecord[] = [];
    const sink: AuditSink = { append: async (r) => { records.push(r); } };
    const proxy = createProxyServer(
      {
        port: 0,
        bind: '127.0.0.1',
        upstream: `http://127.0.0.1:${primary.port}`,
        fallbacks: [{ upstream: `http://127.0.0.1:${fallback.port}` }],
        upstreamTimeoutSeconds: 60,
      },
      sink,
      null,
    );
    await Bun.sleep(50);
    try {
      const ac = new AbortController();
      const p = fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm', stream: true, messages: [] }),
        signal: ac.signal,
      }).catch(() => null);
      await Bun.sleep(300);
      ac.abort();
      await p;
      for (let i = 0; i < 40 && (!primaryAborted || records.length === 0); i++) await Bun.sleep(50);
      expect(primaryAborted).toBe(true);
      expect(fallbackHits).toBe(0);
      expect(records.at(-1)!.error).toContain('client disconnected');
    } finally {
      proxy.stop(true);
      primary.stop(true);
      fallback.stop(true);
    }
  }, 30000);
});
