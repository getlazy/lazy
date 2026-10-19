/**
 * Every endpoint names its credential, and a provider's credential never
 * reaches another host unless the config said so.
 *
 * Field report 2026-10-06: a tiered profile's second tier answered 401 and the
 * first suspicion was that lazy had GUESSED a credential for its gateway host —
 * the Anthropic one, the old wire default. Whatever that turn's cause, the
 * guess was a real hazard: which of a person's secrets a host received was
 * decided by a hostname table they never saw. The rule now is that the file
 * says it, for every endpoint, and the proxy refuses a provider/host pairing
 * nobody wrote.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  cacheAgentProfiles,
  MissingEndpointCredentialError,
  notHonouredProfiles,
  providerCredentialHostMismatch,
  resolveAgentProfiles,
  type AgentProfile,
} from '../../src/config/agent-profiles';
import { buildTargetCredentials } from '../../src/proxy/credential-deps';
import { MANAGED_ENV } from '../../src/config/managed-mode';
import type { ResolvedConfig } from '../../src/config/types';
import { loadConfig } from '../../src/config/loader';
import { writeFile } from 'fs/promises';

const quiet = () => {};

describe('every endpoint names its credential', () => {
  // INVARIANT: an endpoint with no credential is a config error at load, for
  // all three spellings — a named endpoint, an inline profile endpoint, and a
  // tier (through its endpoint) — naming the block and the line to add. Lazy
  // never guesses which secret a host receives.
  test('a named endpoint with no credential is refused, even unused', () => {
    expect(() => resolveAgentProfiles(undefined, quiet, { lunaroute: { url: 'https://gw.lunaroute.com/' } }))
      .toThrow(MissingEndpointCredentialError);
    try {
      resolveAgentProfiles(undefined, quiet, { lunaroute: { url: 'https://gw.lunaroute.com/' } });
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('[endpoints.lunaroute] has no credential');
      expect(msg).toContain('credential = "lunaroute"');
      expect(msg).toContain('lazy auth set lunaroute');
      expect(msg).toContain('credential = "none"');
    }
  });

  test('an inline profile endpoint with no credential is refused; a provider host suggests that provider', () => {
    let msg = '';
    try {
      resolveAgentProfiles({ fw: { harness: 'claude-code', model: 'm', endpoint: 'https://api.fireworks.ai/inference' } }, quiet);
    } catch (err) { msg = (err as Error).message; }
    expect(msg).toContain('[agents.fw] has no credential');
    expect(msg).toContain('credential = "fireworks"');
  });

  test('a local server still has to say so: credential = "none" loads', () => {
    expect(() => resolveAgentProfiles({ local: { harness: 'pi', model: 'q', endpoint: 'http://localhost:11434' } }, quiet))
      .toThrow(MissingEndpointCredentialError);
    let msg = '';
    try { resolveAgentProfiles({ local: { harness: 'pi', model: 'q', endpoint: 'http://localhost:11434' } }, quiet); }
    catch (err) { msg = (err as Error).message; }
    // A local server is told "none" first, not to store a key it does not take.
    expect(msg.indexOf('credential = "none"')).toBeLessThan(msg.indexOf('lazy auth set'));
    const ok = resolveAgentProfiles({ local: { harness: 'pi', model: 'q', endpoint: 'http://localhost:11434', credential: 'none' } }, quiet);
    expect(ok.get('local')?.credential).toBe('none');
  });

  test("the field report's config loads, every tier carrying its named credential", () => {
    const profiles = resolveAgentProfiles(
      {
        'claude-complex': {
          harness: 'claude-code',
          tiers: [
            { endpoint: 'anthropic-subscription', model: 'claude-opus-5-5', threshold_percent: 95 },
            { endpoint: 'lunaroute', model: 'glm-5.3' },
          ],
        },
      },
      quiet,
      {
        'anthropic-subscription': { url: 'https://api.anthropic.com', credential: 'anthropic' },
        lunaroute: { url: 'https://gw.lunaroute.com/', credential: 'lunaroute-api-key' },
      },
    );
    const tiers = profiles.get('claude-complex')!.tiers!;
    expect(tiers.map((t) => [t.upstream, t.credential])).toEqual([
      ['https://api.anthropic.com', 'anthropic'],
      ['https://gw.lunaroute.com', 'lunaroute-api-key'],
    ]);
  });

  test('an explicit provider credential on another host is the user\'s choice, and is honoured', () => {
    const profiles = resolveAgentProfiles(
      { gw: { harness: 'claude-code', model: 'm', endpoint: 'https://gw.example.com', credential: 'anthropic' } },
      quiet,
    );
    expect(profiles.get('gw')).toMatchObject({ credential: 'anthropic', credentialExplicit: true });
  });

  // INVARIANT: on a managed host the imported config is verbatim, so a block
  // missing its credential is reported as NOT HONOURED, with the reason — it
  // never takes the project down and it is never run with a guessed credential.
  test('managed: the profile is left out and reported, the rest loads', () => {
    const saved = process.env[MANAGED_ENV];
    process.env[MANAGED_ENV] = '1';
    try {
      const warnings: string[] = [];
      const profiles = resolveAgentProfiles(
        {
          bad: { harness: 'claude-code', model: 'm', endpoint: 'https://gw.example.com' },
          good: { harness: 'claude-code', model: 'm', endpoint: 'https://gw2.example.com', credential: 'anthropic' },
        },
        (m) => warnings.push(m),
      );
      expect(profiles.has('bad')).toBe(false);
      expect(profiles.has('good')).toBe(true);
      expect(notHonouredProfiles(profiles)).toEqual([
        { profile: 'bad', reason: expect.stringContaining('[agents.bad] has no credential') },
      ]);
      expect(warnings.join('\n')).toContain('agent profile "bad" is not honoured');
    } finally {
      if (saved === undefined) delete process.env[MANAGED_ENV];
      else process.env[MANAGED_ENV] = saved;
    }
  });
});

describe('provider credential host backstop', () => {
  let root: string | null = null;
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = null; });

  test('providerCredentialHostMismatch names the provider only for a foreign host', () => {
    expect(providerCredentialHostMismatch('anthropic', 'https://api.anthropic.com')).toBeNull();
    expect(providerCredentialHostMismatch('anthropic', 'https://gw.lunaroute.com')).toBe('anthropic');
    expect(providerCredentialHostMismatch('openai', 'https://gw.lunaroute.com')).toBe('openai');
    expect(providerCredentialHostMismatch('lunaroute-api-key', 'https://gw.lunaroute.com')).toBeNull();
    expect(providerCredentialHostMismatch('none', 'https://gw.lunaroute.com')).toBeNull();
  });

  // INVARIANT: the proxy never attaches a known provider's credential to a host
  // that is not that provider's unless lazy.toml NAMED it for that endpoint.
  // Independent of the loader: a profile that reaches the proxy with an inferred
  // provider credential on a foreign host (a future default, built-in or
  // migration) is refused, never sent.
  test('an INFERRED provider credential on a foreign host is refused at the proxy; a NAMED one is sent', async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-backstop-'));
    await writeFile(join(root, 'lazy.toml'), '');
    const config = await loadConfig(root);
    const raw = { leaky: {}, named: {} } as unknown as NonNullable<ResolvedConfig['agents']>;
    const base: AgentProfile = {
      name: 'leaky', harness: 'claude-code', model: 'm', endpoint: 'https://gw.lunaroute.com',
      endpointPinned: true, credential: 'anthropic', wire: 'anthropic', builtin: false, description: '',
    };
    cacheAgentProfiles(raw, new Map([
      ['leaky', base],
      ['named', { ...base, name: 'named', endpoint: 'https://gw2.example.com', credentialExplicit: true }],
    ]));
    const { targets, lines } = buildTargetCredentials(root, { ...config, agents: raw } as ResolvedConfig);
    const refused = await targets.forTarget('https://gw.lunaroute.com');
    expect(refused.kind).toBe('missing');
    expect(refused.kind === 'missing' && refused.reason).toContain('will not send the "anthropic" credential');
    expect(lines.join('\n')).toContain('https://gw.lunaroute.com → refused');
    expect(lines.join('\n')).toContain('https://gw2.example.com → anthropic (agent: named)');
  });
});
