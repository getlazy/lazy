/**
 * The `openai` and `openrouter` credentials behind OpenAI-compatible upstreams.
 *
 * Mirrors ollama-hosted-credentials.test.ts: per-target credentials are DATA,
 * looked up per endpoint — never inferred from "it speaks wire format X". The
 * hostname split (openrouter.ai → openrouter, else openai) is the same pattern
 * hosted Ollama established, and under profiles it is what
 * `defaultCredentialFor` applies to a profile that names no credential of its
 * own.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ResolvedConfig } from '../../src/config/types';
import {
  providerForTarget,
  requiredProviders,
} from '../../src/credentials/providers';
import { setCredential } from '../../src/credentials/store';
import { resolveAgentUpstreams } from '../../src/proxy/agent-upstreams';
import { buildProxyCredentialDeps } from '../../src/proxy/credential-deps';
import {
  placeholderValueFor,
  looksLikeLazyPlaceholder,
} from '../../src/proxy/credential-broker';
import { isOpenRouterEndpoint, DEFAULT_OPENAI_UPSTREAM } from '../../src/utils/openai-compat';
import { isCredentialEnvKey } from '../../src/utils/redact';
import { pinDaemonBaseDir, makeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { resolveAgentProfiles, cacheAgentProfiles } from '../../src/config/agent-profiles';
import { roleTargetForProfile, ANTHROPIC_DEFAULT_TARGET } from '../../src/config/default-target';

type ProfileInput = { harness: string; model?: string; endpoint?: string; credential?: string };

/**
 * A config whose `agent` role defaults to the named profile — the same shape
 * `loadConfig` produces, built through the real resolver so the wire and
 * credential defaults under test are the ones the product derives.
 */
function configWithAgentProfile(name: string, input: ProfileInput): ResolvedConfig {
  const agents = { [name]: input } as never as Record<string, never>;
  const profiles = resolveAgentProfiles(agents);
  const profile = profiles.get(name)!;
  // The profile map is resolved once per raw `[agents]` table at config load;
  // seeding the same cache here keeps `resolveAgentUpstreams` on the lookup path
  // the product takes rather than a re-resolution.
  cacheAgentProfiles(agents, profiles);
  return {
    models: {
      roles: {
        builder: ANTHROPIC_DEFAULT_TARGET,
        agent: roleTargetForProfile(profile),
      },
    },
    agents,
    proxy: {
      upstream: 'https://api.anthropic.com',
      cursorUpstream: 'https://api2.cursor.sh',
      fallbacks: [],
    },
  } as never as ResolvedConfig;
}

describe('isOpenRouterEndpoint', () => {
  test('matches openrouter.ai and subdomains only', () => {
    expect(isOpenRouterEndpoint('https://openrouter.ai/api')).toBe(true);
    expect(isOpenRouterEndpoint('https://api.openrouter.ai')).toBe(true);
    expect(isOpenRouterEndpoint(DEFAULT_OPENAI_UPSTREAM)).toBe(false);
    // A hostname that merely CONTAINS the name must not match.
    expect(isOpenRouterEndpoint('https://openrouter.ai.evil.example.com')).toBe(false);
    expect(isOpenRouterEndpoint('')).toBe(false);
    expect(isOpenRouterEndpoint('not a url')).toBe(false);
  });
});

describe('providerForTarget / requiredProviders', () => {
  test('an openai-wire profile bills openai by default, openrouter at openrouter.ai', () => {
    const openai = configWithAgentProfile('work-codex', {
      harness: 'codex', model: 'gpt-5-codex', endpoint: DEFAULT_OPENAI_UPSTREAM,
    });
    const router = configWithAgentProfile('router-codex', {
      harness: 'codex', model: 'x', endpoint: 'https://openrouter.ai/api',
    });
    expect(providerForTarget(openai.models.roles.agent)).toBe('openai');
    expect(providerForTarget(router.models.roles.agent)).toBe('openrouter');
  });

  // INVARIANT (per-user-token billing): an Anthropic-wire profile pinned at
  // OpenRouter's Messages endpoint bills the user's OpenRouter key — handing
  // that target the Anthropic credential would ship one provider's secret to
  // another provider's server.
  test('an anthropic-wire profile at openrouter.ai bills openrouter, not anthropic', () => {
    const router = configWithAgentProfile('router-claude', {
      harness: 'claude-code', model: 'anthropic/claude-opus-5', endpoint: 'https://openrouter.ai/api',
    });
    const gateway = configWithAgentProfile('gateway-claude', {
      harness: 'claude-code', model: 'claude-opus-5', endpoint: 'https://gateway.example.com',
    });
    expect(providerForTarget(router.models.roles.agent)).toBe('openrouter');
    expect(providerForTarget(gateway.models.roles.agent)).toBe('anthropic');
  });

  // INVARIANT: a profile may name its own credential, and that name wins over
  // the hostname default — two profiles on one provider can hold separate keys.
  test('an explicit credential overrides the hostname default', () => {
    const config = configWithAgentProfile('work-codex', {
      harness: 'codex', model: 'gpt-5-codex', endpoint: DEFAULT_OPENAI_UPSTREAM, credential: 'work-openai',
    });
    expect(config.models.roles.agent.credential).toBe('work-openai');
    // Not a Provider, so the daemon's provider-shaped gate has nothing to say
    // about it; it is resolved (and fails loudly) at launch instead.
    expect(providerForTarget(config.models.roles.agent)).toBeNull();
  });

  test('the daemon credential gate requires the right provider per role default', () => {
    expect(requiredProviders(configWithAgentProfile('work-codex', {
      harness: 'codex', model: 'gpt-5.2', endpoint: DEFAULT_OPENAI_UPSTREAM,
    }))).toEqual(['anthropic', 'openai']);
    expect(requiredProviders(configWithAgentProfile('router-codex', {
      harness: 'codex', model: 'x', endpoint: 'https://openrouter.ai/api',
    }))).toEqual(['anthropic', 'openrouter']);
    expect(requiredProviders(configWithAgentProfile('router-claude', {
      harness: 'claude-code', model: 'claude-opus-5', endpoint: 'https://openrouter.ai/api',
    }))).toEqual(['anthropic', 'openrouter']);
  });
});

describe('profile upstream resolution', () => {
  /** Pick one profile's upstream entry out of the project's full set. */
  const entryFor = (config: ResolvedConfig, name: string) =>
    resolveAgentUpstreams(config).find(u => u.profile === name);

  test('an openai-wire profile carries the openai wire and its credential', () => {
    expect(entryFor(configWithAgentProfile('work-codex', {
      harness: 'codex', model: 'gpt-5.2', endpoint: 'https://api.openai.com/',
    }), 'work-codex')).toEqual({
      profile: 'work-codex', upstream: 'https://api.openai.com', credential: 'openai', wire: 'openai',
    });
    expect(entryFor(configWithAgentProfile('router-codex', {
      harness: 'codex', model: 'x', endpoint: 'https://openrouter.ai/api',
    }), 'router-codex')).toEqual({
      profile: 'router-codex', upstream: 'https://openrouter.ai/api', credential: 'openrouter', wire: 'openai',
    });
  });

  // OpenRouter's Anthropic-compatible endpoint: ANTHROPIC wire, openrouter key.
  // The wire follows the HARNESS, not the hostname — claude-code speaks only
  // anthropic, so pointing it at openrouter.ai does not make its traffic openai.
  test('a claude-code profile at openrouter.ai keeps the anthropic wire with the openrouter credential', () => {
    expect(entryFor(configWithAgentProfile('router-claude', {
      harness: 'claude-code', model: 'anthropic/claude-opus-5', endpoint: 'https://openrouter.ai/api',
    }), 'router-claude')).toEqual({
      profile: 'router-claude', upstream: 'https://openrouter.ai/api', credential: 'openrouter', wire: 'anthropic',
    });
  });

  // INVARIANT (the reason profiles exist): declaring one profile does not move
  // anyone else's traffic. The built-in claude-code profile has no endpoint of
  // its own, so it never appears here and keeps riding the primary upstream.
  test('a declared profile leaves every other profile on the primary upstream', () => {
    const config = configWithAgentProfile('router-codex', {
      harness: 'codex', model: 'x', endpoint: 'https://openrouter.ai/api',
    });
    const names = resolveAgentUpstreams(config).map(u => u.profile);
    expect(names).toContain('router-codex');
    expect(names).not.toContain('claude-code');
  });
});

describe('credential resolution for the proxy target map', () => {
  let root: string;
  let undoDaemonBase: () => void;
  const savedConfig = process.env.LAZY_CONFIG;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-openai-cred-'));
    undoDaemonBase = pinDaemonBaseDir(await makeDaemonBaseDir());
    // A file-backed credential store, isolated from the developer's own.
    const configPath = join(root, 'lazy.toml');
    await writeFile(configPath, '[credentials]\nbackend = "file"\n');
    process.env.LAZY_CONFIG = configPath;
  });

  afterAll(async () => {
    undoDaemonBase();
    if (savedConfig === undefined) delete process.env.LAZY_CONFIG;
    else process.env.LAZY_CONFIG = savedConfig;
    await rm(root, { recursive: true, force: true });
  });

  test('a missing key resolves to `missing` with an actionable remedy — never a silent none', async () => {
    const deps = buildProxyCredentialDeps(root, configWithAgentProfile('work-codex', {
      harness: 'codex', model: 'gpt-5.2', endpoint: 'https://api.openai.com',
    }));
    expect(deps.targets.has('https://api.openai.com')).toBe(true);
    const outcome = await deps.targets.forTarget('https://api.openai.com');
    expect(outcome.kind).toBe('missing');
    expect((outcome as { reason: string }).reason).toContain('lazy auth set openai');
  });

  test('a stored key is placed as Authorization: Bearer', async () => {
    await setCredential(root, { provider: 'openrouter', kind: 'api-key', secret: 'sk-or-v1-test-key-123456' });
    const deps = buildProxyCredentialDeps(root, configWithAgentProfile('router-codex', {
      harness: 'codex', model: 'x', endpoint: 'https://openrouter.ai/api',
    }));
    const outcome = await deps.targets.forTarget('https://openrouter.ai/api');
    expect(outcome).toMatchObject({
      kind: 'credential',
      placement: { kind: 'header', header: 'authorization', value: 'Bearer sk-or-v1-test-key-123456' },
    });
  });

  test('fallback credential slots accept openai and openrouter', async () => {
    const config = configWithAgentProfile('plain', { harness: 'claude-code' });
    (config.proxy.fallbacks as unknown[]).push(
      { upstream: 'https://openrouter.ai/api', credential: 'openrouter' },
    );
    const deps = buildProxyCredentialDeps(root, config);
    expect(deps.targets.has('https://openrouter.ai/api')).toBe(true);
  });
});

describe('JIT placeholders for OpenAI-compatible keys', () => {
  // The prefix mimics the real key shape so a client that validates its key
  // format still launches; recognition stays by LOOKUP, never by prefix.
  test('placeholders mimic the real key shapes and self-identify', () => {
    const openai = placeholderValueFor('OPENAI_API_KEY');
    const openrouter = placeholderValueFor('OPENROUTER_API_KEY');
    expect(openai.startsWith('sk-proj-lazy-')).toBe(true);
    expect(openrouter.startsWith('sk-or-v1-lazy-')).toBe(true);
    expect(looksLikeLazyPlaceholder(openai)).toBe(true);
    expect(looksLikeLazyPlaceholder(openrouter)).toBe(true);
  });

  // launch env redaction + placeholderization both key off this predicate; a
  // key it misses would be logged raw AND handed to containers for real.
  test('the new env keys are credential env keys', () => {
    expect(isCredentialEnvKey('OPENAI_API_KEY')).toBe(true);
    expect(isCredentialEnvKey('OPENROUTER_API_KEY')).toBe(true);
  });
});
