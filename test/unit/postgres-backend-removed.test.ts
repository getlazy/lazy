import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from '../../src/config/loader';
import { POSTGRES_BACKEND_REMOVED } from '../../src/storage/index';

// INVARIANT: a config that still names the removed postgres backend must fail
// loud with migration guidance — never fall back silently to file storage.
describe('removed postgres storage backend', () => {
  let dir: string;
  const prevConfig = process.env.LAZY_CONFIG;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lazy-pg-removed-'));
    delete process.env.LAZY_CONFIG;
  });

  afterEach(async () => {
    if (prevConfig !== undefined) process.env.LAZY_CONFIG = prevConfig;
    else delete process.env.LAZY_CONFIG;
    await rm(dir, { recursive: true, force: true });
  });

  test('loadConfig rejects backend = "postgres" with the removal message', async () => {
    await writeFile(
      join(dir, 'lazy.toml'),
      `[storage]\nbackend = "postgres"\nexternal_path = "/tmp/stale-store"\n`,
    );

    let err: unknown;
    try {
      await loadConfig(dir);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain('Storage backend "postgres" was removed in v0.22');
    expect(message).toBe(POSTGRES_BACKEND_REMOVED);
  });
});
