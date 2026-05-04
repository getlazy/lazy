import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from '../../src/config/loader';
import { expandTilde, getHome } from '../../src/utils/home';

// INVARIANT: `~/...` in lazy.toml is a valid, user-facing format. The config
// loader MUST expand it to $HOME before handing the value to downstream code
// that performs filesystem operations. Without expansion, mkdir/writeFile/join
// treat `~` as a literal directory name and create `<cwd>/~/.lazy/...`.

describe('tilde expansion in config', () => {
  let dir: string;
  const prevConfig = process.env.LAZY_CONFIG;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lazy-tilde-'));
    delete process.env.LAZY_CONFIG;
  });

  afterEach(async () => {
    if (prevConfig !== undefined) process.env.LAZY_CONFIG = prevConfig;
    else delete process.env.LAZY_CONFIG;
    await rm(dir, { recursive: true, force: true });
  });

  test('expandTilde expands leading ~/', () => {
    const home = getHome();
    expect(expandTilde('~/.lazy/foo')).toBe(`${home}/.lazy/foo`);
    expect(expandTilde('~')).toBe(home);
  });

  test('expandTilde leaves other paths unchanged', () => {
    expect(expandTilde('/absolute/path')).toBe('/absolute/path');
    expect(expandTilde('relative/path')).toBe('relative/path');
    expect(expandTilde('')).toBe('');
    // No mid-path expansion
    expect(expandTilde('/a/~/b')).toBe('/a/~/b');
    // No ~user expansion
    expect(expandTilde('~bob/foo')).toBe('~bob/foo');
  });

  test('loadConfig expands ~ in storage.external_path', async () => {
    await writeFile(
      join(dir, 'lazy.toml'),
      `[storage]\nbackend = "external"\nexternal_path = "~/.lazy/tilde-test"\n`,
    );
    const config = await loadConfig(dir, { cwd: dir });
    expect(config.storage.external_path).toBe(`${getHome()}/.lazy/tilde-test`);
    // And NOT the literal form that would create <cwd>/~/...
    expect(config.storage.external_path.startsWith('~')).toBe(false);
  });

  test('loadConfig leaves absolute external_path unchanged', async () => {
    await writeFile(
      join(dir, 'lazy.toml'),
      `[storage]\nbackend = "external"\nexternal_path = "/tmp/explicit-abs"\n`,
    );
    const config = await loadConfig(dir, { cwd: dir });
    expect(config.storage.external_path).toBe('/tmp/explicit-abs');
  });

  test('loadConfig leaves empty external_path empty (default path resolution kicks in elsewhere)', async () => {
    await writeFile(
      join(dir, 'lazy.toml'),
      `[storage]\nbackend = "external"\nexternal_path = ""\n`,
    );
    const config = await loadConfig(dir, { cwd: dir });
    expect(config.storage.external_path).toBe('');
  });
});
