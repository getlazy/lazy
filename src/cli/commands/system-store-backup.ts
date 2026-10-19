/**
 * `lazy system store-backup` / `store-backups` / `store-restore` — the
 * pre-upgrade store backups, by hand (src/storage/store-backup.ts).
 *
 * Lazy Teams' host runs `store-backup --store <path> --writer-stopped --json`
 * before every roll, so like `store-check` these need no project and start no
 * daemon (src/index.ts): a backup must never be the reason a daemon starts, and
 * a restore requires the daemon to be stopped.
 */

import { resolve } from 'path';
import { parseFlags } from '../helpers';
import { findLazyRoot } from '../../project-paths';
import { resolveStorePath } from '../../storage';
import {
  backupsDirFor,
  DEFAULT_BACKUP_KEEP,
  backupSizeText,
  listStoreBackups,
  restoreStoreBackup,
  takeStoreBackup,
  StoreBackupError,
  type StoreBackup,
} from '../../storage/store-backup';
import { loadConfig } from '../../config/loader';
import { promptYesNo } from '../editor';
import { backupProgressPrinter } from '../../daemon/upgrade-store-backup';

async function storeFromFlags(flags: Map<string, string | boolean | string[]>, command: string): Promise<{ store: string; keep: number }> {
  const explicit = flags.get('store');
  const keepFlag = flags.get('keep');
  let keep = DEFAULT_BACKUP_KEEP;
  if (typeof keepFlag === 'string') {
    keep = Number(keepFlag);
    if (!Number.isInteger(keep) || keep < 1) {
      console.error(`Error: --keep must be a whole number of at least 1, not "${keepFlag}".`);
      process.exit(1);
    }
  }
  if (typeof explicit === 'string') return { store: resolve(explicit), keep };
  const root = findLazyRoot();
  if (!root) {
    console.error(`Error: lazy system ${command} needs --store <path>, or to run inside a lazy project.`);
    process.exit(1);
  }
  const config = await loadConfig(root);
  if (typeof keepFlag !== 'string') keep = config.storage.backup_keep ?? DEFAULT_BACKUP_KEEP;
  return { store: await resolveStorePath(root), keep };
}

async function runningVersion(): Promise<string> {
  try {
    return (await import('../../version')).VERSION;
  } catch {
    return 'unknown';
  }
}

function describe(b: StoreBackup): string {
  const what = b.status === 'ok'
    ? `${b.file_count} files, ${backupSizeText(b)}${b.duration_ms !== null ? `, took ${b.duration_ms} ms` : ''}`
    : `FAILED${b.error ? ` — ${b.error}` : ''}`;
  return `${b.taken_at}  ${b.from_version} → ${b.to_version}  ${what}\n    ${b.path}`;
}

export async function commandSystemStoreBackup(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'store', takesValue: true },
    { name: 'from', takesValue: true },
    { name: 'to', takesValue: true },
    { name: 'keep', takesValue: true },
    { name: 'writer-stopped', takesValue: false },
    { name: 'json', takesValue: false },
  ], 'system store-backup');
  const { store, keep } = await storeFromFlags(parsed.flags, 'store-backup');
  const to = typeof parsed.flags.get('to') === 'string' ? String(parsed.flags.get('to')) : await runningVersion();
  const from = typeof parsed.flags.get('from') === 'string' ? String(parsed.flags.get('from')) : 'manual';
  const json = parsed.flags.get('json') === true;
  try {
    const backup = await takeStoreBackup({
      storePath: store,
      fromVersion: from,
      toVersion: to,
      keep,
      reason: from === 'manual' ? 'taken by hand (lazy system store-backup)' : `upgrade ${from} → ${to}`,
      exclusion: parsed.flags.get('writer-stopped') === true ? 'writer-stopped' : 'lock',
      onProgress: json ? undefined : backupProgressPrinter((line) => console.log(`  ${line}`)),
    });
    if (json) console.log(JSON.stringify({ ok: true, backup }, null, 2));
    else console.log(`Backed up ${store}\n  ${describe(backup)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failedPath = err instanceof StoreBackupError ? err.failedBackupPath : null;
    if (json) {
      console.log(JSON.stringify({ ok: false, error: message, failed_backup_path: failedPath }, null, 2));
    } else {
      console.error(`Error: the store backup failed: ${message}`);
      if (failedPath) console.error(`  The failed copy is kept at ${failedPath}.`);
      console.error(`  store: ${store}\n  backups: ${backupsDirFor(store)}`);
    }
    process.exit(1);
  }
}

export async function commandSystemStoreBackups(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'store', takesValue: true },
    { name: 'json', takesValue: false },
  ], 'system store-backups');
  const { store } = await storeFromFlags(parsed.flags, 'store-backups');
  const backups = await listStoreBackups(store);
  if (parsed.flags.get('json') === true) {
    console.log(JSON.stringify({ store, backups_dir: backupsDirFor(store), backups }, null, 2));
    return;
  }
  console.log(`Store:   ${store}\nBackups: ${backupsDirFor(store)}`);
  if (backups.length === 0) {
    console.log('  (none yet — one is taken before every upgrade)');
    return;
  }
  for (const b of backups) console.log(`  ${describe(b)}`);
}

export async function commandSystemStoreRestore(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'store', takesValue: true },
    { name: 'yes', takesValue: false },
  ], 'system store-restore');
  const name = parsed.positional[0];
  if (!name) {
    console.error('Error: lazy system store-restore needs a backup name (see `lazy system store-backups`).');
    process.exit(1);
  }
  const { store } = await storeFromFlags(parsed.flags, 'store-restore');
  if (parsed.flags.get('yes') !== true) {
    const ok = await promptYesNo(
      `Restore ${name} into ${store}? The current store is moved aside (never deleted).`,
      false,
    );
    if (!ok) {
      console.log('Cancelled; nothing was changed.');
      return;
    }
  }
  try {
    const result = await restoreStoreBackup({
      storePath: store,
      backup: name,
      onPhase: (phase) => {
        console.log(phase === 'verifying'
          ? '  Verifying the backup...'
          : phase === 'staging'
            ? '  Copying it beside the store...'
            : '  Swapping it in...');
      },
    });
    console.log(`Restored ${result.restored.name} into ${store}.`);
    for (const l of result.skippedLinks) console.log(`Not restored: the symlink ${l.path} → ${l.target}, which points outside the store.`);
    if (result.movedAsideTo) console.log(`The store it replaced was moved to ${result.movedAsideTo} (delete it yourself once you are sure).`);
    if (result.previouslyMovedAside.length > 0) {
      console.log(
        `That store was left half-swapped by an earlier interrupted restore. The store as it was before ANY restore is at ` +
          `${result.previouslyMovedAside[0]}${result.previouslyMovedAside.length > 1 ? ` (later moves: ${result.previouslyMovedAside.slice(1).join(', ')})` : ''}.`,
      );
    }
    console.log('Start the daemon again with `lazy daemon start`.');
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

export function systemStoreBackupUsage(): void {
  console.log(`Usage: lazy system store-backup [--store <path>] [--writer-stopped] [--from <v>] [--to <v>] [--keep <n>] [--json]

Save a lazy store as one compressed archive (store.tar.gz) in <store>.backups/
beside it, verify it (the archive read back and every file compared by size and
sha256), and keep the newest verified ones. lazy does this by itself before a
new version first opens the store; run it by hand for an extra backup.

The store's lock is held for the whole backup, so with the project's daemon
running this fails — stop it first (lazy daemon stop).

Options:
  --store <path>     The store directory (default: this project's store)
  --writer-stopped   Do not take the lock: the caller has already stopped the
                     store's only writer (what Lazy Teams' host does)
  --from, --to <v>   Versions recorded in the backup's name (default: manual → this lazy)
  --keep <n>         Verified backups to keep (default: [storage] backup_keep, 5)
  --json             Machine-readable result`);
}

export function systemStoreBackupsUsage(): void {
  console.log(`Usage: lazy system store-backups [--store <path>] [--json]

List a store's backups, newest first: when, which upgrade, size, and where.
Failed backups are listed too, with why.`);
}

export function systemStoreRestoreUsage(): void {
  console.log(`Usage: lazy system store-restore <backup> [--store <path>] [--yes]

Put a verified backup back. The daemon must be stopped (lazy daemon stop). The
backup is verified again, unpacked beside the store (or copied, for an older
plain-copy backup), checked, and swapped in; the store it
replaces is MOVED to <store>.before-restore-<time>, never deleted.

The store's lock is held for the whole restore, and a daemon that tries to
start meanwhile refuses to.

Options:
  --store <path>     The store directory (default: this project's store)
  --yes              Do not ask for confirmation

Note: a backup taken before an upgrade belongs with the lazy version it was
taken FROM — reinstall that version before starting the daemon on it.`);
}
