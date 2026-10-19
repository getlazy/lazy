/**
 * Pre-upgrade store backups, end to end: a real daemon starting on a new
 * version backs the store up before it opens it, a backup that fails refuses
 * the start, and the CLI lists, takes and restores them.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { readFile, readdir, writeFile, rm, mkdir } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { storageDirFor } from '../helpers/storage';
import { getDaemonDir } from '../../src/daemon/paths';
import { ARCHIVE_FILE, backupsDirFor, restoreMarkerPathFor } from '../../src/storage/store-backup';
import { unpackArchive } from '../../src/storage/store-archive';
import { startForeignProcess } from '../helpers/foreign-process';
import { processNamespaceId } from '../../src/utils/process-identity';
import { VERSION } from '../../src/version';

let ctx: TestContext | null = null;

afterEach(async () => {
  if (ctx) await ctx.cleanup();
  ctx = null;
});

async function pretendPreviousStartWas(root: string, version: string): Promise<void> {
  await writeFile(join(getDaemonDir(root), 'daemon-last-version.json'), JSON.stringify({ version }) + '\n');
}

async function backupNames(store: string): Promise<string[]> {
  return (await readdir(backupsDirFor(store)).catch(() => [] as string[])).sort();
}

describe('daemon start on a new version', () => {
  // INVARIANT: new lazy code never opens an existing store before a verified
  // backup of it exists. The store is the product's data; an upgrade is the
  // moment new code first reads and migrates it.
  test('backs the store up before opening it, once per upgrade', async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    const created = await ctx.lazy(['create', '--goal', 'A task worth keeping', '--prompt', 'p']);
    expect(created.exitCode).toBe(0);
    const store = storageDirFor(ctx.root);

    await pretendPreviousStartWas(ctx.root, '0.0.1');
    await ctx.restartDaemon();
    const names = await backupNames(store);
    expect(names).toHaveLength(1);
    expect(names[0]).toContain(`-0.0.1-to-${VERSION.replace(/[^A-Za-z0-9._+]/g, '_')}`);
    // One compressed archive per backup, holding the store.
    expect((await readdir(join(backupsDirFor(store), names[0]))).sort()).toEqual(['manifest.json', ARCHIVE_FILE]);
    const unpackedDir = join(ctx.root, '..', `unpacked-${Date.now()}`);
    await mkdir(unpackedDir);
    await unpackArchive(join(backupsDirFor(store), names[0], ARCHIVE_FILE), unpackedDir);
    const backedUpTasks = await readdir(join(unpackedDir, 'tasks'));
    await rm(unpackedDir, { recursive: true, force: true });
    expect(backedUpTasks.length).toBeGreaterThan(0);

    // The marker now says this version: an ordinary restart takes nothing.
    await ctx.restartDaemon();
    expect(await backupNames(store)).toHaveLength(1);

    const listed = await ctx.lazy(['system', 'store-backups', '--json']);
    expect(listed.exitCode).toBe(0);
    const payload = JSON.parse(listed.stdout);
    expect(payload.backups[0].status).toBe('ok');
  }, 120_000);

  // INVARIANT: no backup, no new daemon. A start whose backup fails is refused
  // with the store untouched, and the only way past it is an explicit bypass.
  test('refuses to start when the backup fails; LAZY_SKIP_STORE_BACKUP=1 bypasses it', async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    expect((await ctx.lazy(['create', '--goal', 'Another task', '--prompt', 'p'])).exitCode).toBe(0);
    const store = storageDirFor(ctx.root);
    // A FILE where the backups directory must go: mkdir fails.
    await writeFile(backupsDirFor(store), 'not a directory');

    await pretendPreviousStartWas(ctx.root, '0.0.1');
    await expect(ctx.restartDaemon()).rejects.toThrow();
    const log = await readFile(join(getDaemonDir(ctx.root), 'test-startup.log'), 'utf-8').catch(() => '');
    const daemonLog = await readFile(join(getDaemonDir(ctx.root), 'daemon.log'), 'utf-8').catch(() => '');
    expect(log + daemonLog).toContain('store backup taken before every upgrade failed');

    await ctx.restartDaemon({ LAZY_SKIP_STORE_BACKUP: '1' });
    expect((await ctx.lazy(['list'])).exitCode).toBe(0);
  }, 120_000);
});

describe('daemon start during a store restore', () => {
  // INVARIANT: a daemon never opens a store a restore is swapping. Any `lazy`
  // command can auto-start the daemon; mid-restore it must refuse, not have the
  // store renamed out from under it.
  test('refuses while a live restore holds the store, and starts once it is gone', async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    expect((await ctx.lazy(['create', '--goal', 'Restore target', '--prompt', 'p'])).exitCode).toBe(0);
    const store = storageDirFor(ctx.root);
    const holder = await startForeignProcess(ctx.root, 'lazy-store-restore-stand-in');
    try {
      await writeFile(restoreMarkerPathFor(store), JSON.stringify({
        pid: holder.pid,
        holder_started_at: holder.identity.started,
        holder_start_source: holder.identity.startedSource,
        started_at: new Date().toISOString(),
        backup: 'some-backup',
        staging: `${store}.restoring-x`,
        moved_aside_to: `${store}.before-restore-x`,
      }));
      await expect(ctx.restartDaemon()).rejects.toThrow();
      const log = await readFile(join(getDaemonDir(ctx.root), 'test-startup.log'), 'utf-8').catch(() => '');
      const daemonLog = await readFile(join(getDaemonDir(ctx.root), 'daemon.log'), 'utf-8').catch(() => '');
      expect(log + daemonLog).toContain('a store restore is running');
    } finally {
      holder.kill();
      await rm(restoreMarkerPathFor(store), { force: true });
    }
    await ctx.restartDaemon();
    expect((await ctx.lazy(['list'])).exitCode).toBe(0);
  }, 120_000);
});

describe('daemon start against a store held from another pid namespace', () => {
  // INVARIANT: a daemon — like a Lazy Teams project machine's — refuses to open
  // a store whose restore marker was written in another machine or pid
  // namespace: it cannot judge that pid, so "no such process here" is not
  // "stale". A leftover foreign LOCK alone does not wedge it.
  test('refuses on a foreign restore marker; a foreign lock alone does not wedge it', async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    expect((await ctx.lazy(['create', '--goal', 'Guest store', '--prompt', 'p'])).exitCode).toBe(0);
    const store = storageDirFor(ctx.root);
    const foreign = 'linux:00000000-host-boot:pid:[4026531836]';
    await writeFile(restoreMarkerPathFor(store), JSON.stringify({
      pid: 999_999, holder_namespace: foreign, holder_guest: true, started_at: new Date().toISOString(), backup: 'some-backup',
      staging: '/host/store.restoring-x', moved_aside_to: '/host/store.before-restore-x',
    }));
    try {
      await expect(ctx.restartDaemon()).rejects.toThrow();
      const log = await readFile(join(getDaemonDir(ctx.root), 'test-startup.log'), 'utf-8').catch(() => '');
      const daemonLog = await readFile(join(getDaemonDir(ctx.root), 'daemon.log'), 'utf-8').catch(() => '');
      expect(log + daemonLog).toContain('another machine or pid namespace');
    } finally {
      await rm(restoreMarkerPathFor(store), { force: true });
    }
    // The daemon is down now; a lock its machine's daemon left behind.
    await writeFile(join(store, '.storage-lock'), JSON.stringify({ pid: 999_999, acquired_at: new Date().toISOString(), holder_namespace: foreign }));
    await ctx.restartDaemon();
    expect((await ctx.lazy(['list'])).exitCode).toBe(0);
  }, 120_000);
});

describe('daemon start after a reboot', () => {
  // INVARIANT: a storage lock left by this machine before a reboot or crash
  // (another boot id) never stops a daemon starting — not even one starting on
  // a new version, whose store backup takes the lock refusing foreign holders.
  // Only a project machine's lock, seen from the host, is foreign.
  test.skipIf(process.platform !== 'linux')('starts on a new version over an earlier boot\'s lock, backing the store up', async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    expect((await ctx.lazy(['create', '--goal', 'Survives a reboot', '--prompt', 'p'])).exitCode).toBe(0);
    const store = storageDirFor(ctx.root);
    // Bring the daemon down and keep it down: one failed start (no room for backups).
    await writeFile(backupsDirFor(store), 'not a directory');
    await pretendPreviousStartWas(ctx.root, '0.0.1');
    await expect(ctx.restartDaemon()).rejects.toThrow();
    await rm(backupsDirFor(store), { force: true });
    // What a crash before the reboot left behind: a lock from another boot, its
    // pid now naming a live process here.
    const ns = (await processNamespaceId())!.replace(/^linux:[^:]+:/, '');
    await writeFile(join(store, '.storage-lock'), JSON.stringify({
      pid: process.pid, acquired_at: '2026-01-01T00:00:00Z', holder_namespace: `linux:00000000-earlier-boot:${ns}`,
    }));
    await ctx.restartDaemon();
    expect(await backupNames(store)).toHaveLength(1);
    expect((await ctx.lazy(['list'])).exitCode).toBe(0);
  }, 120_000);
});

describe('lazy system store-backup / store-restore', () => {
  test('takes a backup of a named store and restores it with the old one moved aside', async () => {
    ctx = await setupTestLazy();
    const store = join(ctx.root, '..', `standalone-store-${Date.now()}`);
    await mkdir(join(store, 'tasks', 't1'), { recursive: true });
    await writeFile(join(store, 'tasks', 't1', 'task.json'), '{"goal":"original"}');
    try {
      const taken = await ctx.lazy(['system', 'store-backup', '--store', store, '--writer-stopped', '--from', '1', '--to', '2', '--json']);
      expect(taken.exitCode).toBe(0);
      const backup = JSON.parse(taken.stdout).backup;
      expect(backup.status).toBe('ok');
      expect(backup.format).toBe('archive');
      expect(backup.stored_bytes).toBeGreaterThan(0);
      const listed = await ctx.lazy(['system', 'store-backups', '--store', store]);
      expect(listed.stdout).toMatch(/compressed/);

      await writeFile(join(store, 'tasks', 't1', 'task.json'), '{"goal":"damaged"}');
      const restored = await ctx.lazy(['system', 'store-restore', backup.name, '--store', store, '--yes']);
      expect(restored.exitCode).toBe(0);
      expect(await readFile(join(store, 'tasks', 't1', 'task.json'), 'utf-8')).toBe('{"goal":"original"}');
      const siblings = await readdir(join(store, '..'));
      expect(siblings.some(n => n.startsWith(`${store.split('/').pop()}.before-restore-`))).toBe(true);
    } finally {
      const parent = join(store, '..');
      const base = store.split('/').pop()!;
      for (const n of await readdir(parent)) if (n.startsWith(base)) await rm(join(parent, n), { recursive: true, force: true });
    }
  }, 60_000);
});
