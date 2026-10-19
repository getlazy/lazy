import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readdir, rm, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { backupStoreIfVersionChanged, backupStoreForUpgrade } from '../../src/daemon/upgrade-store-backup';
import { getDaemonDir } from '../../src/daemon/paths';
import { backupsDirFor } from '../../src/storage/store-backup';
import { processNamespaceId } from '../../src/utils/process-identity';

let base: string;
let root: string;
let store: string;
const saved: Record<string, string | undefined> = {};
const ENV = ['LAZY_DAEMON_BASE_DIR', 'LAZY_MANAGED', 'LAZY_MANAGED_BACKEND', 'LAZY_MANAGED_STORAGE_PATH', 'LAZY_SKIP_STORE_BACKUP'];

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'upgrade-backup-')));
  root = join(base, 'repo');
  store = join(base, 'store');
  await mkdir(join(root, '.lazy'), { recursive: true });
  await mkdir(join(store, 'tasks', 't1'), { recursive: true });
  await writeFile(join(store, 'tasks', 't1', 'task.json'), '{}');
  await writeFile(join(root, 'lazy.toml'), `[storage]\nbackend = "external"\nexternal_path = "${store}"\n`);
  for (const k of ENV) saved[k] = process.env[k];
  for (const k of ENV) delete process.env[k];
  process.env.LAZY_DAEMON_BASE_DIR = join(base, 'daemon');
  await mkdir(getDaemonDir(root), { recursive: true });
  await writeFile(join(getDaemonDir(root), 'daemon-last-version.json'), JSON.stringify({ version: '0.0.1' }));
});

afterEach(async () => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(base, { recursive: true, force: true });
});

const backups = async () => (await readdir(backupsDirFor(store)).catch(() => [] as string[]));

describe('daemon-start store backup', () => {
  test('a solo daemon on a new version backs the store up, and only once', async () => {
    await backupStoreIfVersionChanged(root);
    expect(await backups()).toHaveLength(1);
    await backupStoreIfVersionChanged(root);
    expect(await backups()).toHaveLength(1);
  });

  // INVARIANT: a local-docker Teams daemon runs on the host against the host's
  // store, so it backs up like a solo daemon. That is what keeps the fleet
  // reconciler's ordinary start, after a roll whose backup failed, from
  // running new code on an unbacked store.
  test('a managed local-docker daemon backs up; a microVM guest leaves it to the host', async () => {
    process.env.LAZY_MANAGED = '1';
    process.env.LAZY_MANAGED_STORAGE_PATH = store;
    process.env.LAZY_MANAGED_BACKEND = 'microvm';
    await backupStoreIfVersionChanged(root);
    expect(await backups()).toHaveLength(0);
    process.env.LAZY_MANAGED_BACKEND = 'local-docker';
    await backupStoreIfVersionChanged(root);
    expect(await backups()).toHaveLength(1);
  });

  // INVARIANT: an existing backup stands in for a new one only when the store
  // has not changed since it was taken. The version pair alone let A→B, B→A,
  // A→B reuse the FIRST A→B copy — days out of date — as the backup of a
  // store the second upgrade then rewrote.
  test('a backup for the same versions is reused only while the store is unchanged', async () => {
    await backupStoreIfVersionChanged(root);
    expect(await backups()).toHaveLength(1);
    // Written since (by B, then back on A): the old A→B copy no longer covers it.
    await Bun.sleep(5);
    await writeFile(join(store, 'tasks', 't1', 'task.json'), '{"goal":"later work"}');
    await backupStoreIfVersionChanged(root);
    expect(await backups()).toHaveLength(2);
    await backupStoreIfVersionChanged(root);
    expect(await backups()).toHaveLength(2);
  });

  // INVARIANT: a storage lock left by this machine before a reboot or crash
  // (another boot id, no guest flag) never stops the upgrade-start backup —
  // and so never stops the daemon starting. Its holder is dead whatever its pid
  // now names here; only a project machine's lock, seen from the host, is
  // refused.
  test.skipIf(process.platform !== 'linux')('an earlier boot\'s lock does not block the upgrade-start backup; a guest\'s does', async () => {
    const ns = (await processNamespaceId())!.replace(/^linux:[^:]+:/, '');
    await writeFile(join(store, '.storage-lock'), JSON.stringify({
      pid: process.ppid, acquired_at: '2026-01-01T00:00:00Z', holder_namespace: `linux:00000000-earlier-boot:${ns}`,
    }));
    await backupStoreIfVersionChanged(root);
    expect(await backups()).toHaveLength(1);

    await writeFile(join(store, 'tasks', 't1', 'task.json'), '{"changed":true}');
    await writeFile(join(store, '.storage-lock'), JSON.stringify({
      pid: 999_999, acquired_at: '2026-01-01T00:00:00Z', holder_namespace: 'linux:00000000-guest-boot:pid:[4026531836]', holder_guest: true,
    }));
    await expect(backupStoreIfVersionChanged(root)).rejects.toThrow(/another machine or pid namespace/);
  });

  test('a failed backup throws the refusal and leaves no progress marker behind', async () => {
    await writeFile(backupsDirFor(store), 'not a directory');
    await expect(backupStoreIfVersionChanged(root)).rejects.toThrow(/store backup taken before every upgrade failed/);
    expect(await readdir(getDaemonDir(root))).not.toContain('store-backup-progress.json');
  });
});

describe('reuse check progress', () => {
  // INVARIANT: the walk that decides whether an existing backup is reusable reports
  // progress too, so a large store's start is not reported failed while it runs.
  test('the reuse walk reports measuring progress', async () => {
    const args = { projectRoot: root, fromVersion: '0.0.1', toVersion: '9.9.9', keep: 5, reason: 't' };
    const first = await backupStoreForUpgrade(args);
    expect(first.kind).toBe('taken');
    const phases: string[] = [];
    const second = await backupStoreForUpgrade({ ...args, onProgress: p => phases.push(p.phase) });
    expect(second.kind).toBe('already');
    expect(phases).toContain('measuring');
  });
});
