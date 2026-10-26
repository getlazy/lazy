/**
 * `[runner] type = "smolvm"` and the `[smolvm]` section: read from the project
 * root's lazy.toml, shape-checked at load, and taken away from a repository on
 * a managed host.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig, DEFAULT_CONFIG } from '../../src/config/loader';
import { findUnknownConfigKeys } from '../../src/config/schema';
import { MANAGED_POLICY } from '../../src/config/managed';
import { isContainerRunnerType, resolveRunnerType } from '../../src/config/types';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'lazy-smolvmcfg-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function load(body: string) {
  await mkdir(join(root, '.lazy'), { recursive: true });
  await writeFile(join(root, 'lazy.toml'), body, 'utf-8');
  return loadConfig(root);
}

describe('[runner] type = "smolvm"', () => {
  test('is a container runner, and an accepted alias', () => {
    expect(isContainerRunnerType('smolvm')).toBe(true);
    expect(resolveRunnerType(' SMOLVM ')).toBe('smolvm');
  });

  test('loads with its section', async () => {
    const config = await load(`[runner]\ntype = "smolvm"\n\n[smolvm]\nbinary = "/opt/smolvm/smolvm"\nimage = "/opt/lazy/daemon.tar"\ncpus = 6\nallow_cidrs = ["1.0.0.0/8"]\n`);
    expect(config.runner.type).toBe('smolvm');
    expect(config.smolvm).toEqual({ binary: '/opt/smolvm/smolvm', image: '/opt/lazy/daemon.tar', cpus: 6, memory_mib: 8192, storage_gib: 64, allow_cidrs: ['1.0.0.0/8'] });
  });

  test('defaults leave the section empty and the project unaffected', async () => {
    expect(DEFAULT_CONFIG.smolvm.binary).toBe('');
    expect(DEFAULT_CONFIG.smolvm.allow_cidrs).toEqual([]);
    expect((await load('[runner]\ntype = "docker"\n')).runner.type).toBe('docker');
  });

  test('every key is known to the unknown-key scan', () => {
    expect(findUnknownConfigKeys({ smolvm: { binary: '/a', image: '/b', cpus: 1, memory_mib: 1, storage_gib: 1, allow_cidrs: [] } })).toEqual([]);
  });

  test.each([
    ['binary = "smolvm"', /binary in lazy.toml \[smolvm\] section: expected an absolute path/],
    ['image = "daemon.tar"', /image in lazy.toml \[smolvm\] section: expected an absolute path/],
    ['cpus = 0', /cpus in lazy.toml \[smolvm\] section: expected a positive whole number/],
    ['memory_mib = 1.5', /memory_mib in lazy.toml \[smolvm\] section/],
    ['allow_cidrs = ["github.com"]', /allow_cidrs in lazy.toml \[smolvm\] section/],
  ])('refuses %s', async (line, message) => {
    await expect(load(`[smolvm]\n${line}\n`)).rejects.toThrow(message);
  });

  // INVARIANT: a repository on a managed host cannot pick a smolvm runner or
  // name a program for the host to run; every [smolvm] key is overridden.
  test('managed mode overrides every [smolvm] key', () => {
    for (const key of ['binary', 'image', 'cpus', 'memory_mib', 'storage_gib', 'allow_cidrs']) {
      expect(MANAGED_POLICY[`smolvm.${key}`]?.disposition).toBe('overridden');
    }
    const c = structuredClone(DEFAULT_CONFIG);
    c.smolvm.binary = '/evil';
    MANAGED_POLICY['smolvm.binary']!.apply!(c, { runner: 'docker' } as never);
    expect(c.smolvm.binary).toBe('');
  });
});
