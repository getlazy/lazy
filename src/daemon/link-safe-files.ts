/**
 * Host-side file reads and writes that refuse to follow links, for the daemon
 * moving files between a task's turn-writable sandbox and a member's home
 * (./member-container.ts).
 *
 * The sandbox is written by agent turns, and by any process an earlier turn
 * left running in the task's container. A symlink planted there — the source
 * file, a directory on the way to it, or the destination directory on the way
 * back — would otherwise make the DAEMON, on the host, read or overwrite
 * whatever the link names (another project's files, the daemon's own state,
 * the human's ~/.ssh). So every path here is:
 *
 *   - resolved under a ROOT whose own realpath is taken first, and checked to
 *     stay under it (no `..`, no absolute segment);
 *   - walked one component at a time with `lstat`: every directory on the way
 *     must be a real directory, the file itself a regular file — a link
 *     anywhere is refused, loudly;
 *   - opened with O_NOFOLLOW, and the open descriptor `fstat`ed, so a link
 *     swapped in after the walk is refused by the kernel rather than followed.
 *
 * Writes never overwrite in place: a new file is created with O_EXCL next to
 * the target and renamed over it (a rename replaces a link, it never writes
 * through one).
 *
 * What remains is the window between the directory walk and the open for an
 * INTERMEDIATE directory swapped for a link by a concurrent process. After the
 * open the parent's realpath is re-checked against the root and the operation
 * undone when it moved, so the swap is detected rather than silently obeyed.
 */

import { constants } from 'fs';
import { link, lstat, mkdir, open, realpath, rename, unlink } from 'fs/promises';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'path';
import { randomBytes } from 'crypto';
import { logger } from '../utils/logger';

export class LinkRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinkRefusedError';
  }
}

/** A regular file larger than the read allowed — refused, but not a link. */
export class FileTooLargeError extends LinkRefusedError {
  constructor(message: string) {
    super(message);
    this.name = 'FileTooLargeError';
  }
}

function assertRelativeUnder(rel: string): string[] {
  const norm = normalize(rel);
  if (isAbsolute(norm) || norm === '..' || norm.startsWith(`..${sep}`) || norm.split(sep).includes('..')) {
    throw new LinkRefusedError(`refusing path ${rel}: it is not inside its root`);
  }
  return norm.split(sep).filter((p) => p && p !== '.');
}

function isUnder(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The realpath of a root that must be a real directory (not itself a link). */
export async function realRoot(root: string): Promise<string> {
  const st = await lstat(root);
  if (st.isSymbolicLink()) throw new LinkRefusedError(`refusing ${root}: it is a symbolic link`);
  if (!st.isDirectory()) throw new LinkRefusedError(`refusing ${root}: it is not a directory`);
  return realpath(root);
}

/**
 * Walk `parts` under `rootReal`, requiring every component to be a real
 * directory. Missing components: null, or created (0700) when `create`.
 */
async function walkDirs(rootReal: string, parts: string[], create: boolean): Promise<string | null> {
  let cur = rootReal;
  for (const part of parts) {
    cur = join(cur, part);
    let st;
    try {
      st = await lstat(cur);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      if (!create) return null;
      await mkdir(cur, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      st = await lstat(cur);
    }
    if (st.isSymbolicLink()) throw new LinkRefusedError(`refusing ${cur}: it is a symbolic link`);
    if (!st.isDirectory()) throw new LinkRefusedError(`refusing ${cur}: it is not a directory`);
  }
  return cur;
}

/**
 * Read a regular file at `rel` under `root`, or null when it (or a directory
 * on the way) does not exist. Throws LinkRefusedError on any link, a
 * non-regular file, or one larger than `maxBytes`.
 */
export async function readRegularFileUnder(root: string, rel: string, maxBytes: number): Promise<Buffer | null> {
  const parts = assertRelativeUnder(rel);
  const rootReal = await realRoot(root);
  const dir = await walkDirs(rootReal, parts.slice(0, -1), false);
  if (dir === null) return null;
  const path = join(dir, parts.at(-1)!);
  let pre;
  try {
    pre = await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (pre.isSymbolicLink()) throw new LinkRefusedError(`refusing ${path}: it is a symbolic link`);
  if (!pre.isFile()) throw new LinkRefusedError(`refusing ${path}: it is not a regular file`);
  const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new LinkRefusedError(`refusing ${path}: it is not a regular file`);
    if (st.size > maxBytes) throw new FileTooLargeError(`refusing ${path}: ${st.size} bytes is more than ${maxBytes}`);
    if (!isUnder(rootReal, await realpath(dirname(path)))) throw new LinkRefusedError(`refusing ${path}: its directory moved outside ${rootReal}`);
    return await fh.readFile();
  } finally {
    await fh.close();
  }
}

/**
 * True when `rel` under `root` is ALREADY a regular file holding exactly
 * `data`, granting no permission bit beyond `mode` — so writing it again would change
 * nothing but its inode and mtime. Never true for a link, a non-regular file,
 * a path whose directories are links, or anything unreadable: every such case
 * answers false and the caller's link-safe write deals with it.
 *
 * Exists because a write is not free for whoever watches the file: a dev
 * server watching `.env` restarts on every replace, and a watcher holding the
 * old inode loses it.
 */
export async function regularFileHolds(
  root: string,
  rel: string,
  data: string | Uint8Array,
  mode: number,
  owner?: { uid: number; gid: number },
): Promise<boolean> {
  const want = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
  let existing: Buffer | null;
  try {
    existing = await readRegularFileUnder(root, rel, want.length);
  } catch (err) {
    if (err instanceof LinkRefusedError) return false;
    throw err;
  }
  if (existing === null || !existing.equals(want)) return false;
  // Same bytes; it must also grant nothing `mode` does not (a secret someone
  // made world-readable is rewritten 0600). "Nothing beyond", not "equal", so
  // a umask that narrowed the original create does not force a write forever.
  // Read after the content: a file swapped in between only makes this answer
  // false (a write), never a skipped write over something else.
  let st;
  try {
    st = await lstat(join(await realRoot(root), ...assertRelativeUnder(rel)));
  } catch (err) {
    // Gone since the read: there is nothing to keep, so the caller writes.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  if (owner && (st.uid !== owner.uid || st.gid !== owner.gid)) return false;
  return st.isFile() && (st.mode & 0o7777 & ~mode) === 0;
}

/**
 * Write `data` as a regular file at `rel` under `root`, creating real
 * directories on the way (never following a link) and replacing an existing
 * file by rename (never writing through one). Throws LinkRefusedError on any
 * link on the way.
 *
 * `owner`, when given, is applied to the new file BEFORE it is renamed into
 * place, so the path never holds a file the intended owner cannot read — for
 * a root daemon writing into a worktree its container user owns.
 */
export async function writeRegularFileUnder(
  root: string,
  rel: string,
  data: string | Uint8Array,
  mode = 0o644,
  immutable = false,
  owner?: { uid: number; gid: number },
): Promise<void> {
  const parts = assertRelativeUnder(rel);
  const rootReal = await realRoot(root);
  const dir = (await walkDirs(rootReal, parts.slice(0, -1), true))!;
  const target = join(dir, parts.at(-1)!);
  try {
    const st = await lstat(target);
    if (!st.isFile() && !st.isSymbolicLink()) throw new LinkRefusedError(`refusing ${target}: it is not a regular file`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const tmp = join(dir, `.lazy-tmp-${randomBytes(6).toString('hex')}`);
  const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    await fh.writeFile(data);
    if (owner) await fh.chown(owner.uid, owner.gid);
  } finally {
    await fh.close();
  }
  if (!isUnder(rootReal, await realpath(dir))) {
    await unlink(tmp).catch((err) => {
      // Refusing anyway; a stray temp file in a directory that moved is logged, not fatal.
      logger.warn(`could not remove ${tmp}: ${err instanceof Error ? err.message : String(err)}`);
    });
    throw new LinkRefusedError(`refusing ${target}: its directory moved outside ${rootReal}`);
  }
  if (immutable) {
    try {
      await link(tmp, target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const existing = await readRegularFileUnder(root, rel, Buffer.byteLength(data));
      if (existing === null || !existing.equals(Buffer.from(data))) {
        throw new LinkRefusedError(`refusing ${target}: its immutable content differs`);
      }
    } finally {
      await unlink(tmp);
    }
  } else {
    await rename(tmp, target);
  }
}
