import { lstat, readFile, realpath } from 'fs/promises';
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

  return { kind: 'content', content: await readFile(resolved, 'utf-8') };
}
