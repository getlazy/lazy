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
import {
  backupPurpose,
  describeBackupProgress,
  phaseEta,
  storeBackupProgressPath,
  storeBackupResultPath,
  type StoreBackupProgressMarker,
} from './store-backup-progress';

export {
  STORE_BACKUP_PROGRESS_FILE,
  storeBackupProgressPath,
  describeBackupProgress,
  type StoreBackupProgressMarker,
} from './store-backup-progress';

/** One-shot bypass, for a human who has read the refusal and chooses to go on. */
export const SKIP_STORE_BACKUP_ENV = 'LAZY_SKIP_STORE_BACKUP';

export type UpgradeBackupOutcome =
  | { kind: 'taken'; backup: StoreBackup }
  | { kind: 'already'; backup: StoreBackup }
  | { kind: 'skipped'; reason: string };

/**
 * Back up the store for an upgrade `from → to` unless a verified backup of the
 * store AS IT IS NOW already exists — whichever upgrade took it. Throws an
 * Error carrying the refusal text when the backup fails.
 *
 * The match is the recorded store state, never the version pair. A pair alone
 * is not enough: after A→B, B→A and A→B again the first A→B backup is days of
 * work out of date — and the state check refuses it. Nor is a pair needed:
 * someone swapping between binaries on an unchanged store would otherwise
 * recopy gigabytes for every new pair.
 */
export async function backupStoreForUpgrade(opts: {
  projectRoot: string;
  fromVersion: string;
  toVersion: string;
  keep: number;
  reason: string;
  onProgress?: (progress: BackupProgress) => void;
  /** Told when an earlier backup was interrupted and is being started again from scratch. */
  onInterruptedDiscarded?: (names: string[]) => void;
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
    const candidates = (await listStoreBackups(storePath)).filter(b => b.status === 'ok' && b.store_state !== null);
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
      onInterruptedDiscarded: opts.onInterruptedDiscarded,
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


/** Hands `write` one progress line at most every 2s, plus every phase change. */
export function backupProgressPrinter(write: (line: string) => void): (p: BackupProgress) => void {
  let last = 0;
  let phase = '';
  let phaseStartedAt = Date.now();
  return (p) => {
    const now = Date.now();
    if (p.phase !== phase) phaseStartedAt = now;
    if (p.phase === phase && now - last < 2000) return;
    last = now;
    phase = p.phase;
    write(describeBackupProgress(p, phaseEta(p, phaseStartedAt, now)));
  };
}

/**
 * The daemon-start hook: back up when this start is on a different version
 * than the previous one. Throws (refusing the start) when the backup fails.
 *
 * Seen everywhere while it runs: progress goes to the daemon log, to the
 * progress marker every other surface reads (src/daemon/store-backup-progress.ts)
 * and — in a foreground start, where a person is watching this process — to
 * the terminal.
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
  // A background daemon's stdout is daemon.log, which the logger already
  // writes; only a foreground start has a person at this process's terminal.
  const toTerminal = process.env.LAZY_DAEMON_BACKGROUND !== '1';
  const say = (line: string) => {
    logger.info(line);
    // Final formatted output for the person running `--foreground`.
    if (toTerminal) console.log(line);
  };
  say(`Lazy ${version} is opening a store last used by lazy ${previous}: making sure there is a backup to go back to first (the daemon answers once that is done).`);
  const resultPath = storeBackupResultPath(projectRoot);
  await rm(resultPath, { force: true });
  let writing: Promise<void> = Promise.resolve();
  let lastWrite = 0;
  let lastSaid = 0;
  let lastPhase = '';
  let phaseStartedAt = Date.now();
  let restarted = false;
  const writeMarker = (marker: StoreBackupProgressMarker) => {
    writing = writing.then(async () => {
      await mkdir(getDaemonDir(projectRoot), { recursive: true });
      const tmp = `${progressPath}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(marker) + '\n');
      await rename(tmp, progressPath);
    }).catch((err) => {
      logger.warn(`Could not record store backup progress at ${progressPath}: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  const writeProgress = (p: BackupProgress) => {
    const now = Date.now();
    const phaseChanged = p.phase !== lastPhase;
    if (phaseChanged) phaseStartedAt = now;
    // takeStoreBackup already reports about once a second, during the copy AND
    // the verification; this only keeps a burst from becoming a burst of writes.
    if (!phaseChanged && now - lastWrite < 1000) return;
    lastPhase = p.phase;
    lastWrite = now;
    const eta = phaseEta(p, phaseStartedAt, now);
    const line = describeBackupProgress(p, eta) + (restarted ? ' — restarted from scratch after an interrupted backup' : '');
    writeMarker({
      ...p, from_version: previous, to_version: version, pid: process.pid, updated_at: new Date(now).toISOString(),
      eta_seconds: eta, restarted_interrupted: restarted, line, summary: `${backupPurpose(previous, version)}: ${line}`,
    });
    if (phaseChanged || now - lastSaid >= 5000) {
      lastSaid = now;
      say(`${backupPurpose(previous, version)}: ${line}`);
    }
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
      onInterruptedDiscarded: (names) => {
        restarted = true;
        say(`An earlier store backup was interrupted midway (${names.join(', ')}); it cannot be resumed, so it was removed and the backup starts again from scratch.`);
      },
    });
  } finally {
    await writing;
    await rm(progressPath, { force: true });
  }
  const result = backupOutcomeLine(outcome, previous);
  say(result);
  // For the CLI that started this daemon: it shows how the backup ended once
  // the daemon answers. Best effort — the log has the same line.
  await writeFile(resultPath, JSON.stringify({ pid: process.pid, line: result, at: new Date().toISOString() }) + '\n').catch((err) => {
    logger.warn(`Could not record the store backup result at ${resultPath}: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/**
 * How a pre-upgrade backup ended, as one line that says what the person now
 * has: where the backup is and the command that takes them back to `fromVersion`.
 */
export function backupOutcomeLine(outcome: UpgradeBackupOutcome, fromVersion: string): string {
  if (outcome.kind === 'skipped') return `No store backup needed: ${outcome.reason}`;
  const b = outcome.backup;
  const back = `To go back to lazy ${fromVersion}: \`lazy daemon stop\`, then \`lazy system store-restore ${b.name}\`.`;
  if (outcome.kind === 'already') return `Store already backed up at ${b.path}; nothing to copy. ${back}`;
  return `Backup saved: ${b.path} (${b.file_count} files, ${backupSizeText(b)}, ${Math.round((b.duration_ms ?? 0) / 1000)} s). ${back}`;
}

/**
 * What the coming pre-upgrade backup will cost, said BEFORE it starts: the
 * store's size and, judged by the newest verified backup's own speed, roughly
 * how long the copy takes. Null when there is no store to back up. A backup
 * of the unchanged store already on disk is named instead (nothing to copy).
 */
export async function describeUpcomingBackup(projectRoot: string): Promise<string | null> {
  const storePath = await resolveStorePath(projectRoot);
  if (!(await stat(join(storePath, 'tasks')).then(s => s.isDirectory(), () => false))) return null;
  const state = await measureStoreState(storePath);
  const backups = (await listStoreBackups(storePath)).filter(b => b.status === 'ok');
  if (backups.some(b => sameStoreState(b.store_state, state))) {
    return `The store (${formatBytes(state.bytes)}) matches a verified backup right now; if nothing writes to it before the daemon stops, that backup is reused and nothing is copied.`;
  }
  const timed = backups.find(b => b.total_bytes && b.duration_ms && b.duration_ms > 0);
  const time = timed
    ? `roughly ${Math.max(1, Math.round((state.bytes / (timed.total_bytes! / timed.duration_ms!)) / 1000))} s, going by the last backup's speed`
    : 'how long is shown as it goes (no earlier backup to judge by)';
  return `Before the new daemon opens your store (${formatBytes(state.bytes)}, ${state.files} files), lazy backs it up so you can go back to this version if you need to: ${time}. The daemon answers once it is done.`;
}
