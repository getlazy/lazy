/**
 * The pre-upgrade store backup, as a solo daemon and `lazy upgrade` take it.
 *
 * Runs BEFORE anything opens storage: a daemon starting on a different lazy
 * version than this project's previous start copies the store first
 * (src/storage/store-backup.ts), holding `.storage-lock`. A backup that fails
 * REFUSES the start — new code never runs against a store it could not back
 * up — and the refusal says why and how to bypass it, once, on purpose.
 *
 * Managed (Lazy Teams) daemons on the microVM backend skip it: the host takes
 * that backup before the roll, beside the store on the host, where it survives
 * the machine — a guest-side copy would land beside the guest's mount path.
 * A local-docker Teams daemon runs ON the host with the host's store path, so
 * it takes the backup like a solo daemon: that is what keeps the fleet
 * reconciler's ordinary start (after a roll whose backup failed) from running
 * new code on an unbacked store. Any other managed backend (unset included)
 * skips it rather than risk refusing a start over a path it cannot judge.
 */

import { mkdir, rename, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { getDaemonDir } from './paths';
import { isManagedMode, MANAGED_BACKEND_ENV } from '../config/managed-mode';
import { resolveStorePath } from '../storage';
import { loadConfig } from '../config/loader';
import {
  backupsDirFor,
  DEFAULT_BACKUP_KEEP,
  formatBytes,
  backupSizeText,
  listStoreBackups,
  measureStoreState,
  sameStoreState,
  takeStoreBackup,
  throttledProgress,
  StoreBackupError,
  type BackupProgress,
  type StoreBackup,
} from '../storage/store-backup';
import { logger } from '../utils/logger';
import { readLastDaemonVersion } from './upgrade-notice';

/** One-shot bypass, for a human who has read the refusal and chooses to go on. */
export const SKIP_STORE_BACKUP_ENV = 'LAZY_SKIP_STORE_BACKUP';

export type UpgradeBackupOutcome =
  | { kind: 'taken'; backup: StoreBackup }
  | { kind: 'already'; backup: StoreBackup }
  | { kind: 'skipped'; reason: string };

/**
 * Back up the store for an upgrade `from → to` unless a verified backup for
 * exactly that upgrade already exists AND the store has not changed since it
 * was taken. Throws an Error carrying the refusal text when the backup fails.
 *
 * The version pair alone is not enough: after A→B, B→A and A→B again, the
 * first A→B backup is days of work out of date, and reusing it would leave the
 * second upgrade with no backup of the store it actually opens. What the pair
 * IS good for is the case it exists for — the Teams local-docker roll backs up
 * and the start right after it would otherwise copy the unchanged store again.
 */
export async function backupStoreForUpgrade(opts: {
  projectRoot: string;
  fromVersion: string;
  toVersion: string;
  keep: number;
  reason: string;
  onProgress?: (progress: BackupProgress) => void;
}): Promise<UpgradeBackupOutcome> {
  const storePath = await resolveStorePath(opts.projectRoot);
  // A store with no tasks/ is a fresh install or a store not created yet:
  // there is nothing an upgrade could damage.
  if (!(await stat(join(storePath, 'tasks')).then(s => s.isDirectory(), () => false))) {
    return { kind: 'skipped', reason: `no existing store at ${storePath}` };
  }
  if (process.env[SKIP_STORE_BACKUP_ENV] === '1') {
    logger.warn(`${SKIP_STORE_BACKUP_ENV}=1: NOT backing up the store at ${storePath} before lazy ${opts.toVersion} opens it.`);
    return { kind: 'skipped', reason: `${SKIP_STORE_BACKUP_ENV}=1` };
  }
  try {
    const candidates = (await listStoreBackups(storePath)).filter(
      b => b.status === 'ok' && b.from_version === opts.fromVersion && b.to_version === opts.toVersion && b.store_state !== null,
    );
    if (candidates.length > 0) {
      // A large store's walk can take a while: report by time so the CLI that
      // started this daemon sees movement instead of calling the start failed.
      const walkProgress = throttledProgress(opts.onProgress);
      const now = await measureStoreState(storePath, (files, bytes) =>
        walkProgress({ phase: 'measuring', files: 0, bytes: 0, total_files: files, total_bytes: bytes }));
      const existing = candidates.find(b => sameStoreState(b.store_state, now));
      if (existing) return { kind: 'already', backup: existing };
    }
    const backup = await takeStoreBackup({
      storePath,
      fromVersion: opts.fromVersion,
      toVersion: opts.toVersion,
      reason: opts.reason,
      keep: opts.keep,
      onProgress: opts.onProgress,
    });
    return { kind: 'taken', backup };
  } catch (err) {
    throw new Error(storeBackupRefusal(storePath, opts.toVersion, err));
  }
}

export function storeBackupRefusal(storePath: string, toVersion: string, err: unknown): string {
  const cause = err instanceof Error ? err.message : String(err);
  const kept = err instanceof StoreBackupError && err.failedBackupPath ? `\n  failed copy kept at: ${err.failedBackupPath}` : '';
  return (
    `Not starting lazy ${toVersion} on this project: the store backup taken before every upgrade failed, ` +
    `so the new version has not touched the store.\n` +
    `  store: ${storePath}\n` +
    `  backups: ${backupsDirFor(storePath)}\n` +
    `  cause: ${cause}${kept}\n` +
    `Make room (or fix permissions) beside it for a compressed backup — about half the store's size plus 64 MiB — and try again. ` +
    `To start WITHOUT a backup, deliberately, run it once with ${SKIP_STORE_BACKUP_ENV}=1 ` +
    `(e.g. \`${SKIP_STORE_BACKUP_ENV}=1 lazy daemon start\`).`
  );
}

/**
 * While the daemon-start backup runs (before the daemon listens), its progress
 * is written here so the CLI that started the daemon can say what it is
 * waiting for instead of timing out (src/daemon/auto-start.ts). Housekeeping
 * in the daemon dir, like the version marker; removed when the backup ends.
 */
export const STORE_BACKUP_PROGRESS_FILE = 'store-backup-progress.json';

export interface StoreBackupProgressMarker extends BackupProgress {
  from_version: string;
  to_version: string;
  pid: number;
  updated_at: string;
}

export function storeBackupProgressPath(projectRoot: string): string {
  return join(getDaemonDir(projectRoot), STORE_BACKUP_PROGRESS_FILE);
}

/** One line for a person waiting on the backup. */
export function describeBackupProgress(p: BackupProgress): string {
  if (p.phase === 'measuring') return `measuring the store (${p.total_files} files, ${formatBytes(p.total_bytes)})`;
  if (p.phase === 'verifying') return `verified ${p.files} of ${p.total_files} files (${formatBytes(p.bytes)} of ${formatBytes(p.total_bytes)})`;
  return `archived ${p.files} of ${p.total_files} files (${formatBytes(p.bytes)} of ${formatBytes(p.total_bytes)})`;
}

/** Hands `write` one progress line at most every 2s, plus every phase change. */
export function backupProgressPrinter(write: (line: string) => void): (p: BackupProgress) => void {
  let last = 0;
  let phase = '';
  return (p) => {
    const now = Date.now();
    if (p.phase === phase && now - last < 2000) return;
    last = now;
    phase = p.phase;
    write(describeBackupProgress(p));
  };
}

/**
 * The daemon-start hook: back up when this start is on a different version
 * than the previous one. Throws (refusing the start) when the backup fails.
 */
export async function backupStoreIfVersionChanged(projectRoot: string): Promise<void> {
  if (isManagedMode() && process.env[MANAGED_BACKEND_ENV] !== 'local-docker') return;
  let version: string;
  try {
    version = (await import('../version')).VERSION;
  } catch {
    // No generated version file (some source/test trees): no upgrade to detect.
    return;
  }
  const previous = await readLastDaemonVersion(projectRoot);
  if (previous === null || previous === version) return;
  // Read here, at the moment it is used, rather than from the daemon's startup
  // config: it is not a setting the running daemon holds.
  const keep = (await loadConfig(projectRoot)).storage.backup_keep ?? DEFAULT_BACKUP_KEEP;
  const progressPath = storeBackupProgressPath(projectRoot);
  let writing: Promise<void> = Promise.resolve();
  let lastWrite = 0;
  let lastPhase = '';
  const writeProgress = (p: BackupProgress) => {
    const now = Date.now();
    // takeStoreBackup already reports about once a second, during the copy AND
    // the verification; this only keeps a burst from becoming a burst of writes.
    if (p.phase === lastPhase && now - lastWrite < 1000) return;
    lastPhase = p.phase;
    lastWrite = now;
    const marker: StoreBackupProgressMarker = { ...p, from_version: previous, to_version: version, pid: process.pid, updated_at: new Date(now).toISOString() };
    writing = writing.then(async () => {
      await mkdir(getDaemonDir(projectRoot), { recursive: true });
      const tmp = `${progressPath}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(marker) + '\n');
      await rename(tmp, progressPath);
    }).catch((err) => {
      logger.warn(`Could not record store backup progress at ${progressPath}: ${err instanceof Error ? err.message : String(err)}`);
    });
    logger.info(`Store backup before lazy ${version}: ${describeBackupProgress(p)}`);
  };
  let outcome: UpgradeBackupOutcome;
  try {
    outcome = await backupStoreForUpgrade({
      projectRoot,
      fromVersion: previous,
      toVersion: version,
      keep,
      reason: `daemon started on lazy ${version} (previous start: ${previous})`,
      onProgress: writeProgress,
    });
  } finally {
    await writing;
    await rm(progressPath, { force: true });
  }
  if (outcome.kind === 'taken') {
    const b = outcome.backup;
    logger.info(
      `Backed up the store before lazy ${version} opened it: ${b.path} ` +
        `(${b.file_count} files, ${backupSizeText(b)}, ${b.duration_ms} ms)`,
    );
  } else if (outcome.kind === 'already') {
    logger.info(`Store already backed up for ${previous} → ${version}: ${outcome.backup.path}`);
  } else {
    logger.info(`No store backup for ${previous} → ${version}: ${outcome.reason}`);
  }
}
