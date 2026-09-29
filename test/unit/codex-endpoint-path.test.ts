/**
 * The path a codex request actually reaches its upstream on.
 *
 * codex's `base_url` always ends in `/v1` for a non-ChatGPT upstream
 * (codexBaseUrlPrefix), codex appends `/responses`, and the proxy forwards
 * `endpoint + path` verbatim. So a profile endpoint must NOT carry its own
 * `/v1`: OpenRouter's is `https://openrouter.ai/api`, not `.../api/v1`.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createProxyServer, type ProxyCredentialDeps } from '../../src/proxy/server';
import { TargetCredentials } from '../../src/proxy/target-credentials';
import { codexProxyEnvVars } from '../../src/proxy/codex-route';
import { agentUpstreamMap } from '../../src/proxy/agent-upstreams';
import type { CredentialGrant } from '../../src/proxy/credential-broker';
import type { AuditSink } from '../../src/proxy/audit';
import { resolveAgentProfiles } from '../../src/config/agent-profiles';

describe('codex profile endpoint path through the proxy', () => {
  const TOKEN = 'sk-lazy-codex-placeholder';
  const freePort = () => 41000 + Math.floor(Math.random() * 8000);
  let upstream: ReturnType<typeof Bun.serve>;
  let proxyPort: number;
  let upstreamUrl: string;
  let paths: string[];

  function startProxy(endpointPath: string) {
    const grants: Record<string, CredentialGrant> = {
      [TOKEN]: {
        token: TOKEN, role: 'agent', taskId: 't', label: 'lazy-task-t',
        envKey: 'OPENAI_API_KEY', profile: 'router-codex', createdAt: new Date().toISOString(),
      },
    };
    const credentials: ProxyCredentialDeps = {
      lookup: async (t: string) => grants[t] ?? null,
      targets: new TargetCredentials(),
    };
    const sink: AuditSink = { append: async () => {} };
    proxyPort = freePort();
    return createProxyServer(
      {
        port: proxyPort, bind: '127.0.0.1',
        upstream: 'http://127.0.0.1:1',
        fallbacks: [],
        retryAfterThreshold: 0,
        // Built from a real codex profile, so the proof runs config → proxy.
        agentUpstreams: agentUpstreamMap({
          agents: {
            'router-codex': {
              harness: 'codex', model: 'x-ai/grok-4',
              endpoint: upstreamUrl + endpointPath, credential: 'none',
            },
          },
        } as never),
      },
      sink,
      credentials,
    );
  }

  beforeAll(() => {
    paths = [];
    const port = freePort();
    upstreamUrl = `http://127.0.0.1:${port}`;
    upstream = Bun.serve({
      port, hostname: '127.0.0.1',
      async fetch(req) {
        await req.text();
        paths.push(new URL(req.url).pathname);
        return Response.json({ id: 'r', object: 'response', output: [] });
      },
    });
  });
  afterAll(() => upstream.stop());

  // What codex does: POST <base_url>/responses, base_url from the launch env.
  async function codexRequest(endpointPath: string): Promise<string | undefined> {
    const proxy = startProxy(endpointPath);
    try {
      await new Promise(r => setTimeout(r, 30));
      const [{ value: baseUrl }] = codexProxyEnvVars(`http://127.0.0.1:${proxyPort}`, upstreamUrl + endpointPath);
      paths = [];
      await fetch(`${baseUrl}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ model: 'x-ai/grok-4', input: 'hi' }),
      });
      return paths[0];
    } finally {
      proxy.stop();
    }
  }

  // INVARIANT: a codex endpoint is the API ROOT without `/v1` — lazy adds it.
  // An endpoint ending in `/v1` doubles it (`/api/v1/v1/responses`), a path no
  // OpenAI-compatible gateway serves.
  test('the documented OpenRouter endpoint (/api) reaches /api/v1/responses', async () => {
    expect(await codexRequest('/api')).toBe('/api/v1/responses');
  });

  // The proxy forwards the configured endpoint path verbatim by design — lazy
  // WARNS at load (below) rather than rewriting a route. This pins that the
  // warning's premise holds: such an endpoint really does reach a doubled path.
  test('the proxy forwards a /v1-suffixed endpoint verbatim, which is why lazy warns', async () => {
    expect(await codexRequest('/api/v1')).toBe('/api/v1/v1/responses');
  });
});

describe('load-time warning for a codex endpoint ending in /v1', () => {
  function warningsFor(harness: string, endpoint: string): string[] {
    const out: string[] = [];
    resolveAgentProfiles({ p: { harness, model: 'm', endpoint } }, (m) => out.push(m));
    return out;
  }

  test('warns, naming the corrected endpoint, and does not rewrite it', () => {
    const out: string[] = [];
    const profiles = resolveAgentProfiles(
      { p: { harness: 'codex', model: 'm', endpoint: 'https://openrouter.ai/api/v1/' } },
      (m) => out.push(m),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('endpoint = "https://openrouter.ai/api"');
    expect(profiles.get('p')!.endpoint).toBe('https://openrouter.ai/api/v1');
  });

  test('silent for a correct codex endpoint and for other harnesses', () => {
    expect(warningsFor('codex', 'https://openrouter.ai/api')).toEqual([]);
    expect(warningsFor('pi', 'https://openrouter.ai/api/v1')).toEqual([]);
    // No /v1 prefix is added for the ChatGPT backend, so nothing to warn about.
    expect(warningsFor('codex', 'https://chatgpt.com/backend-api/codex')).toEqual([]);
  });
});
