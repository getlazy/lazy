/**
 * Pre-upgrade store backups.
 *
 * The store (tasks, sessions, turns, comments, conversations, memories) is the
 * product's data, and an upgrade is the moment new code first reads — and,
 * through FileStorage's read-time migrations, REWRITES — it. So before a new
 * lazy version opens an existing store, a copy is taken, verified, and kept:
 *
 * - **solo**: the daemon, when it starts on a different version than last time
 *   (before anything opens storage), and `lazy upgrade` between stopping the
 *   old daemon and starting the new one;
 * - **Lazy Teams**: the host, after a project's daemon is stopped and before
 *   new lazy is swapped in (`lazy system store-backup --writer-stopped`).
 *
 * The rules, each one load-bearing:
 *
 * - **No writer.** The copy is taken holding `.storage-lock`, or — the Teams
 *   host, whose lock file names a GUEST pid this host cannot judge — with the
 *   caller asserting it has stopped the only writer.
 * - **A full copy — one gzip-compressed tar (`store.tar.gz`, see store-archive.ts)
 *   — never hardlinks.** Most store files are replaced atomically
 *   (temp + rename), which a hardlink would survive, but some are appended in
 *   place (trace spans, wait intervals), and on Teams the store is writable by
 *   the guest: a hardlinked backup is one in-place write away from being the
 *   corrupted data it exists to protect against.
 * - **Symlink- and FIFO-safe.** Files are opened O_NOFOLLOW|O_NONBLOCK and
 *   checked with fstat; a symlink is recorded as a symlink, never followed —
 *   the Teams host reads a guest-writable tree.
 * - **Verified before it gets its name.** Written as `<name>.partial`, the
 *   finished archive is read back from disk and every file in it compared (count, total size, sha256 of each) with
 *   what was read from the store, and only then renamed to `<name>`. A copy
 *   that fails is renamed `<name>.failed` with an `error.txt`, and never
 *   counted toward retention. Its copied DATA is kept only when verification
 *   found a mismatch (the evidence worth inspecting), and only for the newest
 *   such failure — a failed copy must never be what fills the disk the live
 *   store shares. A copy is refused up front when the backups directory's
 *   filesystem lacks room for it.
 * - **Beside the store, never inside it.** `<store>.backups/` — lazy writes
 *   nothing extra into the store directory, with one exception: a running
 *   restore's marker (`.restore-in-progress`, below), which must be INSIDE so
 *   a Lazy Teams project's machine — which sees only the store, never its
 *   parent — is kept out too. It is never copied, counted or moved, like
 *   `.storage-lock`.
 * - **The last N.** Older verified backups are deleted after a new one
 *   verifies (`[storage] backup_keep`, default 5).
 */

import { createHash } from 'crypto';
import { constants } from 'fs';
import { lstat, mkdir, open, type FileHandle, readdir, readFile, readlink, realpath, rename, rm, stat, statfs, symlink, writeFile } from 'fs/promises';
import { docsSuffix } from '../docs/links';
import { dirname, join, relative, resolve, sep } from 'path';
import { ArchiveWriter, safeEntryPath, scanArchive, unpackArchive } from './store-archive';
import { RESTORE_MARKER_FILENAME, StorageLock, STORAGE_LOCK_FILENAME, StoreRestoreInProgressError, UnjudgeableStorageLockError } from '../utils/storage-lock';
import { checkHolder, isVmGuest, judgeHolderNamespace, processNamespaceId, selfIdentity, type StartTimeSource } from '../utils/process-identity';

export const DEFAULT_BACKUP_KEEP = 5;
const MANIFEST = 'manifest.json';
/** The data of a directory-format (format 1) backup: a plain copy. Still restored, never written. */
const DATA_DIR = 'store';
/** The data of an archive-format (format 2) backup. */
export const ARCHIVE_FILE = 'store.tar.gz';
const FAILED_SUFFIX = '.failed';
const PARTIAL_SUFFIX = '.partial';
const ERROR_FILE = 'error.txt';
export { RESTORE_MARKER_FILENAME };

/** Entries of a store's ROOT that describe a process, not data: never copied, counted or moved. */
function isProcessFile(name: string): boolean {
  return name === STORAGE_LOCK_FILENAME || name === RESTORE_MARKER_FILENAME || name.startsWith(`${RESTORE_MARKER_FILENAME}.`);
}
const NAME = /^(\d{8}T\d{6}(?:\d{3})?Z)-(.+)-to-(.+?)(\.failed)?$/;
const CHUNK = 1 << 20;

export interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
}

export interface BackupManifest {
  /** 1: the data is a plain copy in `store/`. 2: the data is `store.tar.gz` (every backup taken now). */
  format: 1 | 2;
  /** Format 2: the archive's size on disk. */
  archive_bytes?: number;
  store: string;
  from_version: string;
  to_version: string;
  reason: string;
  taken_at: string;
  file_count: number;
  total_bytes: number;
  duration_ms: number;
  files: ManifestFile[];
  symlinks: { path: string; target: string }[];
  /** Entries that are neither file, directory nor symlink (FIFOs, sockets). */
  skipped: { path: string; kind: string }[];
  /** The store as it stood when the copy was taken (see measureStoreState). Absent on older backups. */
  store_state?: StoreState;
}

/**
 * What a store looked like at one moment, cheaply: its files, their total
 * size, and the newest modification time of any file or subdirectory under it
 * (the root directory's own is left out — taking `.storage-lock` changes it).
 * Two equal states mean nothing was written in between, as far as the
 * filesystem can say without reading every byte.
 */
export interface StoreState {
  files: number;
  bytes: number;
  latest_mtime_ms: number;
}

export interface StoreBackup {
  name: string;
  path: string;
  status: 'ok' | 'failed';
  taken_at: string;
  from_version: string;
  to_version: string;
  file_count: number | null;
  total_bytes: number | null;
  duration_ms: number | null;
  /** 'archive' (one compressed file) or 'directory' (a plain copy, taken by older lazy). */
  format: 'archive' | 'directory';
  /** What it takes on disk: the archive's size, or the copy's (total_bytes) for a directory backup. */
  stored_bytes: number | null;
  /** Why a failed backup failed, when it recorded one. */
  error: string | null;
  /** The store's state when it was taken; null for a backup older than the field. */
  store_state: StoreState | null;
}

export class StoreBackupError extends Error {
  constructor(message: string, readonly failedBackupPath: string | null = null) {
    super(message);
    this.name = 'StoreBackupError';
  }
}

/** Where a store's backups live: a sibling directory, never inside the store. */
export function backupsDirFor(storePath: string): string {
  const abs = resolve(storePath);
  return `${abs}.backups`;
}

/** A version as a filename part: safe characters, at most 64 of them (the raw value stays in the manifest). */
function safeLabel(version: string): string {
  const clean = version.replace(/[^A-Za-z0-9._+]/g, '_') || 'unknown';
  if (clean.length <= 64) return clean;
  return `${clean.slice(0, 51)}+${createHash('sha256').update(version).digest('hex').slice(0, 12)}`;
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.(\d{3})Z$/, '$1Z');
}

function parseStamp(text: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})?Z$/.exec(text);
  if (!m) return text;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7] ?? '000'}Z`;
}

export interface TakeStoreBackupOptions {
  storePath: string;
  fromVersion: string;
  toVersion: string;
  /** One line saying why, recorded in the manifest. */
  reason: string;
  keep?: number;
  /**
   * `lock` (default): hold `.storage-lock` for the whole copy.
   * `writer-stopped`: the caller has stopped the store's only writer and the
   * lock file (if any) is not this host's to judge — the Teams host.
   */
  exclusion?: 'lock' | 'writer-stopped';
  backupsDir?: string;
  now?: () => Date;
  /** Called as the backup progresses: at every phase change, and about once a second within one (verification and single large files included). */
  onProgress?: (progress: BackupProgress) => void;
  /** Told the names of interrupted copies (`.partial`) this backup removed before starting over. */
  onInterruptedDiscarded?: (names: string[]) => void;
  /** Least time between two progress calls within one phase (default 1000 ms). */
  progressIntervalMs?: number;
  /** Free bytes on the backups filesystem; injectable for tests. */
  freeBytes?: (dir: string) => Promise<number>;
}

export interface BackupProgress {
  phase: 'measuring' | 'copying' | 'verifying';
  files: number;
  bytes: number;
  total_files: number;
  total_bytes: number;
}

/** Room a backup needs beyond its estimated archive size. */
const FREE_SPACE_MARGIN_BYTES = 64 * 1024 * 1024;

/**
 * The room asked for up front: half the store, plus a margin. A store is
 * mostly JSON, which gzip shrinks far more than that; one that compresses
 * worse and still runs the disk out fails cleanly (the partial archive is
 * removed and the failure recorded), so this only has to refuse the hopeless
 * cases before anything is written.
 */
export function backupSpaceNeeded(storeBytes: number): number {
  return Math.ceil(storeBytes / 2) + FREE_SPACE_MARGIN_BYTES;
}

async function defaultFreeBytes(dir: string): Promise<number> {
  const fs = await statfs(dir);
  return Number(fs.bavail) * Number(fs.bsize);
}

/** Marks a failure found by verification — the one kind whose data is kept. */
class VerificationMismatch extends Error {}

/**
 * Take, verify and retain one backup. Resolves to the verified backup; throws
 * StoreBackupError (naming what failed and where any failed copy was kept)
 * otherwise. Never modifies the store.
 */
export async function takeStoreBackup(options: TakeStoreBackupOptions): Promise<StoreBackup> {
  const storePath = resolve(options.storePath);
  const keep = options.keep ?? DEFAULT_BACKUP_KEEP;
  const backupsDir = options.backupsDir ?? backupsDirFor(storePath);
  const now = options.now ?? (() => new Date());

  const st = await lstat(storePath).catch((err: NodeJS.ErrnoException) => {
    throw new StoreBackupError(`cannot back up the store at ${storePath}: ${err.code === 'ENOENT' ? 'it does not exist' : err.message}`);
  });
  if (!st.isDirectory()) throw new StoreBackupError(`cannot back up the store at ${storePath}: it is not a directory`);
  const insideStore = relative(storePath, resolve(backupsDir));
  if (insideStore === '' || (!insideStore.startsWith('..') && !insideStore.startsWith(sep))) {
    throw new StoreBackupError(`refusing to write backups inside the store itself (${backupsDir})`);
  }

  // A marker means a restore is swapping the store or died halfway through: the
  // store is part old, part restored, and a backup of it would be labelled ok
  // and count toward `keep`, pushing good backups out. The lock covers a running
  // restore (and refuses on the marker itself); only the marker covers
  // `writer-stopped`, where there is no lock to take.
  if (options.exclusion === 'writer-stopped') await assertNoRestoreInProgress(storePath);

  const run = async (): Promise<StoreBackup> => {
    await mkdir(backupsDir, { recursive: true, mode: 0o700 });
    const discarded = await discardInterruptedCopies(backupsDir);
    if (discarded.length > 0) options.onInterruptedDiscarded?.(discarded);
    const takenAt = now();
    const name = `${stamp(takenAt)}-${safeLabel(options.fromVersion)}-to-${safeLabel(options.toVersion)}`;
    const finalPath = join(backupsDir, name);
    const partial = finalPath + PARTIAL_SUFFIX;
    const started = Date.now();
    const progress = throttledProgress(options.onProgress, options.progressIntervalMs);
    let manifest: BackupManifest | null = null;
    let keepData = false;
    try {
      progress({ phase: 'measuring', files: 0, bytes: 0, total_files: 0, total_bytes: 0 }, true);
      const measured = await measureStoreState(storePath, (files, bytes) => progress({ phase: 'measuring', files: 0, bytes: 0, total_files: files, total_bytes: bytes }));
      progress({ phase: 'measuring', files: 0, bytes: 0, total_files: measured.files, total_bytes: measured.bytes }, true);
      const needed = backupSpaceNeeded(measured.bytes);
      const free = await (options.freeBytes ?? defaultFreeBytes)(backupsDir);
      if (free < needed) {
        throw new Error(
          `not enough free space in ${backupsDir}: the backup needs about ${formatBytes(needed)} ` +
            `(the store is ${formatBytes(measured.bytes)}), and ${formatBytes(free)} is free`,
        );
      }
      await mkdir(partial, { recursive: true, mode: 0o700 });
      const writer = await ArchiveWriter.create(join(partial, ARCHIVE_FILE));
      let copied: CopiedTree;
      try {
        copied = await archiveTree(storePath, writer, { onProgress: progress, totals: measured });
        await writer.finish();
      } catch (err) {
        await writer.abort();
        throw err;
      }
      manifest = {
        format: 2,
        archive_bytes: writer.compressedBytes,
        store: storePath,
        from_version: options.fromVersion,
        to_version: options.toVersion,
        reason: options.reason,
        taken_at: takenAt.toISOString(),
        file_count: copied.files.length,
        total_bytes: copied.files.reduce((n, f) => n + f.size, 0),
        duration_ms: 0,
        ...copied,
        store_state: measured,
      };
      const totals = { total_files: manifest.file_count, total_bytes: manifest.total_bytes };
      progress({ phase: 'verifying', files: 0, bytes: 0, ...totals }, true);
      try {
        await verifyArchive(join(partial, ARCHIVE_FILE), manifest, (files, bytes) => progress({ phase: 'verifying', files, bytes, ...totals }));
      } catch (verifyErr) {
        throw new VerificationMismatch(verifyErr instanceof Error ? verifyErr.message : String(verifyErr));
      }
      manifest.duration_ms = Date.now() - started;
      await writeDurable(join(partial, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
      await rename(partial, finalPath);
      await fsyncDir(backupsDir);
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      keepData = err instanceof VerificationMismatch;
      const failedPath = finalPath + FAILED_SUFFIX;
      let kept: string | null = null;
      try {
        await mkdir(partial, { recursive: true });
        // A copy that died copying (no room, an unreadable file) is evidence of
        // nothing worth its size: drop the data, keep the record. Older failed
        // entries drop theirs too, so at most ONE failed copy holds data.
        if (!keepData) await removeBackupData(partial);
        await stripOlderFailedData(backupsDir);
        // A failure before the manifest existed still records which upgrade it
        // was for, unmangled — the directory name only has the safe label.
        const record = manifest ?? {
          format: 2, store: storePath, from_version: options.fromVersion, to_version: options.toVersion,
          reason: options.reason, taken_at: takenAt.toISOString(),
        };
        await writeFile(join(partial, MANIFEST), JSON.stringify(record, null, 2) + '\n');
        await writeFile(join(partial, ERROR_FILE), cause + '\n');
        await rename(partial, failedPath);
        kept = failedPath;
      } catch (labelErr) {
        throw new StoreBackupError(
          `${cause} — and the failed copy at ${partial} could not be labelled failed: ` +
            `${labelErr instanceof Error ? labelErr.message : String(labelErr)}`,
          partial,
        );
      }
      throw new StoreBackupError(cause, kept);
    }
    await prune(backupsDir, keep);
    const backup = (await listStoreBackups(storePath, { backupsDir })).find(b => b.name === name);
    if (!backup) throw new StoreBackupError(`the backup ${finalPath} verified but could not be listed afterwards`);
    return backup;
  };

  if (options.exclusion === 'writer-stopped') return run();
  // A lock held in another pid namespace (a project's machine, seen from the
  // host) cannot be judged here — refuse rather than reclaim it.
  const lock = new StorageLock(storePath, storePath, { foreignHolder: 'refuse' });
  try {
    return await lock.withLock(run);
  } catch (err) {
    if (err instanceof StoreBackupError) throw err;
    throw new StoreBackupError(err instanceof Error ? err.message : String(err));
  }
}

interface CopiedTree {
  files: ManifestFile[];
  symlinks: { path: string; target: string }[];
  skipped: { path: string; kind: string }[];
}

/** The store's state now (see StoreState). Reads metadata only, never contents. */
export async function measureStoreState(source: string, onWalk?: (files: number, bytes: number) => void): Promise<StoreState> {
  let files = 0;
  let bytes = 0;
  let latest = 0;
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await readdir(join(source, rel), { withFileTypes: true })) {
      // Not copied (see copyTree), so not counted either.
      if (!rel && isProcessFile(entry.name)) continue;
      const childRel = rel ? join(rel, entry.name) : entry.name;
      const st = await lstat(join(source, childRel));
      if (st.isDirectory()) {
        latest = Math.max(latest, st.mtimeMs);
        await walk(childRel);
      } else if (st.isFile()) {
        files++;
        bytes += st.size;
        latest = Math.max(latest, st.mtimeMs);
        onWalk?.(files, bytes);
      }
    }
  };
  await walk('');
  return { files, bytes, latest_mtime_ms: Math.floor(latest) };
}

function isStoreState(v: unknown): v is StoreState {
  const x = v as StoreState | null | undefined;
  return !!x && typeof x === 'object' && [x.files, x.bytes, x.latest_mtime_ms].every(n => typeof n === 'number' && Number.isFinite(n));
}

/** Same store state: nothing was written between the two measurements. */
export function sameStoreState(a: StoreState | null, b: StoreState | null): boolean {
  return !!a && !!b && a.files === b.files && a.bytes === b.bytes && a.latest_mtime_ms === b.latest_mtime_ms;
}

/**
 * Hand progress on at every phase change and at most once per `everyMs`
 * within a phase: the copy and the verification report on every file and
 * every chunk, so a single huge file or a long verify still shows movement.
 */
export function throttledProgress(fn: ((p: BackupProgress) => void) | undefined, everyMs = 1000): (p: BackupProgress, force?: boolean) => void {
  if (!fn) return () => {};
  let last = 0;
  let phase = '';
  return (p, force = false) => {
    const now = Date.now();
    if (!force && p.phase === phase && now - last < everyMs) return;
    last = now;
    phase = p.phase;
    fn(p);
  };
}

/**
 * Prove `path` (just lstat'ed as `expected`) is still that entry, reached
 * without leaving `root`. The Teams host walks a GUEST-WRITABLE tree:
 * O_NOFOLLOW guards only the last path component, so a directory swapped for
 * a symlink between the lstat and the readdir/open would redirect the copy
 * outside the store. Narrows that race to the instant between this check and
 * the syscall that follows — it cannot close it without openat(2), which
 * neither Bun nor Node exposes.
 */
async function assertContained(root: string, path: string, expected: { dev: number; ino: number }): Promise<void> {
  const real = await realpath(path);
  if (real !== root && !real.startsWith(root + sep)) {
    throw new Error(`${path} resolves outside the store (${real}); refusing to follow it`);
  }
  const now = await stat(real);
  if (now.dev !== expected.dev || now.ino !== expected.ino) {
    throw new Error(`${path} changed while it was being copied; refusing to follow it`);
  }
}

/** Where the walk's entries go: a directory (a restore's staging copy) or an archive (a backup). */
interface TreeSink {
  dir(rel: string, mode: number): Promise<void>;
  symlink(rel: string, target: string): Promise<void>;
  /** Write one file from `input` (already fstat'ed as a regular file of `size` bytes), hashing what was read. */
  file(rel: string, input: FileHandle, mode: number, size: number, onBytes: (copied: number) => void): Promise<ManifestFile>;
}

/**
 * Walk `source` in name order, handing each entry to `sink`. Every directory
 * and file is proved contained first (assertContained), every file is opened
 * O_NOFOLLOW|O_NONBLOCK and fstat'ed, symlinks are recorded and never
 * followed, and anything else (FIFOs, sockets) is skipped and listed.
 */
async function walkTree(
  source: string,
  sink: TreeSink,
  opts: { onProgress?: (p: BackupProgress, force?: boolean) => void; totals?: { files: number; bytes: number } } = {},
): Promise<CopiedTree> {
  const out: CopiedTree = { files: [], symlinks: [], skipped: [] };
  const root = await realpath(source);
  let bytes = 0;
  const report = (inFlight = 0, force = false) => opts.onProgress?.({
    phase: 'copying', files: out.files.length, bytes: bytes + inFlight,
    total_files: opts.totals?.files ?? 0, total_bytes: opts.totals?.bytes ?? 0,
  }, force);
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(join(source, rel), { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const childRel = rel ? join(rel, entry.name) : entry.name;
      // The lock describes a process, not data; restoring it would be a lie.
      if (!rel && isProcessFile(entry.name)) continue;
      const src = join(source, childRel);
      const st = await lstat(src);
      if (st.isDirectory()) {
        await assertContained(root, src, st);
        await sink.dir(childRel, st.mode & 0o777);
        await walk(childRel);
      } else if (st.isSymbolicLink()) {
        const target = await readlink(src);
        await sink.symlink(childRel, target);
        out.symlinks.push({ path: childRel, target });
      } else if (st.isFile()) {
        await assertContained(root, src, st);
        const input = await open(src, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const fst = await input.stat();
          if (!fst.isFile()) throw new Error(`${childRel} changed into something other than a file while it was being copied`);
          const copied = await sink.file(childRel, input, fst.mode & 0o777, fst.size, (n) => report(n));
          out.files.push(copied);
          bytes += copied.size;
        } finally {
          await input.close();
        }
        report();
      } else {
        out.skipped.push({ path: childRel, kind: st.isFIFO() ? 'fifo' : st.isSocket() ? 'socket' : 'other' });
      }
    }
  };
  await walk('');
  report(0, true);
  return out;
}

/** Read `input` to its end in chunks, hashing; `each` receives every chunk. */
async function readHashed(input: FileHandle, rel: string, each: (chunk: Buffer) => Promise<void>, onBytes?: (n: number) => void): Promise<ManifestFile> {
  const hash = createHash('sha256');
  const buf = Buffer.allocUnsafe(CHUNK);
  let size = 0;
  for (;;) {
    const { bytesRead } = await input.read(buf, 0, CHUNK, null);
    if (bytesRead === 0) break;
    const chunk = buf.subarray(0, bytesRead);
    hash.update(chunk);
    await each(chunk);
    size += bytesRead;
    onBytes?.(size);
  }
  return { path: rel, size, sha256: hash.digest('hex') };
}

/** Copy a tree into the directory `dest` (which exists). */
async function copyTree(
  source: string,
  dest: string,
  opts: { onProgress?: (p: BackupProgress, force?: boolean) => void; totals?: { files: number; bytes: number } } = {},
): Promise<CopiedTree> {
  return walkTree(source, {
    dir: async (rel) => { await mkdir(join(dest, rel), { mode: 0o700 }); },
    symlink: async (rel, target) => { await symlink(target, join(dest, rel)); },
    file: async (rel, input, mode, _size, onBytes) => {
      const output = await open(join(dest, rel), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
      try {
        const copied = await readHashed(input, rel, async (chunk) => {
          let written = 0;
          while (written < chunk.length) written += (await output.write(chunk, written, chunk.length - written)).bytesWritten;
        }, onBytes);
        await output.sync();
        return copied;
      } finally {
        await output.close();
      }
    },
  }, opts);
}

/** Write a tree into an archive (see store-archive.ts). */
async function archiveTree(
  source: string,
  writer: ArchiveWriter,
  opts: { onProgress?: (p: BackupProgress, force?: boolean) => void; totals?: { files: number; bytes: number } } = {},
): Promise<CopiedTree> {
  const posix = (rel: string) => rel.split(sep).join('/');
  return walkTree(source, {
    dir: (rel, mode) => writer.directory(posix(rel), mode),
    symlink: (rel, target) => writer.symlink(posix(rel), target),
    file: async (rel, input, mode, size, onBytes) => {
      // A tar entry states its size up front; a file that grows or shrinks
      // under the copy (there should be no writer) fails it instead.
      await writer.beginFile(posix(rel), mode, size);
      const copied = await readHashed(input, rel, async (chunk) => {
        await writer.data(chunk);
      }, (n) => {
        if (n > size) throw new Error(`${rel} grew while it was being copied`);
        onBytes(n);
      });
      if (copied.size !== size) throw new Error(`${rel} shrank while it was being copied`);
      await writer.endFile(size);
      return copied;
    },
  }, opts);
}

async function hashFile(path: string, onBytes?: (read: number) => void): Promise<{ size: number; sha256: string }> {
  const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error(`${path} is not a regular file`);
    const hash = createHash('sha256');
    const buf = Buffer.allocUnsafe(CHUNK);
    let size = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, null);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
      size += bytesRead;
      onBytes?.(size);
    }
    return { size, sha256: hash.digest('hex') };
  } finally {
    await fh.close();
  }
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
      const childRel = rel ? join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) await walk(childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  };
  await walk('');
  return out.sort();
}

/**
 * Read a backup's archive back from disk and compare it with the manifest: the
 * same set of files, each with the recorded size and sha256, the same totals,
 * the same symlinks — and no entry whose path could reach outside a restore.
 * Catches a corrupt or truncated archive (gzip's own check, header checksums)
 * as well as a wrong one.
 */
export async function verifyArchive(
  archivePath: string,
  manifest: BackupManifest,
  onProgress?: (files: number, bytes: number) => void,
): Promise<void> {
  const fail = (why: string) => new Error(`verification failed: ${why}`);
  const expected = new Map(manifest.files.map(f => [f.path.split(sep).join('/'), f]));
  const expectedLinks = new Map((manifest.symlinks ?? []).map(l => [l.path.split(sep).join('/'), l.target]));
  const seen = new Set<string>();
  let total = 0;
  let checked = 0;
  try {
    await scanArchive(archivePath, async (entry, data) => {
      safeEntryPath(entry.path);
      if (entry.type === 'dir') return;
      if (seen.has(entry.path)) throw fail(`the archive holds ${entry.path} twice`);
      seen.add(entry.path);
      if (entry.type === 'symlink') {
        if (expectedLinks.get(entry.path) !== entry.target) throw fail(`the archive has a symlink ${entry.path} the store did not`);
        return;
      }
      const want = expected.get(entry.path);
      if (!want) throw fail(`the archive has a file the store did not (${entry.path})`);
      const hash = createHash('sha256');
      let size = 0;
      for await (const chunk of data) {
        hash.update(chunk);
        size += chunk.length;
        onProgress?.(checked, total + size);
      }
      const sha = hash.digest('hex');
      checked++;
      if (size !== want.size || sha !== want.sha256) {
        throw fail(`${entry.path} reads back as ${size} bytes (sha256 ${sha.slice(0, 12)}), the store's was ${want.size} bytes (sha256 ${want.sha256.slice(0, 12)})`);
      }
      total += size;
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw msg.startsWith('verification failed') ? err : fail(`the archive ${archivePath} cannot be read back: ${msg}`);
  }
  if (checked !== manifest.file_count || expected.size !== manifest.file_count) {
    throw fail(`the archive has ${checked} files, the store had ${manifest.file_count}`);
  }
  for (const link of expectedLinks.keys()) if (!seen.has(link)) throw fail(`the archive is missing the symlink ${link}`);
  if (total !== manifest.total_bytes) throw fail(`the archive totals ${total} bytes, the store ${manifest.total_bytes}`);
}

/**
 * Read every file of a copy back and compare it with the manifest: the same
 * set of files, each with the recorded size and sha256, and the same totals.
 */
export async function verifyCopy(
  dataDir: string,
  manifest: BackupManifest,
  onProgress?: (files: number, bytes: number) => void,
): Promise<void> {
  const present = await listFiles(dataDir);
  const expected = manifest.files.map(f => f.path).sort();
  if (present.length !== manifest.file_count || expected.length !== manifest.file_count) {
    throw new Error(`verification failed: the copy has ${present.length} files, the store had ${manifest.file_count}`);
  }
  for (let i = 0; i < expected.length; i++) {
    if (present[i] !== expected[i]) {
      throw new Error(`verification failed: the copy and the store disagree about which files exist (first difference: ${present[i] ?? expected[i]})`);
    }
  }
  let total = 0;
  let checked = 0;
  for (const file of manifest.files) {
    const got = await hashFile(join(dataDir, file.path), onProgress ? (n) => onProgress(checked, total + n) : undefined);
    checked++;
    if (got.size !== file.size || got.sha256 !== file.sha256) {
      throw new Error(`verification failed: ${file.path} reads back as ${got.size} bytes (sha256 ${got.sha256.slice(0, 12)}), the store's was ${file.size} bytes (sha256 ${file.sha256.slice(0, 12)})`);
    }
    total += got.size;
  }
  if (total !== manifest.total_bytes) {
    throw new Error(`verification failed: the copy totals ${total} bytes, the store ${manifest.total_bytes}`);
  }
}

async function writeDurable(path: string, content: string): Promise<void> {
  const fh = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await fh.writeFile(content, 'utf-8');
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function fsyncDir(path: string): Promise<void> {
  const fh = await open(path, constants.O_RDONLY);
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

// A copy killed half-way leaves a `.partial` the size of the store that nothing
// else would delete. Only one backup of a store runs at a time (the lock, or a
// stopped writer), so any partial here is a dead one.
async function discardInterruptedCopies(backupsDir: string): Promise<string[]> {
  const discarded: string[] = [];
  for (const entry of await readdir(backupsDir)) {
    if (!entry.endsWith(PARTIAL_SUFFIX)) continue;
    await rm(join(backupsDir, entry), { recursive: true, force: true });
    discarded.push(entry);
  }
  return discarded;
}

// Keep copied data for at most the newest failed backup (see the header).
async function stripOlderFailedData(backupsDir: string): Promise<void> {
  for (const old of (await readBackups(backupsDir)).filter(b => b.status === 'failed' && b.name.endsWith(FAILED_SUFFIX))) {
    await removeBackupData(old.path);
  }
}

async function removeBackupData(dir: string): Promise<void> {
  await rm(join(dir, DATA_DIR), { recursive: true, force: true });
  await rm(join(dir, ARCHIVE_FILE), { force: true });
}

async function prune(backupsDir: string, keep: number): Promise<void> {
  const verified = (await readBackups(backupsDir)).filter(b => b.status === 'ok');
  for (const old of verified.slice(Math.max(keep, 1))) {
    await rm(old.path, { recursive: true, force: true });
  }
}

/** Every backup of a store (verified and failed), newest first. */
export async function listStoreBackups(storePath: string, options: { backupsDir?: string } = {}): Promise<StoreBackup[]> {
  return readBackups(options.backupsDir ?? backupsDirFor(storePath));
}

async function readBackups(backupsDir: string): Promise<StoreBackup[]> {
  let entries: string[];
  try {
    entries = await readdir(backupsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`cannot list store backups in ${backupsDir}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const out: StoreBackup[] = [];
  for (const entry of entries) {
    // An in-progress copy is neither a backup nor a failure.
    if (entry.endsWith(PARTIAL_SUFFIX)) continue;
    const m = NAME.exec(entry);
    if (!m) continue;
    const path = join(backupsDir, entry);
    const st = await lstat(path).catch(() => null);
    if (!st?.isDirectory()) continue;
    const failed = Boolean(m[4]);
    let manifest: Partial<BackupManifest> | null = null;
    try {
      manifest = JSON.parse(await readFile(join(path, MANIFEST), 'utf-8')) as BackupManifest;
    } catch {
      // Handled, not swallowed: a backup without a readable manifest cannot be
      // trusted for a restore, so it is listed as failed below (manifest stays
      // null) rather than hidden. A failed backup may legitimately have none.
      manifest = null;
    }
    let error: string | null = null;
    if (failed) error = (await readFile(join(path, ERROR_FILE), 'utf-8').catch(() => '')).trim() || null;
    const ok = !failed && manifest !== null;
    out.push({
      name: entry,
      path,
      status: ok ? 'ok' : 'failed',
      taken_at: manifest?.taken_at ?? parseStamp(m[1]),
      from_version: manifest?.from_version ?? m[2],
      to_version: manifest?.to_version ?? m[3],
      file_count: manifest?.file_count ?? null,
      total_bytes: manifest?.total_bytes ?? null,
      duration_ms: manifest?.duration_ms ?? null,
      format: manifest?.format === 2 ? 'archive' : 'directory',
      stored_bytes: manifest?.format === 2 ? manifest.archive_bytes ?? null : manifest?.total_bytes ?? null,
      error: ok ? null : error ?? (failed ? null : 'its manifest is missing or unreadable'),
      store_state: isStoreState(manifest?.store_state) ? manifest!.store_state! : null,
    });
  }
  return out.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}

export interface RestoreResult {
  restored: StoreBackup;
  /** Where the store that was replaced now lives. Never deleted. */
  movedAsideTo: string | null;
  /**
   * Where earlier restores of this store that died mid-swap had moved the store
   * they were replacing, oldest first. The real pre-restore store is the FIRST
   * of these, not `movedAsideTo` (which then holds a half-swapped mix).
   */
  previouslyMovedAside: string[];
  /**
   * Symlinks the backup recorded but the restore did not recreate, because
   * they point outside the store (an archive is never allowed to make one).
   */
  skippedLinks: { path: string; target: string }[];
}

/**
 * What a restore leaves beside the store while it runs: who is running it and
 * where its two halves are. It outlives a restore that dies part-way through
 * the swap, so the store's next opener is told the store may be half old, half
 * restored, instead of opening it as if nothing happened.
 */
interface RestoreMarker {
  pid: number;
  holder_started_at?: string;
  holder_start_source?: StartTimeSource;
  /** Where `pid` lives (processNamespaceId); another namespace's pid cannot be judged here. */
  holder_namespace?: string;
  /** Written by a Lazy Teams project's machine (see StorageLockFile.holder_guest). */
  holder_guest?: boolean;
  started_at: string;
  backup: string;
  staging: string;
  moved_aside_to: string | null;
  /** Moved-aside stores of earlier restores that died mid-swap, oldest first. */
  previous?: string[];
}

export interface RestoreInProgress {
  marker: string;
  pid: number;
  started_at: string;
  backup: string;
  staging: string;
  movedAsideTo: string | null;
  /** Moved-aside stores of earlier interrupted restores, oldest first. */
  previous: string[];
  /** The process that wrote it is still running; false = a restore that died (meaningless when not judgeable). */
  alive: boolean;
  /**
   * False when it was written where a live holder is out of this side's sight
   * (a project's guest, seen from the host). A marker from an earlier boot of
   * this machine IS judgeable: its writer is dead, so it reads as interrupted.
   */
  judgeable: boolean;
  /** That namespace, when recorded. */
  namespace: string | null;
}

/**
 * Where a restore's marker lives: INSIDE the store, in its root. A Lazy Teams
 * project's machine mounts only the store directory, so a marker beside it
 * would be invisible to the one daemon it most needs to stop.
 */
export function restoreMarkerPathFor(storePath: string): string {
  return join(resolve(storePath), RESTORE_MARKER_FILENAME);
}

/** The restore running (or interrupted) on this store, or null when there is none. */
export async function readRestoreInProgress(storePath: string): Promise<RestoreInProgress | null> {
  const path = restoreMarkerPathFor(storePath);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new StoreBackupError(`cannot read the store restore marker ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let m: Partial<RestoreMarker>;
  try {
    m = JSON.parse(raw) as Partial<RestoreMarker>;
  } catch (err) {
    throw new StoreBackupError(
      `the store restore marker ${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}); ` +
        `a restore of this store may have been interrupted — check the store, then remove the marker`,
    );
  }
  const pid = typeof m.pid === 'number' ? m.pid : -1;
  const namespace = typeof m.holder_namespace === 'string' ? m.holder_namespace : null;
  const recordedHolder = {
    pid,
    started: m.holder_started_at ?? null,
    startedSource: m.holder_start_source ?? null,
    acquiredAt: m.started_at ?? null,
  };
  const verdict = await judgeHolderNamespace({ namespace, guest: m.holder_guest === true, holder: pid > 0 ? recordedHolder : null });
  const judgeable = verdict !== 'foreign';
  // 'dead' (an earlier boot, a container gone since): never judged by pid.
  const alive = verdict === 'judgeable' && pid > 0 && (await checkHolder(recordedHolder)).alive;
  return {
    marker: path,
    pid,
    started_at: String(m.started_at ?? 'unknown'),
    backup: String(m.backup ?? 'unknown'),
    staging: String(m.staging ?? 'unknown'),
    movedAsideTo: typeof m.moved_aside_to === 'string' ? m.moved_aside_to : null,
    previous: Array.isArray(m.previous) ? m.previous.filter((x): x is string => typeof x === 'string') : [],
    alive,
    judgeable,
    namespace,
  };
}

/**
 * Refuse to open a store a restore is swapping, or one a restore left half
 * swapped. The daemon calls this before it opens its store, so a `lazy`
 * command that auto-starts a daemon mid-restore gets a refusal rather than a
 * daemon whose writes land in a store being replaced under it.
 */
export async function assertNoRestoreInProgress(storePath: string): Promise<void> {
  const r = await readRestoreInProgress(storePath);
  if (!r) return;
  if (!r.judgeable) {
    throw new StoreBackupError(
      `a store restore started from another machine or pid namespace owns ${resolve(storePath)} ` +
        `(pid ${r.pid} in ${r.namespace}, since ${r.started_at}, restoring ${r.backup}); it may still be running, ` +
        `or it was interrupted — this side cannot tell. Wait for it to finish where it was started (on Lazy Teams, ` +
        `the host), or run it again there to finish an interrupted one; then start lazy again. ` +
        `The store it was replacing is at ${r.movedAsideTo ?? '(not moved yet)'}` +
        (r.previous.length ? `; the store as it was before ANY restore is at ${r.previous[0]}` : '') +
        ` (paths as seen where the restore ran).`,
    );
  }
  if (r.alive) {
    throw new StoreBackupError(
      `a store restore is running on ${resolve(storePath)} (pid ${r.pid}, since ${r.started_at}, restoring ${r.backup}); ` +
        `wait for it to finish, then start lazy again`,
    );
  }
  if (r.movedAsideTo === null && r.previous.length === 0) {
    throw new StoreBackupError(
      `a store restore of ${resolve(storePath)} was interrupted before it changed anything (pid ${r.pid}, started ${r.started_at}, restoring ${r.backup}); ` +
        `the store itself was not touched. Run \`lazy system store-restore ${r.backup}\` again, or remove ${r.marker} to leave the store as it is`,
    );
  }
  throw new StoreBackupError(
    `a store restore of ${resolve(storePath)} was interrupted (pid ${r.pid}, started ${r.started_at}, restoring ${r.backup}), ` +
      `so the store may be part old, part restored. Nothing was deleted: the store it was replacing is at ` +
      `${r.movedAsideTo ?? '(it had not been moved yet)'}, the verified copy it was swapping in at ${r.staging}. ` +
      (r.previous.length
        ? `Earlier interrupted restores moved stores aside too — the store as it was before ANY restore is at ${r.previous[0]}` +
          `${r.previous.length > 1 ? ` (then ${r.previous.slice(1).join(', ')})` : ''}. `
        : '') +
      `Run \`lazy system store-restore ${r.backup}\` again to finish it (the store as it is now is moved aside again), ` +
      `or put the moved-aside store back by hand and remove ${r.marker}`,
  );
}

export type RestorePhase = 'verifying' | 'staging' | 'swapping';

/**
 * The refusal for a store that is a mount point. The manual way out has to be an
 * exact snapshot that keeps the old contents: extracting straight over the
 * store only overlays the backup (files made after it stay), so the advice is
 * to move the old contents into a folder INSIDE the mount first.
 */
export function mountPointRefusal(storePath: string, backup: { path: string; format: string }): string {
  const source = backup.format === 'archive' ? join(backup.path, ARCHIVE_FILE) : join(backup.path, DATA_DIR);
  const bring = backup.format === 'archive' ? `unpack ${source} into` : `copy ${source} into`;
  return (
    `refusing to restore: ${storePath} is a mount point, and the restore moves its contents to and from ` +
    `directories beside it, which cannot cross filesystems. Nothing was changed. ` +
    `With the daemon stopped, move the store's contents into a new folder inside it (nothing is deleted), ` +
    `then ${bring} the emptied store and check the links it made.` +
    docsSuffix('store-backups-mount-point')
  );
}

/**
 * Restore a verified backup into `storePath`.
 *
 * The store's only writer must be stopped, and stays excluded for the WHOLE
 * restore, not just at its start: re-verifying and copying a large backup takes
 * minutes, and a daemon auto-started by any `lazy` command in that window would
 * otherwise have the store renamed out from under it. So, by default, the
 * restore takes `.storage-lock` before it reads anything and holds it until the
 * swap is done (a daemon holds the same lock for its life, so a running one
 * makes this refuse), and a marker beside the store makes a daemon starting
 * meanwhile refuse to (`assertNoRestoreInProgress`). `writer-stopped` is a
 * programmatic option only (no CLI flag): a caller that has stopped the store's
 * writer itself and cannot judge its lock file, as the Teams host cannot a
 * GUEST pid. There the marker is the only exclusion, so it is written before
 * anything else, verification included.
 *
 * Re-running a restore that died mid-swap is what that restore's refusal asks
 * for, so a dead marker is expected here. It is the only record of where the
 * real pre-restore store went: its moved-aside paths are carried forward
 * (`previous` in the new marker, `previouslyMovedAside` in the result), and if
 * this run fails before its own swap the old marker is put back unchanged.
 *
 * The backup is re-verified, copied to a staging directory beside the store,
 * and only then swapped in: the current store is MOVED to
 * `<store>.before-restore-<stamp>`, never deleted.
 */
export async function restoreStoreBackup(options: {
  storePath: string;
  backup: string;
  exclusion?: 'lock' | 'writer-stopped';
  /** How long to wait for `.storage-lock` before refusing (default 3s). */
  lockTimeoutMs?: number;
  /** Called as each phase starts. */
  onPhase?: (phase: RestorePhase) => void | Promise<void>;
  backupsDir?: string;
  now?: () => Date;
  /** Test seam: free bytes beside the store (default: statfs). */
  freeBytes?: (dir: string) => Promise<number>;
}): Promise<RestoreResult> {
  const storePath = resolve(options.storePath);
  const backups = await listStoreBackups(storePath, { backupsDir: options.backupsDir });
  const backup = backups.find(b => b.name === options.backup || b.path === resolve(options.backup));
  if (!backup) {
    throw new StoreBackupError(
      `no backup named ${options.backup} in ${options.backupsDir ?? backupsDirFor(storePath)}` +
        (backups.length ? ` (available: ${backups.map(b => b.name).join(', ')})` : ' (there are none)'),
    );
  }
  if (backup.status !== 'ok') {
    throw new StoreBackupError(`refusing to restore ${backup.name}: it is a FAILED backup${backup.error ? ` (${backup.error})` : ''}`);
  }

  const existing = await lstat(storePath).catch(() => null);
  if (existing && !existing.isDirectory()) throw new StoreBackupError(`refusing to restore: ${storePath} is not a directory`);
  // The lock file lives in the store directory, so there has to be one to hold it in.
  if (!existing) await mkdir(storePath, { recursive: true, mode: 0o700 });
  // The swap renames entries between the store and directories BESIDE it, which
  // only works on one filesystem. A store that is itself a mount point would
  // fail the first rename with EXDEV — so say so before anything is copied.
  const [storeDev, parentDev] = await Promise.all([stat(storePath), stat(dirname(storePath))]);
  if (storeDev.dev !== parentDev.dev) {
    throw new StoreBackupError(mountPointRefusal(storePath, backup));
  }

  const run = async (): Promise<RestoreResult> => {
    const markerPath = restoreMarkerPathFor(storePath);
    const prior = await readRestoreInProgress(storePath);
    if (prior && !prior.judgeable) {
      throw new StoreBackupError(
        `refusing to restore: a restore of ${storePath} started in another machine or pid namespace ` +
          `(pid ${prior.pid} in ${prior.namespace}, since ${prior.started_at}) may still be running, and this side ` +
          `cannot tell. Run the restore where that one was started; if it is certainly gone, remove ${prior.marker} first.`,
      );
    }
    if (prior?.alive && prior.pid !== process.pid) {
      throw new StoreBackupError(`another restore of ${storePath} is running (pid ${prior.pid}, since ${prior.started_at})`);
    }
    // A dead restore's marker is the only record of where the store as it was
    // before that restore went. It is kept byte for byte to be put back if this
    // run fails before its swap, and its moved-aside paths are carried forward.
    const priorMarkerText = prior ? await readFile(markerPath, 'utf-8') : null;
    const previous = prior ? [...prior.previous, ...(prior.movedAsideTo ? [prior.movedAsideTo] : [])] : [];

    const s = stamp((options.now ?? (() => new Date()))());
    const staging = `${storePath}.restoring-${s}`;
    const movedAsideTo = `${storePath}.before-restore-${s}`;
    const self = await selfIdentity();
    const namespace = await processNamespaceId();
    const marker: RestoreMarker = {
      pid: process.pid,
      ...(self?.started && self.startedSource ? { holder_started_at: self.started, holder_start_source: self.startedSource } : {}),
      ...(namespace ? { holder_namespace: namespace } : {}),
      ...(isVmGuest() ? { holder_guest: true } : {}),
      started_at: new Date().toISOString(),
      backup: backup.name,
      staging,
      // Recorded only once the move-aside directory exists (see below): a restore
      // killed while verifying or staging must not name a path that was never made.
      moved_aside_to: null,
      ...(previous.length ? { previous } : {}),
    };
    const writeMarker = async (text: string) => {
      await writeFile(`${markerPath}.${process.pid}.tmp`, text, { mode: 0o600 });
      await rename(`${markerPath}.${process.pid}.tmp`, markerPath);
    };
    // Written BEFORE verification, so a daemon starting at any point of this
    // restore refuses — the only exclusion there is in `writer-stopped` mode.
    await writeMarker(JSON.stringify(marker, null, 2) + '\n');

    let manifest: BackupManifest;
    let skippedLinks: { path: string; target: string }[] = [];
    // Kept only as evidence of a mismatch (the message names it); any other
    // staging failure removes it, so a failed restore never leaves a full-size
    // copy filling the disk the live store shares.
    let keepStaging = false;
    try {
      await options.onPhase?.('verifying');
      manifest = JSON.parse(await readFile(join(backup.path, MANIFEST), 'utf-8')) as BackupManifest;
      const archived = manifest.format === 2;
      const refuse = (err: unknown) => {
        throw new StoreBackupError(`refusing to restore ${backup.name}: ${err instanceof Error ? err.message : String(err)}`);
      };
      if (archived) await verifyArchive(join(backup.path, ARCHIVE_FILE), manifest).catch(refuse);
      else await verifyCopy(join(backup.path, DATA_DIR), manifest).catch(refuse);
      await options.onPhase?.('staging');
      const needed = manifest.total_bytes + FREE_SPACE_MARGIN_BYTES;
      const free = await (options.freeBytes ?? defaultFreeBytes)(dirname(storePath));
      if (free < needed) {
        throw new StoreBackupError(
          `refusing to restore ${backup.name}: unpacking it needs about ${formatBytes(needed)} beside the store ` +
            `(the store was ${formatBytes(manifest.total_bytes)}), and ${formatBytes(free)} is free in ${dirname(storePath)}. Nothing was changed.`,
        );
      }
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { recursive: true, mode: 0o700 });
      if (archived) {
        // Unpacking refuses any entry that could land outside staging; what
        // landed is then read back and checked against the manifest.
        skippedLinks = (await unpackArchive(join(backup.path, ARCHIVE_FILE), staging).catch(refuse)).skipped;
        await verifyCopy(staging, manifest).catch((err) => {
          keepStaging = true;
          throw new StoreBackupError(`the unpacked copy of ${backup.name} does not match its manifest; the store was not touched (staging left at ${staging}): ${err instanceof Error ? err.message : String(err)}`);
        });
      } else {
        const copied = await copyTree(join(backup.path, DATA_DIR), staging);
        await verifyCopy(staging, { ...manifest, files: copied.files, file_count: copied.files.length, total_bytes: copied.files.reduce((n, f) => n + f.size, 0) });
        const byPath = new Map(manifest.files.map(f => [f.path, f.sha256]));
        for (const f of copied.files) {
          if (byPath.get(f.path) !== f.sha256) { keepStaging = true; throw new StoreBackupError(`restore staging copy of ${f.path} does not match the backup; the store was not touched (staging left at ${staging})`); }
        }
      }
    } catch (err) {
      // Nothing in the store has moved during THIS run. With no earlier
      // marker there is nothing half-done to warn about; with one, the store is
      // still the half-swapped mix that marker describes, so it goes back.
      if (priorMarkerText !== null) await writeMarker(priorMarkerText);
      else await rm(markerPath, { force: true });
      if (!keepStaging) await rm(staging, { recursive: true, force: true });
      throw err;
    }

    // Swap CONTENTS, never the directory: on Lazy Teams the store directory is
    // a VM share source, and a share keeps serving the inode it was given —
    // renaming the directory would leave the guest on the moved-aside store.
    // Every top-level entry is moved aside, then every staged entry is moved
    // in; nothing is deleted. The lock file stays where it is: it is what is
    // keeping a writer out while this runs.
    await options.onPhase?.('swapping');
    try {
      await mkdir(movedAsideTo, { mode: 0o700 });
      await writeMarker(JSON.stringify({ ...marker, moved_aside_to: movedAsideTo }, null, 2) + '\n');
      for (const entry of await readdir(storePath)) {
        // The lock and the marker stay: they are what keeps writers out.
        if (isProcessFile(entry)) continue;
        await rename(join(storePath, entry), join(movedAsideTo, entry));
      }
      await fsyncDir(movedAsideTo);
      for (const entry of await readdir(staging)) await rename(join(staging, entry), join(storePath, entry));
      await rm(staging, { recursive: true, force: true });
      await fsyncDir(storePath);
    } catch (err) {
      // The marker stays: the store may now be part old, part restored, and
      // whatever opens it next must be told (assertNoRestoreInProgress).
      throw new StoreBackupError(
        `the restore failed while swapping the backup in, so ${storePath} may be part old, part restored: ` +
          `${err instanceof Error ? err.message : String(err)}. Nothing was deleted — the store it was replacing is at ` +
          `${movedAsideTo}, the verified copy at ${staging}` +
          (previous.length ? `; the store as it was before any restore is at ${previous[0]}` : '') +
          `. Run the restore again to finish it.`,
      );
    }
    await rm(markerPath, { force: true });
    await fsyncDir(dirname(storePath));
    return { restored: backup, movedAsideTo, previouslyMovedAside: previous, skippedLinks };
  };

  if (options.exclusion === 'writer-stopped') return run();
  // `restoreMarker: 'ignore'`: re-running an interrupted restore over its marker
  // is exactly what that marker's refusal asks for; run() judges it instead.
  const lock = new StorageLock(storePath, storePath, { acquireTimeoutMs: options.lockTimeoutMs ?? 3000, foreignHolder: 'refuse', restoreMarker: 'ignore' });
  try {
    await lock.acquire();
  } catch (err) {
    if (err instanceof UnjudgeableStorageLockError) throw new StoreBackupError(`refusing to restore: ${err.message}`);
    throw new StoreBackupError(
      `refusing to restore while the store is in use — stop the daemon first (lazy daemon stop). ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    return await run();
  } finally {
    lock.release();
  }
}

/** A backup's size for people: the store's size, and what it takes on disk when compressed. */
export function backupSizeText(b: StoreBackup): string {
  const store = formatBytes(b.total_bytes);
  return b.format === 'archive' && b.stored_bytes !== null ? `${store}, ${formatBytes(b.stored_bytes)} compressed` : store;
}

/** Short human form of a byte count. */
export function formatBytes(n: number | null): string {
  if (n === null) return 'unknown size';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

