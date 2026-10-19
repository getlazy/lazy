/**
 * Keeping a task's DELIVERED files (per-task secret files the daemon writes
 * into the worktree — src/daemon/task-files.ts) out of every commit.
 *
 * This is the leaf half: paths, the manifest shape, and the `GIT_CONFIG_*`
 * env that points git's `core.excludesFile` at the task's own exclude list.
 * It imports nothing that runs git, so src/utils/git.ts can use it.
 *
 * WHY COMMAND-SCOPE ENV AND NOT A FILE GIT FINDS BY ITSELF
 * -------------------------------------------------------
 * - `$GIT_COMMON_DIR/info/exclude` is shared by EVERY worktree of the
 *   repository: a `/.env` there would hide another task's own `.env` (and the
 *   project root's) from `git add`.
 * - A per-worktree `core.excludesFile` needs `extensions.worktreeConfig`, which
 *   lazy refuses outright: it makes git read a turn-writable `config.worktree`
 *   as repository config (src/git/worktree-pointers.ts).
 * - `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` is command-scope config, outranks
 *   repository config, and is already how lazy configures the git it runs in a
 *   task worktree (`taskWorktreeGitEnv`, src/utils/git.ts). The supervisor puts
 *   the same entry in the agent's environment before every command, so an
 *   agent's own `git add -A` / `git commit -a` honours it too.
 *
 * The exclude file lives under `.lazy-task-sandbox/`, which the repository's
 * info/exclude already ignores (src/git/lazy-exclude.ts), at the same absolute
 * path inside a container as on the host. `core.excludesFile` REPLACES the
 * user's global excludes file, so the daemon copies that file's content in
 * ahead of the delivered paths. Nothing here is the last line of defence: an
 * agent can unset its own env or `git add -f`, and the content-hash guard at
 * lazy_commit and at accept (src/git/delivered-files.ts) refuses loudly.
 */

import { access } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';

/** The exclude list, relative to the worktree root. */
export const DELIVERED_FILES_EXCLUDE_REL = '.lazy-task-sandbox/task-files.exclude';
/**
 * Manifest of what was delivered: `{ files: [{ path, blob }] }`, `blob` being
 * git's object id of the content. Lets git-side guards that cannot reach the
 * daemon's registry (lazy_commit, the supervisor) recognise the file.
 */
export const DELIVERED_FILES_MANIFEST_REL = '.lazy-task-sandbox/task-files.json';

export interface DeliveredFileEntry {
  path: string;
  blob: string;
}

export function deliveredFilesExcludePath(worktreePath: string): string {
  return join(worktreePath, DELIVERED_FILES_EXCLUDE_REL);
}

/** git's object id for a blob with this content (`git hash-object`). */
export function gitBlobId(content: Uint8Array | string): string {
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : Buffer.from(content);
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

/**
 * Escape a literal path for a gitignore line, anchored at the worktree root.
 * `\` escapes git's glob specials and a leading `#`/`!`; trailing spaces are
 * escaped because git strips them otherwise.
 */
export function excludeLineFor(path: string): string {
  const escaped = path.replace(/[\\*?[\]!#]/g, ch => `\\${ch}`).replace(/ $/, '\\ ');
  return `/${escaped}`;
}

/** The `core.excludesFile` path for this worktree, or null when nothing was delivered. */
export async function deliveredExcludeFileFor(worktreePath: string): Promise<string | null> {
  const path = deliveredFilesExcludePath(worktreePath);
  try {
    await access(path);
    return path;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // Exists but unreadable: still point git at it — git reports the problem
    // itself, and pointing elsewhere would silently drop the exclusion.
    return path;
  }
}

/**
 * `env` with lazy's delivered-files `core.excludesFile` entry set to
 * `excludeFile` (or removed when null), every other `GIT_CONFIG_*` entry kept
 * in order. Pure; returns the replacement keys plus the ones to delete, so a
 * caller can apply it to `process.env`.
 */
export function withDeliveredFilesGitConfig(
  env: Record<string, string | undefined>,
  excludeFile: string | null,
): { set: Record<string, string>; unset: string[] } {
  const n = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10);
  const count = Number.isFinite(n) && n > 0 ? n : 0;
  const entries: Array<[string, string]> = [];
  for (let i = 0; i < count; i++) {
    const k = env[`GIT_CONFIG_KEY_${i}`];
    const v = env[`GIT_CONFIG_VALUE_${i}`] ?? '';
    if (k === undefined) continue;
    if (k.toLowerCase() === 'core.excludesfile' && v.endsWith(DELIVERED_FILES_EXCLUDE_REL)) continue;
    entries.push([k, v]);
  }
  if (excludeFile) entries.push(['core.excludesFile', excludeFile]);
  const set: Record<string, string> = {};
  entries.forEach(([k, v], i) => {
    set[`GIT_CONFIG_KEY_${i}`] = k;
    set[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  const unset: string[] = [];
  for (let i = entries.length; i < count; i++) unset.push(`GIT_CONFIG_KEY_${i}`, `GIT_CONFIG_VALUE_${i}`);
  if (entries.length > 0) set.GIT_CONFIG_COUNT = String(entries.length);
  else if (count > 0 || env.GIT_CONFIG_COUNT !== undefined) unset.push('GIT_CONFIG_COUNT');
  return { set, unset };
}
