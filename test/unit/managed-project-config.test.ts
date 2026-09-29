/**
 * The control plane's copy of a managed project's lazy.toml: the file outside
 * the clone that replaces the repository's config once imported, the daemon's
 * verdict on candidate text, and the atomic apply.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig, resolveConfigPath } from '../../src/config/loader';
import { MANAGED_CONFIG_ENV, managedConfigPath } from '../../src/config/managed';
import { validateProjectConfigText, editableConfigKeys } from '../../src/config/project-config';
import { applyProjectConfig, readProjectConfig } from '../../src/daemon/project-config';
import { RpcError } from '../../src/daemon/rpc-error';
import { recordRunningProxy, resetRunningProxy } from '../../src/daemon/proxy-fingerprint';

const ENV_KEYS = ['LAZY_MANAGED', 'LAZY_MANAGED_STORAGE_PATH', MANAGED_CONFIG_ENV, 'LAZY_CONFIG'];

let base: string;
let root: string;
let fleetDir: string;
let configPath: string;
let saved: Record<string, string | undefined>;

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  base = await realpath(await mkdtemp(join(tmpdir(), 'lazy-managed-config-')));
  root = join(base, 'repo');
  fleetDir = join(base, 'fleet');
  await mkdir(root, { recursive: true });
  await mkdir(join(fleetDir, 'store'), { recursive: true });
  configPath = join(fleetDir, 'config', 'lazy.toml');
  process.env.LAZY_MANAGED = '1';
  process.env.LAZY_MANAGED_STORAGE_PATH = join(fleetDir, 'store');
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

describe('the control plane config file', () => {
  // INVARIANT: once the control plane's file exists, the repository's lazy.toml
  // is never read, whatever it says. Import-once is the whole contract: a later
  // push to the repo's lazy.toml must not change a managed project's rules.
  test('wins over the repository lazy.toml once it exists', async () => {
    await writeFile(join(root, 'lazy.toml'), '[session]\nverbose = true\n');
    expect((await loadConfig(root)).session.verbose).toBe(true);

    await mkdir(join(fleetDir, 'config'), { recursive: true });
    await writeFile(configPath, '[session]\nverbose = false\n');
    expect(await resolveConfigPath(root)).toBe(configPath);
    expect((await loadConfig(root)).session.verbose).toBe(false);
  });

  // INVARIANT: the daemon re-reads config on every load — no cache — so a
  // written change is live for the next turn and tick without a restart.
  test('a rewritten file is seen by the very next load', async () => {
    await mkdir(join(fleetDir, 'config'), { recursive: true });
    await writeFile(configPath, '[agent]\nwatchdog_output_timeout_ms = 1000\n');
    expect((await loadConfig(root)).agent.watchdog_output_timeout_ms).toBe(1000);
    await writeFile(configPath, '[agent]\nwatchdog_output_timeout_ms = 2000\n');
    expect((await loadConfig(root)).agent.watchdog_output_timeout_ms).toBe(2000);
  });

  // INVARIANT: the file must live outside the clone — inside it, a branch
  // could reach the rules that govern it.
  test('a path inside the checkout, or a relative one, is refused', () => {
    expect(() => managedConfigPath(root, { ...process.env, [MANAGED_CONFIG_ENV]: join(root, '.lazy', 'x.toml') }))
      .toThrow(/inside the project checkout/);
    expect(() => managedConfigPath(root, { ...process.env, [MANAGED_CONFIG_ENV]: 'x.toml' }))
      .toThrow(/absolute path/);
  });

  // INVARIANT: the daemon's environment names the file whether or not managed
  // mode is armed — a control plane running daemons unmanaged (a demo install)
  // still owns their config — and an unset variable changes nothing.
  test('is honoured outside managed mode, and absent changes nothing', async () => {
    await mkdir(join(fleetDir, 'config'), { recursive: true });
    await writeFile(configPath, '[session]\nverbose = false\n');
    await writeFile(join(root, 'lazy.toml'), '[session]\nverbose = true\n');
    delete process.env.LAZY_MANAGED;
    expect((await loadConfig(root)).session.verbose).toBe(false);
    delete process.env[MANAGED_CONFIG_ENV];
    expect((await loadConfig(root)).session.verbose).toBe(true);
  });
});

describe('validateProjectConfigText', () => {
  test('a clean config is ok', () => {
    expect(validateProjectConfigText('[permissions]\nprotected = ["CLAUDE.md"]\n')).toEqual({ ok: true, issues: [] });
  });

  test('a syntax error is one file-level error', () => {
    const verdict = validateProjectConfigText('[permissions\n');
    expect(verdict.ok).toBe(false);
    expect(verdict.issues[0]!.key).toBeNull();
    expect(verdict.issues[0]!.message).toContain('Failed to parse');
  });

  // INVARIANT: an unknown key is inert (lazy never reads it), so it is a note
  // naming the key — flagged for the typo it probably is, never blocking.
  test('an unknown key is a note naming the key', () => {
    const verdict = validateProjectConfigText('[permissions]\nprotectd = []\n');
    expect(verdict.ok).toBe(true);
    expect(verdict.issues).toContainEqual(expect.objectContaining({ key: 'permissions.protectd', severity: 'note' }));
  });

  test('a refused key is an error naming the key', () => {
    const verdict = validateProjectConfigText('[proxy]\nupstream = "https://evil.example"\n');
    expect(verdict.ok).toBe(false);
    expect(verdict.issues).toContainEqual(expect.objectContaining({ key: 'proxy.upstream', severity: 'error' }));
  });

  test('an overridden key is a note, not an error', () => {
    const verdict = validateProjectConfigText('[storage]\nbackend = "external"\nexternal_path = "~/.lazy/x"\n');
    expect(verdict.ok).toBe(true);
    expect(verdict.issues).toContainEqual(expect.objectContaining({ key: 'storage.external_path', severity: 'note' }));
  });

  test("the resolver's own validation is reported against the key it names", () => {
    const verdict = validateProjectConfigText('[proxy]\nretry_after_threshold = -1\n');
    expect(verdict.ok).toBe(false);
    expect(verdict.issues).toContainEqual(expect.objectContaining({ key: 'proxy.retry_after_threshold', severity: 'error' }));
  });

  // INVARIANT: the editable set IS the managed policy's respected set — never
  // a second list a client keeps.
  test('the editable keys are the respected ones', () => {
    const keys = editableConfigKeys();
    expect(keys).toContain('permissions.protected');
    expect(keys).toContain('automation.post_turn');
    expect(keys).not.toContain('storage.external_path');
    expect(keys).not.toContain('mounts');
  });
});

describe('applyProjectConfig', () => {
  // INVARIANT: an invalid config is never written, so the file in force is
  // always one the daemon accepted — a bad save cannot take the daemon down.
  test('an invalid candidate is not written', async () => {
    const result = await applyProjectConfig(root, '[proxy]\nupstream = "https://evil.example"\n');
    expect(result.applied).toBe(false);
    expect(await Bun.file(configPath).exists()).toBe(false);
  });

  test('a valid candidate is written atomically and becomes the config', async () => {
    await writeFile(join(root, 'lazy.toml'), '[session]\nverbose = true\n');
    const result = await applyProjectConfig(root, '[session]\nverbose = false\n');
    expect(result).toMatchObject({ applied: true, changed: true, restartRequired: [], path: configPath });
    expect(await readFile(configPath, 'utf-8')).toBe('[session]\nverbose = false\n');
    expect((await readdir(join(fleetDir, 'config'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect((await loadConfig(root)).session.verbose).toBe(false);
    // Nothing in the clone changed.
    expect(await readFile(join(root, 'lazy.toml'), 'utf-8')).toBe('[session]\nverbose = true\n');

    const again = await applyProjectConfig(root, '[session]\nverbose = false\n');
    expect(again).toMatchObject({ applied: true, changed: false });
  });

  // INVARIANT: only what the proxy is built from at startup asks for a restart.
  test('names the changed keys that need a restart', async () => {
    await applyProjectConfig(root, '[proxy]\nretry_after_threshold = 5\n');
    const result = await applyProjectConfig(root, '[proxy]\nretry_after_threshold = 9\n[session]\nverbose = true\n');
    expect(result.restartRequired).toEqual(['proxy.retry_after_threshold']);
  });

  // INVARIANT: a profile with its own endpoint is a proxy ROUTE, fixed when the
  // proxy is built — adding one needs a restart even though its keys are not proxy keys.
  test('adding an agent profile with its own endpoint needs a restart', async () => {
    await applyProjectConfig(root, '[session]\nverbose = true\n');
    const result = await applyProjectConfig(root,
      '[session]\nverbose = true\n[agents.work-codex]\nharness = "codex"\nmodel = "gpt-5-codex"\n');
    expect(result.restartRequired).toContain('agents (proxy routes)');
  });

  // INVARIANT: the comparison is with the RUNNING proxy, so a restart owed by an
  // earlier save that never happened is still owed on the next one.
  test('a restart owed and not performed is still owed on the next save', async () => {
    await applyProjectConfig(root, '[proxy]\nretry_after_threshold = 5\n');
    recordRunningProxy(root, await loadConfig(root));
    const first = await applyProjectConfig(root, '[proxy]\nretry_after_threshold = 9\n');
    expect(first.restartRequired).toEqual(['proxy.retry_after_threshold']);
    const second = await applyProjectConfig(root, '[proxy]\nretry_after_threshold = 9\n[session]\nverbose = true\n');
    expect(second.restartRequired).toEqual(['proxy.retry_after_threshold']);
    expect((await readProjectConfig(root)).restartPending).toEqual(['proxy.retry_after_threshold']);
  });

  test('refuses on a daemon with no control plane path', async () => {
    delete process.env[MANAGED_CONFIG_ENV];
    await expect(applyProjectConfig(root, '')).rejects.toBeInstanceOf(RpcError);
  });

  test('the read reports source, import state and the repository text', async () => {
    await writeFile(join(root, 'lazy.toml'), '[session]\nverbose = true\n');
    const before = await readProjectConfig(root);
    expect(before).toMatchObject({ imported: false, source: 'repository', repositoryToml: '[session]\nverbose = true\n' });
    await applyProjectConfig(root, before.repositoryToml!);
    const after = await readProjectConfig(root);
    expect(after).toMatchObject({ imported: true, source: 'control-plane', toml: '[session]\nverbose = true\n' });
  });
});
