/**
 * Tiered agent profiles through the REAL proxy: per-request tier choice, the
 * model rewrite, credential routing across a mid-turn switch in BOTH
 * directions, the thinking-history handling, the switch record, and the
 * member endpoint checks.
 *
 * Three fake upstreams stand in for Anthropic (sends the subscription
 * `unified-*` usage headers the test dictates), Fireworks and a local Ollama.
 * The proxy's own credential map is the one under test: Anthropic's origin is
 * mapped to the Claude token, Fireworks' to its key, Ollama's to nothing.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createProxyServer, type ProxyCredentialDeps } from '../../src/proxy/server';
import { TargetCredentials, anthropicPlacement, bearerPlacement } from '../../src/proxy/target-credentials';
import { UsageLimitTracker } from '../../src/proxy/usage-limits';
import type { CredentialGrant } from '../../src/proxy/credential-broker';
import type { AuditSink } from '../../src/proxy/audit';
import type { ProxyAuditRecord } from '../../src/storage/types';
import type { AgentUpstreamRoute, TierRoute } from '../../src/proxy/agent-upstreams';
import type { TierSwitchEvent } from '../../src/proxy/tier-select';

const CLAUDE_REAL = 'sk-ant-oat01-REAL-CLAUDE-SUBSCRIPTION-TOKEN';
const FIREWORKS_REAL = 'fw_REAL-FIREWORKS-KEY';
const PLACEHOLDER = 'sk-ant-api03-lazy-tiered-placeholder';

interface Seen { headers: Record<string, string>; body: Record<string, unknown> }

describe('tiered profile through the proxy', () => {
  let anthropic: ReturnType<typeof Bun.serve>;
  let fireworks: ReturnType<typeof Bun.serve>;
  let ollama: ReturnType<typeof Bun.serve>;
  let proxy: ReturnType<typeof Bun.serve>;
  let proxyPort: number;
  let anthropicUrl: string;
  let fireworksUrl: string;
  let ollamaUrl: string;
  let seen: Record<'anthropic' | 'fireworks' | 'ollama', Seen[]>;
  let records: ProxyAuditRecord[];
  let switches: TierSwitchEvent[];
  /** Usage headers the fake Anthropic answers with. */
  let anthropicUsage: Record<string, string>;
  let routes: Record<string, AgentUpstreamRoute>;
  let memberResolver: ProxyCredentialDeps['member'] | null = null;
  let credentialUnavailableAfterTierChoice = false;
  let credentialLookups = 0;
  const tracker = new UsageLimitTracker();

  const grant: CredentialGrant = {
    token: PLACEHOLDER, role: 'agent', taskId: 'task-tiered', label: 'lazy-task-tiered',
    envKey: 'ANTHROPIC_API_KEY', profile: 'chain', createdAt: new Date().toISOString(),
  };

  function fake(name: 'anthropic' | 'fireworks' | 'ollama', extraHeaders: () => Record<string, string>) {
    return Bun.serve({
      port: 0, hostname: '127.0.0.1',
      async fetch(req) {
        const text = await req.text();
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => { headers[k] = v; });
        seen[name].push({ headers, body: text ? JSON.parse(text) : {} });
        return Response.json({ type: 'message', model: 'm', from: name }, { headers: extraHeaders() });
      },
    });
  }

  function tiers(threeTier: boolean): TierRoute[] {
    const out: TierRoute[] = [
      { index: 0, endpoint: 'anthropic-sub', upstream: anthropicUrl, model: 'claude-sonnet-5-5', usage: 'claude', threshold: 95 },
      { index: 1, endpoint: 'fireworks', upstream: fireworksUrl, model: 'firerouter/opus', usage: null, threshold: null },
    ];
    if (!threeTier) return [out[0]!, { index: 1, endpoint: 'ollama-local', upstream: ollamaUrl, model: 'qwen3-coder', usage: null, threshold: null }];
    out.push({ index: 2, endpoint: 'ollama-local', upstream: ollamaUrl, model: 'qwen3-coder', usage: null, threshold: null });
    return out;
  }

  beforeAll(async () => {
    seen = { anthropic: [], fireworks: [], ollama: [] };
    anthropic = fake('anthropic', () => anthropicUsage);
    fireworks = fake('fireworks', () => ({}));
    ollama = fake('ollama', () => ({}));
    anthropicUrl = `http://127.0.0.1:${anthropic.port!}`;
    fireworksUrl = `http://127.0.0.1:${fireworks.port!}`;
    ollamaUrl = `http://127.0.0.1:${ollama.port!}`;

    const targets = new TargetCredentials();
    targets.set(anthropicUrl, async () => {
      if (credentialUnavailableAfterTierChoice && ++credentialLookups > 2) {
        return { kind: 'missing', reason: 'credential removed mid-request' };
      }
      return {
        kind: 'credential', placement: anthropicPlacement('CLAUDE_CODE_OAUTH_TOKEN', CLAUDE_REAL), label: 'CLAUDE_CODE_OAUTH_TOKEN',
      };
    });
    targets.set(fireworksUrl, async () => ({
      kind: 'credential', placement: bearerPlacement(FIREWORKS_REAL), label: 'FIREWORKS_API_KEY',
    }));
    // ollamaUrl deliberately unmapped: a local server gets no credential.

    const credentials: ProxyCredentialDeps = {
      lookup: async (token) => (token === PLACEHOLDER ? grant : null),
      targets,
      member: async (g, origin) => (memberResolver ? memberResolver(g, origin) : null),
    };
    const sink: AuditSink = { append: async (r) => { records.push(r); } };
    proxy = createProxyServer(
      {
        port: 0, bind: '127.0.0.1', upstream: anthropicUrl, fallbacks: [], retryAfterThreshold: 0,
        liveAgentRouting: async () => ({ routes, targets, profiles: new Set(['chain']) }),
      },
      sink,
      credentials,
      { usageLimits: tracker, onTierSwitch: (e) => switches.push(e) },
    );
    proxyPort = proxy.port!;
    await new Promise((r) => setTimeout(r, 50));
  });

  afterAll(() => { anthropic.stop(); fireworks.stop(); ollama.stop(); proxy.stop(); });

  let taskCounter = 0;
  beforeEach(() => {
    // A fresh task per test: the proxy's per-task tier state (last tier, which
    // providers served the session) is real and must not leak between cases.
    taskCounter += 1;
    grant.taskId = `task-tiered-${taskCounter}`;
    seen = { anthropic: [], fireworks: [], ollama: [] };
    records = [];
    switches = [];
    anthropicUsage = {};
    memberResolver = null;
    credentialUnavailableAfterTierChoice = false;
    credentialLookups = 0;
    tracker.resetForTest();
    routes = { chain: { upstream: anthropicUrl, wire: 'anthropic', tiers: tiers(true) } };
  });

  async function send(body: Record<string, unknown> = { model: 'claude-sonnet-5-5', messages: [] }) {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${PLACEHOLDER}` },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    // Let the audit queue fold the response's usage reading in.
    await new Promise((r) => setTimeout(r, 30));
    return { status: res.status, json };
  }

  /** Every credential value an upstream received, across all its requests. */
  const credentialsSeenBy = (name: 'anthropic' | 'fireworks' | 'ollama') =>
    seen[name].flatMap((s) => [s.headers.authorization ?? '', s.headers['x-api-key'] ?? '']).join('\n');

  const full = (resetInSeconds: number) => ({
    'anthropic-ratelimit-unified-5h-utilization': '0.97',
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + resetInSeconds),
  });

  // INVARIANT: the switching rule — first tier under its threshold wins, per
  // request, and a full tier hands over MID-TURN with no launch in between. A
  // tier that is full stays full until its window's reset passes, then the
  // chain climbs back by itself. Without this, a tiered profile is either a
  // fixed profile or a flapping one.
  test('falls to the next tier when the window fills, and climbs back once it resets', async () => {
    expect((await send()).json).toMatchObject({ from: 'anthropic' });
    anthropicUsage = full(2);
    expect((await send()).json).toMatchObject({ from: 'anthropic' }); // this response carries 97%
    expect((await send()).json).toMatchObject({ from: 'fireworks' });
    expect((await send()).json).toMatchObject({ from: 'fireworks' });
    anthropicUsage = {};
    await new Promise((r) => setTimeout(r, 2200)); // the 5h window "resets"
    expect((await send()).json).toMatchObject({ from: 'anthropic' });
  }, 15_000);

  // INVARIANT: credentials are resolved per request, per endpoint, across a
  // mid-turn switch in BOTH directions: the Claude subscription token never
  // reaches a non-Anthropic endpoint, the Fireworks key never reaches
  // Anthropic, and the local server gets no credential at all — not even the
  // placeholder. A switch that reused the previous request's headers would leak
  // one provider's secret to another.
  test('a Claude token never reaches a non-Anthropic tier, in either direction of a switch', async () => {
    routes = { chain: { upstream: anthropicUrl, wire: 'anthropic', tiers: tiers(false) } }; // anthropic → ollama
    await send();
    anthropicUsage = full(2);
    await send();
    await send(); // down to ollama
    anthropicUsage = {};
    await new Promise((r) => setTimeout(r, 2200));
    await send(); // back up to anthropic
    routes = { chain: { upstream: anthropicUrl, wire: 'anthropic', tiers: tiers(true) } }; // anthropic → fireworks
    anthropicUsage = full(2);
    await send();
    await send(); // down to fireworks

    expect(seen.ollama.length).toBeGreaterThan(0);
    expect(seen.fireworks.length).toBeGreaterThan(0);
    expect(seen.anthropic.length).toBeGreaterThan(2);
    expect(credentialsSeenBy('ollama')).not.toContain(CLAUDE_REAL);
    expect(credentialsSeenBy('ollama')).not.toContain(PLACEHOLDER);
    expect(credentialsSeenBy('ollama')).not.toContain(FIREWORKS_REAL);
    expect(credentialsSeenBy('fireworks')).not.toContain(CLAUDE_REAL);
    expect(credentialsSeenBy('fireworks')).toContain(FIREWORKS_REAL);
    expect(credentialsSeenBy('anthropic')).not.toContain(FIREWORKS_REAL);
    for (const s of seen.anthropic) expect(s.headers.authorization).toBe(`Bearer ${CLAUDE_REAL}`);
  }, 15_000);

  // INVARIANT: the harness was launched on tier 0's model, so a request served
  // by another tier must ask for THAT tier's model — the endpoint does not
  // serve tier 0's — while on tier 0 the harness's own choice stands.
  test('the model is rewritten to the serving tier, and left alone on tier 0', async () => {
    await send({ model: 'claude-haiku-4-5', messages: [] });
    expect(seen.anthropic[0]!.body.model).toBe('claude-haiku-4-5');
    anthropicUsage = full(60);
    await send();
    await send({ model: 'claude-haiku-4-5', messages: [] });
    expect(seen.fireworks[0]!.body.model).toBe('firerouter/opus');
    const served = records.filter((r) => r.servedByEndpoint === 'fireworks');
    expect(served.length).toBe(1);
    expect(served[0]!.model).toBe('firerouter/opus');
  });

  // INVARIANT: once a task's history has crossed providers, no thinking block
  // is sent anywhere, and thinking is turned off for a request that had any —
  // Anthropic verifies a block's signature and refuses a final assistant turn
  // without its thinking block while thinking is on. Before any crossing,
  // thinking history passes through untouched.
  test('thinking history is stripped once the session has crossed providers', async () => {
    const withThinking = {
      model: 'claude-sonnet-5-5',
      thinking: { type: 'enabled', budget_tokens: 1024 },
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 'sig' }, { type: 'text', text: 'a' }] },
        { role: 'user', content: 'more' },
      ],
    };
    await send(withThinking);
    expect(JSON.stringify(seen.anthropic[0]!.body)).toContain('"thinking"');
    anthropicUsage = full(2);
    await send(withThinking);
    await send(withThinking); // fireworks
    anthropicUsage = {};
    await new Promise((r) => setTimeout(r, 2200));
    await send(withThinking); // back to anthropic
    const fw = seen.fireworks[0]!.body;
    const back = seen.anthropic[seen.anthropic.length - 1]!.body;
    for (const body of [fw, back]) {
      expect(JSON.stringify(body.messages)).not.toContain('"type":"thinking"');
      // The history ends in a NEW user message, so thinking stays on.
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
    }
  }, 15_000);

  test('every switch is reported once, with from, to and the reading behind it', async () => {
    await send();
    anthropicUsage = full(60);
    await send();
    await send();
    await send();
    expect(switches).toHaveLength(1);
    expect(switches[0]).toMatchObject({
      taskId: grant.taskId, profile: 'chain',
      from: { index: 0, endpoint: 'anthropic-sub', model: 'claude-sonnet-5-5' },
      to: { index: 1, endpoint: 'fireworks', model: 'firerouter/opus' },
    });
    expect(switches[0]!.reason).toContain('5-hour window 97% used');
  });

  /** Every tier of a two-tier, all-conditional chain is full. */
  function allConditional(): void {
    routes = {
      chain: {
        upstream: anthropicUrl, wire: 'anthropic',
        tiers: [
          { index: 0, endpoint: 'anthropic-sub', upstream: anthropicUrl, model: 'claude-sonnet-5-5', usage: 'claude', threshold: 95 },
          { index: 1, endpoint: 'anthropic-sub-2', upstream: anthropicUrl, model: 'claude-haiku-4-5', usage: 'claude', threshold: 90 },
        ],
      },
    };
  }

  async function sendRaw() {
    return fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${PLACEHOLDER}` },
      body: JSON.stringify({ model: 'claude-sonnet-5-5', messages: [] }),
    });
  }

  // INVARIANT: when every tier of a tiered profile is full, the request is
  // NEVER forwarded upstream — not to the last tier, not to any tier. The proxy
  // answers it itself with a 429 whose retry-after is the earliest reset among
  // the full windows. Engineer decision 2026-10-01: serving on the last tier
  // anyway spent past every threshold the profile was written to respect.
  test('an all-full chain never forwards upstream and answers 429 with retry-after', async () => {
    allConditional();
    anthropicUsage = full(600);
    expect((await send()).status).toBe(200); // this response carries 97% — the chain is now full
    const before = seen.anthropic.length;
    const res = await sendRaw();
    expect(res.status).toBe(429);
    const retryAfter = Number(res.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(590);
    expect(retryAfter).toBeLessThanOrEqual(601);
    const body = await res.json() as { type: string; error: { type: string; message: string } };
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('rate_limit_error');
    expect(body.error.message).toContain('agent profile "chain"');
    expect(body.error.message).toContain('every tier');
    expect(body.error.message).toMatch(/resets at \d{4}-\d{2}-\d{2}T/);
    await sendRaw();
    await new Promise((r) => setTimeout(r, 30));
    expect(seen.anthropic.length).toBe(before);
    expect(seen.fireworks).toHaveLength(0);
    expect(seen.ollama).toHaveLength(0);
    const refused = records.filter((r) => r.status === 429);
    expect(refused).toHaveLength(2);
    expect(refused[0]!.error).toContain('every tier full');
  });

  // INVARIANT: a ONE-tier profile whose only tier crosses its threshold
  // behaves exactly like a longer chain whose last tier does: 429, nothing
  // forwarded, and an every-tier-full event naming the tier.
  test('a one-tier profile over its threshold answers 429 and records the event', async () => {
    routes = {
      chain: {
        upstream: anthropicUrl, wire: 'anthropic',
        tiers: [{ index: 0, endpoint: 'anthropic-sub', upstream: anthropicUrl, model: 'claude-sonnet-5-5', usage: 'claude', threshold: 95 }],
      },
    };
    anthropicUsage = full(600);
    expect((await send()).status).toBe(200);
    const before = seen.anthropic.length;
    expect((await sendRaw()).status).toBe(429);
    expect(seen.anthropic.length).toBe(before);
    expect(switches).toHaveLength(1);
    expect(switches[0]).toMatchObject({ to: null, allFull: true, from: { index: 0 } });
  });

  test('an all-full chain returns 429 even if its credential disappears after tier choice', async () => {
    allConditional();
    anthropicUsage = full(600);
    expect((await send()).status).toBe(200);
    const before = seen.anthropic.length;
    credentialUnavailableAfterTierChoice = true;
    credentialLookups = 0;
    const response = await sendRaw();
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).not.toBeNull();
    expect(credentialLookups).toBe(2);
    expect(seen.anthropic.length).toBe(before);
  });

  // INVARIANT: an all-full chain does not mask the other refusals — a
  // forbidden path is still audited as a path refusal, and a missing member
  // endpoint still refuses auth. Neither is recorded as a full stretch.
  test('an all-full chain still refuses a forbidden path and reports full for a valid member', async () => {
    allConditional();
    anthropicUsage = full(600);
    await send();
    switches = [];
    const bad = await fetch(`http://127.0.0.1:${proxyPort}/v1/files`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${PLACEHOLDER}` }, body: '{}',
    });
    expect(bad.status).toBe(403);
    await new Promise((r) => setTimeout(r, 30));
    expect(records[records.length - 1]!.error).toContain('path refused');
    expect(switches).toHaveLength(0);
    memberResolver = async () => ({ userId: 'm@example.com', outcome: { kind: 'missing', reason: 'endpoint disconnected' } });
    expect((await send()).status).toBe(401);
    expect(switches).toHaveLength(0);
    memberResolver = async () => ({ userId: 'm@example.com', outcome: { kind: 'none', reason: 'x' } });
    expect((await send()).status).toBe(429);
    expect(switches).toHaveLength(1);
    expect(switches[0]!.allFull).toBe(true);
  });

  test('every-tier-full is recorded once, and the way back is recorded too', async () => {
    allConditional();
    await send();
    anthropicUsage = full(2);
    await send(); // reading: full
    await send(); // 429
    await send(); // 429 — not recorded again
    expect(switches).toHaveLength(1);
    expect(switches[0]).toMatchObject({ to: null, allFull: true, from: { index: 0 } });
    expect(typeof switches[0]!.retryAt).toBe('number');
    anthropicUsage = {};
    await new Promise((r) => setTimeout(r, 2200));
    expect((await send()).status).toBe(200);
    expect(switches).toHaveLength(2);
    expect(switches[1]).toMatchObject({ from: { index: 0 }, to: { index: 0 }, allFull: false });
  }, 15_000);

  // INVARIANT: a tiered member request uses its endpoint resolver, never the
  // project key. A free selected endpoint strips every auth header.
  test('team mode serves a tiered request with its endpoint resolver', async () => {
    memberResolver = async () => ({ userId: 'm@example.com', outcome: { kind: 'none', reason: 'x' } });
    const res = await send();
    expect(res.status).toBe(200);
    expect(seen.anthropic).toHaveLength(1);
    expect(credentialsSeenBy('anthropic')).toBe('\n');
  });
});

describe('tiered profile through the proxy on LIVE config routing', () => {
  const REAL = 'sk-ant-api03-LIVE-ROUTING-REAL-KEY';
  const PH = 'sk-ant-api03-lazy-live-tiered-placeholder';
  let root: string;
  let one: ReturnType<typeof Bun.serve>;
  let two: ReturnType<typeof Bun.serve>;
  let proxy: ReturnType<typeof Bun.serve>;
  let hits: { one: Seen[]; two: Seen[] };
  let full = false;
  let savedKey: string | undefined;
  const tracker = new UsageLimitTracker();
  let crossedTasks = new Set<string>();
  const grant: CredentialGrant = {
    token: PH, role: 'agent', taskId: 'live-1', label: 'lazy-task-live', envKey: 'ANTHROPIC_API_KEY',
    profile: 'chain', createdAt: new Date().toISOString(),
  };

  const serve = (which: 'one' | 'two', headers: () => Record<string, string>) => Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(req) {
      const h: Record<string, string> = {};
      req.headers.forEach((v, k) => { h[k] = v; });
      const text = await req.text();
      hits[which].push({ headers: h, body: text ? JSON.parse(text) : {} });
      return Response.json({ from: which }, { headers: headers() });
    },
  });

  beforeAll(async () => {
    const { mkdtemp, writeFile } = await import('fs/promises');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const { loadConfig } = await import('../../src/config/loader');
    const { enableLastKnownGood } = await import('../../src/config/last-good');
    const { buildTargetCredentials } = await import('../../src/proxy/credential-deps');
    const { createLiveProxyRouting } = await import('../../src/daemon/live-proxy-routing');
    savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = REAL;
    hits = { one: [], two: [] };
    one = serve('one', (): Record<string, string> => (full ? {
      'anthropic-ratelimit-unified-5h-utilization': '0.99',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600),
    } : {}));
    two = serve('two', () => ({}));
    root = await mkdtemp(join(tmpdir(), 'lazy-tiered-live-proxy-'));
    await writeFile(join(root, 'lazy.toml'), [
      '[endpoints.sub]', `url = "http://127.0.0.1:${one.port}"`, 'credential = "anthropic"',
      '[endpoints.cheap]', `url = "http://127.0.0.1:${two.port}"`, 'credential = "none"',
      '[agents.chain]', 'harness = "claude-code"',
      'tiers = [{ endpoint = "sub", model = "a", threshold_percent = 95 }, { endpoint = "cheap", model = "b" }]',
    ].join('\n'));
    enableLastKnownGood();
    const config = await loadConfig(root);
    const targets = buildTargetCredentials(root, config).targets;
    const live = await createLiveProxyRouting(root, config, targets);
    proxy = createProxyServer(
      { port: 0, bind: '127.0.0.1', upstream: 'https://api.anthropic.com', fallbacks: [], retryAfterThreshold: 0, liveAgentRouting: live },
      { append: async () => {} },
      { lookup: async (t) => (t === PH ? grant : null), targets, member: async () => null },
      { usageLimits: tracker, historyCrossed: async (id) => crossedTasks.has(id) },
    );
  });

  afterAll(async () => {
    const { rm } = await import('fs/promises');
    const { resetLastKnownGood } = await import('../../src/config/last-good');
    resetLastKnownGood();
    one.stop(); two.stop(); proxy.stop();
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey;
    await rm(root, { recursive: true, force: true });
  });

  async function send(body: Record<string, unknown> = { model: 'a', messages: [] }) {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': PH }, body: JSON.stringify(body),
    });
    await res.text();
    return res.status;
  }

  // INVARIANT: a broken lazy.toml edit mid-turn leaves the last good tier chain
  // serving — and a switch made AFTER the edit still routes each tier's request
  // with that tier's credential only. The live-routing fallback and the tier
  // credential guarantee hold together, not just separately.
  test('a broken edit mid-turn: the switch still happens, with each tier\'s own credential', async () => {
    const { writeFile } = await import('fs/promises');
    const { join } = await import('path');
    expect(await send()).toBe(200);
    await writeFile(join(root, 'lazy.toml'), '[agents.chain\n');
    full = true;
    expect(await send()).toBe(200); // tier 1 answers 99%
    expect(await send()).toBe(200); // → tier 2
    expect(hits.one.length).toBe(2);
    expect(hits.two.length).toBe(1);
    for (const h of hits.one) expect(h.headers['x-api-key']).toBe(REAL);
    const twoCreds = `${hits.two[0]!.headers['x-api-key'] ?? ''} ${hits.two[0]!.headers.authorization ?? ''}`;
    expect(twoCreds).not.toContain(REAL);
    expect(twoCreds).not.toContain(PH);
    expect(hits.two[0]!.body.model).toBe('b');
  });

  // INVARIANT: the "history crossed providers" fact survives a daemon restart
  // (the proxy asks for it when it has no in-memory state), so a session back on
  // tier 0 never sends another provider's thinking blocks.
  test('a task recorded as crossed is stripped on its first request after a restart', async () => {
    full = false;
    tracker.resetForTest();
    grant.taskId = 'live-restarted';
    crossedTasks = new Set(['live-restarted']);
    hits.one = [];
    await send({
      model: 'a', thinking: { type: 'enabled', budget_tokens: 1 },
      messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'text', text: 'x' }] }],
    });
    expect(hits.one).toHaveLength(1);
    expect(JSON.stringify(hits.one[0]!.body)).not.toContain('"thinking"');
  });
});
