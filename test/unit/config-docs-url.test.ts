import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig, DEFAULT_CONFIG } from '../../src/config/loader';
import { DEFAULT_DOCS_URL, getDocsBaseUrl, resetDocsBaseUrl } from '../../src/docs/links';
import { pinConfig } from '../helpers/pin-config';

/**
 * The `[docs] url` config surface and its installation into the process.
 *
 * INVARIANT: doc pointers are built deep inside guards and thrown errors that
 * never see a ResolvedConfig, so the base URL is INSTALLED by loadConfig()
 * rather than read from config at each call site. If loadConfig stops
 * installing it, a configured mirror silently stops applying to every error
 * message in the CLI — which is exactly the failure this test exists to catch.
 */
describe('[docs] url config', () => {
  let root: string;
  let restoreConfig: () => void;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-docs-url-'));
    // Without this, loadConfig walks up from process.cwd() — lazy's OWN
    // worktree under `bun test` — and reads the developer's lazy.toml instead
    // of the fixture (see test/helpers/pin-config.ts).
    restoreConfig = pinConfig(root);
    resetDocsBaseUrl();
  });

  afterEach(async () => {
    restoreConfig();
    resetDocsBaseUrl();
    await rm(root, { recursive: true, force: true });
  });

  async function writeConfig(body: string): Promise<void> {
    await writeFile(join(root, 'lazy.toml'), body, 'utf-8');
  }

  test('defaults to the hosted docs domain', () => {
    expect(DEFAULT_CONFIG.docs.url).toBe(DEFAULT_DOCS_URL);
  });

  test('a config with no [docs] section resolves and installs the default', async () => {
    await writeConfig('[models]\ndefault = "claude-opus-4-8"\n');
    const config = await loadConfig(root);
    expect(config.docs.url).toBe(DEFAULT_DOCS_URL);
    expect(getDocsBaseUrl()).toBe(DEFAULT_DOCS_URL);
  });

  test('a configured mirror is resolved and installed', async () => {
    await writeConfig('[docs]\nurl = "https://docs.acme.internal/lazy/"\n');
    const config = await loadConfig(root);
    expect(config.docs.url).toBe('https://docs.acme.internal/lazy');
    expect(getDocsBaseUrl()).toBe('https://docs.acme.internal/lazy');
  });

  test('an empty url disables doc pointers', async () => {
    await writeConfig('[docs]\nurl = ""\n');
    const config = await loadConfig(root);
    expect(config.docs.url).toBe(null);
    expect(getDocsBaseUrl()).toBe(null);
  });

  test('url = false disables doc pointers', async () => {
    await writeConfig('[docs]\nurl = false\n');
    const config = await loadConfig(root);
    expect(config.docs.url).toBe(null);
    expect(getDocsBaseUrl()).toBe(null);
  });

  // INVARIANT: external surfaces validate their inputs and reject loudly. A
  // typo'd docs URL must fail at load, not degrade into "links never appear".
  test('an unusable url fails the config load with an actionable message', async () => {
    await writeConfig('[docs]\nurl = "docs.getlazy.dev"\n');
    await expect(loadConfig(root)).rejects.toThrow(/\[docs\]/);
  });

  test('a non-http scheme fails the config load', async () => {
    await writeConfig('[docs]\nurl = "file:///tmp/docs"\n');
    await expect(loadConfig(root)).rejects.toThrow(/not supported/);
  });
});
