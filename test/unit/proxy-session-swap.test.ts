/**
 * The proxy half of per-user credentials: placeholder in, real token out.
 *
 * Runs the real proxy against an in-process mock upstream and asserts the three
 * decisions from docs/design/lazy-teams.md §3 that this path must not get wrong:
 *
 *   1. The swap replaces the token VALUE inside the header the request ARRIVED
 *      with. The proxy never rewrites header shape.
 *   2. An unknown (or revoked) session token is a 401. Always — there is no
 *      unattributed bucket on this path.
 *   3. An inbound form that disagrees with the owner's credential kind is a loud
 *      401 with an `auth_kind_mismatch` audit record, never a guess.
 *
 * And the one that keeps every existing install working: with no session
 * resolver configured, auth headers are forwarded byte-for-byte as before.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createProxyServer } from '../../src/proxy/server';
import type { AuditSink } from '../../src/proxy/audit';
import type { ProxyAuditRecord } from '../../src/storage/types';
import type { SessionCredentialLookup } from '../../src/proxy/session-auth';
import { SESSION_TOKEN_PREFIX } from '../../src/daemon/session-credentials';

function createMockSink() {
  const records: ProxyAuditRecord[] = [];
  const sink: AuditSink = { append: async (r: ProxyAuditRecord) => { records.push(r); } };
  return { sink, records };
}

const OAUTH_TOKEN = `${SESSION_TOKEN_PREFIX}alice-oauth`;
const APIKEY_TOKEN = `${SESSION_TOKEN_PREFIX}bob-apikey`;

// alice holds an OAuth setup token (Bearer), bob holds an API key (x-api-key).
const resolve: SessionCredentialLookup = async (token) => {
  if (token === OAUTH_TOKEN) return { ok: true, userId: 'alice', kind: 'oauth', secret: 'real-oat-alice' };
  if (token === APIKEY_TOKEN) return { ok: true, userId: 'bob', kind: 'api-key', secret: 'real-key-bob' };
  return { ok: false };
};

const BODY = { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] };

type Forwarded = { headers: Record<string, string> };

describe('proxy session credential swap', () => {
  let upstream: ReturnType<typeof Bun.serve>;
  let proxy: ReturnType<typeof Bun.serve>;
  let plainProxy: ReturnType<typeof Bun.serve>;
  let proxyPort: number;
  let plainPort: number;
  let sink: ReturnType<typeof createMockSink>;
  let plainSink: ReturnType<typeof createMockSink>;
  let lastForwarded: Forwarded | null = null;

  beforeAll(async () => {
    // Port 0 = let the OS pick a free one, rather than gambling on a window.
    upstream = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => { headers[k] = v; });
        lastForwarded = { headers };
        await req.text().catch(() => '');
        return Response.json({ type: 'message', model: 'test' });
      },
    });

    sink = createMockSink();
    proxy = createProxyServer(
      {
        port: 0,
        bind: '127.0.0.1',
        upstream: `http://127.0.0.1:${upstream.port}`,
        resolveSessionCredential: resolve,
      },
      sink.sink,
      // No credential broker: these tests exercise the per-user session swap,
      // not JIT injection.
      null,
    );
    proxyPort = proxy.port!;

    plainSink = createMockSink();
    plainProxy = createProxyServer(
      { port: 0, bind: '127.0.0.1', upstream: `http://127.0.0.1:${upstream.port}` },
      plainSink.sink,
      // No credential broker: these tests exercise the per-user session swap,
      // not JIT injection.
      null,
    );
    plainPort = plainProxy.port!;

    await new Promise((r) => setTimeout(r, 50));
  });

  afterAll(() => {
    upstream.stop();
    proxy.stop();
    plainProxy.stop();
  });

  async function send(port: number, headers: Record<string, string>) {
    lastForwarded = null;
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(BODY),
    });
    // The audit queue flushes asynchronously; every test below reads it.
    await new Promise((r) => setTimeout(r, 50));
    return res;
  }

  test('swaps a Bearer placeholder for the owner\'s real OAuth token', async () => {
    const res = await send(proxyPort, { authorization: `Bearer ${OAUTH_TOKEN}` });
    expect(res.status).toBe(200);

    // Same header, same scheme, new value — no header shape was rewritten.
    expect(lastForwarded!.headers['authorization']).toBe('Bearer real-oat-alice');
    expect(lastForwarded!.headers['x-api-key']).toBeUndefined();

    const rec = sink.records.at(-1)!;
    expect(rec.userId).toBe('alice');
    expect(rec.authDenial ?? null).toBeNull();
  });

  test('swaps an x-api-key placeholder for the owner\'s real API key', async () => {
    const res = await send(proxyPort, { 'x-api-key': APIKEY_TOKEN });
    expect(res.status).toBe(200);

    expect(lastForwarded!.headers['x-api-key']).toBe('real-key-bob');
    expect(lastForwarded!.headers['authorization']).toBeUndefined();
    expect(sink.records.at(-1)!.userId).toBe('bob');
  });

  // INVARIANT: unknown session token ⇒ 401, always. No unattributed bucket.
  test('an unknown session token is refused with 401 and audited', async () => {
    const res = await send(proxyPort, { authorization: `Bearer ${SESSION_TOKEN_PREFIX}ghost` });
    expect(res.status).toBe(401);
    expect(lastForwarded).toBeNull(); // never reached the upstream

    const body = await res.json() as { error?: { type?: string } };
    expect(body.error?.type).toBe('authentication_error');

    const rec = sink.records.at(-1)!;
    expect(rec.authDenial).toBe('unknown_session_token');
    expect(rec.userId ?? null).toBeNull();
    // INVARIANT: lazy's own refusal must NOT look like Anthropic rejecting
    // lazy's credential — src/proxy/auth-verdict.ts reads a 401 in `status`
    // that way, and would send `lazy doctor` chasing the wrong problem.
    expect(rec.status).toBeNull();
  });

  // INVARIANT: form/kind disagreement is a loud 401, never a guess.
  test('a placeholder presented in the wrong header shape is a kind mismatch', async () => {
    // alice holds an OAuth token (Bearer), but the request arrived as x-api-key.
    const res = await send(proxyPort, { 'x-api-key': OAUTH_TOKEN });
    expect(res.status).toBe(401);
    expect(lastForwarded).toBeNull();

    const rec = sink.records.at(-1)!;
    expect(rec.authDenial).toBe('auth_kind_mismatch');
    expect(rec.userId).toBe('alice');
    expect(rec.status).toBeNull();

    const body = await res.json() as { error?: { message?: string } };
    // The message names both sides, so an operator can act on it.
    expect(body.error?.message).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(body.error?.message).toContain('ANTHROPIC_API_KEY');
  });

  test('a placeholder in both headers is refused rather than guessed', async () => {
    const res = await send(proxyPort, {
      authorization: `Bearer ${OAUTH_TOKEN}`,
      'x-api-key': APIKEY_TOKEN,
    });
    expect(res.status).toBe(401);
    expect(lastForwarded).toBeNull();
    expect(sink.records.at(-1)!.authDenial).toBe('auth_kind_mismatch');
  });

  // INVARIANT: additive. A real credential carries no placeholder prefix, so
  // the session rules never touch it — even on a team-mode proxy.
  test('a real credential is forwarded verbatim', async () => {
    const res = await send(proxyPort, { authorization: 'Bearer sk-ant-oat-real' });
    expect(res.status).toBe(200);
    expect(lastForwarded!.headers['authorization']).toBe('Bearer sk-ant-oat-real');
    expect(sink.records.at(-1)!.userId ?? null).toBeNull();
  });

  // INVARIANT: single-user installs. With no resolver configured the proxy has
  // no session behavior at all — not even for a value that looks like one.
  test('with no resolver configured, headers pass through untouched', async () => {
    const res = await send(plainPort, { authorization: `Bearer ${OAUTH_TOKEN}` });
    expect(res.status).toBe(200);
    expect(lastForwarded!.headers['authorization']).toBe(`Bearer ${OAUTH_TOKEN}`);
    expect(plainSink.records.at(-1)!.userId ?? null).toBeNull();
  });
});
