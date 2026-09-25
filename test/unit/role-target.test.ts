import { describe, test, expect } from 'bun:test';
import type { ResolvedConfig, RoleTarget } from '../../src/config/types';
import {
  resolveRoleTarget,
  roleTargetForProfile,
  targetEnvVars,
  proxyAuditHeaderEnv,
  proxyBaseUrlForRunner,
  checkTargetConnectivity,
  preflightRoleTarget,
  upstreamRefused,
  isKnownAnthropicModel,
  targetForSurface,
  ANTHROPIC_DEFAULT_TARGET,
  LOCAL_BACKEND_CREDS,
} from '../../src/utils/role-target';
import {
  agentProfilesFor,
  DEFAULT_AGENT_PROFILE_NAME,
  NO_CREDENTIAL,
  type AgentProfile,
} from '../../src/config/agent-profiles';

/**
 * Build a minimal ResolvedConfig carrying only the fields resolveRoleTarget reads.
 * The role-target resolver only touches config.models, so the rest is unused here.
 */
function configWith(roles: { builder: RoleTarget; agent: RoleTarget }, dflt = 'claude-opus-4-8'): ResolvedConfig {
  return { models: { default: dflt, roles } } as unknown as ResolvedConfig;
}

/** The built-in claude-code profile: no endpoint of its own, nothing pinned. */
const anthropic = (model = ''): RoleTarget => ({ ...ANTHROPIC_DEFAULT_TARGET, model });

/**
 * A profile pinned to a local Ollama box — the successor to `backend = "ollama"`.
 * `pinned` is what the old backend name encoded: a human named this endpoint.
 */
const ollama = (model: string, endpoint = 'http://host.docker.internal:11434'): RoleTarget => ({
  profile: 'local-ollama',
  harness: 'claude-code',
  model,
  endpoint,
  pinned: true,
  wire: 'anthropic',
  credential: NO_CREDENTIAL,
});

/** A profile pinned to an Anthropic-compatible gateway — the old `backend = "proxy"`. */
const gateway = (model: string, endpoint = 'https://gw.example.com'): RoleTarget => ({
  profile: 'gateway',
  harness: 'claude-code',
  model,
  endpoint,
  pinned: true,
  wire: 'anthropic',
  credential: 'anthropic',
});

describe('ANTHROPIC_DEFAULT_TARGET', () => {
  // INVARIANT: the constant is spelled out by hand (role-target must stay a leaf
  // module — resolving profiles reaches the agent registry and closes a cycle),
  // so nothing but a test keeps it in step with the built-in profile it claims to
  // be. A drift here means runners with no per-role target launch a profile that
  // does not exist as written.
  test('matches the built-in claude-code profile', () => {
    const builtin = agentProfilesFor({}).get(DEFAULT_AGENT_PROFILE_NAME)!;
    expect(builtin).toBeDefined();
    expect(ANTHROPIC_DEFAULT_TARGET).toEqual(roleTargetForProfile(builtin));
  });
});

describe('resolveRoleTarget', () => {
  test('unpinned profile honors the caller preferred model', () => {
    const config = configWith({ builder: anthropic(), agent: anthropic() });
    const r = resolveRoleTarget('agent', config, { preferredModel: 'claude-haiku-4-5-20251001' });
    expect(r.pinned).toBe(false);
    expect(r.model).toBe('claude-haiku-4-5-20251001');
  });

  // Fable 5.1 is a concrete Anthropic id, not a short alias. Pass-through must
  // keep the full id so the agent (and the API) get 5.1 rather than whatever
  // Claude Code currently binds `fable` to.
  test('unpinned profile passes claude-fable-5-1 through unchanged', () => {
    const config = configWith({ builder: anthropic('claude-fable-5-1'), agent: anthropic() });
    expect(resolveRoleTarget('builder', config).model).toBe('claude-fable-5-1');
    const r = resolveRoleTarget('agent', config, { preferredModel: 'claude-fable-5-1' });
    expect(r.pinned).toBe(false);
    expect(r.model).toBe('claude-fable-5-1');
  });

  test('unpinned profile with no preferred model falls back to the profile model', () => {
    const config = configWith({ builder: anthropic('claude-opus-4-8'), agent: anthropic() });
    expect(resolveRoleTarget('builder', config).model).toBe('claude-opus-4-8');
  });

  // INVARIANT: on a PINNED profile the configured model is authoritative and a
  // caller's preferred alias (e.g. "claude-opus-4-8") is intentionally ignored —
  // that name does not exist on someone's Ollama box.
  test('pinned profile ignores the preferred model and uses the configured one', () => {
    const config = configWith({ builder: anthropic(), agent: ollama('qwen3-coder') });
    const r = resolveRoleTarget('agent', config, { preferredModel: 'claude-opus-4-8' });
    expect(r.pinned).toBe(true);
    expect(r.model).toBe('qwen3-coder');
    expect(r.endpoint).toBe('http://host.docker.internal:11434');
  });

  // INVARIANT: a pinned ANTHROPIC-WIRE upstream only works through a harness lazy
  // can point at a lazy-controlled base URL (claude-code, pi). Any other harness
  // drops the pin rather than passing a local model name to a backend that can't
  // serve it. Compared against the HARNESS, never the profile name.
  test('a harness that cannot honour an anthropic pin falls back to the model chain', () => {
    const config = configWith({ builder: anthropic(), agent: ollama('qwen3-coder') });
    const r = resolveRoleTarget('agent', config, { preferredModel: 'claude-opus-4-8', harness: 'qa-agent' });
    expect(r.pinned).toBe(false);
    expect(r.model).toBe('claude-opus-4-8');
  });

  // INVARIANT: No silent name substitution — a hand-built pinned target with no
  // model throws rather than guessing a default. (Config load refuses this shape;
  // the guard is here for targets constructed in code.)
  test('throws on a pinned profile with no model', () => {
    const config = configWith({ builder: anthropic(), agent: ollama('') });
    expect(() => resolveRoleTarget('agent', config)).toThrow(/No model configured/);
  });

  // INVARIANT (fix-builder-model-ollama-precedence): an EXPLICIT override (e.g.
  // `lazy builder --model X`) wins over the configured model on a pinned profile,
  // while the endpoint (the "server") stays as configured. This makes a pinned
  // `[agents.<name>]` entry effectively *server* configuration — its model is just
  // a default the explicit flag overrides. Contrast the soft preferredModel above,
  // which a pinned profile intentionally ignores.
  test('pinned profile: overrideModel wins over the configured model but keeps the server', () => {
    const config = configWith({ builder: ollama('ollama-local-model'), agent: anthropic() });
    const r = resolveRoleTarget('builder', config, { overrideModel: 'mythos' });
    expect(r.pinned).toBe(true);
    expect(r.model).toBe('mythos');
    expect(r.endpoint).toBe('http://host.docker.internal:11434');
  });

  // INVARIANT: a hard override beats the soft preferredModel on every profile.
  test('overrideModel takes precedence over preferredModel (unpinned)', () => {
    const config = configWith({ builder: anthropic('claude-opus-4-8'), agent: anthropic() });
    const r = resolveRoleTarget('builder', config, { preferredModel: 'claude-haiku-4-5-20251001', overrideModel: 'mythos' });
    expect(r.pinned).toBe(false);
    expect(r.model).toBe('mythos');
  });

  // INVARIANT: an explicit override satisfies the "no model configured" guard for
  // a pinned profile — server pinned in config, model supplied by the flag.
  test('overrideModel supplies the model for a pinned profile with no configured model', () => {
    const config = configWith({ builder: ollama(''), agent: anthropic() });
    const r = resolveRoleTarget('builder', config, { overrideModel: 'mythos' });
    expect(r.pinned).toBe(true);
    expect(r.model).toBe('mythos');
  });

  // INVARIANT: the soft preferredModel must NEVER override an authoritative pinned
  // model — otherwise an opus-defaulted agent task would break every local launch.
  // Only the explicit overrideModel may.
  test('pinned profile still ignores preferredModel (only overrideModel wins)', () => {
    const config = configWith({ builder: anthropic(), agent: ollama('qwen3-coder') });
    const r = resolveRoleTarget('agent', config, { preferredModel: 'claude-opus-4-8' });
    expect(r.model).toBe('qwen3-coder');
  });

  // INVARIANT (the whole point of profiles): `[models.roles.*]` is only the
  // fallback for a task that named no profile. A launch that resolved its OWN
  // profile runs THAT one — resolving against the role default regardless is what
  // made "pi on local Ollama" reroute every claude-code task too.
  test('an explicit profile overrides the role default entirely', () => {
    const config = configWith({ builder: anthropic(), agent: anthropic() });
    const profile: AgentProfile = {
      name: 'local-ollama-pi',
      builtin: false,
      harness: 'pi',
      model: 'qwen3.8:latest',
      endpoint: 'http://localhost:11434',
      endpointPinned: true,
      wire: 'anthropic',
      credential: NO_CREDENTIAL,
    };
    const r = resolveRoleTarget('agent', config, { profile, preferredModel: 'claude-opus-4-8' });
    expect(r.profile).toBe('local-ollama-pi');
    expect(r.harness).toBe('pi');
    expect(r.model).toBe('qwen3.8:latest');
    expect(r.endpoint).toBe('http://localhost:11434');
  });
});

describe('isKnownAnthropicModel', () => {
  // INVARIANT (fix-builder-model-ollama-precedence): any `claude-*` id is the
  // escape hatch for models newer than our short-name list, so it's always
  // recognized without a hard-coded entry. Fable 5.1 is one such id — lazy does
  // not hard-code it; the prefix is enough for builder --model validation.
  test('recognizes any claude-* id (escape hatch for future models)', () => {
    expect(isKnownAnthropicModel('claude-opus-4-8')).toBe(true);
    expect(isKnownAnthropicModel('claude-fable-5-1')).toBe(true);
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
  // it needs a profile with an endpoint that serves it, so it's rejected against
  // an unpinned profile.
  test('rejects arbitrary / local model names', () => {
    expect(isKnownAnthropicModel('qwen3-coder')).toBe(false);
    expect(isKnownAnthropicModel('llama3')).toBe(false);
    expect(isKnownAnthropicModel('gpt-4o')).toBe(false);
  });
});

describe('targetEnvVars', () => {
  // LOCAL_BACKEND_CREDS is the credential SOURCE for a `credential = "none"`
  // profile — the server ignores auth, and a local-only project may hold no
  // Anthropic credential at all, so requiring a real one would break exactly the
  // setup such a profile serves. The single slot is deliberate: one placeholder,
  // one grant, per launch.
  test('a none-credential profile gets synthetic credentials + the proxy base URL + stability flags', () => {
    const env = targetEnvVars(
      { ...ollama('qwen3-coder', 'http://localhost:11434'), proxyUrl: 'http://127.0.0.1:8766' },
      LOCAL_BACKEND_CREDS,
      'container',
    );
    const map = Object.fromEntries(env.map(v => [v.key, v.value]));
    expect(map.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8766');
    expect(map.ANTHROPIC_AUTH_TOKEN).toBe('ollama');
    expect(map.DISABLE_TELEMETRY).toBe('1');
    expect(LOCAL_BACKEND_CREDS).toHaveLength(1);
  });

  // INVARIANT: a profile's `endpoint` is the upstream the PROXY forwards to — it
  // is never handed to the launched process. The base URL always comes from
  // `proxyUrl`. Emitting `endpoint` here is exactly the direct connection this
  // module exists to prevent, so the assertion is on its ABSENCE too.
  test('a pinned gateway gets the proxy address, never its own endpoint', () => {
    const env = targetEnvVars(
      { ...gateway('claude-opus-4-8', 'http://localhost:8080'), proxyUrl: 'http://127.0.0.1:8766' },
      [{ key: 'ANTHROPIC_API_KEY', value: 'sk-real' }],
      'container',
    );
    const map = Object.fromEntries(env.map(v => [v.key, v.value]));
    expect(map.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8766');
    expect(map.ANTHROPIC_API_KEY).toBe('sk-real');
    expect(env.some(v => v.value.includes('localhost:8080'))).toBe(false);
  });

  test('unpinned with no proxyUrl passes the credential through unchanged (proxy disabled)', () => {
    const env = targetEnvVars(anthropic('claude-opus-4-8'), [{ key: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'tok' }], 'container');
    expect(env).toEqual([{ key: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'tok' }]);
  });

  // INVARIANT (default-on proxy): anthropic traffic routes through lazy's local
  // audit/policy proxy whenever one is live. Without this, the default-on posture
  // is a lie — the proxy would run but nothing would flow through it.
  test('unpinned WITH proxyUrl routes through the proxy, credential passed through', () => {
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

  // INVARIANT (proxy-role-upstreams): local-model profiles ARE routed through the
  // proxy. They used to be the documented carve-out — ANTHROPIC_BASE_URL pointed
  // at the ollama server and the traffic never touched the audit plane. The
  // endpoint is now the upstream the PROXY forwards to, so the launch gets the
  // proxy address and the ollama URL must not appear in the env at all.
  test('a local-model profile routes through proxyUrl and never leaks its endpoint', () => {
    const env = targetEnvVars(
      { ...ollama('qwen3-coder', 'http://localhost:11434'), proxyUrl: 'http://127.0.0.1:8766' },
      LOCAL_BACKEND_CREDS,
      'container',
    );
    const map = Object.fromEntries(env.map(v => [v.key, v.value]));
    expect(map.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8766');
    expect(env.some(v => v.value.includes('11434'))).toBe(false);
    // The stability flags a non-Anthropic Anthropic-wire server needs are applied.
    expect(map.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBeDefined();
  });

  // BEHAVIOUR CHANGE, NOT AN INVARIANT — and the question is OPEN (raised item
  // 0f2ba9c7). The flags are now gated on "pinned Anthropic-wire upstream that is
  // not api.anthropic.com" rather than on the backend NAME `ollama`, so a
  // self-hosted Anthropic-compatible gateway gains them — it stops hitting the
  // 404s and hangs they exist to avoid, but it also silently loses telemetry and
  // error reporting it used to have. This test pins what the code does TODAY; it
  // does not assert that this is the right gate. If the human picks the narrower
  // local-only gate, this test changes with it.
  test('a pinned non-ollama anthropic-wire gateway also gets the stability flags', () => {
    const env = targetEnvVars(
      { ...gateway('claude-opus-4-8'), proxyUrl: 'http://127.0.0.1:8766' },
      [{ key: 'ANTHROPIC_API_KEY', value: 'sk' }],
      'container',
    );
    const map = Object.fromEntries(env.map(v => [v.key, v.value]));
    expect(map.DISABLE_TELEMETRY).toBe('1');
    expect(map.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
  });

  // INVARIANT: Anthropic's own API keeps its default behaviour — an unpinned
  // profile must never get the flags, or every ordinary launch silently loses
  // telemetry and error reporting.
  test('an unpinned profile never gets the stability flags', () => {
    const env = targetEnvVars(
      { ...anthropic('claude-opus-4-8'), proxyUrl: 'http://127.0.0.1:8766' },
      [{ key: 'ANTHROPIC_API_KEY', value: 'sk' }],
      'container',
    );
    expect(env.find(v => v.key === 'DISABLE_TELEMETRY')).toBeUndefined();
  });

  // INVARIANT: proxied traffic carries x-lazy-role / x-lazy-task-id (via
  // ANTHROPIC_CUSTOM_HEADERS) so the audit plane can attribute each request to
  // the agent + task that made it. Without this the audit record's role/taskId
  // are always null (the proxy reads headers nobody sets).
  test('emits ANTHROPIC_CUSTOM_HEADERS from audit hints', () => {
    const env = targetEnvVars(
      { ...gateway('claude-opus-4-8', ''), proxyUrl: 'http://127.0.0.1:8766' },
      [{ key: 'ANTHROPIC_API_KEY', value: 'sk-real' }],
      'container',
      { role: 'agent', taskId: 'abc12345' },
    );
    const map = Object.fromEntries(env.map(v => [v.key, v.value]));
    expect(map.ANTHROPIC_CUSTOM_HEADERS).toBe('x-lazy-role: agent\nx-lazy-task-id: abc12345');
  });

  // INVARIANT: the audit headers ride WITH the proxy address, never without it.
  // A target carrying no proxyUrl is one whose traffic this process is not
  // stamping (see targetEnvVars) — headers there would be noise sent to whatever
  // upstream the inherited base URL happens to name.
  test('a target with no proxyUrl emits no audit headers even with hints', () => {
    const a = targetEnvVars(anthropic('claude-opus-4-8'), [{ key: 'X', value: 'y' }], 'container', { role: 'agent', taskId: 't' });
    expect(a.find(v => v.key === 'ANTHROPIC_CUSTOM_HEADERS')).toBeUndefined();
    const o = targetEnvVars(ollama('qwen3-coder'), [], 'container', { role: 'agent', taskId: 't' });
    expect(o.find(v => v.key === 'ANTHROPIC_CUSTOM_HEADERS')).toBeUndefined();
  });

  test('proxied launch without hints emits no audit header (backwards compatible)', () => {
    const env = targetEnvVars(
      { ...gateway('m', ''), proxyUrl: 'http://127.0.0.1:8766' },
      [{ key: 'ANTHROPIC_API_KEY', value: 'sk' }],
      'container',
    );
    expect(env.find(v => v.key === 'ANTHROPIC_CUSTOM_HEADERS')).toBeUndefined();
  });

  // INVARIANT — THE load-bearing one for this module (proxy-role-upstreams):
  // NO role target ever yields a non-proxy base URL. Every profile shape, every
  // surface, every endpoint spelling: if ANTHROPIC_BASE_URL is set at all, it is
  // the proxy's address. This is the assertion that would catch a third carve-out
  // being reintroduced — the first two (ollama, explicit endpoints) were direct
  // connections behind the audit plane's back for a year.
  test('no role target ever yields a non-proxy base URL', () => {
    const PROXY = 'http://127.0.0.1:8766';
    const UPSTREAMS = ['', 'http://localhost:11434', 'http://host.docker.internal:11434', 'https://api.example.com'];
    for (const pinned of [false, true]) {
      for (const credential of ['anthropic', NO_CREDENTIAL, 'work-openai']) {
        for (const endpoint of UPSTREAMS) {
          for (const surface of ['host', 'container'] as const) {
            const env = targetEnvVars(
              {
                profile: 'p', harness: 'claude-code', model: 'm',
                endpoint, pinned, wire: 'anthropic', credential, proxyUrl: PROXY,
              },
              [{ key: 'ANTHROPIC_API_KEY', value: 'sk' }],
              surface,
            );
            const map = Object.fromEntries(env.map(v => [v.key, v.value]));
            expect(map.ANTHROPIC_BASE_URL).toBe(PROXY);
            // ...and the upstream never rides along in some other variable.
            if (endpoint) expect(env.some(v => v.value.includes(endpoint))).toBe(false);
          }
        }
      }
    }
  });

  // The one case that legitimately produces no base URL: nothing resolved one.
  // That is NOT a direct-connection path — it means this process inherits an
  // already-proxied base URL from its parent (the in-container supervisor) or is
  // in an explicit RPC-bypass mode. The fail-loud gate that refuses a genuine
  // resolution failure lives in daemon/auth-env, not here.
  test('a target with no proxyUrl sets no base URL at all', () => {
    const env = targetEnvVars(
      gateway('m', 'http://localhost:8080'),
      [{ key: 'ANTHROPIC_API_KEY', value: 'sk' }],
      'container',
    );
    expect(env.find(v => v.key === 'ANTHROPIC_BASE_URL')).toBeUndefined();
    // Emphatically not the endpoint, either.
    expect(env.some(v => v.value.includes('localhost:8080'))).toBe(false);
  });
});

describe('targetEnvVars: the first-party base-URL assumption', () => {
  const FLAG = '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL';
  const PROXY = 'http://127.0.0.1:8766';
  const ANTHROPIC_UPSTREAM = 'https://api.anthropic.com';

  const flagOf = (target: RoleTarget) =>
    Object.fromEntries(
      targetEnvVars(target, [{ key: 'ANTHROPIC_API_KEY', value: 'sk' }], 'container').map(v => [v.key, v.value]),
    )[FLAG];

  // INVARIANT: a launch whose traffic really lands at Anthropic's own API must
  // tell Claude Code so. Claude Code caps EVERY model at a 200k context window
  // unless it believes its base URL is first-party, and it decides that by
  // matching ANTHROPIC_BASE_URL against a literal `api.anthropic.com` allowlist.
  // Lazy always points that variable at its own proxy, so without this flag a
  // 1M-window model silently runs at 200k (verified against Claude Code 2.1.266:
  // `claude --model claude-fable-5-1 -p "/context"` reports 200k with the proxy
  // base URL and 1m with the flag).
  test('an unpinned Anthropic profile riding the default upstream gets the flag', () => {
    expect(flagOf({ ...anthropic('claude-fable-5-1'), proxyUrl: PROXY, primaryUpstream: ANTHROPIC_UPSTREAM })).toBe('1');
  });

  // ...and a profile PINNED to Anthropic's own API is the same claim, made
  // explicitly rather than inherited from `[proxy] upstream`.
  test('a profile pinned to api.anthropic.com gets the flag', () => {
    expect(flagOf({ ...gateway('claude-opus-5', 'https://api.anthropic.com'), proxyUrl: PROXY })).toBe('1');
  });

  // INVARIANT: the flag is a factual claim about what sits on the far side of
  // the proxy, not a capability switch to turn on for everyone. It gates the 1M
  // window, the small/fast haiku model, model-alias resolution, org memory and
  // the billing headers — all of which mean "behave as if talking to Anthropic's
  // API". Setting it for an upstream that is NOT Anthropic tells Claude Code it
  // has capabilities that upstream lacks, which fails at request time instead of
  // at launch. Each row below is an upstream that is not Anthropic's API.
  test('never set for an upstream that is not Anthropic', () => {
    const cases: Array<[string, RoleTarget]> = [
      // A local model server, whatever address it answers on.
      ['ollama', { ...ollama('qwen3-coder'), proxyUrl: PROXY, primaryUpstream: ANTHROPIC_UPSTREAM }],
      // A third-party Anthropic-compatible gateway.
      ['pinned gateway', { ...gateway('claude-opus-5', 'https://gw.example.com'), proxyUrl: PROXY }],
      // An OpenAI-wire profile: not Claude Code, and not Anthropic's API.
      ['openai wire', {
        profile: 'work-openai', harness: 'codex', model: 'gpt-5', endpoint: 'https://api.openai.com',
        pinned: true, wire: 'openai', credential: 'work-openai', proxyUrl: PROXY,
      }],
      // The case `endpoint` alone cannot see: an unpinned profile whose traffic
      // rides a `[proxy] upstream` pointed at a self-hosted gateway.
      ['redirected primary upstream', {
        ...anthropic('claude-fable-5-1'), proxyUrl: PROXY, primaryUpstream: 'https://llm.internal.example.com',
      }],
      // Unknown is not Anthropic. A caller that did not resolve the upstream
      // leaves it undefined, and losing the 1M window is a smaller failure than
      // claiming capabilities the upstream may not have.
      ['unresolved upstream', { ...anthropic('claude-fable-5-1'), proxyUrl: PROXY }],
    ];
    for (const [label, target] of cases) {
      expect(`${label}:${flagOf(target)}`).toBe(`${label}:undefined`);
    }
  });

  // INVARIANT: the flag qualifies ANTHROPIC_BASE_URL — it says "the URL in that
  // variable is a passthrough to Anthropic". A launch that sets no base URL
  // inherits one from its parent or is in an RPC-bypass mode, so emitting the
  // flag there would be a claim about somebody else's variable.
  test('never set without the base URL it qualifies', () => {
    const env = targetEnvVars(
      { ...anthropic('claude-fable-5-1'), primaryUpstream: ANTHROPIC_UPSTREAM },
      [{ key: 'ANTHROPIC_API_KEY', value: 'sk' }],
      'container',
    );
    expect(env.find(v => v.key === FLAG)).toBeUndefined();
    expect(env.find(v => v.key === 'ANTHROPIC_BASE_URL')).toBeUndefined();
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
  test('unpinned targets are always reported reachable', async () => {
    const check = await checkTargetConnectivity(anthropic('claude-opus-4-8'));
    expect(check.reachable).toBe(true);
  });

  test('unpinned preflight never throws', async () => {
    await preflightRoleTarget('agent', anthropic('claude-opus-4-8'));
  });

  // INVARIANT: An unreachable pinned upstream fails hard with an actionable error —
  // lazy must NEVER silently fall back to a different upstream.
  test('preflight throws an actionable error for an unreachable pinned upstream', async () => {
    // Port 1 is reserved/unused, so the probe fails fast with a connection error.
    const target = ollama('qwen3-coder', 'http://127.0.0.1:1');
    await expect(preflightRoleTarget('agent', target)).rejects.toThrow(/Preflight failed for the "agent" role/);
  });

  // INVARIANT: a LOCAL upstream is probed whether or not a human pinned it. The
  // built-in `pi` profile's default IS a local Ollama, so "is the server
  // running?" is a real question for a target nobody wrote in lazy.toml — and
  // skipping it turns "start ollama" into an opaque proxy failure mid-turn.
  test('an unpinned LOCAL endpoint is still probed, and fails actionably when nothing answers', async () => {
    const builtinPi: RoleTarget = {
      profile: 'pi',
      harness: 'pi',
      model: 'qwen3.8:latest',
      // Port 1 is reserved/unused, so the probe fails fast.
      endpoint: 'http://127.0.0.1:1',
      pinned: false,
      wire: 'anthropic',
      credential: NO_CREDENTIAL,
    };
    const check = await checkTargetConnectivity(builtinPi);
    expect(check.reachable).toBe(false);
    await expect(preflightRoleTarget('agent', builtinPi)).rejects.toThrow(/Preflight failed/);
  });

  // …but a hosted DEFAULT nobody chose (codex's api.openai.com) is not: that
  // would add a network round-trip to every launch to answer a question the
  // first request answers anyway.
  test('an unpinned HOSTED default endpoint is not probed', async () => {
    const builtinCodex: RoleTarget = {
      profile: 'codex',
      harness: 'codex',
      model: '',
      endpoint: 'https://api.openai.com',
      pinned: false,
      wire: 'openai',
      credential: 'openai',
    };
    const check = await checkTargetConnectivity(builtinCodex);
    expect(check.reachable).toBe(true);
    expect(check.endpoint).toBe('anthropic');
  });

  // The error must name the profile to edit: under profiles the endpoint lives in
  // `[agents.<name>]`, and a message pointing at a role would send the user to a
  // block that no longer carries an endpoint at all.
  test('the preflight error names the profile whose block holds the endpoint', async () => {
    const target = ollama('qwen3-coder', 'http://127.0.0.1:1');
    await expect(preflightRoleTarget('agent', target)).rejects.toThrow(/\[agents\.local-ollama\]/);
  });

  // The remedy depends on WHO is reading, and managed mode is the case where
  // getting it wrong costs more than saying nothing. These two tests are a pair:
  // the unmanaged one is what keeps the managed one honest, because both run the
  // same unreachable target through the same call and differ only in the
  // environment.
  describe('the remedy on a managed host', () => {
    async function preflightMessage(managed: boolean): Promise<string> {
      const before = process.env.LAZY_MANAGED;
      if (managed) process.env.LAZY_MANAGED = '1';
      else delete process.env.LAZY_MANAGED;
      try {
        // Port 1 is reserved/unused, so the probe fails fast with a connection error.
        await preflightRoleTarget('agent', ollama('qwen3-coder', 'http://127.0.0.1:1'));
        throw new Error('preflight was expected to reject for an unreachable upstream');
      } catch (err) {
        return (err as Error).message;
      } finally {
        if (before === undefined) delete process.env.LAZY_MANAGED;
        else process.env.LAZY_MANAGED = before;
      }
    }

    // INVARIANT: the preflight NEVER tells a reader on a managed host to put an
    // endpoint in the repository's lazy.toml. `agents.*.endpoint` is `refused`
    // by the managed policy, so following that advice does not fix the launch —
    // it makes the whole project stop loading with `managed config refused`,
    // which is strictly worse than the failure being explained.
    test('does not send the reader to a repository key the host refuses', async () => {
      const message = await preflightMessage(true);
      expect(message).toMatch(/Preflight failed for the "agent" role/);
      expect(message).not.toMatch(/change \[agents\.[^\]]+\] in lazy\.toml/);
      expect(message).toMatch(/refused/);
      expect(message).toMatch(/installation/);
    });

    // Unmanaged, the reader owns the file and the old advice is the right advice.
    test('still points at [agents.<name>] when the project is not managed', async () => {
      const message = await preflightMessage(false);
      expect(message).toMatch(/change \[agents\.local-ollama\] in lazy\.toml/);
    });
  });
});

/**
 * `upstreamRefused` is the question asked before TAKING A CHOICE AWAY from
 * somebody (the create-time gate in `daemon/agent-profile-check.ts`), which is
 * why it is a different question from `checkTargetConnectivity` and why the
 * difference is tested rather than assumed.
 */
describe('conclusively-refused upstreams', () => {
  // INVARIANT: only a connection the host actively refused counts. A gate that
  // acted on its own timeout would refuse creates because the network was slow,
  // which is a worse failure than the dead task it exists to prevent.
  test('a port nothing is listening on is conclusive', async () => {
    // Port 1 is privileged and unbindable here, so the connect is refused at once.
    expect(await upstreamRefused(ollama('qwen3-coder', 'http://127.0.0.1:1'), 1_500)).toBe(true);
  });

  test('an upstream that accepts the connection and then says nothing is NOT conclusive', async () => {
    // A real blackhole rather than an unroutable address: the TCP connect
    // succeeds and no bytes ever come back, so curl can only time out. An
    // unroutable IP would be refused by the kernel and prove the opposite thing.
    const blackhole = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: { data() { /* deliberately never answers */ } },
    });
    try {
      const target = ollama('qwen3-coder', `http://127.0.0.1:${blackhole.port}`);
      expect(await upstreamRefused(target, 500)).toBe(false);
    } finally {
      blackhole.stop(true);
    }
  });

  test('an upstream that answers is not refused, whatever it answers', async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('nope', { status: 503 }) });
    try {
      const target = ollama('qwen3-coder', `http://127.0.0.1:${server.port}`);
      expect(await upstreamRefused(target, 1_500)).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  // The same narrowing `checkTargetConnectivity` applies: a role riding the
  // proxy's primary upstream has no local component, and nothing to be
  // conclusive about.
  test('a target lazy does not probe is never conclusive', async () => {
    expect(await upstreamRefused(anthropic('claude-opus-4-8'), 1_500)).toBe(false);
  });
});

describe('launch surface (host vs container endpoints)', () => {
  const DOCKER_OLLAMA = 'http://host.docker.internal:11434';

  // INVARIANT (proxy-role-upstreams): surface translation applies to the PROXY
  // ADDRESS ONLY. A profile's `endpoint` is dialed by the daemon, a host process,
  // so it has exactly one perspective and nothing to translate — and it is not
  // in the launch env to translate in the first place.
  test('a profile endpoint is untouched by surface, because it never reaches the env', () => {
    for (const surface of ['host', 'container'] as const) {
      const target = { ...ollama('qwen3-coder', DOCKER_OLLAMA), proxyUrl: 'http://127.0.0.1:8766' };
      expect(targetForSurface(target, surface).endpoint).toBe(DOCKER_OLLAMA);
      const env = targetEnvVars(target, LOCAL_BACKEND_CREDS, surface);
      expect(env.some(v => v.value.includes('11434'))).toBe(false);
    }
  });

  // INVARIANT: the injected proxy address is converted too, not just `endpoint`.
  // `resolveLiveProxyUrl` builds the proxy URL for the CONFIGURED RUNNER — so on
  // a docker-runner project it hands back `host.docker.internal`, which a host
  // launch (pair/chat) must not pass through verbatim. This is the default-on
  // proxy half of the same bug and is NOT covered by `endpoint`.
  test('host surface rewrites an injected proxyUrl on an unpinned profile', () => {
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

  // Only the exact hostname is rewritten — never a substring match.
  test('targetForSurface leaves unrelated hostnames alone', () => {
    const t: RoleTarget = { ...ollama('m', ''), proxyUrl: 'http://host.docker.internal.example.com:11434' };
    expect(targetForSurface(t, 'host').proxyUrl).toBe('http://host.docker.internal.example.com:11434');
    expect(targetForSurface({ ...ollama('m', ''), proxyUrl: 'http://192.168.1.5:11434' }, 'host').proxyUrl)
      .toBe('http://192.168.1.5:11434');
  });

  // INVARIANT (proxy-role-upstreams): the preflight probes the endpoint EXACTLY
  // as configured — no surface conversion — because the prober (this process,
  // or the daemon) is on the same side of the boundary as the proxy that will
  // dial it. And what the launch receives is the proxy's address, never the
  // probed one: verifying the upstream is reachable and telling the agent where
  // to send its traffic are now two different questions with two answers.
  test('preflight probes the endpoint verbatim; the launch still gets the proxy', async () => {
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') });
    try {
      const endpoint = `http://localhost:${server.port}`;
      const target: RoleTarget = {
        ...gateway('claude-opus-4-8', endpoint),
        proxyUrl: 'http://127.0.0.1:8766',
      };
      const probed = await preflightRoleTarget('builder', target);
      expect(probed).toBe(endpoint);
      const map = Object.fromEntries(
        targetEnvVars(target, [{ key: 'ANTHROPIC_API_KEY', value: 'sk' }], 'host').map(v => [v.key, v.value]),
      );
      expect(map.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8766');
    } finally {
      server.stop(true);
    }
  });

  test('preflight reports "anthropic" for an unpinned target', async () => {
    expect(await preflightRoleTarget('builder', anthropic('claude-opus-4-8'))).toBe('anthropic');
  });
});
