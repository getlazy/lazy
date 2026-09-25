/**
 * End-to-end proxy behaviour for an OpenAI-wire profile upstream, against a fake
 * upstream server: routing by grant, JIT credential swap to Bearer, the openai
 * path-allowlist tier, and usage capture on both response shapes.
 *
 * This is where the wire-isolation invariant lives: an openai-wire caller's
 * traffic is judged by the openai tier and scanned by the openai usage
 * extractor, and the Anthropic surface is refused for it — while grant-less
 * traffic on the same proxy still gets the Anthropic primary, untouched.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createProxyServer, type ProxyCredentialDeps } from '../../src/proxy/server';
import { TargetCredentials, bearerPlacement } from '../../src/proxy/target-credentials';
import type { CredentialGrant } from '../../src/proxy/credential-broker';
import type { AuditSink } from '../../src/proxy/audit';
import type { ProxyAuditRecord } from '../../src/storage/types';

const AGENT_TOKEN = 'sk-proj-lazy-agent-openai-placeholder';
const REAL_KEY = 'sk-proj-THE-REAL-OPENAI-KEY';

/**
 * The `[agents.<name>]` profile this launch runs. Routing is per PROFILE, not
 * per role: the grant carries the name, and it is the proxy's only evidence of
 * which upstream and which wire this caller belongs to.
 */
const CODEX_PROFILE = 'work-codex';

const grants: Record<string, CredentialGrant> = {
  [AGENT_TOKEN]: {
    token: AGENT_TOKEN, role: 'agent', taskId: 'task-77', label: 'lazy-task-77',
    envKey: 'OPENAI_API_KEY', profile: CODEX_PROFILE, createdAt: new Date().toISOString(),
  },
};

describe('openai-wire profile upstream through the proxy', () => {
  let upstream: ReturnType<typeof Bun.serve>;
  let primary: ReturnType<typeof Bun.serve>;
  let proxy: ReturnType<typeof Bun.serve>;
  let proxyPort: number;
  let upstreamUrl: string;
  let records: ProxyAuditRecord[];
  let seen: { path: string; headers: Record<string, string> } | null = null;

  const freePort = () => 41000 + Math.floor(Math.random() * 8000);

  beforeAll(async () => {
    records = [];
    const upstreamPort = freePort();
    const primaryPort = freePort();
    upstreamUrl = `http://127.0.0.1:${upstreamPort}`;

    // The fake OpenAI-compatible upstream: records what it saw, answers a chat
    // completion (SSE when asked) or a responses body.
    upstream = Bun.serve({
      port: upstreamPort, hostname: '127.0.0.1',
      async fetch(req) {
        const url = new URL(req.url);
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => { headers[k] = v; });
        seen = { path: url.pathname, headers };
        const body = await req.text();
        const wantsStream = body.includes('"stream":true');
        if (url.pathname.startsWith('/v1/responses')) {
          return Response.json({
            id: 'resp_1', model: 'gpt-5.2-codex',
            usage: { input_tokens: 50, output_tokens: 10, input_tokens_details: { cached_tokens: 20 } },
          });
        }
        if (wantsStream) {
          const sse =
            'data: {"choices":[{"delta":{"content":"hi"}}],"usage":null}\n\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":30,"completion_tokens":5}}\n\n' +
            'data: [DONE]\n\n';
          return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
        }
        return Response.json({
          id: 'chatcmpl-1',
          usage: { prompt_tokens: 12, completion_tokens: 4 },
        });
      },
    });
    primary = Bun.serve({
      port: primaryPort, hostname: '127.0.0.1',
      fetch: async () => Response.json({ type: 'message', from: 'primary' }),
    });

    const targets = new TargetCredentials();
    targets.set(upstreamUrl, async () => ({
      kind: 'credential', placement: bearerPlacement(REAL_KEY), label: 'OPENAI_API_KEY',
    }));
    const credentials: ProxyCredentialDeps = {
      lookup: async (token) => grants[token] ?? null,
      targets,
    };
    const sink: AuditSink = { append: async (r) => { records.push(r); } };
    proxyPort = freePort();
    proxy = createProxyServer(
      {
        port: proxyPort, bind: '127.0.0.1',
        upstream: `http://127.0.0.1:${primaryPort}`,
        agentUpstreams: { [CODEX_PROFILE]: { upstream: upstreamUrl, wire: 'openai' } },
      },
      sink,
      credentials,
    );
    await new Promise(r => setTimeout(r, 50));
  });

  afterAll(() => {
    upstream.stop(); primary.stop(); proxy.stop();
  });

  async function send(path: string, body: unknown, headers: Record<string, string> = {}) {
    return fetch(`http://127.0.0.1:${proxyPort}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${AGENT_TOKEN}`,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  test('a chat completion is routed to the profile upstream with the real Bearer key', async () => {
    seen = null;
    const res = await send('/v1/chat/completions', { model: 'gpt-5.2', messages: [] });
    expect(res.status).toBe(200);
    expect(seen!.path).toBe('/v1/chat/completions');
    // JIT swap: the upstream sees the REAL key; the placeholder never travels.
    expect(seen!.headers.authorization).toBe(`Bearer ${REAL_KEY}`);
    expect(JSON.stringify(seen!.headers)).not.toContain(AGENT_TOKEN);
  });

  test('non-streaming usage lands on the audit record, cached tokens split out', async () => {
    records.length = 0;
    await send('/v1/responses', { model: 'gpt-5.2-codex', input: 'hi' });
    await new Promise(r => setTimeout(r, 100));
    const record = records.find(r => r.endpoint === 'responses');
    expect(record).toBeDefined();
    expect(record!.taskId).toBe('task-77');
    expect(record!.upstream).toBe(upstreamUrl);
    expect(record!.model).toBe('gpt-5.2-codex');
    expect(record!.usage).toEqual({
      inputTokens: 30,
      outputTokens: 10,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: 20,
    });
  });

  test('streaming usage is captured by the openai scanner from the tee', async () => {
    records.length = 0;
    const res = await send('/v1/chat/completions', { model: 'gpt-5.2', stream: true, messages: [] });
    await res.text(); // drain the stream so the tee finishes
    await new Promise(r => setTimeout(r, 100));
    const record = records.find(r => r.endpoint === 'chat_completions');
    expect(record).toBeDefined();
    expect(record!.usage).toEqual({
      inputTokens: 30,
      outputTokens: 5,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    });
  });

  // INVARIANT: wire isolation. The Anthropic surface is refused for an
  // openai-wire caller (never silently forwarded to an upstream that would
  // 404), and the refusal names the OpenAI surface that IS available.
  test('the Anthropic messages path is refused on the openai tier', async () => {
    seen = null;
    const res = await send('/v1/messages', { model: 'claude-opus-5', messages: [] });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toContain('/v1/chat/completions');
    expect(seen).toBeNull();
  });

  // INVARIANT: the openai inference paths do not open up on the PRIMARY tier —
  // grant-less traffic is Anthropic-bound and gets the Anthropic surface only.
  test('grant-less /v1/chat/completions is refused on the primary tier', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.2', messages: [] }),
    });
    expect(res.status).toBe(403);
  });
});
