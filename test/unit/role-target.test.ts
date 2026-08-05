import { describe, test, expect } from 'bun:test';
import type { ResolvedConfig, RoleTarget } from '../../src/config/types';
import {
  resolveRoleTarget,
  resolveAgentModel,
  targetEnvVars,
  proxyAuditHeaderEnv,
  proxyBaseUrlForRunner,
  checkTargetConnectivity,
  preflightRoleTarget,
  isKnownAnthropicModel,
  targetForSurface,
} from '../../src/utils/role-target';

/**
 * Build a minimal ResolvedConfig carrying only the fields resolveRoleTarget reads.
 * The role-target resolver only touches config.models, so the rest is unused here.
 */
function configWith(roles: { builder: RoleTarget; agent: RoleTarget }, dflt = 'claude-opus-4-8'): ResolvedConfig {
  return { models: { default: dflt, roles } } as unknown as ResolvedConfig;
}

const anthropic = (model = ''): RoleTarget => ({ backend: 'anthropic', model, endpoint: '' });
const ollama = (model: string, endpoint = 'http://host.docker.internal:11434'): RoleTarget => ({ backend: 'ollama', model, endpoint });

describe('resolveRoleTarget', () => {
  test('anthropic role honors the caller preferred model', () => {
    const config = configWith({ builder: anthropic(), agent: anthropic() });
    const r = resolveRoleTarget('agent', config, { preferredModel: 'claude-haiku-4-5-20251001' });
    expect(r.backend).toBe('anthropic');
    expect(r.model).toBe('claude-haiku-4-5-20251001');
  });

  test('anthropic role with no preferred model falls back to the configured model', () => {
    const config = configWith({ builder: anthropic('claude-opus-4-8'), agent: anthropic() });
    expect(resolveRoleTarget('builder', config).model).toBe('claude-opus-4-8');
  });

  // INVARIANT: For a local backend (ollama/proxy) the configured model is
  // authoritative and a caller's preferred alias (e.g. "claude-opus-4-8") is
  // intentionally ignored — that name does not exist in the local registry.
  test('ollama role ignores the preferred model and uses the configured one', () => {
    const config = configWith({ builder: anthropic(), agent: ollama('qwen3-coder') });
    const r = resolveRoleTarget('agent', config, { preferredModel: 'claude-opus-4-8' });
    expect(r.backend).toBe('ollama');
    expect(r.model).toBe('qwen3-coder');
    expect(r.endpoint).toBe('http://host.docker.internal:11434');
  });

  // INVARIANT: Local backends only work through Claude Code. Any other agent
  // forces the anthropic path rather than passing a local model name to a
  // backend that can't serve it.
  test('non-claude agent forces anthropic even when the role is ollama', () => {
    const config = configWith({ builder: anthropic(), agent: ollama('qwen3-coder') });
    const r = resolveRoleTarget('agent', config, { preferredModel: 'claude-opus-4-8', agentId: 'qa-agent' });
    expect(r.backend).toBe('anthropic');
    expect(r.model).toBe('claude-opus-4-8');
  });

  // INVARIANT: No silent name substitution — a hand-built ollama target with no
  // model throws rather than guessing a default.
  test('throws on an ollama role with no model', () => {
    const config = configWith({ builder: anthropic(), agent: ollama('') });
    expect(() => resolveRoleTarget('agent', config)).toThrow(/No model configured/);
  });

  // INVARIANT (fix-builder-model-ollama-precedence): an EXPLICIT override (e.g.
  // `lazy builder --model X`) wins over the configured model on a local backend,
  // while the backend + endpoint (the "server") stay as configured. This makes a
  // local [models.roles.*] entry effectively *server* configuration — its model
  // is just a default the explicit flag overrides. Contrast the soft
  // preferredModel above, which an ollama role intentionally ignores.
  test('ollama role: overrideModel wins over the configured model but keeps the server', () => {
    const config = configWith({ builder: ollama('ollama-local-model'), agent: anthropic() });
    const r = resolveRoleTarget('builder', config, { overrideModel: 'mythos' });
    expect(r.backend).toBe('ollama');
    expect(r.model).toBe('mythos');
    expect(r.endpoint).toBe('http://host.docker.internal:11434');
  });

  // INVARIANT: a hard override beats the soft preferredModel on every backend.
  test('overrideModel takes precedence over preferredModel (anthropic)', () => {
    const config = configWith({ builder: anthropic('claude-opus-4-8'), agent: anthropic() });
    const r = resolveRoleTarget('builder', config, { preferredModel: 'claude-haiku-4-5-20251001', overrideModel: 'mythos' });
    expect(r.backend).toBe('anthropic');
    expect(r.model).toBe('mythos');
  });

  // INVARIANT: an explicit override satisfies the "no model configured" guard for
  // a local backend — server pinned in config, model supplied by the flag.
  test('overrideModel supplies the model for an ollama role with no configured model', () => {
    const config = configWith({ builder: ollama(''), agent: anthropic() });
    const r = resolveRoleTarget('builder', config, { overrideModel: 'mythos' });
    expect(r.backend).toBe('ollama');
    expect(r.model).toBe('mythos');
  });

  // INVARIANT: the soft preferredModel must NEVER override an authoritative local
  // model — otherwise an opus-defaulted agent task would break every ollama
  // launch. Only the explicit overrideModel may.
  test('ollama role still ignores preferredModel (only overrideModel wins)', () => {
    const config = configWith({ builder: anthropic(), agent: ollama('qwen3-coder') });
    const r = resolveRoleTarget('agent', config, { preferredModel: 'claude-opus-4-8' });
    expect(r.model).toBe('qwen3-coder');
  });
});

describe('isKnownAnthropicModel', () => {
  // INVARIANT (fix-builder-model-ollama-precedence): any `claude-*` id is the
  // escape hatch for models newer than our short-name list, so it's always
  // recognized without a hard-coded entry.
  test('recognizes any claude-* id (escape hatch for future models)', () => {
    expect(isKnownAnthropicModel('claude-opus-4-8')).toBe(true);
    expect(isKnownAnthropicModel('claude-something-not-shipped-yet')).toBe(true);
  });

  // INVARIANT: the known short aliases are recognized so users can pass them.
  test('recognizes the known short names', () => {
    for (const name of ['haiku', 'sonnet', 'opus', 'fable', 'mythos']) {
      expect(isKnownAnthropicModel(name)).toBe(true);
    }
    expect(isKnownAnthropicModel('OPUS')).toBe(true); // case-insensitive
  });

  // INVARIANT: an arbitrary (e.g. local) model name is NOT an Anthropic model —
  // it needs a configured local server, so it's rejected against the anthropic backend.
  test('rejects arbitrary / local model names', () => {
    expect(isKnownAnthropicModel('qwen3-coder')).toBe(false);
    expect(isKnownAnthropicModel('llama3')).toBe(false);
    expect(isKnownAnthropicModel('gpt-4o')).toBe(false);
  });
});

describe('resolveAgentModel', () => {
  test('falls back to models.default for an anthropic role with nothing set', () => {
    const config = configWith({ builder: anthropic(), agent: anthropic() }, 'claude-opus-4-8');
    expect(resolveAgentModel(config)).toBe('claude-opus-4-8');
  });

  test('returns the ollama model for an ollama agent role', () => {
    const config = configWith({ builder: anthropic(), agent: ollama('qwen3-coder') });
    expect(resolveAgentModel(config)).toBe('qwen3-coder');
  });

  test('accepts a null preferred model (task.model may be null)', () => {
    const config = configWith({ builder: anthropic(), agent: anthropic() }, 'claude-opus-4-8');
    expect(resolveAgentModel(config, { preferredModel: null })).toBe('claude-opus-4-8');
  });
});

describe('targetEnvVars', () => {
  test('ollama uses self-contained dummy credentials + base URL + stability flags', () => {
    const env = targetEnvVars(ollama('qwen3-coder', 'http://localhost:11434'), [], 'container');
    const map = Object.fromEntries(env.map(v => [v.key, v.value]));
    expect(map.ANTHROPIC_BASE_URL).toBe('http://localhost:11434');
    expect(map.ANTHROPIC_AUTH_TOKEN).toBe('ollama');
    expect(map.DISABLE_TELEMETRY).toBe('1');
  });

  test('proxy forwards the real credential alongside the base URL', () => {
    const env = targetEnvVars(
      { backend: 'proxy', model: 'claude-opus-4-8', endpoint: 'http://localhost:8080' },
      [{ key: 'ANTHROPIC_API_KEY', value: 'sk-real' }],
      'container',
    );
    const map = Object.fromEntries(env.map(v => [v.key, v.value]));
    expect(map.ANTHROPIC_BASE_URL).toBe('http://localhost:8080');
    expect(map.ANTHROPIC_API_KEY).toBe('sk-real');
  });

  test('anthropic with no proxyUrl passes the credential through unchanged (proxy disabled)', () => {
    const env = targetEnvVars(anthropic('claude-opus-4-8'), [{ key: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'tok' }], 'container');
    expect(env).toEqual([{ key: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'tok' }]);
  });

  // INVARIANT (default-on proxy): anthropic traffic routes through lazy's local
  // audit/policy proxy whenever one is live. Without this, the default-on posture
  // is a lie — the proxy would run but nothing would flow through it.
  test('anthropic WITH proxyUrl routes through the proxy, credential passed through', () => {
    const env = targetEnvVars(
      { ...anthropic('claude-opus-4-8'), proxyUrl: 'http://127.0.0.1:8766' },
      [{ key: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'tok' }],
      'container',
      { role: 'agent', taskId: 'abc12345' },
    );
    const map = Object.fromEntries(env.map(v => [v.key, v.value]));
    expect(map.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8766');
    // Credential passthrough is what makes this transparent — no auth regression.
    expect(map.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok');
    // Proxied traffic is attributable like any other proxied traffic.
    expect(map.ANTHROPIC_CUSTOM_HEADERS).toBe('x-lazy-role: agent\nx-lazy-task-id: abc12345');
  });

  test('an API-key credential is passed through the proxy path too', () => {
    const env = targetEnvVars(
      { ...anthropic(''), proxyUrl: 'http://127.0.0.1:8766' },
      [{ key: 'ANTHROPIC_API_KEY', value: 'sk-real' }],
      'container',
    );
    const map = Object.fromEntries(env.map(v => [v.key, v.value]));
    expect(map.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8766');
    expect(map.ANTHROPIC_API_KEY).toBe('sk-real');
  });

  // INVARIANT: ollama is NEVER routed through the proxy — the proxy has a single
  // Anthropic-native upstream, and a local model is not it.
  test('ollama ignores proxyUrl entirely', () => {
    const env = targetEnvVars(
      { ...ollama('qwen3-coder', 'http://localhost:11434'), proxyUrl: 'http://127.0.0.1:8766' },
      [],
      'container',
    );
    const map = Object.fromEntries(env.map(v => [v.key, v.value]));
    expect(map.ANTHROPIC_BASE_URL).toBe('http://localhost:11434');
  });

  // INVARIANT: proxied traffic carries x-lazy-role / x-lazy-task-id (via
  // ANTHROPIC_CUSTOM_HEADERS) so the audit plane can attribute each request to
  // the agent + task that made it. Without this the audit record's role/taskId
  // are always null (the proxy reads headers nobody sets).
  test('proxy emits ANTHROPIC_CUSTOM_HEADERS from audit hints', () => {
    const env = targetEnvVars(
      { backend: 'proxy', model: 'claude-opus-4-8', endpoint: 'http://localhost:8080' },
      [{ key: 'ANTHROPIC_API_KEY', value: 'sk-real' }],
      'container',
      { role: 'agent', taskId: 'abc12345' },
    );
    const map = Object.fromEntries(env.map(v => [v.key, v.value]));
    expect(map.ANTHROPIC_CUSTOM_HEADERS).toBe('x-lazy-role: agent\nx-lazy-task-id: abc12345');
  });

  // INVARIANT: the audit headers are proxy-only — real Anthropic and ollama must
  // never receive lazy-internal headers.
  test('anthropic and ollama never emit audit headers even with hints', () => {
    const a = targetEnvVars(anthropic('claude-opus-4-8'), [{ key: 'X', value: 'y' }], 'container', { role: 'agent', taskId: 't' });
    expect(a.find(v => v.key === 'ANTHROPIC_CUSTOM_HEADERS')).toBeUndefined();
    const o = targetEnvVars(ollama('qwen3-coder'), [], 'container', { role: 'agent', taskId: 't' });
    expect(o.find(v => v.key === 'ANTHROPIC_CUSTOM_HEADERS')).toBeUndefined();
  });

  test('proxy without hints emits no audit header (backwards compatible)', () => {
    const env = targetEnvVars(
      { backend: 'proxy', model: 'm', endpoint: 'http://localhost:8080' },
      [{ key: 'ANTHROPIC_API_KEY', value: 'sk' }],
      'container',
    );
    expect(env.find(v => v.key === 'ANTHROPIC_CUSTOM_HEADERS')).toBeUndefined();
  });

  // INVARIANT: never point Claude Code at an empty base URL — that would silently
  // send traffic straight to real Anthropic, bypassing the proxy's audit/policy
  // plane. An unset endpoint means the daemon's live proxy URL was never injected.
  test('proxy with an empty endpoint fails hard (no silent bypass)', () => {
    expect(() =>
      targetEnvVars({ backend: 'proxy', model: 'm', endpoint: '' }, [{ key: 'ANTHROPIC_API_KEY', value: 'sk' }], 'container'),
    ).toThrow(/no endpoint/i);
  });
});

describe('proxyBaseUrlForRunner', () => {
  // INVARIANT: container runners reach host services via host.docker.internal;
  // the host-process runner reaches the proxy on its own bind address.
  test('container runners use host.docker.internal', () => {
    expect(proxyBaseUrlForRunner('docker', 8766, '127.0.0.1')).toBe('http://host.docker.internal:8766');
    expect(proxyBaseUrlForRunner('podman', 40000, '127.0.0.1')).toBe('http://host.docker.internal:40000');
  });

  test('host-process runner uses the proxy bind (loopback default)', () => {
    expect(proxyBaseUrlForRunner('dangerously-host-process-without-any-isolation', 8766, '127.0.0.1'))
      .toBe('http://127.0.0.1:8766');
  });

  test('a wildcard bind falls back to loopback for the host-process URL', () => {
    expect(proxyBaseUrlForRunner('dangerously-host-process-without-any-isolation', 8766, '0.0.0.0'))
      .toBe('http://127.0.0.1:8766');
  });
});

describe('proxyAuditHeaderEnv', () => {
  test('emits only the present hints', () => {
    expect(proxyAuditHeaderEnv({ role: 'builder' })).toEqual({
      key: 'ANTHROPIC_CUSTOM_HEADERS',
      value: 'x-lazy-role: builder',
    });
    expect(proxyAuditHeaderEnv({ taskId: 'abc12345' })).toEqual({
      key: 'ANTHROPIC_CUSTOM_HEADERS',
      value: 'x-lazy-task-id: abc12345',
    });
  });

  test('returns null when nothing usable is present', () => {
    expect(proxyAuditHeaderEnv(undefined)).toBeNull();
    expect(proxyAuditHeaderEnv({})).toBeNull();
  });

  // INVARIANT: a value is interpolated into a header line, so a crafted id that
  // contains a newline (or other non-token chars) MUST be dropped — otherwise it
  // could inject a second, attacker-controlled header.
  test('drops a hint value that could inject a header', () => {
    expect(proxyAuditHeaderEnv({ taskId: 'evil\nx-inject: 1' })).toBeNull();
    expect(proxyAuditHeaderEnv({ role: 'agent', taskId: 'has space' })).toEqual({
      key: 'ANTHROPIC_CUSTOM_HEADERS',
      value: 'x-lazy-role: agent',
    });
  });
});

describe('connectivity preflight', () => {
  // Anthropic reachability is the credential gate's job, not the network probe's.
  test('anthropic targets are always reported reachable', async () => {
    const check = await checkTargetConnectivity(anthropic('claude-opus-4-8'));
    expect(check.reachable).toBe(true);
  });

  test('anthropic preflight never throws', async () => {
    await preflightRoleTarget('agent', anthropic('claude-opus-4-8'));
  });

  // INVARIANT: An unreachable local backend fails hard with an actionable error —
  // lazy must NEVER silently fall back to a different backend.
  test('preflight throws an actionable error for an unreachable ollama backend', async () => {
    // Port 1 is reserved/unused, so the probe fails fast with a connection error.
    const target: RoleTarget = { backend: 'ollama', model: 'qwen3-coder', endpoint: 'http://127.0.0.1:1' };
    await expect(preflightRoleTarget('agent', target)).rejects.toThrow(/Preflight failed for the "agent" role/);
  });
});

describe('launch surface (host vs container endpoints)', () => {
  const DOCKER_OLLAMA = 'http://host.docker.internal:11434';

  // INVARIANT: `host.docker.internal` is Docker's internal DNS alias for the
  // host. It resolves only INSIDE a container — a host process handed that name
  // dies with ENOTFOUND. `lazy pair`, `lazy chat`, and the host-process runner
  // all launch Claude Code as HOST processes even on a docker-runner project,
  // so their env MUST carry the host-reachable address.
  test('host surface rewrites a docker-internal endpoint', () => {
    const env = targetEnvVars(ollama('qwen3-coder', DOCKER_OLLAMA), [], 'host');
    const map = Object.fromEntries(env.map(v => [v.key, v.value]));
    expect(map.ANTHROPIC_BASE_URL).toBe('http://localhost:11434');
  });

  // INVARIANT: the conversion is one-directional. A CONTAINER launch genuinely
  // needs `host.docker.internal` to reach a service on the host — blanket-
  // converting would break containers in the other direction.
  test('container surface keeps the docker-internal endpoint untouched', () => {
    const env = targetEnvVars(ollama('qwen3-coder', DOCKER_OLLAMA), [], 'container');
    const map = Object.fromEntries(env.map(v => [v.key, v.value]));
    expect(map.ANTHROPIC_BASE_URL).toBe(DOCKER_OLLAMA);
  });

  // INVARIANT: the injected proxy address is converted too, not just `endpoint`.
  // `resolveLiveProxyUrl` builds the proxy URL for the CONFIGURED RUNNER — so on
  // a docker-runner project it hands back `host.docker.internal`, which a host
  // launch (pair/chat) must not pass through verbatim. This is the default-on
  // proxy half of the same bug and is NOT covered by `endpoint`.
  test('host surface rewrites an injected proxyUrl on an anthropic role', () => {
    const target: RoleTarget = { ...anthropic('claude-opus-4-8'), proxyUrl: 'http://host.docker.internal:8766' };
    const hostMap = Object.fromEntries(
      targetEnvVars(target, [{ key: 'ANTHROPIC_API_KEY', value: 'sk' }], 'host').map(v => [v.key, v.value]),
    );
    expect(hostMap.ANTHROPIC_BASE_URL).toBe('http://localhost:8766');
    // ...and the container launch still gets the docker-internal name.
    const containerMap = Object.fromEntries(
      targetEnvVars(target, [{ key: 'ANTHROPIC_API_KEY', value: 'sk' }], 'container').map(v => [v.key, v.value]),
    );
    expect(containerMap.ANTHROPIC_BASE_URL).toBe('http://host.docker.internal:8766');
  });

  test('a proxy-backend endpoint is converted for the host surface as well', () => {
    const target: RoleTarget = { backend: 'proxy', model: 'claude-opus-4-8', endpoint: 'http://host.docker.internal:8766' };
    const map = Object.fromEntries(
      targetEnvVars(target, [{ key: 'ANTHROPIC_API_KEY', value: 'sk' }], 'host').map(v => [v.key, v.value]),
    );
    expect(map.ANTHROPIC_BASE_URL).toBe('http://localhost:8766');
  });

  // Only the exact hostname is rewritten — never a substring match.
  test('targetForSurface leaves unrelated hostnames alone', () => {
    const t: RoleTarget = { backend: 'ollama', model: 'm', endpoint: 'http://host.docker.internal.example.com:11434' };
    expect(targetForSurface(t, 'host').endpoint).toBe('http://host.docker.internal.example.com:11434');
    expect(targetForSurface({ backend: 'ollama', model: 'm', endpoint: 'http://192.168.1.5:11434' }, 'host').endpoint)
      .toBe('http://192.168.1.5:11434');
  });

  // INVARIANT — THE load-bearing one for this module: the address the
  // reachability preflight VERIFIED is the address a host launch is handed.
  // These two used to be computed independently: preflight probed the
  // host-converted address (so it passed) while the env carried the raw
  // docker-internal one (so Claude Code died with ENOTFOUND despite a green
  // preflight). They now share `targetForSurface`, and this test pins that.
  test('probed endpoint == the ANTHROPIC_BASE_URL a host launch receives', async () => {
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') });
    try {
      // Configured the way a docker-runner project configures it.
      const target: RoleTarget = {
        backend: 'proxy',
        model: 'claude-opus-4-8',
        endpoint: `http://host.docker.internal:${server.port}`,
      };
      const probed = await preflightRoleTarget('builder', target);
      const map = Object.fromEntries(
        targetEnvVars(target, [{ key: 'ANTHROPIC_API_KEY', value: 'sk' }], 'host').map(v => [v.key, v.value]),
      );
      expect(map.ANTHROPIC_BASE_URL).toBe(probed);
      expect(probed).toBe(`http://localhost:${server.port}`);
    } finally {
      server.stop(true);
    }
  });

  test('preflight reports "anthropic" for an anthropic target', async () => {
    expect(await preflightRoleTarget('builder', anthropic('claude-opus-4-8'))).toBe('anthropic');
  });
});
