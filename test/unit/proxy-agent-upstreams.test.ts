/**
 * Per-PROFILE upstream routing — what replaces per-role routing and the
 * `OPENAI_API_KEY` envKey special case.
 *
 * Three halves, same shape as the role suite this supersedes: the
 * config→upstream mapping, the credential each upstream gets, and the proxy
 * actually routing by the caller's GRANT profile (evidence, not a forgeable
 * header). The fourth thing only profiles can do gets its own block: two
 * profiles of the SAME harness on different upstreams in one project, which is
 * exactly what role config could never express.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  resolveAgentUpstreams,
  agentUpstreamMap,
  routeForProfile,
} from '../../src/proxy/agent-upstreams';
import { buildProxyCredentialDeps } from '../../src/proxy/credential-deps';
import { createProxyServer, type ProxyCredentialDeps } from '../../src/proxy/server';
import { TargetCredentials, anthropicPlacement } from '../../src/proxy/target-credentials';
import type { CredentialGrant } from '../../src/proxy/credential-broker';
import type { AuditSink } from '../../src/proxy/audit';
import type { ProxyAuditRecord } from '../../src/storage/types';
import type { AgentProfileConfig } from '../../src/config/agent-profiles';
import type { ResolvedConfig } from '../../src/config/types';

const NO_ROLE_ENDPOINTS = {
  builder: { backend: 'anthropic', model: '', endpoint: '' },
  agent: { backend: 'anthropic', model: '', endpoint: '' },
};

function configWith(
  agents: Record<string, AgentProfileConfig>,
  proxy?: Record<string, unknown>,
  roles: Record<string, unknown> = NO_ROLE_ENDPOINTS,
): ResolvedConfig {
  return {
    agents,
    models: { roles },
    proxy: {
      upstream: 'https://api.anthropic.com',
      cursorUpstream: 'https://api2.cursor.sh',
      fallbacks: [],
      ...proxy,
    },
  } as never;
}

describe('resolveAgentUpstreams', () => {
  // The zero-config paths, both of which are now nothing but a built-in
  // profile's default endpoint resolved by the same rule as any other:
  //  - codex, which used to be the `OPENAI_API_KEY` special case plus
  //    `[proxy] openai_upstream`;
  //  - pi, which defaults to the machine's own Ollama. INVARIANT: it must
  //    appear HERE, in the proxy's route table — a default upstream the proxy
  //    does not know about would be a default that cannot be reached at all,
  //    since the agent only ever dials the proxy. Its credential is null
  //    because a local server ignores auth.
  test('with no [agents] block, the built-in codex and pi profiles have upstreams', () => {
    const byProfile = Object.fromEntries(
      resolveAgentUpstreams(configWith({})).map(e => [e.profile, e]),
    );
    expect(byProfile).toEqual({
      codex: { profile: 'codex', upstream: 'https://api.openai.com', credential: 'openai', wire: 'openai' },
      // The two codex profiles named for what they BILL. codex-subscription must
      // appear here for the same reason pi does: a default upstream the proxy
      // does not know about cannot be reached at all, since the agent only ever
      // dials the proxy. Its credential is the ChatGPT session, derived from the
      // endpoint's hostname — never an OpenAI API key.
      'codex-api': { profile: 'codex-api', upstream: 'https://api.openai.com', credential: 'openai', wire: 'openai' },
      'codex-subscription': {
        profile: 'codex-subscription',
        upstream: 'https://chatgpt.com/backend-api/codex',
        credential: 'chatgpt',
        wire: 'openai',
      },
      pi: { profile: 'pi', upstream: 'http://localhost:11434', credential: null, wire: 'anthropic' },
    });
  });

  test('a profile that names an endpoint appears; one that does not rides the primary', () => {
    const config = configWith({
      'local-ollama-pi': { harness: 'pi', model: 'qwen3.8:latest', endpoint: 'http://localhost:11434' },
      'claude-code': { harness: 'claude-code', model: 'claude-opus-5' },
    });
    const entries = resolveAgentUpstreams(config);
    expect(entries.find(e => e.profile === 'claude-code')).toBeUndefined();
    expect(entries.find(e => e.profile === 'local-ollama-pi')).toEqual({
      profile: 'local-ollama-pi',
      upstream: 'http://localhost:11434',
      // A local model server ignores auth, so it is never handed a real key.
      credential: null,
      wire: 'anthropic',
    });
  });

  // INVARIANT (carried from the role suite): a local model server ignores auth,
  // so shipping the user's real Anthropic token to it would leak the secret to a
  // process that never needed it — while a pinned REMOTE anthropic-wire gateway
  // keeps the credential it always received. Asserted as a PAIR, in one resolve:
  // the hazard is that the two answers get conflated, which a test of either one
  // alone cannot see.
  test('a local upstream gets no credential; a pinned remote one keeps its own', () => {
    const config = configWith({
      'work-gateway': { harness: 'claude-code', model: 'm', endpoint: 'https://gateway.example.com' },
      'local-pi': { harness: 'pi', model: 'qwen', endpoint: 'http://localhost:11434' },
    });
    const credentials = Object.fromEntries(
      resolveAgentUpstreams(config)
        // The built-ins carry their own default upstreams; this test is about
        // the two profiles it declares.
        .filter(e => !e.profile.startsWith('codex') && e.profile !== 'pi')
        .map(e => [e.profile, e.credential]),
    );
    expect(credentials).toEqual({ 'work-gateway': 'anthropic', 'local-pi': null });
  });

  // The credential map is keyed by ORIGIN, so a trailing slash must not produce
  // a second spelling of the same upstream.
  test('a trailing slash is normalized away', () => {
    const config = configWith({
      'work-codex': { harness: 'codex', model: 'gpt-5-codex', endpoint: 'https://openrouter.ai/api/' },
    });
    expect(agentUpstreamMap(config)['work-codex'])
      .toEqual({ upstream: 'https://openrouter.ai/api', wire: 'openai' });
  });

  // THE POINT OF PROFILES: one harness, two upstreams, two credentials, in one
  // project. `[models.roles.agent]` has a single slot per role and could not
  // express this at all — asking for OpenRouter codex meant every codex task
  // went to OpenRouter.
  test('two profiles of one harness resolve to their own upstream and credential', () => {
    const config = configWith({
      codex: { harness: 'codex', model: 'gpt-5-codex' },
      'router-codex': { harness: 'codex', model: 'x-ai/grok-4', endpoint: 'https://openrouter.ai/api' },
    });
    expect(agentUpstreamMap(config)).toEqual({
      codex: { upstream: 'https://api.openai.com', wire: 'openai' },
      'router-codex': { upstream: 'https://openrouter.ai/api', wire: 'openai' },
      // The built-in profiles' own defaults, untouched by this project's blocks.
      'codex-api': { upstream: 'https://api.openai.com', wire: 'openai' },
      'codex-subscription': { upstream: 'https://chatgpt.com/backend-api/codex', wire: 'openai' },
      pi: { upstream: 'http://localhost:11434', wire: 'anthropic' },
    });
    const credentials = Object.fromEntries(
      resolveAgentUpstreams(config).map(e => [e.profile, e.credential]),
    );
    expect(credentials).toEqual({
      codex: 'openai',
      'router-codex': 'openrouter',
      'codex-api': 'openai',
      'codex-subscription': 'chatgpt',
      pi: null,
    });
  });
});

describe('routeForProfile', () => {
  const map = agentUpstreamMap(configWith({
    'local-pi': { harness: 'pi', model: 'qwen3.8:latest', endpoint: 'http://localhost:11434' },
  }));

  test('a grant naming a profile with an upstream is routed there', () => {
    expect(routeForProfile(map, { profile: 'local-pi' }))
      .toEqual({ upstream: 'http://localhost:11434', wire: 'anthropic' });
  });

  // A profile with no endpoint of its own rides the primary upstream and its
  // failover chain — the same answer a project with no [agents] block gives.
  test('a grant naming a profile without an upstream takes the primary', () => {
    expect(routeForProfile(map, { profile: 'claude-code' })).toBeUndefined();
  });

  // INVARIANT: the grant registry on disk outlives a daemon restart, so a grant
  // minted before profiles existed is a live case, not a hypothetical. It has no
  // profile to route by and must fall through to the primary rather than throw
  // or route somewhere arbitrary; its next launch mints one that carries a name.
  test('a grant minted before profiles existed falls through', () => {
    expect(routeForProfile(map, {})).toBeUndefined();
    expect(routeForProfile(map, { profile: '' })).toBeUndefined();
  });

  test('a grant naming an unknown profile falls through rather than guessing', () => {
    expect(routeForProfile(map, { profile: 'deleted-from-lazy-toml' })).toBeUndefined();
  });
});

describe('profile upstreams in the credential map', () => {
  test('the built-in codex profile maps api.openai.com to the openai credential', () => {
    const deps = buildProxyCredentialDeps('/tmp/x', configWith({}));
    // Nothing in this config names api.openai.com, but a zero-config codex
    // grant routes there — without this mapping the placeholder would be
    // stripped with nothing swapped in and OpenAI would 401 every codex turn.
    expect(deps.targets.has('https://api.openai.com')).toBe(true);
  });

  test('each profile upstream is registered with its own credential', () => {
    const deps = buildProxyCredentialDeps('/tmp/x', configWith({
      'router-codex': { harness: 'codex', model: 'x-ai/grok-4', endpoint: 'https://openrouter.ai/api' },
      'local-pi': { harness: 'pi', model: 'qwen3.8:latest', endpoint: 'http://localhost:11434' },
    }));
    expect(deps.targets.has('https://openrouter.ai/api')).toBe(true);
    // The local one is deliberately unmapped, which TargetCredentials answers
    // as `none` — the placeholder is stripped and no real key replaces it.
    expect(deps.targets.has('http://localhost:11434')).toBe(false);
  });

  // INVARIANT (same hazard as the fallback chain and role upstreams): the map is
  // keyed by origin, so a credential-free profile sharing an origin with a
  // mapped target would silently inherit that target's credential. A config that
  // reads as one thing and behaves as another is worse than one that is rejected.
  test('a credential-free profile on a claimed origin is refused', () => {
    const config = configWith({
      'sneaky-pi': {
        harness: 'pi',
        model: 'qwen',
        // Same ORIGIN as proxy.upstream, different path.
        endpoint: 'https://api.anthropic.com/local',
        credential: 'none',
      },
    });
    expect(() => buildProxyCredentialDeps('/tmp/x', config))
      .toThrow(/already mapped to the "anthropic" credential/);
  });

  // Worse than the `none` case, and new with profiles: this one SPENDS a real
  // secret. The origin already carries the openai key, so an openrouter profile
  // sharing it would be billed to the OpenAI account — a cross-credential leak.
  test('a profile naming a different credential on a claimed origin is refused', () => {
    const config = configWith({
      // api.openai.com is already claimed by the built-in codex profile.
      'wrong-key': {
        harness: 'codex',
        model: 'gpt-5-codex',
        endpoint: 'https://api.openai.com/v2',
        credential: 'openrouter',
      },
    });
    expect(() => buildProxyCredentialDeps('/tmp/x', config))
      .toThrow(/would be billed to "openai"/);
  });

  // "Two profiles on the same provider share one key unless one names its own"
  // — the design's words. Same origin, same credential, nothing lies.
  test('two profiles sharing an origin and a credential are allowed', () => {
    const config = configWith({
      codex: { harness: 'codex', model: 'gpt-5-codex' },
      'codex-mini': { harness: 'codex', model: 'gpt-5-mini', endpoint: 'https://api.openai.com' },
    });
    expect(() => buildProxyCredentialDeps('/tmp/x', config)).not.toThrow();
  });
});

describe('the proxy routes by the caller grant profile', () => {
  const PI_TOKEN = 'sk-ant-api03-lazy-pi-placeholder';
  const CLAUDE_TOKEN = 'sk-ant-api03-lazy-claude-placeholder';
  const LEGACY_TOKEN = 'sk-ant-api03-lazy-legacy-placeholder';
  const REAL = 'sk-ant-oat01-THE-REAL-USER-TOKEN';

  const grants: Record<string, CredentialGrant> = {
    [PI_TOKEN]: {
      token: PI_TOKEN, role: 'agent', taskId: 'task-pi', label: 'lazy-task-pi',
      envKey: 'ANTHROPIC_API_KEY', profile: 'local-pi', createdAt: new Date().toISOString(),
    },
    [CLAUDE_TOKEN]: {
      token: CLAUDE_TOKEN, role: 'agent', taskId: 'task-cc', label: 'lazy-task-cc',
      envKey: 'ANTHROPIC_API_KEY', profile: 'claude-code', createdAt: new Date().toISOString(),
    },
    // Minted before profiles existed — still in the on-disk registry.
    [LEGACY_TOKEN]: {
      token: LEGACY_TOKEN, role: 'agent', taskId: 'task-old', label: 'lazy-task-old',
      envKey: 'ANTHROPIC_API_KEY', createdAt: new Date().toISOString(),
    },
  };

  let primary: ReturnType<typeof Bun.serve>;
  let profileTarget: ReturnType<typeof Bun.serve>;
  let proxy: ReturnType<typeof Bun.serve>;
  let proxyPort: number;
  let primaryUrl: string;
  let profileUrl: string;
  let records: ProxyAuditRecord[];
  let seen: Record<string, { headers: Record<string, string> } | null>;
  // Lets a test make an upstream fail. Restored from the role suite this
  // replaces: without it the no-failover invariant below cannot be expressed.
  let primaryStatus = 200;

  const freePort = () => 41000 + Math.floor(Math.random() * 8000);

  function upstreamServer(name: string, port: number, status: () => number) {
    return Bun.serve({
      port, hostname: '127.0.0.1',
      async fetch(req) {
        await req.text();
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => { headers[k] = v; });
        seen[name] = { headers };
        const code = status();
        if (code !== 200) return new Response('overloaded', { status: code });
        return Response.json({ type: 'message', model: 'm', from: name });
      },
    });
  }

  beforeAll(async () => {
    seen = {};
    records = [];
    const primaryPort = freePort();
    const profilePort = freePort();
    primaryUrl = `http://127.0.0.1:${primaryPort}`;
    profileUrl = `http://127.0.0.1:${profilePort}`;
    primary = upstreamServer('primary', primaryPort, () => primaryStatus);
    profileTarget = upstreamServer('profile', profilePort, () => 200);

    const targets = new TargetCredentials();
    targets.set(primaryUrl, async () => ({
      kind: 'credential',
      placement: anthropicPlacement('CLAUDE_CODE_OAUTH_TOKEN', REAL),
      label: 'CLAUDE_CODE_OAUTH_TOKEN',
    }));
    // profileUrl is deliberately unmapped — a local model server gets `none`.

    const credentials: ProxyCredentialDeps = {
      lookup: async (token: string) => grants[token] ?? null,
      targets,
    };
    const sink: AuditSink = { append: async (r) => { records.push(r); } };
    proxyPort = freePort();
    proxy = createProxyServer(
      {
        port: proxyPort, bind: '127.0.0.1',
        upstream: primaryUrl,
        fallbacks: [],
        retryAfterThreshold: 0,
        // The ONLY route table there is. There is no per-role list any more:
        // a role decides which profile a task DEFAULTS to, and the profile is
        // what decides the upstream. Two profiles in the same role therefore
        // land on different upstreams, which is the whole point below.
        agentUpstreams: { 'local-pi': { upstream: profileUrl, wire: 'anthropic' } },
      },
      sink,
      credentials,
    );
    await new Promise(r => setTimeout(r, 50));
  });

  afterAll(() => {
    primary.stop(); profileTarget.stop(); proxy.stop();
  });

  async function send(headers: Record<string, string>) {
    return fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
    });
  }

  test('a caller whose profile names an upstream is forwarded there', async () => {
    seen.primary = null; seen.profile = null;
    const res = await send({ 'x-api-key': PI_TOKEN });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ from: 'profile' });
    expect(seen.primary).toBeNull();
    // The profile upstream is unmapped, so the placeholder is STRIPPED and no
    // credential replaces it — a local model server never sees the user's token.
    expect(seen.profile!.headers['x-api-key']).toBeUndefined();
    expect(seen.profile!.headers.authorization).toBeUndefined();
  });

  // THE WHOLE POINT: another task in the SAME project, same role, is untouched
  // by that. Under role routing, pointing pi at a local Ollama took every
  // claude-code task with it.
  test('another profile in the same role is untouched', async () => {
    seen.primary = null; seen.profile = null;
    const res = await send({ 'x-api-key': CLAUDE_TOKEN });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ from: 'primary' });
    expect(seen.profile).toBeNull();
    // And it gets the real credential swapped in, as always.
    expect(seen.primary!.headers.authorization).toBe(`Bearer ${REAL}`);
    expect(seen.primary!.headers['x-api-key']).toBeUndefined();
  });

  // INVARIANT: the routing key is the GRANT's profile, which the proxy derived
  // from the token it authenticated — never a self-reported header. Otherwise an
  // agent could route its own traffic to an upstream it was not granted.
  test('a forged x-lazy-profile header does not change the route', async () => {
    seen.primary = null; seen.profile = null;
    const res = await send({ 'x-api-key': CLAUDE_TOKEN, 'x-lazy-profile': 'local-pi' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ from: 'primary' });
    expect(seen.profile).toBeNull();
  });

  // A grant minted before profiles existed (the registry on disk outlives a
  // daemon restart) carries no profile. Absent is NOT "pick something" — it is
  // no evidence, and gets the same answer as traffic with no grant at all: the
  // primary upstream. Guessing a profile for it would route a launch by a name
  // nothing configured, on whatever credential that upstream happens to use.
  test('a grant with no profile goes to the primary upstream', async () => {
    seen.primary = null; seen.profile = null;
    const res = await send({ 'x-api-key': LEGACY_TOKEN });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ from: 'primary' });
    expect(seen.profile).toBeNull();
  });

  // Traffic with no grant — a host `claude` login session sharing the proxy —
  // has no profile to route by and keeps going to the primary upstream.
  test('grant-less traffic still goes to the primary upstream', async () => {
    seen.primary = null; seen.profile = null;
    const res = await send({ 'x-api-key': 'sk-ant-some-unknown-token' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ from: 'primary' });
    expect(seen.profile).toBeNull();
  });

  // The audit record must name the upstream the request ACTUALLY reached, not
  // the configured primary — attribution is the reason the proxy exists.
  test('the audit record names the real per-profile upstream', async () => {
    records.length = 0;
    await send({ 'x-api-key': PI_TOKEN });
    await new Promise(r => setTimeout(r, 50));
    const record = records.find(r => r.taskId === 'task-pi');
    expect(record).toBeDefined();
    expect(record!.upstream).toBe(profileUrl);
  });

  // INVARIANT (carried from the role suite this replaces — the hazard did not
  // change when the routing key did): a profile upstream gets a SINGLE target
  // and no failover chain. `[[proxy.fallback]]` is the PRIMARY's failover;
  // failing a local-model profile over to api.anthropic.com would silently
  // change the model and bill the user (CLAUDE.md: no silent fallbacks).
  // Nothing reroutes INTO a profile upstream either — a primary failure is the
  // primary's chain, which is empty here, so it fails hard.
  test('a profile upstream is never a failover destination for the primary', async () => {
    primaryStatus = 529;
    seen.profile = null;
    try {
      const res = await send({ 'x-api-key': CLAUDE_TOKEN });
      expect(res.status).toBe(529);
      expect(seen.profile).toBeNull();
    } finally {
      primaryStatus = 200;
    }
  });
});

// The other half of that invariant, which the role suite stated in prose and
// never asserted: with `fallbacks: []` a profile upstream cannot fail over
// because there is nowhere to go. Here the chain is REAL and configured, and a
// profile-routed request that fails must still not touch it — otherwise a
// down local Ollama would quietly become a billed api.anthropic.com turn on a
// model the user never asked for.
describe('a configured fallback chain belongs to the primary alone', () => {
  const PI_TOKEN = 'sk-ant-api03-lazy-pi-2-placeholder';
  const CLAUDE_TOKEN = 'sk-ant-api03-lazy-cc-2-placeholder';

  const grants: Record<string, CredentialGrant> = {
    [PI_TOKEN]: {
      token: PI_TOKEN, role: 'agent', taskId: 'task-pi', label: 'lazy-task-pi',
      envKey: 'ANTHROPIC_API_KEY', profile: 'local-pi', createdAt: new Date().toISOString(),
    },
    [CLAUDE_TOKEN]: {
      token: CLAUDE_TOKEN, role: 'agent', taskId: 'task-cc', label: 'lazy-task-cc',
      envKey: 'ANTHROPIC_API_KEY', profile: 'claude-code', createdAt: new Date().toISOString(),
    },
  };

  let primary: ReturnType<typeof Bun.serve>;
  let fallback: ReturnType<typeof Bun.serve>;
  let profileTarget: ReturnType<typeof Bun.serve>;
  let proxy: ReturnType<typeof Bun.serve>;
  let proxyPort: number;
  let seen: Record<string, boolean>;
  let primaryStatus = 200;
  let profileStatus = 200;

  const freePort = () => 41000 + Math.floor(Math.random() * 8000);

  function upstreamServer(name: string, port: number, status: () => number) {
    return Bun.serve({
      port, hostname: '127.0.0.1',
      async fetch(req) {
        await req.text();
        seen[name] = true;
        const code = status();
        if (code !== 200) return new Response('overloaded', { status: code });
        return Response.json({ type: 'message', model: 'm', from: name });
      },
    });
  }

  beforeAll(async () => {
    seen = {};
    const primaryPort = freePort();
    const fallbackPort = freePort();
    const profilePort = freePort();
    const primaryUrl = `http://127.0.0.1:${primaryPort}`;
    const fallbackUrl = `http://127.0.0.1:${fallbackPort}`;
    const profileUrl = `http://127.0.0.1:${profilePort}`;
    primary = upstreamServer('primary', primaryPort, () => primaryStatus);
    fallback = upstreamServer('fallback', fallbackPort, () => 200);
    profileTarget = upstreamServer('profile', profilePort, () => profileStatus);

    const targets = new TargetCredentials();
    for (const url of [primaryUrl, fallbackUrl]) {
      targets.set(url, async () => ({
        kind: 'credential',
        placement: anthropicPlacement('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat01-REAL'),
        label: 'CLAUDE_CODE_OAUTH_TOKEN',
      }));
    }

    proxyPort = freePort();
    proxy = createProxyServer(
      {
        port: proxyPort, bind: '127.0.0.1',
        upstream: primaryUrl,
        fallbacks: [{ upstream: fallbackUrl }],
        retryAfterThreshold: 0,
        agentUpstreams: { 'local-pi': { upstream: profileUrl, wire: 'anthropic' } },
      },
      { append: async () => {} },
      { lookup: async (token: string) => grants[token] ?? null, targets },
    );
    await new Promise(r => setTimeout(r, 50));
  });

  afterAll(() => {
    primary.stop(); fallback.stop(); profileTarget.stop(); proxy.stop();
  });

  async function send(token: string) {
    return fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token },
      body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
    });
  }

  // The chain works — so the negative below is about ROUTING, not about a
  // failover feature that happens to be switched off.
  test('the primary does fail over into its own chain', async () => {
    seen = {}; primaryStatus = 529;
    try {
      const res = await send(CLAUDE_TOKEN);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ from: 'fallback' });
      expect(seen.profile).toBeUndefined();
    } finally {
      primaryStatus = 200;
    }
  });

  test('a failing profile upstream does NOT fall over into that chain', async () => {
    seen = {}; profileStatus = 529;
    try {
      const res = await send(PI_TOKEN);
      // Fails loudly on the upstream the profile named…
      expect(res.status).toBe(529);
      expect(seen.profile).toBe(true);
      // …and neither the primary nor its fallback is billed for a turn the
      // user pointed somewhere else entirely.
      expect(seen.primary).toBeUndefined();
      expect(seen.fallback).toBeUndefined();
    } finally {
      profileStatus = 200;
    }
  });
});
