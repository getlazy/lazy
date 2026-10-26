import { constants, lstat, open, realpath } from 'fs/promises';
import { basename, dirname, join, sep } from 'path';

/**
 * Read one file out of a task worktree for the review surface — WITHOUT ever
 * following a symlink out of it.
 *
 * WHY THIS EXISTS: a task branch is agent-writable, so an agent can commit
 * `docs/x.md` as a symlink (mode 120000) pointing at `/etc/passwd` or
 * `~/.claude/...`. That path is genuinely part of the diff, so the expand
 * endpoint's file allow-list passes it — and a plain `readFile` would then
 * follow the link ON THE HOST and hand the target's content to the reviewer's
 * browser. The allow-list answers "which path may be read"; it cannot answer
 * "which bytes that path resolves to", which is what this does.
 *
 * The safe answer is also the CONSISTENT one: `git diff` renders a symlink as
 * its link-target text, so a caller that gets `notRegular` should read the blob
 * (`getFileAtCommit`) and show the same target string the hunks show. Following
 * the link would make the expanded context disagree with the hunk it surrounds
 * even when the target is harmless.
 *
 * Defence in depth, for the parent directories this cannot lstat individually:
 * the containing directory is resolved with `realpath` and must still be inside
 * `realpath(worktreePath)`. BOTH sides are realpath'd — on macOS `/tmp` and
 * `/var` are themselves symlinks (`/private/...`), so comparing a resolved path
 * against an unresolved root reports every read as an escape.
 */
export type WorktreeReadResult =
  /** A regular file inside the worktree. */
  | { kind: 'content'; content: string }
  /** Exists, but is a symlink / directory / device — do not follow it. */
  | { kind: 'notRegular' }
  /** No such file (or no such directory) inside the worktree. */
  | { kind: 'missing' }
  /** The path resolves outside the worktree. Refuse loudly; never read it. */
  | { kind: 'outside'; resolved: string };

export async function readWorktreeFileNoFollow(
  worktreePath: string,
  relativePath: string,
): Promise<WorktreeReadResult> {
  const located = await locateNoFollow(worktreePath, relativePath);
  if (located.kind !== 'file') return located;
  const read = await readOpenedNoFollow(located.resolved, Number.MAX_SAFE_INTEGER);
  if (read.kind !== 'content') return { kind: 'notRegular' };
  return { kind: 'content', content: new TextDecoder().decode(read.bytes) };
}

type Located =
  | { kind: 'file'; resolved: string; size: number }
  | { kind: 'notRegular' }
  | { kind: 'missing' }
  | { kind: 'outside'; resolved: string };

async function locateNoFollow(worktreePath: string, relativePath: string): Promise<Located> {
  let root: string;
  try {
    root = await realpath(worktreePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw new Error(
      `failed to resolve worktree ${worktreePath}: ${err instanceof Error ? err.message : err}`,
    );
  }

  const target = join(root, relativePath);
  let parent: string;
  try {
    parent = await realpath(dirname(target));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw new Error(
      `failed to resolve ${dirname(target)}: ${err instanceof Error ? err.message : err}`,
    );
  }

  if (parent !== root && !parent.startsWith(root + sep)) {
    return { kind: 'outside', resolved: join(parent, basename(target)) };
  }

  const resolved = join(parent, basename(target));
  let stats;
  try {
    // lstat, never stat: the whole point is to see the link, not its target.
    stats = await lstat(resolved);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw new Error(
      `failed to stat ${resolved}: ${err instanceof Error ? err.message : err}`,
    );
  }
  if (!stats.isFile()) return { kind: 'notRegular' };
  return { kind: 'file', resolved, size: stats.size };
}

/** {@link readWorktreeFileNoFollow}'s answer for bytes, bounded before reading. */
export type WorktreeBytesResult =
  | { kind: 'content'; bytes: Uint8Array }
  /** A regular file larger than the caller's limit — not read. */
  | { kind: 'tooLarge'; size: number }
  | { kind: 'notRegular' }
  | { kind: 'missing' }
  | { kind: 'outside'; resolved: string };

/**
 * The same no-follow read as {@link readWorktreeFileNoFollow}, returning raw
 * bytes (an image is not UTF-8) and refusing to read past `maxBytes`.
 */
export async function readWorktreeBytesNoFollow(
  worktreePath: string,
  relativePath: string,
  maxBytes: number,
): Promise<WorktreeBytesResult> {
  const located = await locateNoFollow(worktreePath, relativePath);
  if (located.kind !== 'file') return located;
  if (located.size > maxBytes) return { kind: 'tooLarge', size: located.size };
  return readOpenedNoFollow(located.resolved, maxBytes);
}

/**
 * Read through ONE file handle opened with O_NOFOLLOW | O_NONBLOCK, and judge
 * the file by `fstat` on that handle — never by the earlier `lstat`. The path
 * is agent-writable, so between the lstat and the read an agent could swap in
 * a symlink, a FIFO (a read that hangs) or a device such as /dev/zero (a read
 * that never ends); the handle is what is read, so what it is decides.
 */
export async function readOpenedNoFollow(
  resolved: string,
  maxBytes: number,
): Promise<{ kind: 'content'; bytes: Uint8Array } | { kind: 'tooLarge'; size: number } | { kind: 'notRegular' } | { kind: 'missing' }> {
  let handle;
  try {
    handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'missing' };
    // ELOOP: the final component became a symlink since the lstat.
    if (code === 'ELOOP') return { kind: 'notRegular' };
    throw new Error(`failed to open ${resolved}: ${err instanceof Error ? err.message : err}`);
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return { kind: 'notRegular' };
    if (stats.size > maxBytes) return { kind: 'tooLarge', size: stats.size };
    const bytes = new Uint8Array(stats.size);
    let at = 0;
    while (at < bytes.length) {
      const { bytesRead } = await handle.read(bytes, at, bytes.length - at, at);
      if (bytesRead === 0) break;
      at += bytesRead;
    }
    return { kind: 'content', bytes: at === bytes.length ? bytes : bytes.subarray(0, at) };
  } finally {
    await handle.close();
  }
}
