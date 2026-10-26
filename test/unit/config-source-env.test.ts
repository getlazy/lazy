import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveConfigSource } from '../../src/config/loader';
import { isolateLazyEnv } from '../helpers/isolated-lazy-env';

isolateLazyEnv();

describe('config source environment', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'lazy-config-env-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  // INVARIANT: config resolution reads the current LAZY_CONFIG, never an
  // override captured when the module was imported by an outer agent process.
  test('a relative override can be selected and removed after import', async () => {
    process.env.LAZY_CONFIG = 'machine.toml';
    expect(await resolveConfigSource(root)).toEqual({ path: join(root, 'machine.toml'), rule: 'LAZY_CONFIG' });
    delete process.env.LAZY_CONFIG;
    expect(await resolveConfigSource(root)).toEqual({ path: join(root, 'lazy.toml'), rule: 'project-root' });
  });

  test('an absolute override can be removed without retaining its imported filename', async () => {
    process.env.LAZY_CONFIG = join(root, 'machine.toml');
    expect(await resolveConfigSource(root)).toEqual({ path: join(root, 'machine.toml'), rule: 'LAZY_CONFIG' });
    delete process.env.LAZY_CONFIG;
    expect(await resolveConfigSource(root)).toEqual({ path: join(root, 'lazy.toml'), rule: 'project-root' });
  });
});
