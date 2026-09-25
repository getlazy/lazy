/**
 * Hosted Ollama (ollama.com) credentials — a local Ollama profile stays
 * credential-free; a cloud endpoint needs a stored API key on both the launch
 * and proxy paths.
 *
 * Under profiles the split is decided ONCE, by `defaultCredentialFor` at config
 * load: a local endpoint resolves to the `none` credential, ollama.com to the
 * `ollama` one. Everything below reads that resolved credential rather than
 * re-deciding from the hostname, which is what keeps the launch path and the
 * proxy path from ever disagreeing about who pays for a request.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { isHostedOllamaEndpoint } from '../../src/utils/ollama';
import {
  LOCAL_BACKEND_CREDS,
  resolveProfileLaunchCreds,
} from '../../src/utils/role-target';
import { requiredProviders } from '../../src/credentials/providers';
import { resolveAgentUpstreams } from '../../src/proxy/agent-upstreams';
import { buildProxyCredentialDeps } from '../../src/proxy/credential-deps';
import { setCredential } from '../../src/credentials/store';
import { pinDaemonBaseDir, makeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { resolveAgentProfiles, cacheAgentProfiles } from '../../src/config/agent-profiles';
import { roleTargetForProfile } from '../../src/config/default-target';
import type { ResolvedConfig } from '../../src/config/types';

describe('isHostedOllamaEndpoint', () => {
  test('recognises ollama.com and subdomains', () => {
    expect(isHostedOllamaEndpoint('https://ollama.com')).toBe(true);
    expect(isHostedOllamaEndpoint('https://ollama.com/api')).toBe(true);
    expect(isHostedOllamaEndpoint('https://api.ollama.com')).toBe(true);
  });

  test('local and LAN endpoints are not hosted', () => {
    expect(isHostedOllamaEndpoint('http://localhost:11434')).toBe(false);
    expect(isHostedOllamaEndpoint('http://host.docker.internal:11434')).toBe(false);
    expect(isHostedOllamaEndpoint('http://192.168.1.5:11434')).toBe(false);
    expect(isHostedOllamaEndpoint('')).toBe(false);
  });
});

/** A project whose BOTH roles default to one claude-code profile at `endpoint`. */
function configWithOllamaEndpoint(endpoint: string): ResolvedConfig {
  const agents = {
    'local-ollama': { harness: 'claude-code', model: 'gpt-oss:120b', endpoint },
  } as never as Record<string, never>;
  const profiles = resolveAgentProfiles(agents);
  cacheAgentProfiles(agents, profiles);
  const target = roleTargetForProfile(profiles.get('local-ollama')!);
  return {
    models: { roles: { builder: target, agent: target } },
    agents,
    proxy: {
      upstream: 'https://api.anthropic.com',
      cursorUpstream: 'https://api2.cursor.sh',
      fallbacks: [],
    },
  } as unknown as ResolvedConfig;
}

/** This project's upstream entry for the ollama profile under test. */
function ollamaUpstream(config: ResolvedConfig) {
  return resolveAgentUpstreams(config).find(u => u.profile === 'local-ollama');
}

describe('hosted vs local ollama credential routing', () => {
  let root: string;
  let undoDaemonBase: () => void;
  const savedConfig = process.env.LAZY_CONFIG;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-ollama-hosted-'));
    const baseDir = await makeDaemonBaseDir();
    undoDaemonBase = pinDaemonBaseDir(baseDir);
    const configPath = join(root, 'lazy.toml');
    await writeFile(configPath, '[credentials]\nbackend = "file"\n');
    process.env.LAZY_CONFIG = configPath;
  });

  afterEach(async () => {
    undoDaemonBase();
    if (savedConfig === undefined) delete process.env.LAZY_CONFIG;
    else process.env.LAZY_CONFIG = savedConfig;
    await rm(root, { recursive: true, force: true });
  });

  test('a local ollama profile uses synthetic launch creds and no provider requirement', async () => {
    const endpoint = 'http://localhost:11434';
    const config = configWithOllamaEndpoint(endpoint);
    const target = config.models.roles.agent;
    expect(target.credential).toBe('none');

    const creds = await resolveProfileLaunchCreds(root, target);
    expect(creds).toEqual(LOCAL_BACKEND_CREDS);
    expect(requiredProviders(config)).toEqual([]);
    expect(ollamaUpstream(config)).toEqual({
      profile: 'local-ollama', upstream: endpoint, credential: null, wire: 'anthropic',
    });
    const deps = buildProxyCredentialDeps(root, config);
    expect(deps.targets.has(endpoint)).toBe(false);
  });

  test('a hosted ollama profile requires a stored key and maps a proxy credential', async () => {
    const endpoint = 'https://ollama.com';
    const config = configWithOllamaEndpoint(endpoint);
    const target = config.models.roles.agent;
    expect(target.credential).toBe('ollama');

    // INVARIANT: the launch fails EARLY and actionably rather than as a 401
    // mid-turn, and the message names the command that fixes it.
    await expect(resolveProfileLaunchCreds(root, target)).rejects.toThrow(/lazy auth set ollama/);
    await setCredential(root, { provider: 'ollama', kind: 'api-key', secret: 'ollama-test-key-12345' });
    expect(await resolveProfileLaunchCreds(root, target))
      .toEqual([{ key: 'ANTHROPIC_AUTH_TOKEN', value: 'ollama-test-key-12345' }]);

    expect(requiredProviders(config)).toEqual(['ollama']);
    expect(ollamaUpstream(config)).toEqual({
      profile: 'local-ollama', upstream: endpoint, credential: 'ollama', wire: 'anthropic',
    });
    const deps = buildProxyCredentialDeps(root, config);
    expect(deps.targets.has(endpoint)).toBe(true);
  });

  // INVARIANT: a profile may name its own credential, and that overrides the
  // hostname default — including at a LOCAL endpoint, for a local gateway that
  // does authenticate. The default is a convenience, not a ceiling.
  test('an explicit credential overrides the local-endpoint default', async () => {
    const agents = {
      'guarded-local': {
        harness: 'claude-code', model: 'm', endpoint: 'http://localhost:11434', credential: 'my-gateway',
      },
    } as never as Record<string, never>;
    const profiles = resolveAgentProfiles(agents);
    const target = roleTargetForProfile(profiles.get('guarded-local')!);
    expect(target.credential).toBe('my-gateway');
    await expect(resolveProfileLaunchCreds(root, target)).rejects.toThrow(/lazy auth set my-gateway/);
  });
});
