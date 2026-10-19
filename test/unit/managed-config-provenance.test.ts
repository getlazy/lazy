/**
 * Which configuration a managed daemon is ACTUALLY on, and what an agent name
 * that configuration does not have is told.
 *
 * The incident (2026-10-06): a Teams task carried agent `claude-complex`, which
 * the fabricate repository's lazy.toml defined (added after Teams' one-time
 * import) but Teams' configuration never had. The engineer's Mac clone, bound
 * to Teams, validated `--agent` against its OWN lazy.toml and the daemon's
 * storage proxy wrote the name unchecked; the task only failed at launch, with
 * advice ("ask whoever runs it") that pointed nowhere.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm, mkdir, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from '../../src/config/loader';
import { MANAGED_CONFIG_ENV } from '../../src/config/managed';
import { agentProfileOrThrow, agentProfilesFor } from '../../src/config/agent-profiles';
import { agentTableNames } from '../../src/config/config-provenance';
import { applyProjectConfig, readProjectConfig } from '../../src/daemon/project-config';
import { handleStorageCall } from '../../src/daemon/rpc-handlers';
import { resetRunningProxy } from '../../src/daemon/proxy-fingerprint';

const ENV_KEYS = ['LAZY_MANAGED', 'LAZY_MANAGED_STORAGE_PATH', MANAGED_CONFIG_ENV, 'LAZY_CONFIG'];

const TEAMS_TOML = '[agents.security]\nharness = "claude-code"\nmodel = "claude-opus-5-5"\n';
const REPO_TOML = TEAMS_TOML + '\n[agents.claude-complex]\nharness = "claude-code"\nmodel = "claude-opus-5-5"\n';

let base: string;
let root: string;
let configPath: string;
let saved: Record<string, string | undefined>;

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  base = await realpath(await mkdtemp(join(tmpdir(), 'lazy-config-provenance-')));
  root = join(base, 'repo');
  await mkdir(root, { recursive: true });
  await mkdir(join(base, 'fleet', 'store'), { recursive: true });
  configPath = join(base, 'fleet', 'config', 'lazy.toml');
  process.env.LAZY_MANAGED = '1';
  process.env.LAZY_MANAGED_STORAGE_PATH = join(base, 'fleet', 'store');
  process.env[MANAGED_CONFIG_ENV] = configPath;
  await writeFile(join(root, 'lazy.toml'), REPO_TOML);
});

afterEach(async () => {
  resetRunningProxy();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(base, { recursive: true, force: true });
});

describe('the config in force is reported, never inferred', () => {
  // INVARIANT: the daemon reports the version its file was applied from, bound
  // to the bytes' hash. A control plane that infers "applied" from its own
  // bookkeeping cannot see a daemon running something else.
  test('an apply with a version is reported back with the file hash', async () => {
    const applied = await applyProjectConfig(root, TEAMS_TOML, 7);
    expect(applied.applied).toBe(true);
    const read = await readProjectConfig(root);
    expect(read.inForce.rule).toBe('managed');
    expect(read.inForce.path).toBe(configPath);
    expect(read.inForce.appliedVersion).toBe(7);
    expect(read.inForce.sha256).toBe(applied.sha256!);
  });

  // INVARIANT: a version is only claimed for the bytes it was applied with.
  test('a file changed behind the apply reports no version', async () => {
    await applyProjectConfig(root, TEAMS_TOML, 7);
    await writeFile(configPath, TEAMS_TOML + '\n# edited by hand\n');
    expect((await readProjectConfig(root)).inForce.appliedVersion).toBeNull();
  });

  test('before any apply, the repository lazy.toml is reported as the source', async () => {
    const read = await readProjectConfig(root);
    expect(read.inForce.rule).toBe('project-root');
    expect(read.inForce.appliedVersion).toBeNull();
  });
});

describe('an agent name the configuration in force does not have', () => {
  // INVARIANT: "Unknown agent profile" names the file and version it was
  // judged against and, when the repository's lazy.toml defines the profile
  // but the control plane's copy does not, says exactly that.
  test('names the repository definition and the control plane file actually loaded', async () => {
    await applyProjectConfig(root, TEAMS_TOML, 3);
    const config = await loadConfig(root);
    expect(() => agentProfileOrThrow(agentProfilesFor(config), 'security')).not.toThrow();
    let message = '';
    try {
      agentProfileOrThrow(agentProfilesFor(config), 'claude-complex', 'task x');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/Unknown agent profile "claude-complex"/);
    expect(message).toMatch(/repository's lazy\.toml defines \[agents\.claude-complex\]/);
    expect(message).toContain(configPath);
    expect(message).toMatch(/configuration version 3/);
    expect(message).not.toMatch(/ask whoever runs it/);
  });

  // INVARIANT: the daemon judges every agent name a client sends through the
  // storage proxy against ITS profiles. A bound clone's lazy.toml is the
  // repository's copy, so a client-side check is no check at all.
  test('the storage proxy refuses it on create and on an agent change', async () => {
    await applyProjectConfig(root, TEAMS_TOML, 3);
    await expect(handleStorageCall(root, {
      method: 'createTask', args: { goal: 'g', agentId: 'claude-complex' },
    })).rejects.toThrow(/Unknown agent profile "claude-complex"/);
    await expect(handleStorageCall(root, {
      method: 'updateTaskAgent', args: { taskId: 'whatever', agentId: 'claude-complex' },
    })).rejects.toThrow(/Unknown agent profile "claude-complex"/);
  });
});

// INVARIANT: provenance is diagnostics only — a repository lazy.toml that is
// not a regular file never fails (or hangs) a load of the control plane's file.
test('a repository lazy.toml that is a directory does not break a managed load', async () => {
  await applyProjectConfig(root, TEAMS_TOML, 3);
  await rm(join(root, 'lazy.toml'));
  await mkdir(join(root, 'lazy.toml'));
  const config = await loadConfig(root);
  expect(() => agentProfileOrThrow(agentProfilesFor(config), 'security')).not.toThrow();
});

test('agentTableNames reads bare and quoted [agents.*] headers', () => {
  expect(agentTableNames('[agents.a]\n[agents."b.c"]\n [ agents . d-e ]\n[agent]\n[agents_x]\n'))
    .toEqual(['a', 'b.c', 'd-e']);
});
