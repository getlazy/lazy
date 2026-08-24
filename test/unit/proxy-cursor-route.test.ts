/**
 * Cursor passthrough route: path parsing/building, plus end-to-end forwarding
 * through a live proxy against a mock Cursor upstream.
 *
 * INVARIANT: cursor requests are OPAQUE to the proxy. They must never be parsed
 * by the Anthropic-wire extractor, never enforced against, and never have their
 * body buffered — the agent stream is a connect-rpc stream and buffering it
 * would deadlock the turn. These tests encode that: the audit record carries
 * coarse attribution only (no model/tier/usage), and the request body reaches
 * the upstream verbatim.
 *
 * INVARIANT: the route's single path segment is a MINTED PLACEHOLDER, and
 * attribution comes from the grant it resolves to — never from anything the
 * client said about itself. It used to be two self-reported `role`/`taskId`
 * segments, which any container could set to another task's identity.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createProxyServer, type ProxyCredentialDeps } from '../../src/proxy/server';
import {
  CURSOR_PROXY_PREFIX,
  DEFAULT_CURSOR_UPSTREAM,
  cursorProxyEndpoint,
  cursorProxyEnvVars,
  cursorLaunchEnvVars,
  isCursorProxyPath,
  parseCursorProxyPath,
  CURSOR_ENDPOINT_ENV,
} from '../../src/proxy/cursor-route';
import { TargetCredentials } from '../../src/proxy/target-credentials';
import type { CredentialGrant } from '../../src/proxy/credential-broker';
import type { AuditSink } from '../../src/proxy/audit';
import type { ProxyAuditRecord } from '../../src/storage/types';

function createMockSink() {
  const records: ProxyAuditRecord[] = [];
  const sink: AuditSink = { append: async (r) => { records.push(r); } };
  return { sink, records };
}

function findFreePort(): number {
  return 40000 + Math.floor(Math.random() * 10000);
}

describe('cursor proxy endpoint building', () => {
  test('carries the launch placeholder as a single fixed segment', () => {
    expect(cursorProxyEndpoint('http://127.0.0.1:8766', 'key_lazy_abc'))
      .toBe('http://127.0.0.1:8766/_lazy/cursor/key_lazy_abc');
  });

  test('no placeholder becomes "-" so the arity never changes', () => {
    expect(cursorProxyEndpoint('http://127.0.0.1:8766', null))
      .toBe('http://127.0.0.1:8766/_lazy/cursor/-');
    expect(cursorProxyEndpoint('http://127.0.0.1:8766'))
      .toBe('http://127.0.0.1:8766/_lazy/cursor/-');
  });

  test('unsafe segment values are replaced, never interpolated into the path', () => {
    // A value carrying a slash would forge extra path segments and silently
    // re-point the upstream path.
    expect(cursorProxyEndpoint('http://h:1', 'a/../b')).toBe('http://h:1/_lazy/cursor/-');
  });

  test('a trailing slash on the base URL does not double up', () => {
    expect(cursorProxyEndpoint('http://h:1/', 'tok')).toBe('http://h:1/_lazy/cursor/tok');
  });
});

describe('cursor proxy path parsing', () => {
  test('splits the placeholder from the upstream path', () => {
    expect(parseCursorProxyPath('/_lazy/cursor/tok123/auth/exchange_user_api_key')).toEqual({
      token: 'tok123',
      upstreamPath: '/auth/exchange_user_api_key',
    });
  });

  test('preserves the query string on the upstream path', () => {
    expect(parseCursorProxyPath('/_lazy/cursor/tok123/v1/thing?a=1&b=2')?.upstreamPath)
      .toBe('/v1/thing?a=1&b=2');
  });

  test('"-" decodes back to null rather than a literal dash', () => {
    expect(parseCursorProxyPath('/_lazy/cursor/-/ping')?.token).toBeNull();
  });

  test('a bare prefix with no upstream path still parses, forwarding "/"', () => {
    expect(parseCursorProxyPath('/_lazy/cursor/tok')).toEqual({
      token: 'tok',
      upstreamPath: '/',
    });
  });

  test('rejects paths with no credential segment', () => {
    expect(parseCursorProxyPath('/_lazy/cursor')).toBeNull();
  });

  test('returns null for non-cursor paths', () => {
    expect(parseCursorProxyPath('/v1/messages')).toBeNull();
    // Prefix-lookalike must not match: a different top-level path could
    // otherwise be swallowed by the cursor route.
    expect(isCursorProxyPath('/_lazy/cursorx/agent/t')).toBe(false);
  });
});

describe('cursorLaunchEnvVars: which address each launch surface gets', () => {
  const base = { proxyPort: 8766, bind: '127.0.0.1', token: 'key_lazy_t' };

  // INVARIANT: routing cursor traffic is cursor-only. Anthropic-backed agents
  // are routed by the role-target machinery; adding an endpoint override for
  // them here would silently override THAT decision.
  test('non-cursor agents get nothing', () => {
    expect(cursorLaunchEnvVars({ ...base, agentId: 'claude-code', runnerType: 'docker' })).toEqual([]);
    expect(cursorLaunchEnvVars({ ...base, agentId: undefined, runnerType: 'docker' })).toEqual([]);
  });

  // INVARIANT: the container surface must get host.docker.internal and the host
  // surface a loopback address. This is the one thing the two launch sites
  // disagree about, which is why they share this function — an inlined copy is
  // how a container address ends up handed to a host process.
  test('container runners reach the proxy via host.docker.internal', () => {
    for (const runnerType of ['docker', 'podman'] as const) {
      expect(cursorLaunchEnvVars({ ...base, agentId: 'cursor', runnerType })).toEqual([
        { key: 'CURSOR_API_ENDPOINT', value: 'http://host.docker.internal:8766/_lazy/cursor/key_lazy_t' },
      ]);
    }
  });

  test('the host-process runner reaches the proxy on its bind address', () => {
    expect(cursorLaunchEnvVars({
      ...base,
      bind: '127.0.0.2',
      agentId: 'cursor',
      runnerType: 'dangerously-host-process-without-any-isolation',
    })).toEqual([
      { key: 'CURSOR_API_ENDPOINT', value: 'http://127.0.0.2:8766/_lazy/cursor/key_lazy_t' },
    ]);
  });

  // The one launch with no placeholder: a HOST cursor-agent authenticating with
  // its own `cursor-agent login` session. There is no key to swap, so there is
  // nothing to mint — the traffic is forwarded verbatim and recorded
  // unattributed rather than refused.
  test('a launch with no placeholder is routed anyway, as "-"', () => {
    expect(cursorLaunchEnvVars({ ...base, token: null, agentId: 'cursor', runnerType: 'docker' })[0].value)
      .toBe('http://host.docker.internal:8766/_lazy/cursor/-');
  });

  // INVARIANT: no proxy ⇒ no cursor turn. Falling through to Cursor's servers
  // direct would produce an unaudited turn, which is the exact failure this
  // whole route exists to prevent. Mirrors the Anthropic path's fail-loud gate.
  test('a cursor launch with no live proxy port fails loudly', () => {
    expect(() => cursorLaunchEnvVars({ ...base, proxyPort: undefined, agentId: 'cursor', runnerType: 'docker' }))
      .toThrow(/could not resolve the live proxy address/i);
  });
});

describe('cursorProxyEnvVars', () => {
  test('produces the endpoint override env var', () => {
    expect(cursorProxyEnvVars('http://127.0.0.1:1/', 'tok')).toEqual([
      { key: CURSOR_ENDPOINT_ENV, value: 'http://127.0.0.1:1/_lazy/cursor/tok' },
    ]);
  });

  // INVARIANT: the audit plane has no off switch. A cursor launch that cannot
  // resolve the proxy FAILS rather than talking straight to Cursor's servers
  // with nothing recorded — same contract as ProxyUnavailableError on the
  // Anthropic path. Never "fix" this into a direct-connection fallback.
  test('fails loud when no proxy address could be resolved', () => {
    expect(() => cursorProxyEnvVars(undefined, 'tok')).toThrow(/could not resolve the live proxy address/i);
  });
});

describe('cursor route forwarding', () => {
  let upstream: ReturnType<typeof Bun.serve>;
  let proxy: ReturnType<typeof Bun.serve>;
  let proxyPort: number;
  let sink: ReturnType<typeof createMockSink>;
  let seen: { method: string; path: string; headers: Record<string, string>; body: string } | null = null;

  const PLACEHOLDER = 'key_lazy_cursorgrant';
  const REAL_KEY = 'key_real_cursor_secret';

  const GRANT: CredentialGrant = {
    token: PLACEHOLDER,
    role: 'agent',
    taskId: 'ab12',
    label: 'lazy-task-ab12',
    envKey: 'CURSOR_API_KEY',
    createdAt: new Date(0).toISOString(),
  };

  beforeAll(async () => {
    const upstreamPort = findFreePort();
    upstream = Bun.serve({
      port: upstreamPort,
      hostname: '127.0.0.1',
      async fetch(req) {
        const url = new URL(req.url);
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => { headers[k] = v; });
        seen = {
          method: req.method,
          path: url.pathname + url.search,
          headers,
          body: req.method === 'GET' ? '' : await req.text(),
        };
        return new Response('cursor-ok', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const cursorUpstream = `http://127.0.0.1:${upstreamPort}`;
    const targets = new TargetCredentials();
    targets.set(cursorUpstream, async () => ({
      kind: 'credential',
      placement: { kind: 'in-place', value: REAL_KEY },
      label: 'CURSOR_API_KEY',
    }));
    const credentials: ProxyCredentialDeps = {
      lookup: async (token) => (token === PLACEHOLDER ? GRANT : null),
      targets,
    };

    proxyPort = findFreePort();
    sink = createMockSink();
    proxy = createProxyServer(
      {
        port: proxyPort,
        bind: '127.0.0.1',
        upstream: 'http://127.0.0.1:1',   // deliberately dead: cursor must not use it
        cursorUpstream,
      },
      sink.sink,
      credentials,
    );
    await new Promise((r) => setTimeout(r, 50));
  });

  afterAll(() => {
    proxy.stop(true);
    upstream.stop(true);
  });

  test('forwards method, path and body verbatim to the cursor upstream', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/_lazy/cursor/${PLACEHOLDER}/v1/ping`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('cursor-ok');
    expect(seen?.method).toBe('POST');
    expect(seen?.path).toBe('/v1/ping');
    expect(seen?.body).toBe(JSON.stringify({ hello: 'world' }));
  });

  // INVARIANT (JIT credentials): the launch holds only a placeholder. The real
  // Cursor key is substituted here, at the last hop, and the placeholder must
  // never reach Cursor.
  test('swaps the placeholder for the real key in headers AND body', async () => {
    await fetch(`http://127.0.0.1:${proxyPort}/_lazy/cursor/${PLACEHOLDER}/auth/exchange_user_api_key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${PLACEHOLDER}` },
      body: JSON.stringify({ apiKey: PLACEHOLDER }),
    });

    expect(seen?.headers.authorization).toBe(`Bearer ${REAL_KEY}`);
    expect(seen?.body).toBe(JSON.stringify({ apiKey: REAL_KEY }));
    expect(JSON.stringify(seen)).not.toContain(PLACEHOLDER);
  });

  test('records coarse audit attributed from the GRANT, not from headers', async () => {
    sink.records.length = 0;
    await fetch(`http://127.0.0.1:${proxyPort}/_lazy/cursor/${PLACEHOLDER}/v1/ping?x=1`, {
      method: 'POST',
      // A client claiming to be another task must not be believed.
      headers: { 'x-lazy-role': 'builder', 'x-lazy-task-id': 'someone-else' },
      body: '{}',
    });
    await new Promise((r) => setTimeout(r, 50));

    const rec = sink.records.find((r) => r.backend === 'cursor');
    expect(rec).toBeDefined();
    expect(rec!.role).toBe('agent');
    expect(rec!.taskId).toBe('ab12');
    expect(rec!.endpoint).toBe('cursor');
    expect(rec!.method).toBe('POST');
    // The lazy prefix is stripped: the record shows what cursor actually saw.
    expect(rec!.path).toBe('/v1/ping?x=1');
    expect(rec!.status).toBe(200);
    // INVARIANT: the Anthropic-wire extractor never runs on cursor traffic, so
    // these stay null rather than being guessed at from a foreign wire format.
    expect(rec!.model).toBeNull();
    expect(rec!.tier).toBeNull();
    expect(rec!.usage).toBeNull();
    expect(rec!.requestShape).toBeNull();
    expect(rec!.enforcement).toBeNull();
  });

  test('strips lazy-internal headers before forwarding', async () => {
    await fetch(`http://127.0.0.1:${proxyPort}/_lazy/cursor/${PLACEHOLDER}/v1/ping`, {
      method: 'POST',
      headers: { 'x-lazy-role': 'agent', 'x-lazy-task-id': 'ab12' },
      body: '{}',
    });
    expect(seen?.headers['x-lazy-role']).toBeUndefined();
    expect(seen?.headers['x-lazy-task-id']).toBeUndefined();
  });

  // INVARIANT: a placeholder whose grant is gone (task accepted/rejected/closed)
  // or was never minted is refused HERE. Forwarding it would spend nothing and
  // surface to the user as a confusing Cursor auth error.
  test('an unknown placeholder is a 401 naming the remedy', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/_lazy/cursor/key_lazy_revoked/v1/ping`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(await res.text()).toMatch(/lazy/i);
  });

  // The host `cursor-agent login` case: no placeholder to resolve, so the
  // session credential the client sent rides along and the record is
  // unattributed. Deliberately not a 401 — that login is a supported setup.
  test('a "-" route forwards unattributed rather than refusing', async () => {
    sink.records.length = 0;
    const res = await fetch(`http://127.0.0.1:${proxyPort}/_lazy/cursor/-/v1/ping`, {
      method: 'POST',
      headers: { authorization: 'Bearer session-cred' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(seen?.headers.authorization).toBe('Bearer session-cred');
    await new Promise((r) => setTimeout(r, 50));
    const rec = sink.records.find((r) => r.backend === 'cursor');
    expect(rec!.role).toBeNull();
    expect(rec!.taskId).toBeNull();
  });

  test('a malformed cursor path is refused, not forwarded unattributed', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}${CURSOR_PROXY_PREFIX}`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('Malformed cursor proxy path');
  });

  test('non-cursor paths still go to the Anthropic upstream', async () => {
    // The Anthropic upstream is a dead port here, so a 502 proves the cursor
    // branch did not swallow the request.
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(502);
  });
});

describe('cursor route defaults', () => {
  test('defaults to Cursor production when no upstream is configured', async () => {
    expect(DEFAULT_CURSOR_UPSTREAM).toBe('https://api2.cursor.sh');
  });
});
