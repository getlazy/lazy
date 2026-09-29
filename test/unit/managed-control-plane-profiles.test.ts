/**
 * On a MANAGED host, the project owner may define agent profiles with their own
 * endpoint and credential name in the CONTROL PLANE's config — and those
 * endpoints are paid only by each member's own credential, never the host's.
 *
 * The repository's lazy.toml keeps its refusal (test/unit/managed-config-policy
 * .test.ts): a file that arrived from a git clone still cannot redirect
 * anything. What changed is only the control plane's own file, which a person
 * edits on purpose.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm, mkdir, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from '../../src/config/loader';
import { MANAGED_CONFIG_ENV, evaluateManagedConfig } from '../../src/config/managed';
import { validateProjectConfigText, editableConfigKeys } from '../../src/config/project-config';
import { applyProjectConfig } from '../../src/daemon/project-config';
import { buildTargetCredentials } from '../../src/proxy/credential-deps';
import { resetRunningProxy } from '../../src/daemon/proxy-fingerprint';

const ENV_KEYS = ['LAZY_MANAGED', 'LAZY_MANAGED_STORAGE_PATH', MANAGED_CONFIG_ENV, 'LAZY_CONFIG', 'LAZY_CREDENTIAL_GW_CLAUDE'];

const PROFILES = [
  '[agents.claude-gw]',
  'harness = "claude-code"',
  'model = "claude-sonnet-4-6"',
  'endpoint = "https://gw.example.com"',
  'credential = "gw-claude"',
  '',
].join('\n');

let base: string;
let root: string;
let configPath: string;
let saved: Record<string, string | undefined>;

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  base = await realpath(await mkdtemp(join(tmpdir(), 'lazy-cp-profiles-')));
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

describe('agent profiles in the control plane config of a managed project', () => {
  // INVARIANT: WHO chose the value decides. A repository may not point a
  // profile anywhere; the project owner, in the control plane, may.
  test('the repository is refused, the control plane is not', () => {
    const raw = Bun.TOML.parse(PROFILES) as Record<string, unknown>;
    expect(evaluateManagedConfig(raw, process.env).refusals.map((r) => r.key).sort())
      .toEqual(['agents.*.credential', 'agents.*.endpoint']);
    expect(evaluateManagedConfig(raw, process.env, 'control-plane').refusals).toEqual([]);
    expect(editableConfigKeys()).toEqual(expect.arrayContaining(['agents.*.endpoint', 'agents.*.credential']));
  });

  test('the Configuration page saves one, and the daemon runs on it', async () => {
    expect(validateProjectConfigText(PROFILES)).toEqual({ ok: true, issues: [] });
    const applied = await applyProjectConfig(root, PROFILES);
    expect(applied.applied).toBe(true);
    // A new profile with its own endpoint changes the proxy's routes.
    expect(applied.restartRequired.length).toBeGreaterThan(0);
    const config = await loadConfig(root);
    expect(config.agents?.['claude-gw']).toMatchObject({ endpoint: 'https://gw.example.com' });
  });

  // INVARIANT: on a managed host a project-chosen endpoint never receives the
  // host's own credential — not from its store, not from its environment. Only
  // a member's credential connected for the profile pays for it.
  test('a pinned endpoint gets nothing from the host', async () => {
    await applyProjectConfig(root, PROFILES);
    process.env.LAZY_CREDENTIAL_GW_CLAUDE = 'host-secret';
    const { targets } = buildTargetCredentials(root, await loadConfig(root));
    const outcome = await targets.forTarget('https://gw.example.com');
    expect(outcome.kind).toBe('missing');
    expect(JSON.stringify(outcome)).not.toContain('host-secret');
  });
});
