import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rename, rm, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig } from '../../src/config/loader';
import { enableLastKnownGood, lastKnownGoodState, resetLastKnownGood } from '../../src/config/last-good';
import { buildTargetCredentials } from '../../src/proxy/credential-deps';
import { createLiveProxyRouting } from '../../src/daemon/live-proxy-routing';

const initialText = [
  '[agents.staging]',
  'harness = "claude-code"',
  'model = "claude-sonnet-4-6"',
  'endpoint = "https://old.example.com"',
  'credential = "none"',
].join('\n');

describe('live proxy routing', () => {
  let root: string | null = null;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = null;
    resetLastKnownGood();
  });

  test('retains stable snapshots, refreshes changed routes and credential targets, and survives bad edits', async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-live-proxy-'));
    enableLastKnownGood();
    const path = join(root, 'lazy.toml');
    await writeFile(path, initialText);
    const initial = await loadConfig(root);
    const routeForRequest = await createLiveProxyRouting(root, initial, buildTargetCredentials(root, initial).targets);
    const before = await routeForRequest();
    expect(before.routes.staging?.upstream).toBe('https://old.example.com');
    expect(await routeForRequest()).toBe(before);

    const newText = initialText
      .replace('https://old.example.com', 'https://api.fireworks.ai/inference')
      .replace('credential = "none"', 'credential = "fireworks"');
    const replacement = join(root, 'next.toml');
    await writeFile(replacement, newText);
    await rename(replacement, path);
    const changed = await routeForRequest();
    expect(changed).not.toBe(before);
    expect(changed.routes.staging?.upstream).toBe('https://api.fireworks.ai/inference');
    expect(changed.targets.has('https://api.fireworks.ai')).toBe(true);
    expect(changed.targets.has('https://old.example.com')).toBe(false);
    expect(await routeForRequest()).toBe(changed);

    await writeFile(path, '[agents.staging\n');
    expect(await routeForRequest()).toBe(changed);
    expect(lastKnownGoodState(path)).not.toBeNull();
    expect(await routeForRequest()).toBe(changed);

    await unlink(path);
    expect(await routeForRequest()).toBe(changed);

    await writeFile(path, initialText);
    const recovered = await routeForRequest();
    expect(recovered.routes.staging?.upstream).toBe('https://old.example.com');
    expect(recovered.targets.has('https://api.fireworks.ai')).toBe(false);
    expect(lastKnownGoodState(path)).toBeNull();
  });

  test('a valid startup route survives its config file disappearing before the first request', async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-live-proxy-'));
    const path = join(root, 'lazy.toml');
    await writeFile(path, initialText);
    const initial = await loadConfig(root);
    const routeForRequest = await createLiveProxyRouting(root, initial, buildTargetCredentials(root, initial).targets);
    await unlink(path);
    const retained = await routeForRequest();
    expect(retained.routes.staging?.upstream).toBe('https://old.example.com');
    expect(await routeForRequest()).toBe(retained);
    await writeFile(path, initialText.replace('https://old.example.com', 'https://recovered.example.com'));
    expect((await routeForRequest()).routes.staging?.upstream).toBe('https://recovered.example.com');
  });

  test('bad edit -> old routes keep serving, including when the config path changes', async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-live-proxy-'));
    const managedRoot = await mkdtemp(join(tmpdir(), 'lazy-live-proxy-managed-'));
    const previousManagedPath = process.env.LAZY_MANAGED_CONFIG_PATH;
    try {
      enableLastKnownGood();
      await writeFile(join(root, 'lazy.toml'), initialText);
      const initial = await loadConfig(root);
      const routeForRequest = await createLiveProxyRouting(root, initial, buildTargetCredentials(root, initial).targets);
      expect((await routeForRequest()).routes.staging?.upstream).toBe('https://old.example.com');

      const managedPath = join(managedRoot, 'lazy.toml');
      process.env.LAZY_MANAGED_CONFIG_PATH = managedPath;
      expect((await routeForRequest()).routes.staging?.upstream).toBe('https://old.example.com');
      await writeFile(managedPath, initialText.replace('https://old.example.com', 'https://managed.example.com'));
      expect((await loadConfig(root)).agents.staging?.endpoint).toBe('https://managed.example.com');
      await writeFile(managedPath, '[agents.staging\n');
      await loadConfig(root);
      expect(lastKnownGoodState(managedPath)).not.toBeNull();
      const retained = await routeForRequest();
      expect(retained.routes.staging?.upstream).toBe('https://old.example.com');
      expect(await routeForRequest()).toBe(retained);

      await writeFile(managedPath, initialText.replace('https://old.example.com', 'https://recovered.example.com'));
      expect((await routeForRequest()).routes.staging?.upstream).toBe('https://recovered.example.com');
      expect(lastKnownGoodState(managedPath)).toBeNull();
    } finally {
      if (previousManagedPath === undefined) delete process.env.LAZY_MANAGED_CONFIG_PATH;
      else process.env.LAZY_MANAGED_CONFIG_PATH = previousManagedPath;
      await rm(managedRoot, { recursive: true, force: true });
    }
  });

  test('a removed profile stays empty even if its name is added back before restart', async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-live-proxy-'));
    const path = join(root, 'lazy.toml');
    await writeFile(path, initialText);
    const initial = await loadConfig(root);
    const routeForRequest = await createLiveProxyRouting(root, initial, buildTargetCredentials(root, initial).targets);
    await routeForRequest();
    await writeFile(path, '[agents.other]\nharness = "claude-code"\nmodel = "claude-sonnet-4-6"\nendpoint = "https://other.example.com"\ncredential = "none"\n');
    expect((await routeForRequest()).profiles.has('staging')).toBe(false);
    await writeFile(path, initialText);
    const restored = await routeForRequest();
    expect(restored.profiles.has('staging')).toBe(false);
    expect(restored.routes.staging).toBeUndefined();
  });

  test('retains the last applied route when a valid config has conflicting credential targets', async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-live-proxy-'));
    const path = join(root, 'lazy.toml');
    await writeFile(path, initialText);
    const initial = await loadConfig(root);
    const routeForRequest = await createLiveProxyRouting(root, initial, buildTargetCredentials(root, initial).targets);
    const before = await routeForRequest();
    await writeFile(path, initialText.replace('https://old.example.com', 'https://api.anthropic.com/local'));
    expect(await routeForRequest()).toBe(before);
    await writeFile(path, initialText.replace('https://old.example.com', 'https://another.example.com'));
    expect((await routeForRequest()).routes.staging?.upstream).toBe('https://another.example.com');
  });
});

describe('live proxy routing content keying', () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
    resetLastKnownGood();
  });

  // INVARIANT: routes reload on the CONTENT of lazy.toml and its applied record, not file stat. A record-only change must be seen.
  test('an applied-record-only change is picked up, and a mid-write pair settles', async () => {
    dir = await mkdtemp(join(tmpdir(), 'lazy-live-proxy-'));
    const path = join(dir, 'lazy.toml');
    await writeFile(path, initialText);
    const initial = await loadConfig(dir);
    const route = await createLiveProxyRouting(dir, initial, buildTargetCredentials(dir, initial).targets, { mismatchGraceMs: 60_000 });
    const first = await route();
    expect(await route()).toBe(first);
    const { sha256Text } = await import('../../src/config/config-provenance');
    const record = (sha: string) => JSON.stringify({ version: 2, sha256: sha, appliedAt: 'now', origin: 'control-plane' });
    // record-only change: file bytes untouched
    await writeFile(`${path}.applied.json`, record(sha256Text(initialText)));
    const afterRecord = await route();
    expect(afterRecord).not.toBe(first);
    expect(afterRecord.routes.staging?.upstream).toBe('https://old.example.com');

    // mid-write: new file text, record still names the old text -> held one tick, then applied
    const next = initialText.replace('https://old.example.com', 'https://new.example.com');
    await writeFile(path, next);
    expect(await route()).toBe(afterRecord);
    expect(await route()).toBe(afterRecord); // back-to-back requests still hold
    expect((await route()).profiles.has('staging')).toBe(true);
    await writeFile(`${path}.applied.json`, record(sha256Text(next)));
    const settled = await route();
    expect(settled.routes.staging?.upstream).toBe('https://new.example.com');
    expect(settled.profiles.has('staging')).toBe(true);
  });

  test('a record that stays stale is applied once the grace period passes', async () => {
    dir = await mkdtemp(join(tmpdir(), 'lazy-live-proxy-'));
    const path = join(dir, 'lazy.toml');
    await writeFile(path, initialText);
    const initial = await loadConfig(dir);
    const route = await createLiveProxyRouting(dir, initial, buildTargetCredentials(dir, initial).targets, { mismatchGraceMs: 20 });
    await route();
    await writeFile(`${path}.applied.json`, JSON.stringify({ version: 1, sha256: 'stale', appliedAt: 'now', origin: 'control-plane' }));
    await writeFile(path, initialText.replace('https://old.example.com', 'https://late.example.com'));
    const held = await route();
    expect(held.routes.staging?.upstream).toBe('https://old.example.com');
    await new Promise((r) => setTimeout(r, 40));
    expect((await route()).routes.staging?.upstream).toBe('https://late.example.com');
  });
});
