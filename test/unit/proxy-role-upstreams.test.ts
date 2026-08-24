/**
 * Per-ROLE upstream routing — the last proxy bypass, closed.
 *
 * A role's `endpoint` used to be an address the launched agent dialed ITSELF
 * (ollama roles, and any role with an explicit endpoint), which is traffic
 * outside lazy's audit and policy plane. The key survives with its meaning
 * inverted: it is now the upstream lazy's PROXY forwards that role's traffic to.
 *
 * These tests pin the three halves of that: the config→upstream mapping, the
 * credential each upstream gets, and the proxy actually routing by the caller's
 * GRANT role (evidence, not a forgeable header).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from '../../src/config/loader';
import { resolveRoleUpstreams, roleUpstreamMap } from '../../src/proxy/role-upstreams';
import { buildProxyCredentialDeps } from '../../src/proxy/credential-deps';
import { createProxyServer, type ProxyCredentialDeps } from '../../src/proxy/server';
import { TargetCredentials, anthropicPlacement } from '../../src/proxy/target-credentials';
import type { CredentialGrant } from '../../src/proxy/credential-broker';
import type { AuditSink } from '../../src/proxy/audit';
import type { ProxyAuditRecord } from '../../src/storage/types';
import type { ResolvedConfig } from '../../src/config/types';

function configWithRoles(roles: Record<string, unknown>, proxy?: Record<string, unknown>): ResolvedConfig {
  return {
    models: { roles },
    proxy: {
      upstream: 'https://api.anthropic.com',
      cursorUpstream: 'https://api2.cursor.sh',
      fallbacks: [],
      ...proxy,
    },
  } as never;
}

describe('resolveRoleUpstreams', () => {
  test('only roles that name their own endpoint appear', () => {
    const config = configWithRoles({
      builder: { backend: 'anthropic', model: '', endpoint: '' },
      agent: { backend: 'ollama', model: 'qwen', endpoint: 'http://localhost:11434' },
    });
    expect(resolveRoleUpstreams(config)).toEqual([
      { role: 'agent', upstream: 'http://localhost:11434', credential: 'none' },
    ]);
    expect(roleUpstreamMap(config)).toEqual({ agent: 'http://localhost:11434' });
  });

  // INVARIANT: an ollama server ignores auth, so shipping the user's real
  // Anthropic token to it would leak the secret to a process that never needed
  // it. A pinned Anthropic-native endpoint keeps the credential it already
  // received back when the agent dialed it directly — this task is a routing
  // change, not a silent auth change.
  test('ollama upstreams get no credential; pinned endpoints keep theirs', () => {
    const config = configWithRoles({
      builder: { backend: 'proxy', model: 'm', endpoint: 'https://gateway.example.com' },
      agent: { backend: 'ollama', model: 'qwen', endpoint: 'http://localhost:11434' },
    });
    expect(resolveRoleUpstreams(config)).toEqual([
      { role: 'builder', upstream: 'https://gateway.example.com', credential: 'anthropic' },
      { role: 'agent', upstream: 'http://localhost:11434', credential: 'none' },
    ]);
  });

  // The credential map is keyed by ORIGIN, so a trailing slash must not produce
  // a second spelling of the same upstream.
  test('a trailing slash is normalized away', () => {
    const config = configWithRoles({
      builder: { backend: 'ollama', model: 'm', endpoint: 'http://localhost:11434/' },
      agent: { backend: 'anthropic', model: '', endpoint: '' },
    });
    expect(roleUpstreamMap(config)).toEqual({ builder: 'http://localhost:11434' });
  });
});

describe('role upstreams in the credential map', () => {
  test('each role upstream is registered with its own credential', () => {
    const config = configWithRoles({
      builder: { backend: 'proxy', model: 'm', endpoint: 'https://gateway.example.com' },
      agent: { backend: 'ollama', model: 'qwen', endpoint: 'http://localhost:11434' },
    });
    const deps = buildProxyCredentialDeps('/tmp/x', config);
    // The pinned endpoint is mapped; the ollama one is deliberately unmapped,
    // which TargetCredentials answers as `none`.
    expect(deps.targets.has('https://gateway.example.com')).toBe(true);
    expect(deps.targets.has('http://localhost:11434')).toBe(false);
  });

  // INVARIANT (same hazard as the fallback chain): the map is keyed by origin,
  // so a credential-free role upstream that shares an origin with a mapped
  // target would silently inherit that target's credential. A config that reads
  // as one thing and behaves as another is worse than one that is rejected.
  test('a credential-free role upstream on a shared origin is refused', () => {
    const config = configWithRoles({
      builder: { backend: 'anthropic', model: '', endpoint: '' },
      // Same ORIGIN as proxy.upstream, different path.
      agent: { backend: 'ollama', model: 'qwen', endpoint: 'https://api.anthropic.com/local' },
    });
    expect(() => buildProxyCredentialDeps('/tmp/x', config)).toThrow(/shares an origin/);
  });

  test('an anthropic-credentialled role upstream on a shared origin is allowed', () => {
    const config = configWithRoles({
      builder: { backend: 'anthropic', model: '', endpoint: '' },
      agent: { backend: 'proxy', model: 'm', endpoint: 'https://api.anthropic.com/v2' },
    });
    // It resolves to the same credential it would inherit, so nothing lies.
    expect(() => buildProxyCredentialDeps('/tmp/x', config)).not.toThrow();
  });
});

describe('endpoint migration: container-perspective spellings', () => {
  let dir: string;
  const prevConfig = process.env.LAZY_CONFIG;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lazy-role-upstream-cfg-'));
    delete process.env.LAZY_CONFIG;
  });
  afterEach(async () => {
    if (prevConfig !== undefined) process.env.LAZY_CONFIG = prevConfig;
    else delete process.env.LAZY_CONFIG;
    await rm(dir, { recursive: true, force: true });
  });

  // MIGRATION: `host.docker.internal` was the CONTAINER's name for the host,
  // correct back when the agent dialed the endpoint from inside its container.
  // The daemon makes that call now, from the host, where the name is a
  // guaranteed ENOTFOUND. Reading it as the host equivalent keeps existing
  // projects working; the warning is how the user learns the meaning changed
  // (same discipline as the `[proxy] enabled` removal: warn where harmless).
  test('a container-perspective role endpoint is read as host-perspective, with a warning', async () => {
    await writeFile(
      join(dir, 'lazy.toml'),
      `[models.roles.agent]\nbackend = "ollama"\nmodel = "qwen"\nendpoint = "http://host.docker.internal:11434"\n`,
    );
    const warnings: string[] = [];
    const prevWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    try {
      const config = await loadConfig(dir, { cwd: dir });
      expect(config.models.roles.agent.endpoint).toBe('http://localhost:11434');
    } finally {
      console.warn = prevWarn;
    }
    expect(warnings.join('\n')).toContain('host.docker.internal');
  });

  // A host-perspective endpoint is already correct: nothing changes and nothing
  // is printed. Warning here would train users to ignore the warning.
  test('a host-perspective endpoint is untouched and silent', async () => {
    await writeFile(
      join(dir, 'lazy.toml'),
      `[models.roles.agent]\nbackend = "ollama"\nmodel = "qwen"\nendpoint = "http://localhost:11434"\n`,
    );
    const warnings: string[] = [];
    const prevWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    try {
      const config = await loadConfig(dir, { cwd: dir });
      expect(config.models.roles.agent.endpoint).toBe('http://localhost:11434');
    } finally {
      console.warn = prevWarn;
    }
    expect(warnings.join('\n')).not.toContain('host.docker.internal');
  });
});

describe('the proxy routes by the caller grant role', () => {
  const AGENT_TOKEN = 'sk-ant-api03-lazy-agent-placeholder';
  const BUILDER_TOKEN = 'sk-ant-api03-lazy-builder-placeholder';
  const REAL = 'sk-ant-oat01-THE-REAL-USER-TOKEN';

  const grants: Record<string, CredentialGrant> = {
    [AGENT_TOKEN]: {
      token: AGENT_TOKEN, role: 'agent', taskId: 'task-42', label: 'lazy-task-42',
      envKey: 'ANTHROPIC_API_KEY', createdAt: new Date().toISOString(),
    },
    [BUILDER_TOKEN]: {
      token: BUILDER_TOKEN, role: 'builder', taskId: null, label: 'builder-1',
      envKey: 'ANTHROPIC_API_KEY', createdAt: new Date().toISOString(),
    },
  };

  let primary: ReturnType<typeof Bun.serve>;
  let roleTarget: ReturnType<typeof Bun.serve>;
  let proxy: ReturnType<typeof Bun.serve>;
  let proxyPort: number;
  let primaryUrl: string;
  let roleUrl: string;
  let records: ProxyAuditRecord[];
  let seen: Record<string, { headers: Record<string, string> } | null>;
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
    const rolePort = freePort();
    primaryUrl = `http://127.0.0.1:${primaryPort}`;
    roleUrl = `http://127.0.0.1:${rolePort}`;
    primary = upstreamServer('primary', primaryPort, () => primaryStatus);
    roleTarget = upstreamServer('role', rolePort, () => 200);

    const targets = new TargetCredentials();
    targets.set(primaryUrl, async () => ({
      kind: 'credential',
      placement: anthropicPlacement('CLAUDE_CODE_OAUTH_TOKEN', REAL),
      label: 'CLAUDE_CODE_OAUTH_TOKEN',
    }));
    // roleUrl is deliberately unmapped — an ollama upstream gets `none`.

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
        roleUpstreams: { agent: roleUrl },
      },
      sink,
      credentials,
    );
    await new Promise(r => setTimeout(r, 50));
  });

  afterAll(() => {
    primary.stop(); roleTarget.stop(); proxy.stop();
  });

  async function send(headers: Record<string, string>) {
    return fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
    });
  }

  test("a caller whose role names an upstream is forwarded there", async () => {
    seen.primary = null; seen.role = null;
    const res = await send({ 'x-api-key': AGENT_TOKEN });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ from: 'role' });
    expect(seen.primary).toBeNull();
    // The role upstream is unmapped, so the placeholder is STRIPPED and no
    // credential replaces it — a local model server never sees the user's token.
    expect(seen.role!.headers['x-api-key']).toBeUndefined();
    expect(seen.role!.headers.authorization).toBeUndefined();
  });

  // INVARIANT: the routing key is the GRANT's role, which the proxy derived
  // from the token it authenticated — not the self-reported x-lazy-role header.
  // Otherwise an agent could route itself somewhere else by setting a header.
  test('a forged x-lazy-role header does not change the route', async () => {
    seen.primary = null; seen.role = null;
    const res = await send({ 'x-api-key': BUILDER_TOKEN, 'x-lazy-role': 'agent' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ from: 'primary' });
    expect(seen.role).toBeNull();
  });

  // Traffic with no grant — a host `claude` login session sharing the proxy —
  // has no role to route by and keeps going to the primary upstream, as before.
  test('grant-less traffic still goes to the primary upstream', async () => {
    seen.primary = null; seen.role = null;
    const res = await send({ 'x-api-key': 'sk-ant-some-unknown-token' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ from: 'primary' });
    expect(seen.role).toBeNull();
  });

  // The audit record is the whole point of closing this bypass: it must name
  // the upstream the request ACTUALLY reached, not the configured primary.
  test('the audit record names the real per-role upstream', async () => {
    records.length = 0;
    await send({ 'x-api-key': AGENT_TOKEN });
    await new Promise(r => setTimeout(r, 50));
    const record = records.find(r => r.role === 'agent');
    expect(record).toBeDefined();
    expect(record!.upstream).toBe(roleUrl);
  });

  // INVARIANT: a role upstream gets a SINGLE target and no failover chain.
  // `[[proxy.fallback]]` is the PRIMARY's failover; failing an ollama role over
  // to api.anthropic.com would silently change the model and bill the user
  // (CLAUDE.md: no silent fallbacks). Nothing reroutes INTO a role upstream
  // either — a primary failure is the primary's chain, which is empty here.
  test('a role upstream is never a failover destination for the primary', async () => {
    primaryStatus = 529;
    seen.role = null;
    try {
      const res = await send({ 'x-api-key': BUILDER_TOKEN });
      expect(res.status).toBe(529);
      expect(seen.role).toBeNull();
    } finally {
      primaryStatus = 200;
    }
  });
});
