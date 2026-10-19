import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, appendFile, chmod, stat, readdir, rm, realpath, symlink, lstat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  backupsDirFor,
  listStoreBackups,
  restoreStoreBackup,
  measureStoreState,
  takeStoreBackup,
  verifyCopy,
  verifyArchive,
  ARCHIVE_FILE,
  StoreBackupError,
  assertNoRestoreInProgress,
  mountPointRefusal,
  readRestoreInProgress,
  restoreMarkerPathFor,
  type BackupManifest,
} from '../../src/storage/store-backup';
import { ArchiveWriter, unpackArchive } from '../../src/storage/store-archive';
import { startForeignProcess, type ForeignProcess } from '../helpers/foreign-process';

let unpackCount = 0;
/** A backup's data, unpacked from its archive into a fresh directory. */
async function unpacked(backupPath: string): Promise<string> {
  const dest = join(root, `unpacked-${unpackCount++}`);
  await mkdir(dest);
  await unpackArchive(join(backupPath, ARCHIVE_FILE), dest);
  return dest;
}

let root: string;
let store: string;

async function seedStore(): Promise<void> {
  await mkdir(join(store, 'tasks', 'abc'), { recursive: true });
  await writeFile(join(store, 'tasks', 'abc', 'task.json'), JSON.stringify({ id: 'abc', goal: 'g' }));
  await writeFile(join(store, 'version.json'), JSON.stringify({ schema_version: 1 }));
  // The two append-in-place files.
  await mkdir(join(store, 'traces'), { recursive: true });
  await writeFile(join(store, 'traces', 'spans.jsonl'), '{"a":1}\n');
}

let tick = 0;
const clock = () => new Date(Date.UTC(2026, 9, 11, 12, 0, tick++));

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'store-backup-')));
  store = join(root, 'store');
  await seedStore();
});

afterEach(async () => {
  await chmod(join(store, 'tasks', 'abc', 'task.json'), 0o600).catch(() => {});
  await rm(root, { recursive: true, force: true });
});

describe('takeStoreBackup', () => {
  // INVARIANT: backups live BESIDE the store, never inside it. lazy writes
  // nothing extra into the store directory (external-store-is-just-a-store).
  test('writes a verified copy beside the store with a manifest', async () => {
    const backup = await takeStoreBackup({ storePath: store, fromVersion: '0.1', toVersion: '0.2', reason: 't', now: clock });
    expect(backup.status).toBe('ok');
    expect(backup.path.startsWith(backupsDirFor(store) + '/')).toBe(true);
    expect(backup.file_count).toBe(3);
    expect(await readdir(store)).toEqual(expect.not.arrayContaining([expect.stringContaining('backup')]));
    // One compressed archive, no plain copy.
    expect((await readdir(backup.path)).sort()).toEqual(['manifest.json', ARCHIVE_FILE]);
    expect(backup.format).toBe('archive');
    expect(backup.stored_bytes).toBe((await stat(join(backup.path, ARCHIVE_FILE))).size);
    const copied = await readFile(join(await unpacked(backup.path), 'tasks', 'abc', 'task.json'), 'utf-8');
    expect(JSON.parse(copied).id).toBe('abc');
    const manifest = JSON.parse(await readFile(join(backup.path, 'manifest.json'), 'utf-8')) as BackupManifest;
    expect(manifest.from_version).toBe('0.1');
    expect(manifest.files.every(f => f.sha256.length === 64)).toBe(true);
  });

  // INVARIANT: progress keeps coming for as long as the backup runs — inside a
  // single large file and through the whole verification — so a CLI waiting on
  // a daemon's start never mistakes a big backup for a hung one.
  test('reports progress within large files and during verification', async () => {
    await writeFile(join(store, 'big.bin'), Buffer.alloc(3 * 1024 * 1024 + 17, 7));
    const seen: Array<{ phase: string; files: number; bytes: number }> = [];
    await takeStoreBackup({
      storePath: store, fromVersion: 'a', toVersion: 'b', reason: 't', now: clock, progressIntervalMs: 0,
      onProgress: (p) => seen.push({ phase: p.phase, files: p.files, bytes: p.bytes }),
    });
    const copying = seen.filter(p => p.phase === 'copying');
    const verifying = seen.filter(p => p.phase === 'verifying');
    // Mid-file: bytes moved on while the file count did not.
    expect(copying.some((p, i) => i > 0 && p.files === copying[i - 1].files && p.bytes > copying[i - 1].bytes)).toBe(true);
    expect(verifying.length).toBeGreaterThan(3);
    expect(verifying.some((p, i) => i > 0 && p.files === verifying[i - 1].files && p.bytes > verifying[i - 1].bytes)).toBe(true);
    expect(Math.max(...verifying.map(p => p.bytes))).toBeGreaterThanOrEqual(3 * 1024 * 1024);
  });

  // INVARIANT: a backup is a COPY, never hardlinks. Some store files are
  // appended in place (trace spans, wait intervals); a hardlinked backup would
  // silently take every later append, and on Teams the store is guest-writable.
  test('append-in-place files are copied, not shared', async () => {
    const backup = await takeStoreBackup({ storePath: store, fromVersion: 'a', toVersion: 'b', reason: 't', now: clock });
    await appendFile(join(store, 'traces', 'spans.jsonl'), '{"b":2}\n');
    expect(await readFile(join(await unpacked(backup.path), 'traces', 'spans.jsonl'), 'utf-8')).toBe('{"a":1}\n');
  });

  test('the storage lock file is not copied, and a symlink is recorded, never followed', async () => {
    await writeFile(join(store, '.storage-lock'), JSON.stringify({ pid: 1 }));
    await writeFile(join(root, 'outside-secret'), 'secret');
    await symlink(join(root, 'outside-secret'), join(store, 'link'));
    // The lock names a live pid (1), so take the copy as the Teams host does.
    const backup = await takeStoreBackup({ storePath: store, fromVersion: 'a', toVersion: 'b', reason: 't', exclusion: 'writer-stopped', now: clock });
    const manifest = JSON.parse(await readFile(join(backup.path, 'manifest.json'), 'utf-8')) as BackupManifest;
    expect(manifest.symlinks).toEqual([{ path: 'link', target: join(root, 'outside-secret') }]);
    expect(manifest.files.map(f => f.path)).not.toContain('link');
    expect(manifest.files.map(f => f.path)).not.toContain('.storage-lock');
    // A link pointing out of the store is never recreated on restore; the rest
    // of the backup still restores, and the left-out link is reported.
    await rm(join(store, '.storage-lock'));
    const result = await restoreStoreBackup({ storePath: store, backup: backup.name, now: clock });
    expect(result.skippedLinks).toEqual([{ path: 'link', target: join(root, 'outside-secret') }]);
    expect(await readdir(store)).not.toContain('link');
    expect(JSON.parse(await readFile(join(store, 'tasks', 'abc', 'task.json'), 'utf-8')).goal).toBe('g');
  });

  // INVARIANT: a backup that fails is kept, labelled failed, and never counted
  // toward retention. A failure must leave evidence and never push out a good copy.
  test('a failed backup is labelled failed, kept, and the error names the cause', async () => {
    await chmod(join(store, 'tasks', 'abc', 'task.json'), 0o000);
    let caught: unknown;
    try {
      await takeStoreBackup({ storePath: store, fromVersion: 'a', toVersion: 'b', reason: 't', now: clock });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StoreBackupError);
    const failedPath = (caught as StoreBackupError).failedBackupPath!;
    expect(failedPath.endsWith('.failed')).toBe(true);
    expect(await readFile(join(failedPath, 'error.txt'), 'utf-8')).toContain('task.json');
    const listed = await listStoreBackups(store);
    expect(listed.map(b => b.status)).toEqual(['failed']);
  });

  // INVARIANT: a failed copy never holds the disk the live store shares. A
  // copy that died while copying keeps only its error record; the store's
  // size is checked against free space before anything is written.
  test('a copy that fails while copying keeps no data', async () => {
    await chmod(join(store, 'tasks', 'abc', 'task.json'), 0o000);
    const err = await takeStoreBackup({ storePath: store, fromVersion: 'a', toVersion: 'b', reason: 't', now: clock }).catch(e => e as StoreBackupError);
    const failed = (err as StoreBackupError).failedBackupPath!;
    expect((await readdir(failed)).sort()).toEqual(['error.txt', 'manifest.json']);
  });

  test('a large incompressible file round-trips through the archive', async () => {
    const { randomBytes } = await import('crypto');
    const big = randomBytes(2 * 1024 * 1024 + 333);
    await writeFile(join(store, 'big.bin'), big);
    await mkdir(join(store, 'deep', 'x'.repeat(90), 'y'.repeat(90)), { recursive: true });
    await writeFile(join(store, 'deep', 'x'.repeat(90), 'y'.repeat(90), 'long-named-file-ünïcode.json'), '{}');
    const backup = await takeStoreBackup({ storePath: store, fromVersion: 'a', toVersion: 'b', reason: 't', now: clock });
    const data = await unpacked(backup.path);
    expect((await readFile(join(data, 'big.bin'))).equals(big)).toBe(true);
    expect(await readFile(join(data, 'deep', 'x'.repeat(90), 'y'.repeat(90), 'long-named-file-ünïcode.json'), 'utf-8')).toBe('{}');
  });

  // INVARIANT: the free-space refusal is sized for a COMPRESSED result — a
  // store that would not fit as a plain copy may still be backed up.
  test('the free-space check asks for half the store plus a margin, not a full copy', async () => {
    await writeFile(join(store, 'big.json'), JSON.stringify({ x: 'a'.repeat(10 * 1024 * 1024) }));
    const { bytes } = await measureStoreState(store);
    const backup = await takeStoreBackup({
      storePath: store, fromVersion: 'a', toVersion: 'b', reason: 't', now: clock,
      freeBytes: async () => Math.ceil(bytes / 2) + 64 * 1024 * 1024,
    });
    expect(backup.status).toBe('ok');
    expect(backup.stored_bytes!).toBeLessThan(bytes / 10);
  });

  test('refuses up front when the backups filesystem lacks room, writing no copy', async () => {
    const err = await takeStoreBackup({
      storePath: store, fromVersion: 'a', toVersion: 'b', reason: 't', now: clock, freeBytes: async () => 1000,
    }).catch(e => e as StoreBackupError);
    expect((err as Error).message).toMatch(/not enough free space/);
    const failed = (err as StoreBackupError).failedBackupPath!;
    expect((await readdir(failed)).sort()).toEqual(['error.txt', 'manifest.json']);
  });

  test('an in-progress copy is not listed as a backup', async () => {
    await mkdir(join(backupsDirFor(store), '20261011T120000000Z-a-to-b.partial'), { recursive: true });
    expect(await listStoreBackups(store)).toEqual([]);
  });

  test('long version labels are capped in the backup name', async () => {
    const long = 'registry.example/very/long/image:tag@sha256:' + 'f'.repeat(64);
    const backup = await takeStoreBackup({ storePath: store, fromVersion: long, toVersion: long, reason: 't', now: clock });
    expect(backup.name.length).toBeLessThan(160);
    expect(backup.from_version).toBe(long);
  });

  test('retention keeps the last N verified backups and never prunes failed ones', async () => {
    await chmod(join(store, 'tasks', 'abc', 'task.json'), 0o000);
    await takeStoreBackup({ storePath: store, fromVersion: 'x', toVersion: 'y', reason: 't', keep: 2, now: clock }).catch(() => {});
    await chmod(join(store, 'tasks', 'abc', 'task.json'), 0o600);
    for (const v of ['1', '2', '3']) {
      await takeStoreBackup({ storePath: store, fromVersion: v, toVersion: `${v}n`, reason: 't', keep: 2, now: clock });
    }
    const listed = await listStoreBackups(store);
    expect(listed.filter(b => b.status === 'ok').map(b => b.from_version)).toEqual(['3', '2']);
    expect(listed.filter(b => b.status === 'failed')).toHaveLength(1);
  });

  test('refuses while another process holds the storage lock', async () => {
    // pid 1 is alive and is not this process: the lock cannot be taken.
    await writeFile(join(store, '.storage-lock'), JSON.stringify({ pid: 1, acquired_at: new Date().toISOString() }));
    await expect(
      takeStoreBackup({ storePath: store, fromVersion: 'a', toVersion: 'b', reason: 't', now: clock }),
    ).rejects.toThrow(/storage lock/);
  }, 20_000);
});

describe('verifyCopy', () => {
  test('detects a file that differs from the manifest', async () => {
    const backup = await takeStoreBackup({ storePath: store, fromVersion: 'a', toVersion: 'b', reason: 't', now: clock });
    const manifest = JSON.parse(await readFile(join(backup.path, 'manifest.json'), 'utf-8')) as BackupManifest;
    const data = await unpacked(backup.path);
    await writeFile(join(data, 'version.json'), '{"schema_version":9}');
    await expect(verifyCopy(data, manifest)).rejects.toThrow(/version\.json/);
  });
});

describe('verifyArchive', () => {
  // INVARIANT: verification reads the finished ARCHIVE back from disk; a
  // corrupted or truncated one never passes, and a restore refuses it.
  test('catches a corrupted archive, and a restore refuses it', async () => {
    const backup = await takeStoreBackup({ storePath: store, fromVersion: 'a', toVersion: 'b', reason: 't', now: clock });
    const manifest = JSON.parse(await readFile(join(backup.path, 'manifest.json'), 'utf-8')) as BackupManifest;
    expect(manifest.format).toBe(2);
    await verifyArchive(join(backup.path, ARCHIVE_FILE), manifest);
    const archive = join(backup.path, ARCHIVE_FILE);
    const bytes = await readFile(archive);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    await writeFile(archive, bytes);
    await expect(verifyArchive(archive, manifest)).rejects.toThrow(/verification failed/);
    await writeFile(archive, bytes.subarray(0, bytes.length - 20));
    await expect(verifyArchive(archive, manifest)).rejects.toThrow(/verification failed/);
    await writeFile(join(store, 'tasks', 'abc', 'task.json'), 'CURRENT');
    await expect(restoreStoreBackup({ storePath: store, backup: backup.name, now: clock })).rejects.toThrow(/refusing to restore/);
    expect(await readFile(join(store, 'tasks', 'abc', 'task.json'), 'utf-8')).toBe('CURRENT');
  });

  test('catches an archive whose content does not match the manifest', async () => {
    const backup = await takeStoreBackup({ storePath: store, fromVersion: 'a', toVersion: 'b', reason: 't', now: clock });
    const manifest = JSON.parse(await readFile(join(backup.path, 'manifest.json'), 'utf-8')) as BackupManifest;
    const wrong = { ...manifest, files: manifest.files.map(f => f.path === 'version.json' ? { ...f, sha256: '0'.repeat(64) } : f) };
    await expect(verifyArchive(join(backup.path, ARCHIVE_FILE), wrong)).rejects.toThrow(/version\.json/);
    await expect(verifyArchive(join(backup.path, ARCHIVE_FILE), { ...manifest, file_count: 4 })).rejects.toThrow(/3 files/);
  });
});

describe('unpackArchive refuses entries that reach outside its destination', () => {
  // INVARIANT: a backup is read back on the HOST from a guest-writable origin.
  // No archive entry may write outside the restore's staging directory — by
  // path, by a symlink pointing out, or by writing through a symlink.
  async function craft(build: (w: ArchiveWriter) => Promise<void>): Promise<string> {
    const path = join(root, `crafted-${unpackCount++}.tar.gz`);
    const w = await ArchiveWriter.create(path);
    await build(w);
    await w.finish();
    return path;
  }
  async function file(w: ArchiveWriter, path: string, text: string) {
    await w.beginFile(path, 0o600, Buffer.byteLength(text));
    await w.data(Buffer.from(text));
    await w.endFile(Buffer.byteLength(text));
  }
  const cases: Array<[string, (w: ArchiveWriter) => Promise<void>, RegExp]> = [
    ['a .. path', (w) => file(w, '../escaped', 'x'), /unsafe path/],
    ['a nested .. path', (w) => file(w, 'tasks/../../escaped', 'x'), /unsafe path/],
    ['an absolute path', (w) => file(w, '/tmp/escaped', 'x'), /unsafe path/],
    ['a file written through a symlink', async (w) => { await w.symlink('link', '.'); await file(w, 'link/x', 'x'); }, /under a symlink/],
    ['a chain of links that each look inside', async (w) => { await w.symlink('d', '.'); await w.symlink('d/e', '..'); await w.symlink('e/outside', 'x'); }, /under a symlink|passes through another symlink/],
    ['a target that climbs through another link', async (w) => { await w.symlink('y', '.'); await w.symlink('outside', 'y/..'); }, /passes through another symlink/],
    // On a case-insensitive host (a Mac) `d/e/A` is the link `d/e/a` → the store root, so `x` would climb out.
    ['a target that climbs through a link spelled in another case', async (w) => { await w.directory('d', 0o700); await w.directory('d/e', 0o700); await w.symlink('d/e/a', '../..'); await w.symlink('x', 'd/e/A/../..'); }, /passes through another symlink/],
    ['a duplicate file', async (w) => { await file(w, 'a', 'one'); await file(w, 'a', 'two'); }, /EEXIST|exists/],
  ];
  for (const [name, build, error] of cases) {
    test(name, async () => {
      const archive = await craft(build);
      const dest = join(root, `dest-${unpackCount++}`);
      await mkdir(dest);
      await expect(unpackArchive(archive, dest)).rejects.toThrow(error);
      expect(await readdir(root)).not.toContain('escaped');
      expect(await readdir(root)).not.toContain('outside');
    });
  }

  // Not created at all, and reported — never an escaping link on the host.
  for (const [name, path, target] of [['an absolute symlink', 'link', '/etc'], ['a symlink climbing out', 'tasks/link', '../../outside']]) {
    test(`${name} is left out and reported`, async () => {
      const archive = await craft(async (w) => { await w.directory('tasks', 0o700); await w.symlink(path, target); });
      const dest = join(root, `dest-${unpackCount++}`);
      await mkdir(dest);
      const result = await unpackArchive(archive, dest);
      expect(result.skipped).toEqual([{ path, target }]);
      await expect(lstat(join(dest, path))).rejects.toThrow();
    });
  }

  test('a symlink inside the destination is unpacked as a symlink', async () => {
    const archive = await craft(async (w) => { await w.directory('d', 0o700); await file(w, 'd/a', 'A'); await w.symlink('d/b', 'a'); });
    const dest = join(root, `dest-${unpackCount++}`);
    await mkdir(dest);
    await unpackArchive(archive, dest);
    expect(await readFile(join(dest, 'd', 'b'), 'utf-8')).toBe('A');
  });

  test('a backup whose archive holds an escaping entry is refused by restore', async () => {
    const backup = await takeStoreBackup({ storePath: store, fromVersion: 'a', toVersion: 'b', reason: 't', now: clock });
    const evil = await craft((w) => file(w, '../escaped', 'x'));
    await writeFile(join(backup.path, ARCHIVE_FILE), await readFile(evil));
    await expect(restoreStoreBackup({ storePath: store, backup: backup.name, now: clock })).rejects.toThrow(/unsafe path/);
    expect(await readdir(root)).not.toContain('escaped');
  });
});

describe('directory-format backups taken by older lazy', () => {
  // INVARIANT: backups people already have (a plain copy in `store/`) keep
  // restoring, and taking new backups never converts or deletes them.
  async function legacyBackup(): Promise<string> {
    const name = '20200101T000000000Z-0.1-to-0.2';
    const dir = join(backupsDirFor(store), name);
    await mkdir(join(dir, 'store'), { recursive: true });
    const { cp } = await import('fs/promises');
    await cp(store, join(dir, 'store'), { recursive: true });
    const { createHash } = await import('crypto');
    const files = [];
    for (const rel of ['tasks/abc/task.json', 'traces/spans.jsonl', 'version.json']) {
      const buf = await readFile(join(store, rel));
      files.push({ path: rel, size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') });
    }
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({
      format: 1, store, from_version: '0.1', to_version: '0.2', reason: 'old', taken_at: '2020-01-01T00:00:00.000Z',
      file_count: files.length, total_bytes: files.reduce((n, f) => n + f.size, 0), duration_ms: 1, files, symlinks: [], skipped: [],
    }));
    return name;
  }

  test('lists, restores, and survives new backups and pruning', async () => {
    const name = await legacyBackup();
    const listed = (await listStoreBackups(store)).find(b => b.name === name)!;
    expect(listed.status).toBe('ok');
    expect(listed.format).toBe('directory');
    expect(listed.stored_bytes).toBe(listed.total_bytes);
    await writeFile(join(store, 'tasks', 'abc', 'task.json'), JSON.stringify({ id: 'abc', goal: 'CHANGED' }));
    await restoreStoreBackup({ storePath: store, backup: name, now: clock });
    expect(JSON.parse(await readFile(join(store, 'tasks', 'abc', 'task.json'), 'utf-8')).goal).toBe('g');
    await takeStoreBackup({ storePath: store, fromVersion: 'c', toVersion: 'd', reason: 't', keep: 5, now: clock });
    expect(await readdir(join(backupsDirFor(store), name, 'store'))).toContain('tasks');
  });

  test('a tampered directory backup is refused', async () => {
    const name = await legacyBackup();
    await writeFile(join(backupsDirFor(store), name, 'store', 'version.json'), 'tampered');
    await expect(restoreStoreBackup({ storePath: store, backup: name, now: clock })).rejects.toThrow(/version\.json/);
  });
});

describe('restoreStoreBackup', () => {
  // INVARIANT: a restore never deletes the store it replaces — it is moved
  // aside — and a round trip gives back exactly what was backed up.
  test('round-trips and moves the current store aside', async () => {
    const backup = await takeStoreBackup({ storePath: store, fromVersion: 'a', toVersion: 'b', reason: 't', now: clock });
    await writeFile(join(store, 'tasks', 'abc', 'task.json'), JSON.stringify({ id: 'abc', goal: 'CHANGED' }));
    const inodeBefore = (await stat(store)).ino;
    const result = await restoreStoreBackup({ storePath: store, backup: backup.name, now: clock });
    // The directory itself is kept (a VM share source must keep its inode).
    expect((await stat(store)).ino).toBe(inodeBefore);
    expect(JSON.parse(await readFile(join(store, 'tasks', 'abc', 'task.json'), 'utf-8')).goal).toBe('g');
    expect(JSON.parse(await readFile(join(result.movedAsideTo!, 'tasks', 'abc', 'task.json'), 'utf-8')).goal).toBe('CHANGED');
    // Done: no marker left behind, and the lock it held is given back.
    expect(await readRestoreInProgress(store)).toBeNull();
    expect(await readdir(store)).not.toContain('.storage-lock');
  });

  test('refuses while the store is in use, and refuses a failed backup', async () => {
    const backup = await takeStoreBackup({ storePath: store, fromVersion: 'a', toVersion: 'b', reason: 't', now: clock });
    let holder: ForeignProcess | null = null;
    try {
      holder = await startForeignProcess(root, 'lazy-daemon-stand-in');
      await writeFile(join(store, '.storage-lock'), JSON.stringify({
        pid: holder.pid,
        acquired_at: new Date().toISOString(),
        holder_started_at: holder.identity.started,
        holder_start_source: holder.identity.startedSource,
      }));
      await expect(
        restoreStoreBackup({ storePath: store, backup: backup.name, lockTimeoutMs: 200 }),
      ).rejects.toThrow(/in use/);
    } finally {
      holder?.kill();
      await rm(join(store, '.storage-lock'), { force: true });
    }
    await chmod(join(store, 'tasks', 'abc', 'task.json'), 0o000);
    const failed = await takeStoreBackup({ storePath: store, fromVersion: 'c', toVersion: 'd', reason: 't', now: clock }).catch((e: StoreBackupError) => e);
    const name = (failed as StoreBackupError).failedBackupPath!.split('/').pop()!;
    await expect(restoreStoreBackup({ storePath: store, backup: name })).rejects.toThrow(/FAILED/);
  });

  // INVARIANT: a restore excludes the store's writer for the WHOLE copy and
  // swap, not only at its start. Re-verifying and copying a big backup takes
  // minutes; a daemon auto-started in that window must refuse rather than have
  // the store renamed out from under it.
  test('holds the store lock throughout, and a daemon start mid-restore is refused', async () => {
    const backup = await takeStoreBackup({ storePath: store, fromVersion: 'a', toVersion: 'b', reason: 't', now: clock });
    const seen: Array<{ phase: string; lockPid: number | null; startRefusal: string | null }> = [];
    await restoreStoreBackup({
      storePath: store,
      backup: backup.name,
      now: clock,
      onPhase: async (phase) => {
        const lock = await readFile(join(store, '.storage-lock'), 'utf-8').then(t => JSON.parse(t).pid as number, () => null);
        const startRefusal = await assertNoRestoreInProgress(store).then(() => null, (e: Error) => e.message);
        seen.push({ phase, lockPid: lock, startRefusal });
      },
    });
    expect(seen.map(s => s.phase)).toEqual(['verifying', 'staging', 'swapping']);
    for (const s of seen) expect(s.lockPid).toBe(process.pid);
    // From the first phase on, a starting daemon is told a restore owns the store.
    for (const s of seen) expect(s.startRefusal).toMatch(/store restore is running/);
    await assertNoRestoreInProgress(store);
  });

  // INVARIANT: a restore that dies part-way through the swap is never mistaken
  // for a healthy store. Its marker outlives it and the next opener refuses,
  // naming where both halves are; running the restore again finishes it.
  test('an interrupted swap leaves a marker that refuses starts until the restore is re-run', async () => {
    const backup = await takeStoreBackup({ storePath: store, fromVersion: 'a', toVersion: 'b', reason: 't', now: clock });
    // A restore by a process that has since died, mid-swap.
    await writeFile(restoreMarkerPathFor(store), JSON.stringify({
      pid: 2 ** 22 + 7, started_at: new Date().toISOString(), backup: backup.name,
      staging: `${store}.restoring-x`, moved_aside_to: `${store}.before-restore-x`,
    }));
    await expect(assertNoRestoreInProgress(store)).rejects.toThrow(/was interrupted.*before-restore-x/s);
    await restoreStoreBackup({ storePath: store, backup: backup.name, now: clock });
    await assertNoRestoreInProgress(store);
    expect(JSON.parse(await readFile(join(store, 'tasks', 'abc', 'task.json'), 'utf-8')).goal).toBe('g');
  });

  // INVARIANT: a dead restore's marker is the only record of where the real
  // pre-restore store went. A re-run that fails before its own swap puts it
  // back, so starts still refuse and still name that store; a re-run that
  // succeeds carries the path forward to its caller.
  test('a failed re-run of an interrupted restore keeps the earlier marker; a successful one names the original store', async () => {
    const backup = await takeStoreBackup({ storePath: store, fromVersion: 'a', toVersion: 'b', reason: 't', now: clock });
    const original = `${store}.before-restore-ORIGINAL`;
    await writeFile(restoreMarkerPathFor(store), JSON.stringify({
      pid: 2 ** 22 + 7, started_at: new Date().toISOString(), backup: backup.name,
      staging: `${store}.restoring-x`, moved_aside_to: original,
    }));

    await expect(restoreStoreBackup({
      storePath: store, backup: backup.name, now: clock,
      onPhase: (phase) => { if (phase === 'staging') throw new Error('disk full'); },
    })).rejects.toThrow(/disk full/);
    await expect(assertNoRestoreInProgress(store)).rejects.toThrow(/was interrupted/);
    await expect(assertNoRestoreInProgress(store)).rejects.toThrow(original);

    // While the re-run is under way, its own marker carries the original path.
    let during: string[] = [];
    const result = await restoreStoreBackup({
      storePath: store, backup: backup.name, now: clock,
      onPhase: async (phase) => { if (phase === 'swapping') during = (await readRestoreInProgress(store))!.previous; },
    });
    expect(during).toEqual([original]);
    expect(result.previouslyMovedAside).toEqual([original]);
    await assertNoRestoreInProgress(store);
  });

  // INVARIANT: with no lock to hold (`writer-stopped`), the marker is the only
  // exclusion, so it exists from the very first phase.
  test('writer-stopped mode writes the marker before verification', async () => {
    const backup = await takeStoreBackup({ storePath: store, fromVersion: 'a', toVersion: 'b', reason: 't', now: clock });
    const refusals: Array<string | null> = [];
    await restoreStoreBackup({
      storePath: store, backup: backup.name, now: clock, exclusion: 'writer-stopped',
      onPhase: async () => { refusals.push(await assertNoRestoreInProgress(store).then(() => null, (e: Error) => e.message)); },
    });
    expect(refusals).toHaveLength(3);
    for (const r of refusals) expect(r).toMatch(/store restore is running/);
    await assertNoRestoreInProgress(store);
  });

  // INVARIANT: the restore marker lives INSIDE the store (a Teams project's
  // machine sees only the store, never its parent) and is never copied or
  // moved by the swap; a pid from another machine or pid namespace is never
  // judged here — a marker or lock that names one is a refusal, not "stale".
  test('a marker and lock from another pid namespace refuse daemon starts, restores and backups', async () => {
    const backup = await takeStoreBackup({ storePath: store, fromVersion: 'a', toVersion: 'b', reason: 't', now: clock });
    expect(restoreMarkerPathFor(store)).toBe(join(store, '.restore-in-progress'));
    const foreign = 'linux:00000000-guest-boot:pid:[4026531836]';
    // pid 1 exists on THIS side too — the number must not be judged here.
    // Written by a project's machine (holder_guest): the one holder another
    // kernel may really see alive, so the host must not judge it.
    await writeFile(join(store, '.storage-lock'), JSON.stringify({ pid: 1, acquired_at: new Date().toISOString(), holder_namespace: foreign, holder_guest: true }));
    await writeFile(restoreMarkerPathFor(store), JSON.stringify({
      pid: 1, holder_namespace: foreign, holder_guest: true, started_at: new Date().toISOString(), backup: backup.name,
      staging: '/guest/store.restoring-x', moved_aside_to: '/guest/store.before-restore-x',
    }));
    // The guest-like daemon start.
    await expect(assertNoRestoreInProgress(store)).rejects.toThrow(/another machine or pid namespace/);
    // The restore: an unjudgeable LIVE-looking lock is refused, never reclaimed.
    await expect(restoreStoreBackup({ storePath: store, backup: backup.name, lockTimeoutMs: 200 }))
      .rejects.toThrow(/another machine or pid namespace.*Stop the project first/s);
    expect(JSON.parse(await readFile(join(store, '.storage-lock'), 'utf-8')).holder_namespace).toBe(foreign);
    // A backup refuses too — on the restore's marker, which it checks before it
    // ever looks at the lock.
    await expect(takeStoreBackup({ storePath: store, fromVersion: 'c', toVersion: 'd', reason: 't', now: clock }))
      .rejects.toThrow(/a store restore owns this store/);
    // Lock gone, marker still there: the restore still refuses on the marker.
    await rm(join(store, '.storage-lock'));
    await expect(restoreStoreBackup({ storePath: store, backup: backup.name, now: clock }))
      .rejects.toThrow(/another machine or pid namespace/);
    // A backup never copies the marker, and a restore never moves it.
    await rm(restoreMarkerPathFor(store));
    let markerSeenAtSwap = false;
    await restoreStoreBackup({
      storePath: store, backup: backup.name, now: clock,
      onPhase: async (phase) => { if (phase === 'swapping') markerSeenAtSwap = (await readdir(store)).includes('.restore-in-progress'); },
    });
    expect(markerSeenAtSwap).toBe(true);
    expect(await readdir(store)).not.toContain('.restore-in-progress');
    const again = await takeStoreBackup({ storePath: store, fromVersion: 'e', toVersion: 'f', reason: 't', now: clock });
    expect(await readdir(await unpacked(again.path))).not.toContain('.restore-in-progress');
  });

  test('a failure before the swap leaves the store untouched and no marker', async () => {
    const backup = await takeStoreBackup({ storePath: store, fromVersion: 'a', toVersion: 'b', reason: 't', now: clock });
    await writeFile(join(store, 'tasks', 'abc', 'task.json'), JSON.stringify({ id: 'abc', goal: 'CURRENT' }));
    await expect(restoreStoreBackup({
      storePath: store, backup: backup.name, now: clock,
      onPhase: (phase) => { if (phase === 'staging') throw new Error('disk full'); },
    })).rejects.toThrow(/disk full/);
    expect(await readRestoreInProgress(store)).toBeNull();
    expect(JSON.parse(await readFile(join(store, 'tasks', 'abc', 'task.json'), 'utf-8')).goal).toBe('CURRENT');
  });
});

describe('interrupted restores and backups', () => {
  // INVARIANT: a backup is never taken of a store a restore left half-swapped.
  // It would be labelled ok, count toward `keep` and push good backups out.
  test('writer-stopped backup refuses while a restore marker exists', async () => {
    await writeFile(restoreMarkerPathFor(store), JSON.stringify({
      pid: 2 ** 22 + 7, started_at: new Date().toISOString(), backup: 'x', staging: `${store}.restoring-x`, moved_aside_to: `${store}.before-restore-x`,
    }));
    const before = await listStoreBackups(store);
    await expect(takeStoreBackup({ storePath: store, fromVersion: 'a', toVersion: 'b', reason: 't', exclusion: 'writer-stopped', now: clock }))
      .rejects.toThrow(/was interrupted/);
    expect(await listStoreBackups(store)).toEqual(before);
  });

  // INVARIANT: the marker names a moved-aside store only once it exists, so a
  // restore killed while verifying never points at a path that was never made.
  test('the marker records moved_aside_to only after the move', async () => {
    const backup = await takeStoreBackup({ storePath: store, fromVersion: 'a', toVersion: 'b', reason: 't', now: clock });
    const seen: Array<string | null> = [];
    await restoreStoreBackup({
      storePath: store, backup: backup.name, now: clock, exclusion: 'writer-stopped',
      onPhase: async (phase) => {
        const m = JSON.parse(await readFile(restoreMarkerPathFor(store), 'utf-8'));
        if (phase === 'verifying' || phase === 'staging') seen.push(m.moved_aside_to);
      },
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const v of seen) expect(v).toBeNull();
  });

  // INVARIANT: a large store's walk reports progress by time, file by file, before any copy starts.
  test('the measuring walk reports running totals', async () => {
    const seen: Array<[number, number]> = [];
    const state = await measureStoreState(store, (files, bytes) => seen.push([files, bytes]));
    expect(seen).toHaveLength(state.files);
    expect(seen[seen.length - 1]).toEqual([state.files, state.bytes]);
  });

  test('takeStoreBackup reports walk totals before the final measured totals', async () => {
    const totals: number[] = [];
    await takeStoreBackup({
      storePath: store, fromVersion: 'a', toVersion: 'b', reason: 't', now: clock, progressIntervalMs: 0,
      onProgress: p => { if (p.phase === 'measuring') totals.push(p.total_files); },
    });
    expect(totals[0]).toBe(0);
    expect(totals.length).toBeGreaterThan(2);
  });

  // INVARIANT: a restore that died before moving anything says the store was not touched.
  test('an interrupted restore with nothing moved says the store was not touched', async () => {
    await writeFile(restoreMarkerPathFor(store), JSON.stringify({
      pid: 2 ** 22 + 7, started_at: new Date().toISOString(), backup: 'x', staging: `${store}.restoring-x`, moved_aside_to: null,
    }));
    await expect(assertNoRestoreInProgress(store)).rejects.toThrow(/before it changed anything.*not touched/s);
  });
});

describe('a restore that fails while staging', () => {
  // INVARIANT: a failed restore never leaves its full-size unpacked copy beside
  // the store (only a manifest MISMATCH keeps it, as named evidence), and a
  // restore without room to unpack refuses before writing anything — a stray
  // copy would keep the disk the live store shares full.
  const leftovers = async () => (await readdir(root)).filter(e => e.startsWith('store.restoring-'));

  test('removes its staging copy when unpacking is refused', async () => {
    // Verifies against its manifest, but unpacking refuses a link through a link.
    await symlink('.', join(store, 'y'));
    await symlink('y/..', join(store, 'z'));
    const backup = await takeStoreBackup({ storePath: store, fromVersion: 'a', toVersion: 'b', reason: 't', now: clock });
    await expect(restoreStoreBackup({ storePath: store, backup: backup.name, now: clock })).rejects.toThrow(/passes through another symlink/);
    expect(await leftovers()).toEqual([]);
  });

  test('refuses up front when there is no room to unpack', async () => {
    const backup = await takeStoreBackup({ storePath: store, fromVersion: 'a', toVersion: 'b', reason: 't', now: clock });
    await expect(restoreStoreBackup({ storePath: store, backup: backup.name, now: clock, freeBytes: async () => 1 })).rejects.toThrow(/needs about .* is free/);
    expect(await leftovers()).toEqual([]);
    expect(await readFile(join(store, 'version.json'), 'utf-8')).toContain('schema_version');
  });
});

describe('mountPointRefusal', () => {
  // INVARIANT: the mount-point refusal never recommends extracting straight over the store. That only overlays the backup (files made after it stay behind); the advice is to move the old contents aside first.
  test('does not recommend overlay extraction', () => {
    for (const format of ['archive', 'directory']) {
      const msg = mountPointRefusal('/mnt/store', { path: '/b/one', format });
      expect(msg).not.toContain('tar -xzf');
      expect(msg).not.toContain('by hand');
      expect(msg).toContain('move the store\'s contents into a new folder inside it');
      expect(msg).toContain('Nothing was changed');
    }
    expect(mountPointRefusal('/mnt/store', { path: '/b/one', format: 'archive' })).toContain(`unpack ${join('/b/one', ARCHIVE_FILE)}`);
    expect(mountPointRefusal('/mnt/store', { path: '/b/one', format: 'directory' })).toContain('copy /b/one/store into');
    expect(mountPointRefusal('/mnt/store', { path: '/b/one', format: 'archive' })).toContain('store-backups#a-store-that-is-a-mount-point');
  });
});
