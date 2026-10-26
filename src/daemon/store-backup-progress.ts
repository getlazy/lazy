/**
 * What a daemon start's pre-upgrade store backup is doing, for whoever asks.
 *
 * The starting daemon writes its progress to `store-backup-progress.json` in
 * the daemon dir (src/daemon/upgrade-store-backup.ts) BEFORE it listens, so
 * nothing can ask it over RPC. Every surface that would otherwise say "not
 * running" or "lock held" reads this instead: the CLI that started the daemon,
 * `lazy daemon start --foreground`, `lazy daemon status`, the auto-start every
 * other command performs, and Lazy Teams' project diagnostics (which read the
 * same file and render its `line` verbatim, never re-deriving it).
 *
 * Kept small on purpose: the CLI imports it on every start.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { getDaemonDir } from './paths';
import { isProcessAlive } from './lifecycle';
import { formatBytes, type BackupProgress } from '../storage/store-backup';

export const STORE_BACKUP_PROGRESS_FILE = 'store-backup-progress.json';

/** A marker older than this is a process that stopped writing (wedged or gone). */
const STALE_AFTER_MS = 120_000;

export interface StoreBackupProgressMarker extends BackupProgress {
  from_version: string;
  to_version: string;
  pid: number;
  updated_at: string;
  /** Seconds left in the whole backup (copy and verification) at the rate so far; null before a rate is known. */
  eta_seconds: number | null;
  /** Set when this start found an interrupted backup and started it again from scratch. */
  restarted_interrupted?: boolean;
  /** The progress itself, already worded (`copying: 1.2 of 4.2 GiB …`). */
  line: string;
  /** What every surface shows: why the backup runs, then the progress. */
  summary?: string;
}

/** Why the backup runs, said as what it is: the way back to the version before. */
export function backupPurpose(fromVersion: string, toVersion: string): string {
  return `Backing up your store before lazy ${toVersion} opens it, so you can go back to ${fromVersion} if you need to`;
}

/**
 * How the last daemon-start backup ended, one line, for the CLI that started
 * that daemon to show once it answers (the progress marker is gone by then).
 */
export const STORE_BACKUP_RESULT_FILE = 'store-backup-result.json';

export interface StoreBackupResult { pid: number; line: string; at: string }

export function storeBackupResultPath(projectRoot: string): string {
  return join(getDaemonDir(projectRoot), STORE_BACKUP_RESULT_FILE);
}

/** The result line the start with `pid` wrote, or null. */
export async function readBackupResult(projectRoot: string, pid: number): Promise<string | null> {
  try {
    const r = JSON.parse(await readFile(storeBackupResultPath(projectRoot), 'utf-8')) as StoreBackupResult;
    return r.pid === pid && typeof r.line === 'string' ? r.line : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    console.error(`Warning: could not read the store backup result: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** The marker's full line: purpose, then progress. */
export function backupSummary(m: StoreBackupProgressMarker): string {
  return m.summary ?? `${backupPurpose(m.from_version, m.to_version)}: ${m.line}`;
}

export function storeBackupProgressPath(projectRoot: string): string {
  return join(getDaemonDir(projectRoot), STORE_BACKUP_PROGRESS_FILE);
}

function etaText(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '';
  if (seconds < 90) return `, about ${Math.max(1, Math.round(seconds))} s left`;
  return `, about ${Math.round(seconds / 60)} min left`;
}

/** One line for a person waiting on the backup. */
export function describeBackupProgress(p: BackupProgress, etaSeconds?: number | null): string {
  if (p.phase === 'measuring') return `measuring the store (${p.total_files} files, ${formatBytes(p.total_bytes)} so far)`;
  const verb = p.phase === 'verifying' ? 'verifying' : 'copying';
  return `${verb}: ${formatBytes(p.bytes)} of ${formatBytes(p.total_bytes)} (${p.files} of ${p.total_files} files)${etaText(etaSeconds)}`;
}

/**
 * Seconds left in the WHOLE backup, estimated from how fast the current phase
 * has gone since it began. During the copy that includes the verification
 * after it, which reads the whole archive again — counted at the copy's rate.
 * Null until there is enough to judge (a second in, some bytes done).
 */
export function phaseEta(p: BackupProgress, phaseStartedAt: number, now: number): number | null {
  if (p.phase === 'measuring') return null;
  const elapsed = (now - phaseStartedAt) / 1000;
  if (elapsed < 1 || p.bytes <= 0) return null;
  const rate = p.bytes / elapsed;
  const verifyAfter = p.phase === 'copying' ? p.total_bytes : 0;
  return Math.max(0, (p.total_bytes - p.bytes + verifyAfter) / rate);
}

/**
 * The backup a LIVE daemon start is running right now, or null: no marker, a
 * marker whose writer is gone, or one it stopped updating two minutes ago.
 * `pid` narrows it to one child (the CLI that spawned it).
 */
export async function readLiveBackupProgress(projectRoot: string, pid?: number): Promise<StoreBackupProgressMarker | null> {
  let marker: StoreBackupProgressMarker;
  try {
    marker = JSON.parse(await readFile(storeBackupProgressPath(projectRoot), 'utf-8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // Half-written JSON cannot happen (written via rename); anything else is
    // unexpected but must not break the command asking — it falls back to its
    // ordinary answer.
    console.error(`Warning: could not read the store backup progress: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (pid !== undefined && marker.pid !== pid) return null;
  if (!isProcessAlive(marker.pid)) return null;
  if (Date.now() - Date.parse(marker.updated_at) > STALE_AFTER_MS) return null;
  if (typeof marker.line !== 'string') marker.line = describeBackupProgress(marker, marker.eta_seconds);
  return marker;
}

/** "starting (PID n). Backing up your store before lazy X opens it, so you can go back to Y …: progress" */
export function startingLine(m: StoreBackupProgressMarker): string {
  return `starting (PID ${m.pid}). ${backupSummary(m)}`;
}
