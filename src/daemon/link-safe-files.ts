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
import { lstat, mkdir, open, realpath, rename, unlink } from 'fs/promises';
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
      await mkdir(cur, { mode: 0o700 });
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
 * Write `data` as a regular file at `rel` under `root`, creating real
 * directories on the way (never following a link) and replacing an existing
 * file by rename (never writing through one). Throws LinkRefusedError on any
 * link on the way.
 */
export async function writeRegularFileUnder(root: string, rel: string, data: string | Uint8Array, mode = 0o644): Promise<void> {
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
  await rename(tmp, target);
}
