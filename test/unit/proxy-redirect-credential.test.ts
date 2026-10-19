/**
 * A redirect never carries the real credential to another host.
 *
 * The proxy attaches the credential mapped for the target it calls. If it
 * FOLLOWED a 3xx, the request — real key included — would go wherever the
 * Location header says, past the per-target credential map and the
 * provider-host backstop. Found in review, 2026-10-06.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createProxyServer, type ProxyCredentialDeps } from '../../src/proxy/server';
import { TargetCredentials, anthropicPlacementForKind } from '../../src/proxy/target-credentials';
import { upstreamFetchOptions } from '../../src/proxy/upstream-timeout';
import type { CredentialGrant } from '../../src/proxy/credential-broker';
import type { AgentUpstreamRoute } from '../../src/proxy/agent-upstreams';

const REAL = 'sk-ant-oat01-REAL-SHOULD-NEVER-LEAVE';
const PLACEHOLDER = 'sk-ant-oat01-lazy-redirect-placeholder';

describe('upstream redirects', () => {
  let upstream: ReturnType<typeof Bun.serve>;
  let elsewhere: ReturnType<typeof Bun.serve>;
  let proxy: ReturnType<typeof Bun.serve>;
  let proxyPort: number;
  let elsewhereUrl: string;
  const seenElsewhere: Array<Record<string, string>> = [];
  const seenUpstream: Array<Record<string, string>> = [];

  beforeAll(async () => {
    // Port 0 everywhere: the OS assigns, so suites running side by side never collide.
    elsewhere = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req) => {
      const h: Record<string, string> = {}; req.headers.forEach((v, k) => { h[k] = v; }); seenElsewhere.push(h);
      return Response.json({ from: 'elsewhere' });
    } });
    elsewhereUrl = `http://127.0.0.1:${elsewhere.port}`;
    upstream = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req) => {
      const h: Record<string, string> = {}; req.headers.forEach((v, k) => { h[k] = v; }); seenUpstream.push(h);
      return new Response(null, { status: 307, headers: { location: `${elsewhereUrl}/v1/messages` } });
    } });
    const upstreamUrl = `http://127.0.0.1:${upstream.port}`;
    const targets = new TargetCredentials();
    targets.set(upstreamUrl, async () => ({
      kind: 'credential', placement: anthropicPlacementForKind('oauth', REAL), label: 'CLAUDE_CODE_OAUTH_TOKEN',
    }));
    const grant: CredentialGrant = {
      token: PLACEHOLDER, role: 'agent', taskId: 'task-redirect', label: 'lazy-task-redirect',
      envKey: 'CLAUDE_CODE_OAUTH_TOKEN', profile: 'gw', createdAt: new Date().toISOString(),
    };
    const routes: Record<string, AgentUpstreamRoute> = { gw: { upstream: upstreamUrl, wire: 'anthropic' } };
    const credentials: ProxyCredentialDeps = { lookup: async (t) => (t === PLACEHOLDER ? grant : null), targets };
    proxy = createProxyServer(
      { port: 0, bind: '127.0.0.1', upstream: upstreamUrl, fallbacks: [], retryAfterThreshold: 0,
        liveAgentRouting: async () => ({ routes, targets, profiles: new Set(['gw']) }) },
      { append: async () => {} },
      credentials,
    );
    proxyPort = proxy.port!;
    await new Promise((r) => setTimeout(r, 50));
  });

  afterAll(() => { upstream.stop(); elsewhere.stop(); proxy.stop(); });

  test('every upstream fetch is configured not to follow redirects', () => {
    expect(upstreamFetchOptions(30).redirect).toBe('manual');
    expect(upstreamFetchOptions(0).redirect).toBe('manual');
  });

  // INVARIANT: a cross-origin redirect from an upstream never carries the real
  // credential. The proxy does not follow it; the 3xx goes back to the client,
  // which holds only its placeholder.
  test('a cross-origin 307 is returned to the client and the other host sees nothing', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${PLACEHOLDER}` },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`${elsewhereUrl}/v1/messages`);
    expect(seenUpstream.at(-1)?.authorization).toBe(`Bearer ${REAL}`);
    expect(seenElsewhere).toEqual([]);
  });
});
