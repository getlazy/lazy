/**
 * The proxy really publishes activity — end to end, through a live server.
 *
 * The unit tests next door pin the bus and the projection in isolation; this
 * file pins the WIRING, which is the part that can silently rot. If a future
 * refactor drops the `open` publish or adds an audit site that skips the tap,
 * `lazy watch` goes quiet again for exactly the agents that need it most, and
 * nothing else in the suite would notice.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createProxyServer, type ProxyCredentialDeps } from '../../src/proxy/server';
import { ProxyActivityBus, type ProxyActivityEvent } from '../../src/proxy/activity';
import { TargetCredentials } from '../../src/proxy/target-credentials';
import type { CredentialGrant } from '../../src/proxy/credential-broker';
import type { AuditSink } from '../../src/proxy/audit';
import type { ProxyAuditRecord } from '../../src/storage/types';

function findFreePort(): number {
  return 40000 + Math.floor(Math.random() * 10000);
}

describe('proxy → activity bus wiring', () => {
  let upstream: ReturnType<typeof Bun.serve>;
  let proxy: ReturnType<typeof Bun.serve>;
  let proxyPort: number;
  let bus: ProxyActivityBus;
  let events: ProxyActivityEvent[];
  const records: ProxyAuditRecord[] = [];

  beforeAll(async () => {
    const upstreamPort = findFreePort();
    upstream = Bun.serve({
      port: upstreamPort,
      hostname: '127.0.0.1',
      async fetch(req) {
        const body = req.method !== 'GET' ? await req.json().catch(() => null) : null;
        return Response.json({
          type: 'message',
          model: body?.model ?? 'test',
          usage: { input_tokens: 7, output_tokens: 3 },
        });
      },
    });

    bus = new ProxyActivityBus();
    events = [];
    bus.subscribe((e) => events.push(e));

    const sink: AuditSink = { append: async (r) => { records.push(r); } };
    proxyPort = findFreePort();
    proxy = createProxyServer(
      { port: proxyPort, bind: '127.0.0.1', upstream: `http://127.0.0.1:${upstreamPort}` },
      sink,
      null,
      { activity: bus },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  afterAll(() => {
    upstream.stop();
    proxy.stop();
  });

  // WHY BOTH HALVES: an audit record is written when a request COMPLETES, and a
  // streaming /v1/messages call runs for tens of seconds to minutes. That
  // window is precisely when watch felt dead, so the `open` event — published
  // as the proxy forwards — is the half that actually fixes the silence.
  test('a forwarded request publishes open then close', async () => {
    events.length = 0;
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
    });
    expect(response.status).toBe(200);
    await response.text();
    // The close event rides the audit enqueue, which happens as the response
    // settles; a tick is enough for it to land.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('open');
    expect(kinds).toContain('close');
    expect(kinds.indexOf('open')).toBeLessThan(kinds.indexOf('close'));
  });

  test('both halves describe the same request and carry the wire model', async () => {
    events.length = 0;
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
    });
    await response.text();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const open = events.find((e) => e.kind === 'open')!;
    const close = events.find((e) => e.kind === 'close')!;
    expect(open.id).toBe(close.id);
    expect(open.method).toBe('POST');
    expect(open.path).toBe('/v1/messages');
    expect(open.model).toBe('claude-opus-5');
    expect(close.kind === 'close' && close.status).toBe(200);
    // Usage came back on the response, so the live view can show a token total.
    expect(close.kind === 'close' && close.totalTokens).toBe(10);
  });

  // INVARIANT: every record that reaches the durable audit trail reaches the
  // live view too. That is why the tap is wired into AuditQueue rather than at
  // each of the proxy's record sites — a new site cannot forget it.
  test('every audit record has a matching close event', async () => {
    events.length = 0;
    records.length = 0;
    for (let i = 0; i < 3; i++) {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
      });
      await response.text();
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    const closedIds = events.filter((e) => e.kind === 'close').map((e) => e.id).sort();
    expect(closedIds).toEqual(records.map((r) => r.id).sort());
    expect(closedIds).toHaveLength(3);
  });
});

/**
 * Attribution and per-role routing, together.
 *
 * Two things are pinned here, and the second is why the feature shipped broken
 * once already:
 *
 *  1. The activity tap sits BEFORE per-role target selection, so a role routed
 *     to its own upstream (an ollama server, a pinned gateway) is still visible
 *     to `lazy watch`. A tap wired after target selection would go dark for
 *     exactly the setups that route.
 *  2. What lands on `taskId` is the task REF carried by the credential grant —
 *     the task's code, not its full id. Every consumer filters against that, so
 *     it is written down here rather than left to be rediscovered in the field.
 */
describe('activity attribution composes with per-role routing', () => {
  const AGENT_TOKEN = 'sk-ant-api03-lazy-agent-placeholder';
  const grant: CredentialGrant = {
    token: AGENT_TOKEN, role: 'agent', taskId: 'watch-proxy-traffic',
    label: 'lazy-watch-proxy-traffic', envKey: 'ANTHROPIC_API_KEY',
    createdAt: new Date().toISOString(),
  };

  let primary: ReturnType<typeof Bun.serve>;
  let roleTarget: ReturnType<typeof Bun.serve>;
  let proxy: ReturnType<typeof Bun.serve>;
  let proxyPort: number;
  let bus: ProxyActivityBus;
  let events: ProxyActivityEvent[];
  let reachedRoleTarget: boolean;

  function upstreamServer(port: number, onHit: () => void) {
    return Bun.serve({
      port, hostname: '127.0.0.1',
      async fetch(req) {
        await req.text();
        onHit();
        return Response.json({ type: 'message', model: 'm' });
      },
    });
  }

  beforeAll(async () => {
    const primaryPort = findFreePort();
    const rolePort = findFreePort();
    reachedRoleTarget = false;
    primary = upstreamServer(primaryPort, () => {});
    roleTarget = upstreamServer(rolePort, () => { reachedRoleTarget = true; });

    bus = new ProxyActivityBus();
    events = [];
    bus.subscribe((e) => events.push(e));

    const credentials: ProxyCredentialDeps = {
      lookup: async (token: string) => (token === AGENT_TOKEN ? grant : null),
      targets: new TargetCredentials(),
    };
    proxyPort = findFreePort();
    proxy = createProxyServer(
      {
        port: proxyPort, bind: '127.0.0.1',
        upstream: `http://127.0.0.1:${primaryPort}`,
        fallbacks: [],
        roleUpstreams: { agent: `http://127.0.0.1:${rolePort}` },
      },
      { append: async () => {} } as AuditSink,
      credentials,
      { activity: bus },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  afterAll(() => { primary.stop(); roleTarget.stop(); proxy.stop(); });

  test('role-routed traffic is published, attributed by the grant task ref', async () => {
    events.length = 0;
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': AGENT_TOKEN },
      body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
    });
    expect(response.status).toBe(200);
    await response.text();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(reachedRoleTarget).toBe(true);
    const open = events.find((e) => e.kind === 'open');
    expect(open).toBeDefined();
    expect(open!.role).toBe('agent');
    // The REF, not the full task id — the whole reason filters accept a set of
    // attribution forms rather than one string.
    expect(open!.taskId).toBe('watch-proxy-traffic');
    expect(events.some((e) => e.kind === 'close')).toBe(true);
  });
});
