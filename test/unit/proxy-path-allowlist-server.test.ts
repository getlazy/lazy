/**
 * The path allowlist as WIRED INTO the proxy server.
 *
 * proxy-path-allowlist.test.ts pins the decision function; this file pins that
 * the decision is actually enforced on the forwarding path — a refused request
 * must never reach an upstream, must come back 403 with an actionable body, and
 * must leave an audit record. A decision function nobody calls is not a control.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createProxyServer, type ProxyCredentialDeps } from '../../src/proxy/server';
import { TargetCredentials } from '../../src/proxy/target-credentials';
import { PATH_REFUSED_PREFIX } from '../../src/proxy/activity';
import type { CredentialGrant } from '../../src/proxy/credential-broker';
import type { AuditSink } from '../../src/proxy/audit';
import type { ProxyAuditRecord } from '../../src/storage/types';

const AGENT_TOKEN = 'sk-ant-api03-lazy-agent-placeholder';

const grants: Record<string, CredentialGrant> = {
  [AGENT_TOKEN]: {
    token: AGENT_TOKEN, role: 'agent', taskId: 'task-42', label: 'lazy-task-42',
    envKey: 'ANTHROPIC_API_KEY', createdAt: new Date().toISOString(),
  },
};

const freePort = () => 41000 + Math.floor(Math.random() * 8000);

describe('proxy forwarding-surface allowlist', () => {
  let primary: ReturnType<typeof Bun.serve>;
  let roleTarget: ReturnType<typeof Bun.serve>;
  let proxy: ReturnType<typeof Bun.serve>;
  let proxyPort: number;
  let records: ProxyAuditRecord[] = [];
  /** Every path each upstream was actually asked for. */
  let hits: Record<string, string[]> = { primary: [], role: [] };

  function upstreamServer(name: string, port: number) {
    return Bun.serve({
      port, hostname: '127.0.0.1',
      async fetch(req) {
        await req.text();
        hits[name]!.push(`${req.method} ${new URL(req.url).pathname}`);
        return Response.json({ type: 'message', model: 'm', from: name });
      },
    });
  }

  beforeAll(async () => {
    const primaryPort = freePort();
    const rolePort = freePort();
    primary = upstreamServer('primary', primaryPort);
    roleTarget = upstreamServer('role', rolePort);

    const credentials: ProxyCredentialDeps = {
      lookup: async (token: string) => grants[token] ?? null,
      // Both upstreams unmapped → `none`: nothing to inject, which keeps this
      // suite about the path decision and not about credential exchange.
      targets: new TargetCredentials(),
    };
    const sink: AuditSink = { append: async (r) => { records.push(r); } };
    proxyPort = freePort();
    proxy = createProxyServer(
      {
        port: proxyPort, bind: '127.0.0.1',
        upstream: `http://127.0.0.1:${primaryPort}`,
        roleUpstreams: { agent: `http://127.0.0.1:${rolePort}` },
      },
      sink,
      credentials,
    );
    await new Promise((r) => setTimeout(r, 50));
  });

  afterAll(() => {
    primary.stop(); roleTarget.stop(); proxy.stop();
  });

  function reset() {
    records = [];
    hits = { primary: [], role: [] };
  }

  const send = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${proxyPort}${path}`, init);

  const asAgent = (path: string, init: RequestInit = {}) =>
    send(path, {
      ...init,
      headers: { 'x-api-key': AGENT_TOKEN, ...(init.headers as Record<string, string> ?? {}) },
    });

  // Audit records are enqueued asynchronously; give the queue a tick.
  const settle = () => new Promise((r) => setTimeout(r, 60));

  test('forwards the allowed model API surface unchanged', async () => {
    reset();
    const resp = await send('/v1/messages?beta=true', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    expect(resp.status).toBe(200);
    expect(hits.primary).toEqual(['POST /v1/messages']);
  });

  // INVARIANT: this is the hole the allowlist exists to close. A granted agent
  // routed to a role upstream (a local ollama server) must not be able to reach
  // that server's administrative surface through lazy's own audit plane.
  test('refuses an ollama admin endpoint on a role upstream and never forwards it', async () => {
    reset();
    const resp = await asAgent('/api/delete', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-coder' }),
    });
    expect(resp.status).toBe(403);
    // The request reached NEITHER upstream — refusal happens before forwarding.
    expect(hits.role).toEqual([]);
    expect(hits.primary).toEqual([]);

    const body = await resp.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe('permission_error');
    // Actionable: names what was refused and where to go if it is legitimate.
    expect(body.error.message).toContain('DELETE /api/delete');
    expect(body.error.message).toContain('src/proxy/path-allowlist.ts');
  });

  // INVARIANT: a refusal is the security-interesting event, so it is DURABLY
  // recorded, not merely logged — same reasoning as credential refusals.
  test('records the refusal in the audit log with grant attribution', async () => {
    reset();
    await asAgent('/api/pull', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'llama3' }),
    });
    await settle();
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.status).toBe(403);
    expect(rec.method).toBe('POST');
    expect(rec.path).toBe('/api/pull');
    expect(rec.error).toStartWith(PATH_REFUSED_PREFIX);
    // Attribution comes from the grant, not a client header.
    expect(rec.role).toBe('agent');
    expect(rec.taskId).toBe('task-42');
  });

  // INVARIANT: the allowlist covers unattributed traffic too. Scoping it to
  // granted callers would leave the surface wide open to the one client shape
  // that presents no credential at all.
  test('refuses an unlisted path even with no credential presented', async () => {
    reset();
    const resp = await send('/api/pull', { method: 'POST', body: '{}' });
    expect(resp.status).toBe(403);
    expect(hits.primary).toEqual([]);
  });

  // INVARIANT: a role upstream gets inference and nothing else, so a route the
  // Anthropic primary legitimately serves can still be refused there.
  test('model discovery reaches the primary but not a role upstream', async () => {
    reset();
    const onPrimary = await send('/v1/models');
    expect(onPrimary.status).toBe(200);
    expect(hits.primary).toEqual(['GET /v1/models']);

    reset();
    const onRole = await asAgent('/v1/models');
    expect(onRole.status).toBe(403);
    expect(hits.role).toEqual([]);
  });

  test('the unauthenticated reachability probe is still forwarded', async () => {
    reset();
    const resp = await send('/api/hello', { method: 'HEAD' });
    expect(resp.status).toBe(200);
    expect(hits.primary).toEqual(['HEAD /api/hello']);
  });

  // INVARIANT: matching is on the normalised pathname, so a traversal cannot
  // smuggle an admin path in behind an allowed prefix.
  test('a dot-segment traversal to an admin path is refused', async () => {
    reset();
    const resp = await send('/v1/messages/../../api/pull', { method: 'POST', body: '{}' });
    expect(resp.status).toBe(403);
    expect(hits.primary).toEqual([]);
  });
});
