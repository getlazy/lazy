/**
 * Per-turn pi config: the models.json proxy pin, the MCP bridge extension
 * write, and the pi-specific launch env.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import {
  piLaunchEnvVars,
  piProviderForProfile,
  piCredentialMirror,
  writePiModelsConfig,
  writePiBridgeExtension,
  writePiSettingsConfig,
  piModelsConfigPath,
  piBridgeExtensionPath,
  piSettingsConfigPath,
  piHttpIdleTimeoutMsFromEnv,
  LAZY_PI_UPSTREAM_TIMEOUT_MS_ENV,
} from '../../src/agent/pi-turn-config';
import { LAZY_PI_PROVIDER_ENV } from '../../src/agent/pi';
import { wireForProfile } from '../../src/config/agent-profiles';

let home: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'HOME', 'ANTHROPIC_BASE_URL', LAZY_PI_PROVIDER_ENV, LAZY_PI_UPSTREAM_TIMEOUT_MS_ENV,
];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pi-home-'));
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.HOME = home;
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env[LAZY_PI_PROVIDER_ENV];
  delete process.env[LAZY_PI_UPSTREAM_TIMEOUT_MS_ENV];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(home, { recursive: true, force: true });
});

/**
 * A resolved profile, as far as these functions care. The wire comes from the
 * real resolver so these tests exercise the rule the proxy routes by, not a
 * hand-written copy of it.
 */
const profile = (endpoint: string, model = '') => {
  const wire = wireForProfile('pi', endpoint);
  if ('error' in wire) throw new Error(wire.error);
  return { endpoint, model, wire: wire.wire };
};

describe('piProviderForProfile', () => {
  // INVARIANT: an Anthropic upstream runs pi's BUILT-IN anthropic provider,
  // which carries Anthropic's own catalog and auth. Only an upstream pi has no
  // catalog for needs the custom provider block.
  test('no endpoint is the harness default: anthropic', () => {
    expect(piProviderForProfile(profile(''))).toBe('anthropic');
    expect(piProviderForProfile(profile('   '))).toBe('anthropic');
  });

  test('an explicit Anthropic endpoint is still the built-in provider', () => {
    expect(piProviderForProfile(profile('https://api.anthropic.com'))).toBe('anthropic');
  });

  // The case the whole feature exists for: an anthropic-wire server that is not
  // Anthropic. pi has no catalog for it, so models.json declares one.
  test('any other endpoint runs the custom provider', () => {
    expect(piProviderForProfile(profile('http://localhost:11434'))).toBe('ollama');
    expect(piProviderForProfile(profile('https://gateway.internal:8080'))).toBe('ollama');
  });

  // INVARIANT: the provider follows the profile's RESOLVED wire — the one
  // `wireForProfile` computed and the proxy routes by — so an OpenAI-wire
  // profile's custom provider speaks openai-completions rather than
  // anthropic-messages. OpenRouter speaks both wires and pi takes its native
  // OpenAI one; an endpoint that implies NO wire (a self-hosted gateway) stays
  // on the anthropic-wire custom provider, which is what pi profiles resolved
  // to before pi gained a second wire.
  test('an OpenAI-wire profile runs the openai-wire custom provider', () => {
    expect(piProviderForProfile(profile('https://api.openai.com'))).toBe('openai');
    expect(piProviderForProfile(profile('https://api.openai.com/v1'))).toBe('openai');
    expect(piProviderForProfile(profile('https://openrouter.ai/api'))).toBe('openai');
    expect(piProviderForProfile(profile('https://gateway.example.com/v1'))).toBe('ollama');
  });
});

describe('piLaunchEnvVars', () => {
  // INVARIANT: keyed on the HARNESS, not the task's `agent` — that names a
  // PROFILE, so `[agents.local-ollama-pi]` would fail an `=== 'pi'` comparison
  // and launch pi with none of its offline flags or provider selection.
  test('returns nothing for non-pi harnesses', () => {
    expect(piLaunchEnvVars({ harness: 'claude-code', profile: profile('http://localhost:11434', 'x'), upstreamTimeoutMs: 1_800_000 })).toEqual([]);
    expect(piLaunchEnvVars({ upstreamTimeoutMs: 1_800_000 })).toEqual([]);
    expect(piLaunchEnvVars({ harness: 'local-ollama-pi', profile: profile('http://localhost:11434', 'x'), upstreamTimeoutMs: 1_800_000 })).toEqual([]);
  });

  // INVARIANT: no startup egress around the proxy — update checks, catalog
  // refreshes and telemetry are all disabled on every pi launch.
  test('an anthropic profile: provider + offline flags', () => {
    const vars = piLaunchEnvVars({ harness: 'pi', profile: profile(''), upstreamTimeoutMs: 1_800_000 });
    const map = Object.fromEntries(vars.map(v => [v.key, v.value]));
    expect(map[LAZY_PI_PROVIDER_ENV]).toBe('anthropic');
    expect(map.PI_OFFLINE).toBe('1');
    expect(map.PI_SKIP_VERSION_CHECK).toBe('1');
    expect(map.PI_TELEMETRY).toBe('0');
  });

  // INVARIANT: the launch env carries NO model. It is assembled from the
  // PROFILE, whose model is only a default the task stops using once it has its
  // own; a profile model in the env (formerly LAZY_PI_OLLAMA_MODEL) read to the
  // agent as "the model this turn runs" while the turn ran the task's model, and
  // fed models.json a silent fallback. The provider still follows the profile.
  test('a custom-upstream profile selects its provider but carries no model', () => {
    for (const [endpoint, provider] of [
      ['http://localhost:11434', 'ollama'],
      ['https://api.openai.com/v1', 'openai'],
      ['https://openrouter.ai/api', 'openai'],
    ] as const) {
      const vars = piLaunchEnvVars({ harness: 'pi', profile: profile(endpoint, 'qwen3:8b'), upstreamTimeoutMs: 1_800_000 });
      const map = Object.fromEntries(vars.map(v => [v.key, v.value]));
      expect(map[LAZY_PI_PROVIDER_ENV]).toBe(provider);
      expect(vars.some(v => v.value === 'qwen3:8b' || /MODEL/.test(v.key))).toBe(false);
    }
  });

  // A launch with no profile at all (the host runner's stale-config path) must
  // still produce a usable pi launch rather than throwing: anthropic is the
  // harness default, and a missing model is caught loudly by the models.json
  // writer rather than guessed at here.
  test('no profile falls back to the harness default', () => {
    const map = Object.fromEntries(piLaunchEnvVars({ harness: 'pi', upstreamTimeoutMs: 1_800_000 }).map(v => [v.key, v.value]));
    expect(map[LAZY_PI_PROVIDER_ENV]).toBe('anthropic');
  });

  // INVARIANT: the proxy ceiling rides the launch env as a RAW value — a
  // statement about the proxy. The pi-side margin is computed in the writer,
  // not here, so the invariant logic lives in one file.
  test('carries the proxy ceiling in ms verbatim', () => {
    const map = Object.fromEntries(piLaunchEnvVars({ harness: 'pi', upstreamTimeoutMs: 1_800_000 }).map(v => [v.key, v.value]));
    expect(map[LAZY_PI_UPSTREAM_TIMEOUT_MS_ENV]).toBe('1800000');
    const zero = Object.fromEntries(piLaunchEnvVars({ harness: 'pi', upstreamTimeoutMs: 0 }).map(v => [v.key, v.value]));
    expect(zero[LAZY_PI_UPSTREAM_TIMEOUT_MS_ENV]).toBe('0');
  });
});

describe('piCredentialMirror', () => {
  test('mirrors a claude-shaped OAuth placeholder into ANTHROPIC_AUTH_TOKEN', () => {
    const mirror = piCredentialMirror([{ key: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'lazy-grant-1' }]);
    expect(mirror).toEqual([{ key: 'ANTHROPIC_AUTH_TOKEN', value: 'lazy-grant-1' }]);
  });

  test('is a no-op when pi can already read a credential', () => {
    expect(piCredentialMirror([
      { key: 'ANTHROPIC_API_KEY', value: 'k' },
      { key: 'CLAUDE_CODE_OAUTH_TOKEN', value: 't' },
    ])).toEqual([]);
    expect(piCredentialMirror([{ key: 'ANTHROPIC_AUTH_TOKEN', value: 't' }])).toEqual([]);
    expect(piCredentialMirror([])).toEqual([]);
  });
});

describe('writePiModelsConfig', () => {
  // INVARIANT: models.json is what pins pi's providers to lazy's proxy — a
  // turn without a proxied base URL must refuse rather than run unaudited.
  test('refuses when ANTHROPIC_BASE_URL is unset', async () => {
    await expect(writePiModelsConfig({ turnModel: 'qwen3:8b' })).rejects.toThrow(/unproxied pi turn/);
  });

  test('anthropic backend: overrides only the built-in anthropic base URL', async () => {
    process.env.ANTHROPIC_BASE_URL = 'http://host.docker.internal:8790';
    await writePiModelsConfig({ turnModel: 'qwen3:8b' });
    const config = JSON.parse(readFileSync(piModelsConfigPath(), 'utf-8'));
    expect(config.providers.anthropic).toEqual({ baseUrl: 'http://host.docker.internal:8790' });
    expect(config.providers.ollama).toBeUndefined();
  });

  // INVARIANT: pi's ollama route speaks anthropic-messages THROUGH the proxy —
  // pi's native OpenAI-compat ollama wire (/v1/chat/completions) is not on the
  // proxy's path allowlist, and the ollama role upstream already serves
  // Anthropic wire for Claude Code.
  test('ollama backend: custom anthropic-messages provider with the resolved model', async () => {
    process.env.ANTHROPIC_BASE_URL = 'http://host.docker.internal:8790';
    process.env[LAZY_PI_PROVIDER_ENV] = 'ollama';
    await writePiModelsConfig({ turnModel: 'qwen3:8b' });
    const config = JSON.parse(readFileSync(piModelsConfigPath(), 'utf-8'));
    expect(config.providers.ollama.api).toBe('anthropic-messages');
    expect(config.providers.ollama.baseUrl).toBe('http://host.docker.internal:8790');
    expect(config.providers.ollama.apiKey).toBe('$ANTHROPIC_AUTH_TOKEN');
    expect(config.providers.ollama.models).toEqual([
      { id: 'qwen3:8b', reasoning: true, thinkingLevelMap: { xhigh: 'xhigh', max: 'max' }, maxTokens: 32768 },
    ]);
  });

  // INVARIANT: a custom provider's model is declared REASONING-CAPABLE, or the
  // task's effort never reaches it. pi's `reasoning` field defaults to false,
  // and a model that cannot reason has exactly one supported thinking level —
  // `off` — so pi clamps every `--thinking <effort>` lazy passes down to it and
  // sends no `thinking` field at all (VERIFIED against pi 0.84.4 and a local
  // Ollama: PI_REASONING_LEVEL=off with --thinking high).
  test('ollama backend: the model is declared reasoning-capable so effort reaches it', async () => {
    process.env.ANTHROPIC_BASE_URL = 'http://proxy:1';
    process.env[LAZY_PI_PROVIDER_ENV] = 'ollama';
    await writePiModelsConfig({ turnModel: 'qwen3:8b' });
    const config = JSON.parse(readFileSync(piModelsConfigPath(), 'utf-8'));
    const model = config.providers.ollama.models[0];
    expect(model.reasoning).toBe(true);
    // INVARIANT: xhigh and max must be NAMED. pi treats the two extended levels
    // as unsupported unless the model's thinkingLevelMap has an entry, and
    // clamps an unsupported level DOWN — so lazy's two highest efforts would
    // both run as `high` without these.
    expect(model.thinkingLevelMap).toEqual({ xhigh: 'xhigh', max: 'max' });
    // INVARIANT: thinking is funded out of max_tokens on the Anthropic wire.
    // pi's default ceiling (16384) equals its own `high` budget, so a
    // high-effort turn would be left the 1024-token answer floor.
    expect(model.maxTokens).toBe(32768);
  });

  // INVARIANT: a custom-provider turn with no model REFUSES — it never falls
  // back to a profile default nobody chose for this task.
  test('ollama backend without a turn model is a launch-path bug, not a silent default', async () => {
    process.env.ANTHROPIC_BASE_URL = 'http://x:1';
    process.env[LAZY_PI_PROVIDER_ENV] = 'ollama';
    for (const turnModel of [undefined, null, '', '   ']) {
      await expect(writePiModelsConfig({ turnModel })).rejects.toThrow(/names no model/);
    }
  });

  // The openai provider speaks Chat Completions at the proxy's /v1 — the one
  // OpenAI-wire inference path the proxy's openai allowlist tier forwards. Its
  // credential slot is ANTHROPIC_AUTH_TOKEN like every other custom provider:
  // routing is decided by the PROFILE on this turn's grant, not by which env
  // var carried the placeholder.
  test('openai provider: openai-completions at <proxy>/v1', async () => {
    process.env.ANTHROPIC_BASE_URL = 'http://host.docker.internal:8790';
    process.env[LAZY_PI_PROVIDER_ENV] = 'openai';
    await writePiModelsConfig({ turnModel: 'gpt-5.2' });
    const config = JSON.parse(readFileSync(piModelsConfigPath(), 'utf-8'));
    expect(config.providers['lazy-openai']).toEqual({
      baseUrl: 'http://host.docker.internal:8790/v1',
      api: 'openai-completions',
      apiKey: '$ANTHROPIC_AUTH_TOKEN',
      // Reasoning declared, and `xhigh` named so lazy's xhigh effort is sent as
      // OpenAI's own `reasoning_effort: "xhigh"`. `max` is deliberately ABSENT:
      // OpenAI has no such effort (pi's own gpt-5.x catalog entries stop at
      // xhigh), so pi clamps a max-effort turn down to xhigh instead of sending
      // a value the API rejects. No maxTokens override — on this wire thinking
      // is a separate parameter, not a slice of the completion budget.
      models: [{ id: 'gpt-5.2', reasoning: true, thinkingLevelMap: { xhigh: 'xhigh' } }],
    });
    // INVARIANT: never under pi's built-in `openai` key. A declaration there is
    // MERGED with pi's own catalog, and an OpenRouter id such as `openai/gpt-4o`
    // then resolves to the catalog's `gpt-4o` on the Responses wire (verified
    // against 0.84.4 — see PI_PROVIDER_KEY in src/agent/pi.ts).
    expect(config.providers.openai).toBeUndefined();
    // The anthropic pin stays: no pi provider ever has a direct-egress base.
    expect(config.providers.anthropic).toEqual({ baseUrl: 'http://host.docker.internal:8790' });
  });

  test('openai provider without a model is a launch-path bug, not a silent default', async () => {
    process.env.ANTHROPIC_BASE_URL = 'http://x:1';
    process.env[LAZY_PI_PROVIDER_ENV] = 'openai';
    await expect(writePiModelsConfig({ turnModel: undefined })).rejects.toThrow(/names no model/);
  });

  // INVARIANT (turn-model stickiness): models.json declares exactly ONE model —
  // the one this turn runs, which is the task's persisted model. It used to
  // declare the profile default alongside it "because a task that overrode the
  // model this turn may not have overridden it the next" — the non-sticky model
  // the engineer rejected: any launch without `--model` then silently ran the
  // profile default. With one declared model there is nothing to fall back to.
  test('ollama backend: declares only this turn\'s model', async () => {
    process.env.ANTHROPIC_BASE_URL = 'http://proxy:1';
    process.env[LAZY_PI_PROVIDER_ENV] = 'ollama';
    // A stale profile-model var from an older launch must not be declared either.
    process.env.LAZY_PI_OLLAMA_MODEL = 'qwen3:8b';
    try {
      await writePiModelsConfig({ turnModel: '  muse-glimmer  ' });
    } finally {
      delete process.env.LAZY_PI_OLLAMA_MODEL;
    }
    const config = JSON.parse(readFileSync(piModelsConfigPath(), 'utf-8'));
    expect(config.providers.ollama.models.map((m: { id: string }) => m.id)).toEqual(['muse-glimmer']);
  });

  // The turn model belongs to the CUSTOM provider only: pi's built-in anthropic
  // provider carries Anthropic's own catalog, and lazy declares no models into it.
  test('an anthropic backend ignores the turn model', async () => {
    process.env.ANTHROPIC_BASE_URL = 'http://proxy:1';
    await writePiModelsConfig({ turnModel: 'claude-opus-5' });
    const config = JSON.parse(readFileSync(piModelsConfigPath(), 'utf-8'));
    expect(config.providers.anthropic).toEqual({ baseUrl: 'http://proxy:1' });
    expect(config.providers.ollama).toBeUndefined();
  });

  // INVARIANT: the write is wholesale, not a merge — an agent-edited base URL
  // (a would-be proxy bypass) must not survive into the next turn.
  test('rewrites wholesale over a tampered file', async () => {
    process.env.ANTHROPIC_BASE_URL = 'http://proxy:1';
    await writePiModelsConfig({ turnModel: 'qwen3:8b' });
    const tampered = { providers: { anthropic: { baseUrl: 'https://evil.example.com' }, google: {} } };
    await Bun.write(piModelsConfigPath(), JSON.stringify(tampered));
    await writePiModelsConfig({ turnModel: 'qwen3:8b' });
    const config = JSON.parse(readFileSync(piModelsConfigPath(), 'utf-8'));
    expect(config.providers.anthropic.baseUrl).toBe('http://proxy:1');
    expect(config.providers.google).toBeUndefined();
  });
});

describe('piHttpIdleTimeoutMsFromEnv', () => {
  // INVARIANT: pi's request timeout must never be shorter than lazy's upstream
  // ceiling — pi's own default (300s) fires while the proxy is still serving a
  // slow-but-alive request (the 2026-09-16 local-Ollama incident: the upstream
  // answered at 349s, pi had already given up at 300s). The margin below keeps
  // pi waiting past whatever the proxy will wait past.
  test('ceiling 30min plus margin', () => {
    expect(piHttpIdleTimeoutMsFromEnv({ [LAZY_PI_UPSTREAM_TIMEOUT_MS_ENV]: '1800000' }))
      .toBe(1_860_000);
  });

  // INVARIANT (same rule, no-ceiling shape): a proxy with 0 = no ceiling must
  // leave pi with NO timeout either — a shorter pi-side timeout would kill
  // requests the proxy was still serving.
  test('ceiling 0 disables the pi timeout too', () => {
    expect(piHttpIdleTimeoutMsFromEnv({ [LAZY_PI_UPSTREAM_TIMEOUT_MS_ENV]: '0' })).toBe(0);
  });

  test('absent env is undefined — the writer refuses rather than guess', () => {
    expect(piHttpIdleTimeoutMsFromEnv({})).toBeUndefined();
    expect(piHttpIdleTimeoutMsFromEnv({ [LAZY_PI_UPSTREAM_TIMEOUT_MS_ENV]: '  ' })).toBeUndefined();
  });

  test('unparseable or negative env throws with the value named', () => {
    expect(() => piHttpIdleTimeoutMsFromEnv({ [LAZY_PI_UPSTREAM_TIMEOUT_MS_ENV]: 'abc' }))
      .toThrow(/non-negative/);
    expect(() => piHttpIdleTimeoutMsFromEnv({ [LAZY_PI_UPSTREAM_TIMEOUT_MS_ENV]: '-5' }))
      .toThrow(/non-negative/);
  });
});

describe('writePiSettingsConfig', () => {
  // The launch env missing is a launch-path bug — refusing the turn is how the
  // chokepoint keeps a broken launch from silently reproducing the 300s bug.
  test('refuses when the proxy ceiling is not in the launch env', async () => {
    await expect(writePiSettingsConfig()).rejects.toThrow(/launch-path bug/);
  });

  test('pins the ceiling plus margin into the global settings file', async () => {
    process.env[LAZY_PI_UPSTREAM_TIMEOUT_MS_ENV] = '1800000';
    await writePiSettingsConfig();
    const settings = JSON.parse(readFileSync(piSettingsConfigPath(), 'utf-8'));
    expect(settings.httpIdleTimeoutMs).toBe(1_860_000);
  });

  // INVARIANT: a proxy with no ceiling must never leave pi with one — pi would
  // kill the very requests the proxy was built to let through.
  test('ceiling 0 writes 0 (pi: no timeout)', async () => {
    process.env[LAZY_PI_UPSTREAM_TIMEOUT_MS_ENV] = '0';
    await writePiSettingsConfig();
    const settings = JSON.parse(readFileSync(piSettingsConfigPath(), 'utf-8'));
    expect(settings.httpIdleTimeoutMs).toBe(0);
  });

  // Unlike models.json (owned wholesale), the settings file may carry real
  // state in this HOME — only lazy's key may change.
  test('merges over existing settings and overwrites a stale timeout', async () => {
    process.env[LAZY_PI_UPSTREAM_TIMEOUT_MS_ENV] = '1800000';
    await Bun.write(piSettingsConfigPath(), JSON.stringify({ theme: 'dark', httpIdleTimeoutMs: 123 }));
    await writePiSettingsConfig();
    const settings = JSON.parse(readFileSync(piSettingsConfigPath(), 'utf-8'));
    expect(settings.theme).toBe('dark');
    expect(settings.httpIdleTimeoutMs).toBe(1_860_000);
  });

  test('refuses over an unparseable settings file instead of clobbering it', async () => {
    process.env[LAZY_PI_UPSTREAM_TIMEOUT_MS_ENV] = '1800000';
    await Bun.write(piSettingsConfigPath(), '{not json');
    await expect(writePiSettingsConfig()).rejects.toThrow(/Could not pin/);
    // The broken file is left for the human to look at, not replaced.
    expect(readFileSync(piSettingsConfigPath(), 'utf-8')).toBe('{not json');
  });

  test('refuses over a settings file that is not a JSON object', async () => {
    process.env[LAZY_PI_UPSTREAM_TIMEOUT_MS_ENV] = '1800000';
    await Bun.write(piSettingsConfigPath(), '[1,2,3]');
    await expect(writePiSettingsConfig()).rejects.toThrow(/Could not pin/);
  });
});

describe('writePiBridgeExtension', () => {
  test('writes the bridge with the per-turn MCP server command baked in', async () => {
    await writePiBridgeExtension({
      command: 'lazy-agent',
      args: ['mcp', '--daemon-config', '/cfg', '--task-id', 't1', '--worktree', '/w', '--read-only'],
    });
    expect(existsSync(piBridgeExtensionPath())).toBe(true);
    const source = readFileSync(piBridgeExtensionPath(), 'utf-8');
    expect(source).toContain('"command":"lazy-agent"');
    expect(source).toContain('--read-only');
    // The verified exit fix: without unref + session_shutdown kill, pi never
    // exits after agent_end (reproduced against 0.84.4).
    expect(source).toContain('unref()');
    expect(source).toContain('session_shutdown');
    // No leftover template placeholder.
    expect(source).not.toContain('__LAZY_MCP_COMMAND_JSON__');
  });
});
