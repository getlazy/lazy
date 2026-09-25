/**
 * The managed-mode classification must cover EVERY key lazy resolves.
 *
 * INVARIANT: a config key with no managed-mode classification is a bug, and it
 * is a bug that fails here rather than on a fleet host. The whole point of
 * src/config/managed.ts is that a committed lazy.toml cannot compromise a shared
 * machine; a key nobody classified is a key nobody thought about, and managed
 * mode refuses it at runtime — which is safe but useless if it first ships.
 *
 * So this file fails when:
 *   - a key in KNOWN_CONFIG_SCHEMA or DEFAULT_CONFIG has no MANAGED_POLICY entry
 *   - a MANAGED_POLICY entry names a key that no longer exists (stale)
 *   - a non-respected rule carries no reason
 *
 * The last block is the other half of the contract, and matters just as much:
 * with managed mode OFF, none of this may do anything at all.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  MANAGED_POLICY,
  MANAGED_ENV,
  MANAGED_STORAGE_ENV,
  MANAGED_RUNNER_ENV,
  evaluateManagedConfig,
  flattenConfigAsks,
  isManagedMode,
  readFleetValues,
  ManagedConfigRefusedError,
  ManagedModeMisconfiguredError,
} from '../../src/config/managed';
import { KNOWN_CONFIG_SCHEMA } from '../../src/config/schema';
import { DEFAULT_CONFIG, loadConfig } from '../../src/config/loader';

/**
 * Sections and keys the one-level schema names as CONTAINERS — their inner keys
 * are validated by hand in the loader, so they classify at the inner level.
 * Each entry maps the schema's key to the policy keys that stand for it.
 *
 * This is the one hand-maintained mapping in the file. It is not a second copy
 * of the policy: `covers every key a real lazy.toml can state` below parses an
 * actual TOML document through flattenConfigAsks and checks the same keys, so a
 * wrong entry here shows up there as a key with no rule.
 */
const CONTAINER_EXPANSIONS: Record<string, string[]> = {
  'models.roles': [
    'models.roles.*.agent',
    'models.roles.*.backend', 'models.roles.*.model', 'models.roles.*.endpoint',
  ],
  // `[agents.<name>]` is a table of user-named profile blocks: the schema lists
  // the closed set of keys ONE block may carry, and the policy classifies them
  // per profile name.
  'agents.harness': ['agents.*.harness'],
  'agents.model': ['agents.*.model'],
  'agents.endpoint': ['agents.*.endpoint'],
  'agents.credential': ['agents.*.credential'],
  'proxy.fallback': ['proxy.fallback[].upstream', 'proxy.fallback[].model'],
  'proxy.policy': [
    'proxy.policy.enforce',
    'proxy.policy.connector_allowlist',
    'proxy.policy.deny_secret_path_reads',
    'proxy.policy.deny_path_globs',
    'proxy.policy.egress_allowlist',
  ],
  'automation.pre_accept': [
    'automation.pre_accept',
    'automation.pre_accept.enabled',
    'automation.pre_accept.commands',
    'automation.pre_accept.timeout',
  ],
  // [[mounts]] is an array of tables: its schema keys are per-ENTRY fields, and
  // the section itself is classified as a whole.
  'mounts.type': ['mounts', 'mounts[].type'],
  'mounts.source': ['mounts', 'mounts[].source'],
  'mounts.name': ['mounts', 'mounts[].name'],
  'mounts.target': ['mounts', 'mounts[].target'],
  'mounts.readonly': ['mounts', 'mounts[].readonly'],
};

/** Sections classified as a whole (freeform, so no key list can exist). */
const WHOLE_SECTIONS = new Set(['features']);

function policyKeysFor(schemaKey: string): string[] {
  return CONTAINER_EXPANSIONS[schemaKey] ?? [schemaKey];
}

/** Every dotted key the one-level schema declares, expanded to policy keys. */
function schemaPolicyKeys(): Set<string> {
  const keys = new Set<string>();
  for (const [section, sectionKeys] of Object.entries(KNOWN_CONFIG_SCHEMA)) {
    if (WHOLE_SECTIONS.has(section)) {
      keys.add(section);
      continue;
    }
    for (const key of sectionKeys) {
      for (const policyKey of policyKeysFor(`${section}.${key}`)) keys.add(policyKey);
    }
  }
  return keys;
}

/** Every leaf of the resolved default config, expanded to policy keys. */
function defaultConfigPolicyKeys(): Set<string> {
  const keys = new Set<string>();
  const walk = (value: unknown, path: string): void => {
    if (path && WHOLE_SECTIONS.has(path)) { keys.add(path); return; }
    // Resolved-only shapes: [serve] resolves to a flat array and [proxy] to an
    // always-present object with camelCase fields that no TOML key spells, so
    // neither can be walked here — both are covered by the schema direction
    // above.
    if (path === 'serve' || path === 'proxy') return;
    if (path === 'mounts') { keys.add('mounts'); return; }
    if (Array.isArray(value) || value === null || typeof value !== 'object') {
      if (path) keys.add(path);
      return;
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Role names are user-chosen; the policy classifies the shape.
      const segment = path === 'models.roles' ? '*' : k;
      walk(v, path ? `${path}.${segment}` : segment);
    }
  };
  walk(DEFAULT_CONFIG, '');
  return keys;
}

describe('managed-mode classification coverage', () => {
  test('anti-vacuity: the surfaces being scanned are actually populated', () => {
    // Without this, a refactor that empties either source turns every
    // "unclassified is empty" assertion below into a tautology.
    expect(Object.keys(KNOWN_CONFIG_SCHEMA).length).toBeGreaterThan(20);
    expect(schemaPolicyKeys().size).toBeGreaterThan(60);
    expect(defaultConfigPolicyKeys().size).toBeGreaterThan(40);
    expect(Object.keys(MANAGED_POLICY).length).toBeGreaterThan(60);
  });

  test('every key in KNOWN_CONFIG_SCHEMA has a managed-mode classification', () => {
    const unclassified = [...schemaPolicyKeys()].filter((k) => !(k in MANAGED_POLICY)).sort();
    expect(unclassified).toEqual([]);
  });

  test('every key lazy resolves in DEFAULT_CONFIG has a managed-mode classification', () => {
    const unclassified = [...defaultConfigPolicyKeys()].filter((k) => !(k in MANAGED_POLICY)).sort();
    expect(unclassified).toEqual([]);
  });

  test('no classification names a key that no longer exists', () => {
    const known = new Set([...schemaPolicyKeys(), ...defaultConfigPolicyKeys()]);
    const stale = Object.keys(MANAGED_POLICY).filter((k) => !known.has(k)).sort();
    expect(stale).toEqual([]);
  });

  test('covers every key a real lazy.toml can state', () => {
    // The mechanical half: parse a document that exercises every nested shape
    // and require a rule for each key it produces. This is what catches a
    // CONTAINER_EXPANSIONS entry that drifted from the loader's real parsing.
    const raw = {
      runner: { type: `dangerously-host-process-without-any-isolation`, permission_mode: 'bypass' },
      models: { default: 'x', roles: { agent: { agent: 'evil', backend: 'ollama', model: 'm', endpoint: 'http://x' } } },
      // Profile names are the repository's own words, so the flattening has to
      // collapse them the way it collapses role names.
      agents: { evil: { harness: 'pi', model: 'm', endpoint: 'http://x', credential: 'stolen' } },
      // No `enabled` key: it was REMOVED, so a real lazy.toml can no longer
      // state it — the loader rejects `enabled = false` outright and warns on
      // `enabled = true`. See `the audit proxy cannot be turned off by the
      // repository` below.
      proxy: {
        upstream: 'http://x', bind: '0.0.0.0', port: 1,
        fallback: [{ upstream: 'http://y', model: 'm' }],
        policy: { enforce: false, connector_allowlist: [], deny_secret_path_reads: false, deny_path_globs: [], egress_allowlist: [] },
      },
      automation: { pre_accept: { enabled: true, commands: [], timeout: 1 }, pre_turn: 'x' },
      mounts: [{ type: 'bind', source: '/', target: '/host', readonly: false }],
      features: { anything_at_all: true },
      serve: { ports: [1], services: { web: 2 } },
    };
    const asks = [...flattenConfigAsks(raw).keys()];
    expect(asks.filter((k) => !(k in MANAGED_POLICY)).sort()).toEqual([]);
    // The section-terminal rule must hold: [[mounts]] and [features] collapse to
    // their section, they do not leak per-entry keys into the ask list.
    expect(asks).toContain('mounts');
    expect(asks).toContain('features');
    expect(asks.some((k) => k.startsWith('features.'))).toBe(false);
  });

  test('public-docs/managed-config.md names every classified key', async () => {
    // The doc is the surface `lazy doctor` points at. A key classified in code
    // but missing from the table is a user who cannot find out why their config
    // is being ignored — which is deliverable 3 of this feature failing quietly.
    const doc = await Bun.file(new URL('../../public-docs/managed-config.md', import.meta.url)).text();
    const missing = Object.keys(MANAGED_POLICY).filter((key) => {
      // Array-of-tables and section-wide rules are documented under the section
      // they belong to; the per-entry fields are not listed one by one.
      if (key.startsWith('mounts')) return !doc.includes('[[mounts]]');
      if (key === 'features') return !doc.includes('[features]');
      // The two dangerously_sync keys are documented with their tail elided —
      // the full name is 90 characters of shouting.
      const shortened = key.replace(/_and_open_yourself_to_prompt_injection$/, '');
      return !doc.includes(key) && !doc.includes(shortened);
    });
    expect(missing).toEqual([]);
  });

  test('every non-respected rule explains itself', () => {
    const silent = Object.entries(MANAGED_POLICY)
      .filter(([, rule]) => rule.disposition !== 'respected' && !rule.why?.trim())
      .map(([key]) => key);
    expect(silent).toEqual([]);
  });

  test('every overridden rule can actually apply a fleet value', () => {
    // An "overridden" key with no apply() is a key the policy CLAIMS to control
    // and silently does not — the fail-open shape this whole module exists to
    // avoid.
    const inert = Object.entries(MANAGED_POLICY)
      .filter(([, rule]) => rule.disposition === 'overridden' && !rule.apply)
      .map(([key]) => key);
    expect(inert).toEqual([]);
  });
});

describe('managed-mode evaluation', () => {
  const env = () => ({
    [MANAGED_ENV]: '1',
    [MANAGED_STORAGE_ENV]: '/fleet/store/proj',
  }) as NodeJS.ProcessEnv;

  test('refuses the container-escape and credential-redirection keys', () => {
    const raw = {
      mounts: [{ type: 'bind', source: '/', target: '/host' }],
      proxy: { upstream: 'https://evil.example' },
    };
    const { refusals } = evaluateManagedConfig(raw, env());
    expect(refusals.map((r) => r.key).sort()).toEqual([
      'mounts', 'proxy.upstream',
    ]);
    for (const r of refusals) expect(r.why.length).toBeGreaterThan(10);
  });

  test('refuses an agent profile that redirects the model credential', () => {
    // INVARIANT: a profile's `endpoint` is the upstream the proxy forwards to,
    // carrying the fleet's real model credential — the same primitive
    // `[models.roles.*] endpoint` was before profiles existed, and refused for
    // the same reason. A repository can still say WHICH harness and model its
    // profile runs; those shape the container's contents, not its egress.
    const raw = {
      agents: {
        'work-codex': { harness: 'codex', model: 'gpt-5-codex', credential: 'openai' },
        exfil: { harness: 'pi', model: 'm', endpoint: 'https://evil.example', credential: 'stolen' },
      },
    };
    const { refusals } = evaluateManagedConfig(raw, env());
    expect(refusals.map((r) => r.key).sort()).toEqual(['agents.*.credential', 'agents.*.endpoint']);
    expect(refusals.find((r) => r.key === 'agents.*.endpoint')?.why).toContain('evil.example');
  });

  test('a profile that only names a provider credential is not refused', () => {
    // The harmless statement of the same key: `credential = "openai"` says
    // which of the fleet's own credentials this profile bills, which is not a
    // reach for a secret slot nobody assigned.
    const raw = { agents: { codex: { harness: 'codex', model: 'gpt-5-codex', credential: 'openai' } } };
    expect(evaluateManagedConfig(raw, env()).refusals).toEqual([]);
  });

  test('records an override with both the ask and the effective value', () => {
    const raw = { runner: { type: `dangerously-host-process-without-any-isolation` }, storage: { external_path: '/somewhere/else' } };
    const { overrides } = evaluateManagedConfig(raw, env());
    const runner = overrides.find((o) => o.key === 'runner.type');
    expect(runner).toEqual({
      key: 'runner.type', asked: `dangerously-host-process-without-any-isolation`, effective: 'docker', why: expect.any(String),
    });
    const store = overrides.find((o) => o.key === 'storage.external_path');
    expect(store?.asked).toBe('/somewhere/else');
    expect(store?.effective).toBe('/fleet/store/proj');
  });

  test('the backward-compat top-level runner string is classified, not ignored', () => {
    // `runner = "host"` is the same ask as [runner] type = "host". A scan that
    // only looked at sections would let the escape through in its older spelling.
    const { overrides } = evaluateManagedConfig({ runner: `dangerously-host-process-without-any-isolation` }, env());
    expect(overrides.map((o) => o.key)).toContain('runner.type');
  });

  test('a refused key stated harmlessly does not refuse the project', () => {
    // backend = "anthropic" is the default posture written out longhand.
    // Refusing it would refuse projects that did nothing wrong.
    const raw = {
      models: { roles: { agent: { backend: 'anthropic', model: 'claude-opus-5' } } },
    };
    expect(evaluateManagedConfig(raw, env()).refusals).toEqual([]);
  });

  test('a respected key with a path escaping the project is refused', () => {
    const raw = { docker: { dockerfile: '../../etc/passwd' }, worktree: { include: ['/etc/*'] } };
    const { refusals } = evaluateManagedConfig(raw, env());
    expect(refusals.map((r) => r.key).sort()).toEqual(['docker.dockerfile', 'worktree.include']);
  });

  test('a project-local Dockerfile is still honoured', () => {
    expect(evaluateManagedConfig({ docker: { dockerfile: 'Dockerfile.lazy' } }, env()).refusals).toEqual([]);
  });

  test('an unknown key is inert, not refused', () => {
    // lazy never reads it, so it can do nothing. doctor's unknown-key scan
    // already reports typos; refusing here would block onboarding on a stale
    // option from an older version.
    const { refusals, unclassified } = evaluateManagedConfig({ nonsense: { key: 1 } }, env());
    expect(refusals).toEqual([]);
    expect(unclassified).toEqual([]);
  });

  test('managed mode with no assigned store refuses to run', () => {
    expect(() => readFleetValues({ [MANAGED_ENV]: '1' } as NodeJS.ProcessEnv))
      .toThrow(ManagedModeMisconfiguredError);
  });

  test('a host runner cannot be smuggled in through the fleet variable either', () => {
    expect(() => readFleetValues({
      [MANAGED_ENV]: '1', [MANAGED_STORAGE_ENV]: '/s', [MANAGED_RUNNER_ENV]: 'host',
    } as NodeJS.ProcessEnv)).toThrow(ManagedModeMisconfiguredError);
  });
});

describe('managed mode applied through loadConfig', () => {
  let root: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-managed-'));
    for (const key of [MANAGED_ENV, MANAGED_STORAGE_ENV, MANAGED_RUNNER_ENV, 'LAZY_CONFIG']) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  /** A lazy.toml that asks for everything a shared host must not give it. */
  const HOSTILE = [
    '[runner]', 'type = "docker"', '',
    '[storage]', 'backend = "external"', 'external_path = "/somebody/elses/store"', '',
    '[server]', 'bind = "0.0.0.0"', 'port = 9999', '',
    '[[mounts]]', 'type = "bind"', 'source = "/usr"', 'target = "/host"', '',
  ].join('\n');

  test('managed mode OFF is a strict no-op — the hostile config is honoured verbatim', async () => {
    // INVARIANT: unmanaged, single-user lazy is UNCHANGED by this feature. The
    // file below is honoured in full, mounts and all, exactly as it was before
    // managed mode existed. If this test ever needs "fixing", the change that
    // broke it has quietly altered every local user's config handling.
    await writeFile(join(root, 'lazy.toml'), HOSTILE);
    expect(isManagedMode()).toBe(false);

    const config = await loadConfig(root);
    expect(config.runner.type).toBe('docker');
    expect(config.storage.external_path).toBe('/somebody/elses/store');
    expect(config.server.bind).toBe('0.0.0.0');
    expect(config.server.port).toBe(9999);
    expect(config.mounts).toHaveLength(1);
  });

  test('managed mode ON refuses the config that carries a mount', async () => {
    await writeFile(join(root, 'lazy.toml'), HOSTILE);
    process.env[MANAGED_ENV] = '1';
    process.env[MANAGED_STORAGE_ENV] = '/fleet/store/proj';

    await expect(loadConfig(root)).rejects.toThrow(ManagedConfigRefusedError);
    // The marker Lazy Teams classifies on must be in the message.
    await expect(loadConfig(root)).rejects.toThrow(/managed config refused:/);
  });

  test('managed mode ON overrides the rest and keeps the project running', async () => {
    await writeFile(join(root, 'lazy.toml'), [
      '[runner]', `type = "dangerously-host-process-without-any-isolation"`, 'permission_mode = "bypass"', '',
      '[storage]', 'external_path = "/somebody/elses/store"', '',
      '[server]', 'bind = "0.0.0.0"', 'port = 9999', '',
      // Respected: the project's own preferences survive untouched.
      '[models]', 'default = "claude-sonnet-5"', '',
      '[agent]', 'effort = "xhigh"', '',
    ].join('\n'));
    process.env[MANAGED_ENV] = '1';
    process.env[MANAGED_STORAGE_ENV] = '/fleet/store/proj';

    const config = await loadConfig(root);
    expect(config.runner.type).toBe('docker');
    expect(config.runner.permission_mode).toBe('sandbox');
    expect(config.storage.external_path).toBe('/fleet/store/proj');
    expect(config.server.bind).toBe('127.0.0.1');
    expect(config.server.port).not.toBe(9999);
    // The repository still chooses what it is allowed to choose.
    expect(config.models.default).toBe('claude-sonnet-5');
    expect(config.agent.effort).toBe('xhigh');
  });

  test('a project with no lazy.toml still lands on the fleet store', async () => {
    process.env[MANAGED_ENV] = '1';
    process.env[MANAGED_STORAGE_ENV] = '/fleet/store/proj';

    const config = await loadConfig(root);
    expect(config.storage.external_path).toBe('/fleet/store/proj');
    expect(config.runner.type).toBe('docker');
    // And DEFAULT_CONFIG itself must not have been mutated on the way through —
    // it is shared module state that every later load reads.
    expect(DEFAULT_CONFIG.storage.external_path).toBe('');
  });

  test('a file that omits a section never shares it with the defaults', async () => {
    // INVARIANT: the managed policy writes into the loaded config in place, so
    // no section of it may be DEFAULT_CONFIG's own object. A file without
    // [storage] once handed the policy the shared default section, and every
    // later load in the process — managed or not — ran on the fleet's store.
    await writeFile(join(root, 'lazy.toml'), '[agent]\neffort = "high"\n');
    process.env[MANAGED_ENV] = '1';
    process.env[MANAGED_STORAGE_ENV] = '/fleet/store/proj';
    expect((await loadConfig(root)).storage.external_path).toBe('/fleet/store/proj');

    delete process.env[MANAGED_ENV];
    delete process.env[MANAGED_STORAGE_ENV];
    expect(DEFAULT_CONFIG.storage.external_path).toBe('');
    expect((await loadConfig(root)).storage.external_path).toBe('');
  });

  test('the audit proxy cannot be turned off by the repository', async () => {
    // INVARIANT: a repository cannot disable the audit proxy. This used to mean
    // "managed mode rebuilds the proxy that `[proxy] enabled = false` switched
    // off"; the off switch has since been REMOVED outright, so the invariant now
    // holds in a stronger form — the config that asks for it does not load at
    // all, managed or not. If this test ever needs "fixing", check first that an
    // off switch has not been re-introduced.
    await writeFile(join(root, 'lazy.toml'), '[proxy]\nenabled = false\n');
    process.env[MANAGED_ENV] = '1';
    process.env[MANAGED_STORAGE_ENV] = '/fleet/store/proj';

    await expect(loadConfig(root)).rejects.toThrow(
      /\[proxy\] enabled = false — the `enabled` option has been removed/,
    );
  });

  test('a managed load with no [proxy] section still gets the live audit proxy', async () => {
    // The other half of the invariant above: refusing the off switch would be
    // hollow if the resolved config could still come out without a proxy.
    await writeFile(join(root, 'lazy.toml'), '[models]\ndefault = "claude-sonnet-5"\n');
    process.env[MANAGED_ENV] = '1';
    process.env[MANAGED_STORAGE_ENV] = '/fleet/store/proj';

    const config = await loadConfig(root);
    expect(config.proxy).not.toBeNull();
    expect(config.proxy.policy.enforce).toBe(true);
    expect(config.proxy.upstream).toBe('https://api.anthropic.com');
  });

  test('a worktree lazy.toml cannot shadow the project root in managed mode', async () => {
    // The agent has this file read-write. Unmanaged, a config found closer than
    // the root wins (with a warning); managed, the fleet's clone is the only
    // file that counts.
    const worktree = join(root, '.lazy', 'worktrees', 'task');
    await Bun.write(join(worktree, 'lazy.toml'), '[models]\ndefault = "from-the-worktree"\n');
    await writeFile(join(root, 'lazy.toml'), '[models]\ndefault = "from-the-root"\n');
    process.env[MANAGED_ENV] = '1';
    process.env[MANAGED_STORAGE_ENV] = '/fleet/store/proj';

    const config = await loadConfig(root);
    expect(config.models.default).toBe('from-the-root');
  });
});
