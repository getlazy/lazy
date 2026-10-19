/**
 * A tier switch between credential FORMS: tier 0 is an Anthropic subscription
 * (OAuth bearer + `anthropic-beta: oauth-2025-04-20`), tier 1 a third-party
 * Anthropic-wire gateway paid by its own API key (`x-api-key`).
 *
 * The harness is launched on tier 0, so every request it sends carries the
 * OAuth form — including the requests the proxy routes to tier 1. What tier 1
 * receives must describe tier 1's credential and nothing of tier 0's.
 *
 * Field report 2026-10-06: the first request after such a switch was answered
 * 401 "Invalid or revoked API key" by the gateway, while a non-tiered profile
 * on the same endpoint and key — launched in the API-key form, so it never sent
 * the OAuth flag — worked.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createProxyServer, type ProxyCredentialDeps } from '../../src/proxy/server';
import { TargetCredentials, anthropicPlacementForKind, ANTHROPIC_OAUTH_BETA } from '../../src/proxy/target-credentials';
import { UsageLimitTracker } from '../../src/proxy/usage-limits';
import type { CredentialGrant } from '../../src/proxy/credential-broker';
import type { AuditSink } from '../../src/proxy/audit';
import type { ProxyAuditRecord } from '../../src/storage/types';
import type { AgentUpstreamRoute } from '../../src/proxy/agent-upstreams';

const SUBSCRIPTION = 'sk-ant-oat01-REAL-SUBSCRIPTION';
const GATEWAY_KEY = 'luna-REAL-GATEWAY-KEY';
const PLACEHOLDER = 'sk-ant-oat01-lazy-form-placeholder';

describe('tier switch across credential forms', () => {
  let anthropic: ReturnType<typeof Bun.serve>;
  let gateway: ReturnType<typeof Bun.serve>;
  let proxy: ReturnType<typeof Bun.serve>;
  let proxyPort: number;
  let anthropicFull = false;
  const seenByGateway: Array<Record<string, string>> = [];
  const records: ProxyAuditRecord[] = [];
  const tracker = new UsageLimitTracker();

  beforeAll(async () => {
    // Port 0 everywhere: the OS assigns, so suites running side by side never collide.
    anthropic = Bun.serve({
      port: 0, hostname: '127.0.0.1',
      fetch: () => Response.json({ from: 'anthropic' }, {
        headers: anthropicFull
          ? {
            'anthropic-ratelimit-unified-5h-utilization': '0.97',
            'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600),
          }
          : {},
      }),
    });
    gateway = Bun.serve({
      port: 0, hostname: '127.0.0.1',
      fetch: (req) => {
        const h: Record<string, string> = {};
        req.headers.forEach((v, k) => { h[k] = v; });
        seenByGateway.push(h);
        // What an Anthropic-compatible gateway in front of Anthropic does with
        // the OAuth beta flag: it reads the request as subscription-authed.
        if ((h['anthropic-beta'] ?? '').includes(ANTHROPIC_OAUTH_BETA)) {
          return Response.json({ type: 'error', error: { type: 'authentication_error', message: 'Invalid or revoked API key' } }, { status: 401 });
        }
        return Response.json({ from: 'gateway' });
      },
    });

    const anthropicUrl = `http://127.0.0.1:${anthropic.port}`;
    const gatewayUrl = `http://127.0.0.1:${gateway.port}`;
    const targets = new TargetCredentials();
    targets.set(anthropicUrl, async () => ({
      kind: 'credential', placement: anthropicPlacementForKind('oauth', SUBSCRIPTION), label: 'CLAUDE_CODE_OAUTH_TOKEN',
    }));
    targets.set(gatewayUrl, async () => ({
      kind: 'credential', placement: anthropicPlacementForKind('api-key', GATEWAY_KEY), label: 'LAZY_CREDENTIAL_LUNAROUTE_API_KEY',
    }));
    const grant: CredentialGrant = {
      token: PLACEHOLDER, role: 'agent', taskId: 'task-form', label: 'lazy-task-form',
      envKey: 'CLAUDE_CODE_OAUTH_TOKEN', profile: 'claude-complex', createdAt: new Date().toISOString(),
    };
    const routes: Record<string, AgentUpstreamRoute> = {
      'claude-complex': {
        upstream: anthropicUrl, wire: 'anthropic', tiers: [
          { index: 0, endpoint: 'anthropic-subscription', upstream: anthropicUrl, model: 'claude-opus-5-5', usage: 'claude', threshold: 95 },
          { index: 1, endpoint: 'lunaroute', upstream: gatewayUrl, model: 'glm-5.3', usage: null, threshold: null },
        ],
      },
    };
    const credentials: ProxyCredentialDeps = {
      lookup: async (t) => (t === PLACEHOLDER ? grant : null),
      targets,
    };
    const sink: AuditSink = { append: async (r) => { records.push(r); } };
    proxy = createProxyServer(
      {
        port: 0, bind: '127.0.0.1', upstream: anthropicUrl, fallbacks: [], retryAfterThreshold: 0,
        liveAgentRouting: async () => ({ routes, targets, profiles: new Set(['claude-complex']) }),
      },
      sink, credentials, { usageLimits: tracker },
    );
    proxyPort = proxy.port!;
    await new Promise((r) => setTimeout(r, 50));
  });

  afterAll(() => { anthropic.stop(); gateway.stop(); proxy.stop(); });

  /** What Claude Code sends when launched on a subscription. */
  const send = async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${PLACEHOLDER}`,
        'anthropic-beta': `claude-code-20250219,${ANTHROPIC_OAUTH_BETA},interleaved-thinking-2025-05-14`,
      },
      body: JSON.stringify({ model: 'claude-opus-5-5', messages: [] }),
    });
    await new Promise((r) => setTimeout(r, 30));
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  // INVARIANT: a request routed to a tier paid by an API key carries that key
  // and NOTHING of the OAuth form the harness was launched with — no bearer,
  // no `oauth-2025-04-20` beta flag. The flag describes the credential, not the
  // endpoint; leaving it on beside an x-api-key tells an Anthropic-compatible
  // gateway to treat the request as subscription-authed, and it answers 401.
  test('the gateway tier receives its own key and no OAuth beta flag', async () => {
    expect((await send()).json).toMatchObject({ from: 'anthropic' });
    anthropicFull = true;
    await send(); // this answer carries 97%
    const switched = await send();
    expect(switched.status).toBe(200);
    expect(switched.json).toMatchObject({ from: 'gateway' });

    const last = seenByGateway.at(-1)!;
    expect(last['x-api-key']).toBe(GATEWAY_KEY);
    expect(last.authorization).toBeUndefined();
    expect(last['anthropic-beta'] ?? '').not.toContain(ANTHROPIC_OAUTH_BETA);
    // The client's own feature flags survive.
    expect(last['anthropic-beta']).toContain('claude-code-20250219');
    expect(last['anthropic-beta']).toContain('interleaved-thinking-2025-05-14');
    expect(JSON.stringify(seenByGateway)).not.toContain(SUBSCRIPTION);
  });

  // INVARIANT: every request a tiered profile sends is recorded with the tier,
  // endpoint, upstream, model actually sent and the NAME of the credential
  // attached — so "which upstream refused which credential" is answerable from
  // the audit log alone.
  test('the audit record names tier, endpoint, upstream, model sent and credential', async () => {
    await send();
    await new Promise((r) => setTimeout(r, 50));
    const last = records.at(-1)!;
    expect(last).toMatchObject({
      servedByEndpoint: 'lunaroute',
      tierIndex: 1,
      model: 'glm-5.3',
      credential: 'credential:LAZY_CREDENTIAL_LUNAROUTE_API_KEY',
    });
    expect(last.upstream).toContain('127.0.0.1');
    expect(records.some((r) => r.servedByEndpoint === 'anthropic-subscription' && r.credential === 'credential:CLAUDE_CODE_OAUTH_TOKEN')).toBe(true);
  });
});

describe('a credential-free tier', () => {
  // INVARIANT: the OAuth beta flag never reaches a target that gets no
  // credential (a local tier): it describes a bearer that is not there.
  test('receives neither the placeholder nor the OAuth flag', async () => {
    const seen: Array<Record<string, string>> = [];
    const local = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req) => {
      const h: Record<string, string> = {}; req.headers.forEach((v, k) => { h[k] = v; }); seen.push(h);
      return Response.json({ from: 'local' });
    } });
    const url = `http://127.0.0.1:${local.port}`;
    const targets = new TargetCredentials();
    const grant: CredentialGrant = {
      token: PLACEHOLDER, role: 'agent', taskId: 'task-local', label: 'lazy-task-local',
      envKey: 'CLAUDE_CODE_OAUTH_TOKEN', profile: 'local', createdAt: new Date().toISOString(),
    };
    const routes: Record<string, AgentUpstreamRoute> = { local: { upstream: url, wire: 'anthropic' } };
    const proxy = createProxyServer(
      { port: 0, bind: '127.0.0.1', upstream: url, fallbacks: [], retryAfterThreshold: 0,
        liveAgentRouting: async () => ({ routes, targets, profiles: new Set(['local']) }) },
      { append: async () => {} },
      { lookup: async (t) => (t === PLACEHOLDER ? grant : null), targets },
    );
    try {
      await new Promise((r) => setTimeout(r, 50));
      const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${PLACEHOLDER}`,
          'anthropic-beta': `claude-code-20250219,${ANTHROPIC_OAUTH_BETA}` },
        body: JSON.stringify({ model: 'q', messages: [] }),
      });
      expect(res.status).toBe(200);
      const h = seen.at(-1)!;
      expect(h.authorization).toBeUndefined();
      expect(h['anthropic-beta']).toBe('claude-code-20250219');
    } finally { local.stop(); proxy.stop(); }
  });
});
