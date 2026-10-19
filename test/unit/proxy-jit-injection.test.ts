/**
 * JIT credential injection on the Anthropic path, end to end through a live
 * proxy: a placeholder goes in, the real credential comes out the other side.
 *
 * INVARIANT (the property the whole feature exists for): the placeholder the
 * agent holds must NEVER reach an upstream, and the real credential must never
 * reach a target that was not configured to receive it. Both are asserted as
 * absences here — a regression would otherwise look like a passing test suite.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createProxyServer, type ProxyCredentialDeps } from '../../src/proxy/server';
import { TargetCredentials, anthropicPlacement } from '../../src/proxy/target-credentials';
import type { CredentialGrant } from '../../src/proxy/credential-broker';
import type { AuditSink } from '../../src/proxy/audit';
import type { ProxyAuditRecord } from '../../src/storage/types';

const PLACEHOLDER = 'sk-ant-api03-lazy-abcdef';
const REAL = 'sk-ant-oat01-THE-REAL-USER-TOKEN';
const FALLBACK_KEY = 'sk-ant-api03-FALLBACK-ACCOUNT';

const GRANT: CredentialGrant = {
  token: PLACEHOLDER,
  role: 'agent',
  taskId: 'task-42',
  label: 'lazy-task-42',
  envKey: 'ANTHROPIC_API_KEY',
  createdAt: new Date().toISOString(),
};

type Seen = { headers: Record<string, string>; body: unknown };

describe('proxy JIT credential injection (Anthropic path)', () => {
  let primary: ReturnType<typeof Bun.serve>;
  let fallback: ReturnType<typeof Bun.serve>;
  let noCredTarget: ReturnType<typeof Bun.serve>;
  let proxy: ReturnType<typeof Bun.serve>;
  let proxyPort: number;
  let records: ProxyAuditRecord[];
  let seen: Record<string, Seen | null>;
  /** Flipped per test to make the primary fail over. */
  let primaryStatus = 200;

  function upstream(name: string, status: () => number) {
    return Bun.serve({
      port: 0, hostname: '127.0.0.1',
      async fetch(req) {
        const body = await req.json().catch(() => null);
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => { headers[k] = v; });
        seen[name] = { headers, body };
        const code = status();
        if (code !== 200) return new Response('overloaded', { status: code });
        return Response.json({ type: 'message', model: 'm', from: name });
      },
    });
  }

  beforeAll(async () => {
    seen = {};
    records = [];
    primary = upstream('primary', () => primaryStatus);
    fallback = upstream('fallback', () => 200);
    noCredTarget = upstream('nocred', () => 200);
    const primaryPort = primary.port!;
    const fallbackPort = fallback.port!;

    const targets = new TargetCredentials();
    targets.set(`http://127.0.0.1:${primaryPort}`, async () => ({
      kind: 'credential',
      // The real credential is an OAuth token even though the agent presented
      // an api-key-shaped placeholder — the TARGET's form wins.
      placement: anthropicPlacement('CLAUDE_CODE_OAUTH_TOKEN', REAL),
      label: 'CLAUDE_CODE_OAUTH_TOKEN',
    }));
    targets.set(`http://127.0.0.1:${fallbackPort}`, async () => ({
      kind: 'credential',
      placement: anthropicPlacement('ANTHROPIC_API_KEY', FALLBACK_KEY),
      label: 'ANTHROPIC_API_KEY',
    }));
    // noCredTarget is deliberately NOT registered: an unmapped target gets
    // nothing, which is the default for a `[[proxy.fallback]]` entry.

    const credentials: ProxyCredentialDeps = {
      lookup: async (token: string) => (token === PLACEHOLDER ? GRANT : null),
      targets,
    };

    const sink: AuditSink = { append: async (r) => { records.push(r); } };
    proxy = createProxyServer(
      {
        port: 0, bind: '127.0.0.1',
        upstream: `http://127.0.0.1:${primaryPort}`,
        fallbacks: [{ upstream: `http://127.0.0.1:${fallbackPort}` }],
        retryAfterThreshold: 0,
      },
      sink,
      credentials,
    );
    proxyPort = proxy.port!;
    await new Promise(r => setTimeout(r, 50));
  });

  afterAll(() => {
    primary.stop(); fallback.stop(); noCredTarget.stop(); proxy.stop();
  });

  async function send(headers: Record<string, string>) {
    return fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
    });
  }

  test('the placeholder is swapped for the real credential, in the target form', async () => {
    primaryStatus = 200;
    seen.primary = null;
    const res = await send({ 'x-api-key': PLACEHOLDER });
    expect(res.status).toBe(200);

    // The real credential arrived in the form the TARGET wants...
    expect(seen.primary!.headers.authorization).toBe(`Bearer ${REAL}`);
    // ...and the slot the placeholder rode in is gone, not merely overwritten.
    expect(seen.primary!.headers['x-api-key']).toBeUndefined();
    // The placeholder itself never left this machine.
    expect(JSON.stringify(seen.primary)).not.toContain(PLACEHOLDER);
  });

  // INVARIANT: attribution comes from the token, not from headers the agent
  // controls. Before JIT injection the proxy believed whatever x-lazy-* said.
  test('audit attribution comes from the grant, not from forgeable headers', async () => {
    primaryStatus = 200;
    records.length = 0;
    await send({
      'x-api-key': PLACEHOLDER,
      'x-lazy-role': 'builder',
      'x-lazy-task-id': 'someone-elses-task',
    });
    await new Promise(r => setTimeout(r, 30));
    expect(records[0]?.role).toBe('agent');
    expect(records[0]?.taskId).toBe('task-42');
  });

  // On a reroute the credential is looked up for the target actually being
  // called — the agent's presented value is never simply passed along.
  test('a fallback target gets ITS credential, not the primary one', async () => {
    primaryStatus = 529;
    seen.fallback = null;
    const res = await send({ 'x-api-key': PLACEHOLDER });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ from: 'fallback' });

    expect(seen.fallback!.headers['x-api-key']).toBe(FALLBACK_KEY);
    expect(seen.fallback!.headers.authorization).toBeUndefined();
    expect(JSON.stringify(seen.fallback)).not.toContain(REAL);
    expect(JSON.stringify(seen.fallback)).not.toContain(PLACEHOLDER);
    primaryStatus = 200;
  });

  // A placeholder that fails lookup is dead: revoked with its task, or forged.
  // It must not be forwarded — upstream would reject it as if the human's own
  // credential were bad.
  test('an unknown placeholder is a 401 naming the remedy', async () => {
    seen.primary = null;
    const res = await send({ 'x-api-key': 'sk-ant-api03-lazy-revoked' });
    expect(res.status).toBe(401);
    const body = await res.json() as { error?: { type?: string; message?: string } };
    expect(body.error?.type).toBe('authentication_error');
    expect(body.error?.message).toMatch(/lazy/i);
    expect(seen.primary).toBeNull();
  });

  // Claude Code probes before it authenticates; 401-ing that would break
  // startup. Nothing is added on the way through either.
  test('an unauthenticated request is forwarded with no credential added', async () => {
    primaryStatus = 200;
    seen.primary = null;
    const res = await send({});
    expect(res.status).toBe(200);
    expect(seen.primary!.headers['x-api-key']).toBeUndefined();
    expect(seen.primary!.headers.authorization).toBeUndefined();
    expect(JSON.stringify(seen.primary)).not.toContain(REAL);
  });

  // A real credential presented by something with no grant (a host session on
  // its own login) is not lazy's to touch.
  test('a real credential with no grant is forwarded untouched', async () => {
    primaryStatus = 200;
    seen.primary = null;
    await send({ 'x-api-key': 'sk-ant-api03-someones-own-key' });
    expect(seen.primary!.headers['x-api-key']).toBe('sk-ant-api03-someones-own-key');
  });
});

describe('proxy JIT injection with an unmapped target', () => {
  // INVARIANT: an unmapped target receives NO credential. A fallback is a
  // different server — forwarding the human's Anthropic credential to it by
  // default is exactly the leak per-target lookup exists to prevent.
  test('a target with no credential gets the placeholder stripped, not passed', async () => {
    let seen: Record<string, string> = {};
    const up = Bun.serve({
      port: 0, hostname: '127.0.0.1',
      async fetch(req) {
        await req.text();
        seen = {};
        req.headers.forEach((v, k) => { seen[k] = v; });
        return Response.json({ ok: true });
      },
    });
    const port = up.port!;
    const proxy = createProxyServer(
      { port: 0, bind: '127.0.0.1', upstream: `http://127.0.0.1:${port}` },
      { append: async () => {} },
      {
        lookup: async (t: string) => (t === PLACEHOLDER ? GRANT : null),
        targets: new TargetCredentials(),  // nothing registered
      },
    );
    const proxyPort = proxy.port!;
    await new Promise(r => setTimeout(r, 50));
    try {
      const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': PLACEHOLDER },
        body: JSON.stringify({ model: 'm', messages: [] }),
      });
      expect(res.status).toBe(200);
      expect(seen['x-api-key']).toBeUndefined();
      expect(JSON.stringify(seen)).not.toContain(PLACEHOLDER);
    } finally {
      up.stop(); proxy.stop();
    }
  });
});

describe('a credential that cannot be resolved RIGHT NOW', () => {
  // INVARIANT: a transient failure to resolve a credential (token refresh timed
  // out, DNS blip, 5xx) is a retryable 503 that records NO refusal against the
  // credential. A 401 + refusal is reserved for a credential that is really
  // refused: a 401 parks the turn as an auth failure, files an alert and marks
  // the connection broken, which a network blip must never do.
  test('transient → 503 with no refusal; refused → 401 with the refusal', async () => {
    let outcome: { kind: 'missing'; reason: string; transient?: true } = { kind: 'missing', reason: 'timed out', transient: true };
    const upstreamUrl = 'http://127.0.0.1:9';
    const targets = new TargetCredentials();
    targets.set(upstreamUrl, async () => outcome);
    const records: ProxyAuditRecord[] = [];
    const proxy = createProxyServer(
      { port: 0, bind: '127.0.0.1', upstream: upstreamUrl, fallbacks: [], retryAfterThreshold: 0 },
      { append: async (r) => { records.push(r); } },
      { lookup: async (t: string) => (t === PLACEHOLDER ? GRANT : null), targets },
    );
    try {
      const send = () => fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': PLACEHOLDER },
        body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
      });
      const transient = await send();
      expect(transient.status).toBe(503);
      expect(await transient.text()).toContain('timed out');
      outcome = { kind: 'missing', reason: 'refresh_token_reused' };
      const refused = await send();
      expect(refused.status).toBe(401);
      await new Promise(r => setTimeout(r, 50));
      expect(records.map(r => [r.status, Boolean(r.refusedCredential)])).toEqual([[503, false], [401, true]]);
    } finally {
      proxy.stop();
    }
  });
});
