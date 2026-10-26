import { constants } from 'fs';
import { link, lstat, mkdir, mkdtemp, open, rename, unlink } from 'fs/promises';
import type { Stats } from 'fs';
import { basename, join } from 'path';

export interface SetupFileRecovery { restored: boolean; backup?: string }

/**
 * Move the old directory entry out of the way before installing a restoration.
 * Never truncate it: a writer holding its old fd can still write to the recovery
 * copy. link() installs only into an absent path, so a replacement (including a
 * symlink) is never followed or overwritten. Copies live in Git-local metadata,
 * outside the tracked tree, and are deliberately retained for the operator.
 */
export async function restoreSetupFile(
  path: string,
  original: string | Uint8Array,
  expected: Buffer,
  inspected: Stats,
  gitDir: string,
  stillCurrent: () => Promise<boolean>,
): Promise<SetupFileRecovery> {
  let lock;
  const lockPath = join(gitDir, 'index.lock');
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { restored: false };
    throw new Error(`Cannot lock the index before recovering ${path}: ${(err as Error).message}`);
  }
  let backup: string | undefined;
  try {
    if (!await stillCurrent()) return { restored: false };
    const parent = join(gitDir, 'info', 'lazy-setup-recovery');
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(join(parent, 'copy-'));
    backup = join(dir, basename(path));
    const receipt = await open(join(dir, 'recovery.json'), 'wx', 0o600);
    try {
      await receipt.writeFile(JSON.stringify({ path, backup }, null, 2) + '\n');
      await receipt.sync();
    } finally { await receipt.close(); }
    // rename preserves even a symlink substituted since inspection, without
    // touching its target. Its private destination cannot clobber another copy.
    try { await rename(path, backup); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { restored: false };
      throw err;
    }
    const savedDirectory = await open(dir, constants.O_RDONLY);
    try { await savedDirectory.sync(); } finally { await savedDirectory.close(); }
    let matches = false;
    const stat = await lstat(backup);
    if (stat.isFile() && stat.dev === inspected.dev && stat.ino === inspected.ino && stat.mode === inspected.mode) {
      const saved = await open(backup, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await saved.sync();
        matches = (await saved.readFile()).equals(expected);
      } finally { await saved.close(); }
    }
    // Revalidate HEAD and staged changes after capturing the entry, while the
    // index lock excludes ordinary git writers. A mismatch is put back whole.
    if (!matches || !await stillCurrent()) {
      try { await link(backup, path); } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        // Somebody installed a newer entry: leave both it and our copy intact.
      }
      return { restored: false, backup };
    }
    const replacement = join(dir, 'restored');
    const output = await open(replacement, 'wx', inspected.mode & 0o777);
    try { await output.writeFile(original); await output.sync(); } finally { await output.close(); }
    try { await link(replacement, path); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { restored: false, backup };
      throw err;
    }
    return { restored: true, backup };
  } catch (err) {
    throw new Error(`Cannot safely recover ${path}${backup ? `; the captured entry is at ${backup}` : ''}: ${(err as Error).message}`);
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
