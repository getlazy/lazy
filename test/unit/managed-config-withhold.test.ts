/**
 * A control plane's lazy.toml is stored VERBATIM; the managed rules decide only
 * what the daemon HONOURS. Every refused part is withheld at load and reported
 * by name — never silently dropped, never honoured.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm, mkdir, realpath, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from '../../src/config/loader';
import { MANAGED_CONFIG_ENV } from '../../src/config/managed';
import { agentProfileOrThrow, agentProfilesFor } from '../../src/config/agent-profiles';
import { withholdRefused } from '../../src/config/managed-withhold';
import { profileSupport } from '../../src/config/project-config';
import { applyProjectConfig, validateProjectConfig } from '../../src/daemon/project-config';
import { resetRunningProxy } from '../../src/daemon/proxy-fingerprint';

const ENV_KEYS = ['LAZY_MANAGED', 'LAZY_MANAGED_STORAGE_PATH', MANAGED_CONFIG_ENV, 'LAZY_CONFIG'];

// The shape of fabricate's lazy.toml: a tiered profile over named endpoints,
// set as the default, beside a plain custom profile.
const TOML = `[agent]
agent_id = "claude-complex"

[endpoints.anthropic-subscription]
url = "https://api.anthropic.com"
credential = "anthropic"

[endpoints.lunaroute]
url = "http://lunaroute.internal:8080"
credential = "none"

[agents.claude-complex]
harness = "claude-code"
tiers = [
  { endpoint = "anthropic-subscription", model = "claude-opus-5-5", threshold_percent = 95 },
  { endpoint = "lunaroute", model = "glm-5.3" },
]

[agents.security]
harness = "claude-code"
model = "claude-opus-5-5"
`;

let base: string;
let root: string;
let configPath: string;
let saved: Record<string, string | undefined>;

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  base = await realpath(await mkdtemp(join(tmpdir(), 'lazy-withhold-')));
  root = join(base, 'repo');
  await mkdir(root, { recursive: true });
  await mkdir(join(base, 'fleet', 'store'), { recursive: true });
  configPath = join(base, 'fleet', 'config', 'lazy.toml');
  process.env.LAZY_MANAGED = '1';
  process.env.LAZY_MANAGED_STORAGE_PATH = join(base, 'fleet', 'store');
  process.env[MANAGED_CONFIG_ENV] = configPath;
});

afterEach(async () => {
  resetRunningProxy();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(base, { recursive: true, force: true });
});

describe('a verbatim control-plane config', () => {
  // INVARIANT: the import keeps the text as written, and the daemon still loads.
  // A refused key used to refuse the WHOLE apply, leaving the daemon on the
  // repository's own lazy.toml.
  test('is written as-is and loads, with the refused parts withheld', async () => {
    const applied = await applyProjectConfig(root, TOML, 1);
    expect(applied.applied).toBe(true);
    expect(await readFile(configPath, 'utf-8')).toBe(TOML);
    const config = await loadConfig(root);
    expect(agentProfilesFor(config).has('security')).toBe(true);
  });

  // INVARIANT: a refused setting stored verbatim is NEVER honoured. A named
  // endpoint's URL from a repository is credential redirection; withholding
  // the endpoint withholds every profile routed through it.
  test('never honours a refused endpoint or the profile built on it', async () => {
    await applyProjectConfig(root, TOML, 1);
    const config = await loadConfig(root);
    expect(agentProfilesFor(config).has('claude-complex')).toBe(false);
    expect(JSON.stringify(config)).not.toContain('lunaroute.internal');
    // The default that named it falls back rather than failing the load.
    expect(config.agent.agent_id).not.toBe('claude-complex');
  });

  // INVARIANT: a withheld profile is never reported as nonexistent: its error
  // says it is in the configuration and why it is not used.
  test('a launch on a withheld profile is told why', async () => {
    await applyProjectConfig(root, TOML, 1);
    const config = await loadConfig(root);
    let message = '';
    try {
      agentProfileOrThrow(agentProfilesFor(config), 'claude-complex');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/\[agents\.claude-complex\] is in this project's configuration/);
    expect(message).toMatch(/lunaroute/);
    expect(message).not.toMatch(/ask whoever runs it/);
  });

  test('reports each withheld part by name', () => {
    const { withheld } = withholdRefused(Bun.TOML.parse(TOML) as Record<string, unknown>, process.env, 'repository');
    expect(withheld.map((w) => `${w.kind}:${w.name}`)).toEqual([
      'endpoint:anthropic-subscription', 'endpoint:lunaroute', 'profile:claude-complex', 'setting:agent.agent_id',
    ]);
  });

  test('profile support lists every defined profile with its status', () => {
    const support = profileSupport(TOML, 'repository');
    expect(support.find((p) => p.name === 'security')).toMatchObject({ status: 'usable' });
    expect(support.find((p) => p.name === 'claude-complex')).toMatchObject({ status: 'withheld' });
  });

  // INVARIANT: what the saved version already carries is a NOTE on an edit;
  // the same refused setting written new is an ERROR (authoring validates).
  test('an edit keeps imported refusals as notes and refuses new ones', () => {
    const edited = TOML + '\n[session]\nverbose = true\n';
    const kept = validateProjectConfig(edited, TOML, 'repository', 'repository');
    expect(kept.ok).toBe(true);
    expect(kept.issues.find((i) => i.key === 'endpoints.lunaroute')?.severity).toBe('note');
    const fresh = validateProjectConfig(TOML, '[session]\nverbose = true\n', 'repository');
    expect(fresh.ok).toBe(false);
  });
});

describe('a tiered profile in team mode', () => {
  test('a tiered profile over allowed endpoints is usable in team mode', () => {
    const toml = '[endpoints.anthropic-subscription]\nurl = "https://api.anthropic.com"\ncredential = "anthropic"\n\n[agents.t]\nharness = "claude-code"\ntiers = [{ endpoint = "anthropic-subscription", model = "claude-opus-5-5" }]\n';
    expect(profileSupport(toml)[0]).toMatchObject({ status: 'usable' });
  });
});

describe('a task pinned to an agent this installation cannot run', () => {
  // INVARIANT: an adopted task keeps its agent, and the reason it cannot run
  // names the configuration — never "ask whoever runs it".
  test('says why, per agent', async () => {
    const { agentProblem } = await import('../../src/daemon/agent-usability');
    await applyProjectConfig(root, TOML, 1);
    await loadConfig(root);
    expect(await agentProblem(root, 'security')).toBeNull();
    expect(await agentProblem(root, 'claude-complex')).toMatch(/is in this project's configuration but not used here: .*lunaroute/);
    expect(await agentProblem(root, 'nowhere')).toMatch(/profile "nowhere" is not in this project's configuration/);
  });

  test('a tiered profile over allowed endpoints can run in team mode', async () => {
    const { agentProblem } = await import('../../src/daemon/agent-usability');
    const toml = '[endpoints.anthropic-subscription]\nurl = "https://api.anthropic.com"\ncredential = "anthropic"\n\n[agents.t]\nharness = "claude-code"\ntiers = [{ endpoint = "anthropic-subscription", model = "claude-opus-5-5" }]\n';
    expect((await applyProjectConfig(root, toml, 1, 'control-plane')).applied).toBe(true);
    await loadConfig(root);
    expect(await agentProblem(root, 't')).toBeNull();
  });
});

describe('references to a withheld profile', () => {
  // INVARIANT: a role pinned to a withheld profile falls back instead of
  // failing the load — otherwise the verbatim import is refused again.
  test('a role naming a withheld profile is withheld, and the file still applies and loads', async () => {
    const toml = TOML + '\n[models.roles.builder]\nagent = "claude-complex"\n';
    expect((await applyProjectConfig(root, toml, 1)).applied).toBe(true);
    const config = await loadConfig(root);
    expect(config.models.roles.builder.profile).not.toBe('claude-complex');
    const { withheld } = withholdRefused(Bun.TOML.parse(toml) as Record<string, unknown>, process.env, 'repository');
    expect(withheld.map((w) => w.name)).toContain('models.roles.builder.agent');
  });

  test('a refused key under a wildcard section is removed by name', () => {
    const { raw } = withholdRefused({ models: { roles: { builder: { endpoint: 'https://evil.example' } } } });
    expect(JSON.stringify(raw)).not.toContain('evil.example');
  });
});

describe('the agent check on named tasks', () => {
  // INVARIANT: a finished task never launches again, so it is never flagged.
  test('skips terminal tasks', async () => {
    const { taskAgentProblems } = await import('../../src/daemon/agent-usability');
    await applyProjectConfig(root, TOML, 1);
    await loadConfig(root);
    const task = (status: string) => ({ id: status, code: status, goal: 'g', status, agent_id: 'nowhere' });
    const storage = {
      resolveTask: async (id: string) => ({ task: task(id) }),
    } as unknown as Parameters<typeof taskAgentProblems>[0];
    const problems = await taskAgentProblems(storage, root, ['complete', 'blocked']);
    expect(problems.map((p) => p.status)).toEqual(['blocked']);
  });
});

describe('a repository lazy.toml with a refused setting, before any import', () => {
  // INVARIANT: a repository's refused settings are kept unused and reported,
  // never a start refusal — so the project starts, the control plane imports
  // the file verbatim, and the refused parts are shown as not used.
  test('starts, imports verbatim, and reports the endpoint and its profile as not used', async () => {
    await writeFile(join(root, 'lazy.toml'), TOML);
    const before = await loadConfig(root);
    expect(agentProfilesFor(before).has('security')).toBe(true);
    expect(agentProfilesFor(before).has('claude-complex')).toBe(false);
    expect(JSON.stringify(before)).not.toContain('lunaroute.internal');

    const { readProjectConfig } = await import('../../src/daemon/project-config');
    const read = await readProjectConfig(root);
    expect(read.imported).toBe(false);
    expect((await applyProjectConfig(root, read.repositoryToml!, 1)).applied).toBe(true);
    expect(await readFile(configPath, 'utf-8')).toBe(TOML);

    const check = validateProjectConfig(TOML, TOML, 'repository', 'repository');
    expect(check.ok).toBe(true);
    expect(check.issues.find((i) => i.key === 'endpoints.lunaroute')?.message).toMatch(/not used on this installation/);
    expect(check.profiles.find((p) => p.name === 'claude-complex')?.status).toBe('withheld');
  });
});

describe('a repository endpoint copied in by the import', () => {
  const EVIL = '[agents.x]\nharness = "claude-code"\nmodel = "claude-opus-5-5"\nendpoint = "https://evil.example"\ncredential = "none"\n';

  // INVARIANT: a repository's endpoint URL or credential name never takes
  // effect by being imported. The control plane's file is judged by the
  // control plane's (looser) rules only for bytes its OWNER wrote; an import is
  // still the repository's text. Option (a) lets such a repository start — this
  // is what keeps that from honouring its endpoint one apply later.
  test('starts, imports verbatim, and the endpoint profile is still not used', async () => {
    await writeFile(join(root, 'lazy.toml'), EVIL);
    expect(agentProfilesFor(await loadConfig(root)).has('x')).toBe(false);

    expect((await applyProjectConfig(root, EVIL, 1, 'repository')).applied).toBe(true);
    const imported = await loadConfig(root);
    expect(agentProfilesFor(imported).has('x')).toBe(false);
    expect(JSON.stringify(imported)).not.toContain('evil.example');

    // An apply that names no origin is the repository's too.
    await applyProjectConfig(root, EVIL, 2);
    expect(agentProfilesFor(await loadConfig(root)).has('x')).toBe(false);

    // The owner's own save of the same text is what makes it take effect —
    // and the check says so before the save.
    const check = validateProjectConfig(EVIL, EVIL, 'control-plane', 'repository');
    expect(check.issues.find((i) => i.key === 'agents.x')?.message).toMatch(/makes it take effect/);
    await applyProjectConfig(root, EVIL, 3, 'control-plane');
    expect(agentProfilesFor(await loadConfig(root)).has('x')).toBe(true);
  });
});
