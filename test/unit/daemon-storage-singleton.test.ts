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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  initDaemonStorage,
  getOrCreateStorage,
  openProjectStorage,
  closeAllStorage,
  daemonStoreLockHold,
} from '../../src/daemon/rpc-handlers';
import { createShowHandler } from '../../src/mcp/tools';
import { buildStorageLockRow } from '../../src/daemon/daemon-health-rows';

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

describe('the daemon keeps its storage lock while borrowers close its storage', () => {
  let root: string;
  let storeDir: string;
  let prevLazyConfig: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-daemon-storage-lock-'));
    storeDir = join(root, 'store');
    const configPath = join(root, 'lazy.toml');
    await writeFile(configPath, `[storage]\nbackend = "external"\nexternal_path = "${storeDir}"\n`);
    prevLazyConfig = process.env.LAZY_CONFIG;
    process.env.LAZY_CONFIG = configPath;
  });

  afterEach(async () => {
    await closeAllStorage();
    if (prevLazyConfig === undefined) delete process.env.LAZY_CONFIG;
    else process.env.LAZY_CONFIG = prevLazyConfig;
    await rm(root, { recursive: true, force: true });
  });

  async function lockHolder(): Promise<number | null> {
    try {
      return (JSON.parse(await readFile(join(storeDir, '.storage-lock'), 'utf-8')) as { pid: number }).pid;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  // INVARIANT: closing the daemon's storage handle from a borrower — an MCP tool
  // handler's `finally { storage.close() }`, which every one of them has — never
  // gives up the lock the daemon holds for its whole life. Only closeAllStorage
  // (daemon shutdown) may. When close() started releasing the lock, the first
  // `lazy_*` call of any agent turn deleted `.storage-lock`: every write still
  // took the lock for itself, so nothing visibly broke, but between writes a
  // second daemon could open the store, and `lazy daemon health` (and every Lazy
  // Teams project page) reported "Storage lock" failing for the daemon's life.
  test('a borrower closing the storage leaves the lock held by this daemon', async () => {
    initDaemonStorage(root);
    const storage = await getOrCreateStorage();
    expect(await lockHolder()).toBe(process.pid);

    await storage.close();
    expect(await lockHolder()).toBe(process.pid);

    // Writes after the borrower's close still leave the lock in place.
    await storage.createTask('after a borrower closed the handle');
    expect(await lockHolder()).toBe(process.pid);

    await closeAllStorage();
    expect(await lockHolder()).toBeNull();
  });

  // INVARIANT: the health check asks whether the daemon still has its LIFELONG
  // hold, never whether the lock is held at this instant. Once that hold is lost
  // every write still takes the lock for its own duration, so a health sample
  // taken mid-write used to read "held" and the Storage lock row said OK — the
  // regression it exists to catch (2026-10-20) was invisible to it exactly then.
  test('a lost lifelong hold reads as released even while a write holds the lock', async () => {
    initDaemonStorage(root);
    const storage = await getOrCreateStorage();
    expect(daemonStoreLockHold()).toBe('held');

    // The original bug: the owned store's lock given up entirely, as a
    // borrower's close() on the owned FileStorage did.
    const lock = (storage as unknown as { lock: { releaseAll(): void; withLock<T>(fn: () => Promise<T>): Promise<T> } }).lock;
    lock.releaseAll();

    await lock.withLock(async () => {
      expect(await lockHolder()).toBe(process.pid);
      const hold = daemonStoreLockHold();
      expect(hold).toBe('released');
      const lockPath = join(storeDir, '.storage-lock');
      const row = buildStorageLockRow(
        { kind: 'held', lockPath, pid: process.pid, acquiredAt: null, verdict: { alive: true } },
        process.pid,
        Date.now(),
        hold,
      );
      expect(row.state).toBe('fail');
    });
  });

  test('an MCP tool handler run in the daemon leaves the lock held', async () => {
    initDaemonStorage(root);
    const storage = await getOrCreateStorage();
    const task = await storage.createTask('shown over MCP');
    const show = createShowHandler({ taskId: '', worktreePath: root, storage });
    await show({ task_id: task.id });
    expect(await lockHolder()).toBe(process.pid);
  });
});

describe('the daemon reports a store it could not open', () => {
  let root: string;
  let storeDir: string;
  let prevLazyConfig: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-daemon-storage-open-failed-'));
    storeDir = join(root, 'store');
    const configPath = join(root, 'lazy.toml');
    await writeFile(configPath, `[storage]\nbackend = "external"\nexternal_path = "${storeDir}"\n`);
    prevLazyConfig = process.env.LAZY_CONFIG;
    process.env.LAZY_CONFIG = configPath;
  });

  afterEach(async () => {
    await closeAllStorage();
    if (prevLazyConfig === undefined) delete process.env.LAZY_CONFIG;
    else process.env.LAZY_CONFIG = prevLazyConfig;
    await rm(root, { recursive: true, force: true });
  });

  // INVARIANT: daemon storage errors retain both the configured and resolved
  // paths. Explicit options must not erase the spelling a person can fix.
  test.each(['singleton', 'fresh'] as const)('%s storage open reports the relative configured path', async (mode) => {
    await writeFile(join(root, 'lazy.toml'), '[storage]\nbackend = "external"\nexternal_path = "./store"\n');
    await writeFile(storeDir, 'not a directory');
    initDaemonStorage(root);
    const open = mode === 'singleton' ? getOrCreateStorage() : openProjectStorage(root);
    await expect(open).rejects.toThrow(`Cannot open storage "./store" (resolved to "${storeDir}")`);
  });

  // INVARIANT: a failed open is reported as such (with its error), never as
  // "not opened yet" — and a restore owning the store is not restart-fixable.
  test('a restore in progress is an open failure a restart does not fix', async () => {
    await mkdir(storeDir, { recursive: true });
    await writeFile(join(storeDir, '.restore-in-progress'), '{}\n');
    initDaemonStorage(root);
    expect(daemonStoreLockHold()).toBe('not-open');
    await expect(getOrCreateStorage()).rejects.toThrow();
    const hold = daemonStoreLockHold();
    expect(typeof hold).toBe('object');
    if (typeof hold !== 'object') throw new Error('unreachable');
    expect(hold.openFailed.error).toContain('restore');
    expect(hold.openFailed.restartFixes).toBe(false);
  });
});
