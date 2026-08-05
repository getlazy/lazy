/**
 * Regression tests for the daemon's single-writer storage singleton.
 *
 * INVARIANT: getOrCreateStorage() must return ONE shared Storage instance even
 * under concurrent first-callers. The web handler, the proxy, and reconcile ticks
 * all race to call it at startup; the pre-fix check-then-await let two callers both
 * pass `!daemonStorage` and each construct their own Storage, whose second lock
 * acquisition then contended for the filesystem lock — the single-writer violation
 * behind the "Failed to acquire storage lock" daemon crash (task proxy-policy-plane).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  initDaemonStorage,
  getOrCreateStorage,
  closeAllStorage,
} from '../../src/daemon/rpc-handlers';

describe('daemon storage singleton', () => {
  let root: string;
  let storeDir: string;
  let prevLazyConfig: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-daemon-storage-'));
    storeDir = join(root, 'store');
    // Minimal lazy.toml pointing storage at an isolated path so the test never
    // touches ~/.lazy or another project's store.
    const configPath = join(root, 'lazy.toml');
    await writeFile(
      configPath,
      `[storage]\nbackend = "external"\nexternal_path = "${storeDir}"\n`,
    );
    // The in-process test cwd is the dev repo, so loadConfig would otherwise pick
    // up lazy-dev's own lazy.toml. Pin it to this temp config via LAZY_CONFIG.
    prevLazyConfig = process.env.LAZY_CONFIG;
    process.env.LAZY_CONFIG = configPath;
  });

  afterEach(async () => {
    await closeAllStorage();
    if (prevLazyConfig === undefined) delete process.env.LAZY_CONFIG;
    else process.env.LAZY_CONFIG = prevLazyConfig;
    await rm(root, { recursive: true, force: true });
  });

  test('concurrent first-callers share ONE storage instance', async () => {
    initDaemonStorage(root);

    // Fire many concurrent callers before any has resolved — the race window the
    // fix closes. All must resolve to the exact same object reference.
    const instances = await Promise.all(
      Array.from({ length: 8 }, () => getOrCreateStorage()),
    );

    const first = instances[0];
    for (const inst of instances) {
      expect(inst).toBe(first);
    }

    // A later call returns the same cached instance too.
    expect(await getOrCreateStorage()).toBe(first);
  });

  test('after close, a fresh call re-initializes cleanly', async () => {
    initDaemonStorage(root);
    const a = await getOrCreateStorage();
    await closeAllStorage();
    const b = await getOrCreateStorage();
    // A brand-new instance after close (the memo was cleared), and it works.
    expect(b).not.toBe(a);
    expect(typeof (b as any).getStoragePath).toBe('function');
  });
});
