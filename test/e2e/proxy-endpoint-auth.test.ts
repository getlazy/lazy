import { afterEach, describe, expect, test } from 'bun:test';
import { createProxyServer } from '../../src/proxy/server';
import { TargetCredentials, bearerPlacement } from '../../src/proxy/target-credentials';
import type { CredentialGrant } from '../../src/proxy/credential-broker';
import { memberEndpointUsageKey } from '../../src/proxy/usage-limits';
import type { ProxyAuditRecord } from '../../src/storage/types';

const TOKEN = 'sk-ant-api03-lazy-endpoint-auth-test';
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

// INVARIANT: an unreachable provider still records the member and endpoint that would pay. An error cannot collapse endpoint usage into a member-only slot.
test('upstream connection errors retain the member endpoint usage key', async () => {
  const target = upstream(() => new Response('unused'));
  servers.at(-1)!.stop(true);
  const records: ProxyAuditRecord[] = [];
  const grant: CredentialGrant = { token: TOKEN, role: 'agent', taskId: 'task', label: 'task', envKey: 'ANTHROPIC_API_KEY', profile: 'test', createdAt: '' };
  const server = createProxyServer({ port: 0, bind: '127.0.0.1', upstream: target,
    agentUpstreams: { test: { upstream: target, wire: 'anthropic' } },
  }, { append: async record => { records.push(record); } }, {
    lookup: async token => token === TOKEN ? grant : null, targets: new TargetCredentials(),
    member: async () => ({ userId: 'alice@example.com', endpoint: 'paid', outcome: { kind: 'credential', placement: bearerPlacement('member-secret'), label: 'member' } }),
  });
  servers.push(server);
  const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, { method: 'POST',
    headers: { 'x-api-key': TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', messages: [] }),
  });
  expect(response.status).toBe(502);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(records.at(-1)?.credential).toBe(memberEndpointUsageKey('alice@example.com', 'paid'));
});

function upstream(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handler });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

function proxy(target: string, paid: boolean, role: 'agent' | 'builder') {
  const grant: CredentialGrant = {
    token: TOKEN, role, taskId: role === 'agent' ? 'task' : null,
    label: 'endpoint-auth-test', envKey: 'ANTHROPIC_API_KEY', profile: 'test', createdAt: new Date().toISOString(),
  };
  const targets = new TargetCredentials();
  if (paid) targets.set(target, async () => ({ kind: 'credential', placement: bearerPlacement('member-endpoint-secret'), label: 'member' }));
  const server = createProxyServer(
    { port: 0, bind: '127.0.0.1', upstream: target, agentUpstreams: { test: { upstream: target, wire: 'anthropic' } } },
    { append: async () => {} },
    { lookup: async token => token === TOKEN ? grant : null, targets },
  );
  servers.push(server);
  return `http://127.0.0.1:${server.port}/v1/messages`;
}

for (const role of ['agent', 'builder'] as const) {
  describe(`${role} endpoint authentication`, () => {
    // INVARIANT: a free endpoint receives no auth, even auth the client supplied alongside its placeholder. A free tier cannot spend a hidden account.
    test('strips all authentication at a credential-free endpoint', async () => {
      let seen: Headers | null = null;
      const target = upstream(req => { seen = req.headers; return Response.json({ type: 'message', content: [] }); });
      const response = await fetch(proxy(target, false, role), {
        method: 'POST', headers: {
          'x-api-key': TOKEN, authorization: 'Bearer client-secret', 'api-key': 'another-secret',
          cookie: 'session=client-secret', 'chatgpt-account-id': 'client-account', 'content-type': 'application/json',
        }, body: JSON.stringify({ model: 'm', messages: [] }),
      });
      expect(response.status).toBe(200);
      expect(seen).not.toBeNull();
      for (const name of ['x-api-key', 'authorization', 'api-key', 'cookie', 'chatgpt-account-id']) expect(seen!.get(name)).toBeNull();
    });

    // INVARIANT: attached credentials never follow a redirect to an unchecked route. Same-origin redirects can also leave the API path allowlist.
    test('does not follow an upstream redirect with credentials', async () => {
      let leaked = false;
      const destination = upstream(() => { leaked = true; return new Response('leaked'); });
      const target = upstream(req => {
        expect(req.headers.get('authorization')).toBe('Bearer member-endpoint-secret');
        return new Response(null, { status: 307, headers: { location: `${destination}/capture` } });
      });
      const response = await fetch(proxy(target, true, role), {
        method: 'POST', headers: { 'x-api-key': TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm', messages: [] }), redirect: 'manual',
      });
      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe(`${destination}/capture`);
      expect(leaked).toBe(false);
    });
  });
}

// INVARIANT: a raw session's checked primary is its only destination. Neither client auth nor a generic fallback may carry the member's secret elsewhere.
test('raw session auth stays on its checked primary even when it is overloaded', async () => {
  let fallbackHits = 0;
  const fallback = upstream(() => { fallbackHits++; return Response.json({ ok: true }); });
  const primary = upstream(req => {
    expect(req.headers.get('x-api-key')).toBe('session-secret');
    expect(req.headers.get('authorization')).toBeNull();
    expect(req.headers.get('cookie')).toBeNull();
    return Response.json({ error: 'overloaded' }, { status: 529 });
  });
  const server = createProxyServer({ port: 0, bind: '127.0.0.1', upstream: primary,
    fallbacks: [{ upstream: fallback }], retryAfterThreshold: 0,
    resolveSessionCredential: async (_token, context) => {
      expect(context?.upstream).toBe(primary);
      return { ok: true, userId: 'alice@example.com', endpoint: 'builtin:anthropic', kind: 'api-key', secret: 'session-secret' };
    },
  }, { append: async () => {} }, null);
  servers.push(server);
  const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'lazy-sess-test', authorization: 'Bearer other-secret', cookie: 'session=other-secret' },
    body: JSON.stringify({ model: 'm', messages: [] }),
  });
  expect(response.status).toBe(529);
  expect(fallbackHits).toBe(0);
});

// INVARIANT: a transient usage refresh failure keeps unknown tiers available without bypassing credential checks. Approved usage fallback is independent of destination authorization.
test('conditional tiers stay available on a transient usage read failure and retry the refresh', async () => {
  let hits = 0;
  let unreadable = true;
  const target = upstream(() => { hits++; return Response.json({ type: 'message', content: [] }); });
  const grant: CredentialGrant = { token: TOKEN, role: 'builder', taskId: null, label: 'builder', envKey: 'ANTHROPIC_API_KEY', profile: 'chain', createdAt: '' };
  const server = createProxyServer({
    port: 0, bind: '127.0.0.1', upstream: target,
    agentUpstreams: { chain: { upstream: target, wire: 'anthropic', tiers: [
      { index: 0, endpoint: 'sub', upstream: target, model: 'm', usage: 'claude', threshold: 95 },
    ] } },
  }, { append: async () => {} }, { targets: new TargetCredentials(), lookup: async token => token === TOKEN ? grant : null }, {
    prepareTierChoice: async () => { if (unreadable) throw new Error('stored readings corrupt'); },
  });
  servers.push(server);
  const request = () => fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
    method: 'POST', headers: { 'x-api-key': TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', messages: [] }),
  });
  expect((await request()).status).toBe(200);
  expect(hits).toBe(1);
  unreadable = false;
  expect((await request()).status).toBe(200);
  expect(hits).toBe(2);
});
