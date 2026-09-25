import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from '../../src/config/loader';

describe('[server] dashboard_url', () => {
  let root: string;
  let previousConfig: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-dashboard-url-'));
    previousConfig = process.env.LAZY_CONFIG;
    process.env.LAZY_CONFIG = join(root, 'lazy.toml');
  });

  afterEach(async () => {
    if (previousConfig === undefined) delete process.env.LAZY_CONFIG;
    else process.env.LAZY_CONFIG = previousConfig;
    await rm(root, { recursive: true, force: true });
  });

  async function load(value: string) {
    await writeFile(join(root, 'lazy.toml'), `[server]\ndashboard_url = ${JSON.stringify(value)}\n`);
    return loadConfig(root);
  }

  test('normalizes an exact HTTP(S) origin', async () => {
    expect((await load('https://Example.NGROK.app:443')).server.dashboard_url)
      .toBe('https://example.ngrok.app');
  });

  test.each([
    '',
    'ftp://example.com',
    'https://user:pass@example.com',
    'https://example.com/dashboard',
    'https://example.com/?token=secret',
    'https://example.com/#fragment',
  ])('rejects a value that is not an exact HTTP(S) origin: %s', async (value) => {
    await expect(load(value)).rejects.toThrow(/dashboard_url/);
  });

  // The shapes a person pastes from a browser address bar or a tunnel's banner
  // all mean the same origin, and the port is part of it.
  test.each([
    ['https://lazy.example.com/', 'https://lazy.example.com'],
    ['https://lazy.example.com:8443', 'https://lazy.example.com:8443'],
    ['http://lazy.example.com', 'http://lazy.example.com'],
    ['http://my-mac.tailnet.ts.net:26024/', 'http://my-mac.tailnet.ts.net:26024'],
  ])('keeps %s as the origin %s', async (value, origin) => {
    expect((await load(value)).server.dashboard_url).toBe(origin);
  });

  // The daemon refuses to start on a config that fails here, so the message is
  // all the person who edited it has: it must say which file, which key, what
  // they wrote, and what would be accepted.
  test('a refusal names the file, the key, the value and an example', async () => {
    const error = await load('lazy.example.com/dashboard').then(
      () => { throw new Error('expected the load to fail'); },
      (err: Error) => err,
    );
    expect(error.message).toContain(join(root, 'lazy.toml'));
    expect(error.message).toContain('[server] dashboard_url');
    expect(error.message).toContain('lazy.example.com/dashboard');
    expect(error.message).toContain('https://lazy.example.com');
  });
});
