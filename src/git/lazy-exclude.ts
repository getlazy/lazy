/**
 * Lazy's runtime files, excluded through the repository's own
 * `$GIT_COMMON_DIR/info/exclude`.
 *
 * `lazy init` also writes these rules into the project root's `.gitignore`, but
 * that file lives in ONE working tree and only reaches a task worktree once
 * somebody commits it — a project cloned or created on a Teams install never
 * does. A linked worktree cut from such a branch then sees its agent sandbox
 * (`.lazy-task-sandbox/.claude.json` and friends) as untracked-and-unignored,
 * and a `git add -A` stages it as the task's work. `info/exclude` lives in the
 * COMMON git dir, applies to every worktree of the repository, and is never
 * committed — git's mechanism for exactly this. It is the guarantee; the
 * `.gitignore` entries stay for a human's clone elsewhere.
 *
 * Written host-side only (init, daemon start, before every worktree add): the
 * common dir is read-only inside task containers.
 */
import { dirname, join, isAbsolute, resolve } from 'path';
import { mkdir, readFile, writeFile, rename, rm } from 'fs/promises';
import { runGit } from '../utils/git';
import { logger } from '../utils/logger';

/**
 * The runtime paths lazy writes into a project or task worktree.
 *
 * `.lazy/*` + `!.lazy/plugins/`, never `.lazy/`: a project commits its proxy
 * plugins under `.lazy/plugins/`, and git cannot re-include anything under an
 * excluded DIRECTORY. Excluding the directory's CONTENTS keeps the negation
 * effective.
 */
export const LAZY_RUNTIME_EXCLUDE_ENTRIES = ['.lazy-task-sandbox/', '.lazy-lock', '.lazy/*', '!.lazy/plugins/'];

/** Entries an earlier version of the block carried, swept from an unterminated block. */
const LEGACY_EXCLUDE_ENTRIES = ['.lazy/'];

export const LAZY_EXCLUDE_BEGIN = '# BEGIN lazy runtime files (managed by lazy — do not edit)';
export const LAZY_EXCLUDE_END = '# END lazy runtime files';

/**
 * The exclude file's text with lazy's marked block reconciled: any existing
 * block (wherever it sits, however it was edited) is replaced by the current
 * one; everything outside it is left byte-for-byte. Pure, for the unit test.
 *
 * A BEGIN with no END (a hand edit, a truncated file) must not swallow the
 * user's lines after it: only the marker and lazy's own entries are dropped.
 */
export function reconcileExcludeText(before: string): string {
  const lines = before.length > 0 ? before.replace(/\n$/, '').split('\n') : [];
  const kept: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i] === LAZY_EXCLUDE_BEGIN) {
      const end = lines.indexOf(LAZY_EXCLUDE_END, i + 1);
      if (end !== -1) { i = end + 1; continue; }
      // Unterminated: drop the marker and our entries, keep the rest.
      i++;
      while (i < lines.length && (LAZY_RUNTIME_EXCLUDE_ENTRIES.includes(lines[i]) || LEGACY_EXCLUDE_ENTRIES.includes(lines[i]))) i++;
      continue;
    }
    kept.push(lines[i]);
    i++;
  }
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  const block = [LAZY_EXCLUDE_BEGIN, ...LAZY_RUNTIME_EXCLUDE_ENTRIES, LAZY_EXCLUDE_END];
  return [...kept, ...(kept.length > 0 ? [''] : []), ...block].join('\n') + '\n';
}

/**
 * Ensure lazy's block in the repository's `info/exclude`. `cwd` may be the
 * project root or any worktree of it. Idempotent; returns true if it wrote.
 * Throws with context when the repository cannot be resolved or written.
 */
export async function ensureLazyExclude(cwd: string): Promise<boolean> {
  const res = await runGit(['rev-parse', '--git-common-dir'], { cwd });
  if (res.exitCode !== 0 || !res.stdout.trim()) {
    throw new Error(`cannot resolve the git common dir of ${cwd}: ${res.stderr || 'no output'}`);
  }
  const raw = res.stdout.trim();
  const commonDir = isAbsolute(raw) ? raw : resolve(cwd, raw);
  const excludePath = join(commonDir, 'info', 'exclude');

  let before = '';
  try {
    before = await readFile(excludePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`failed to read ${excludePath}: ${(err as Error).message}`);
    }
  }
  const after = reconcileExcludeText(before);
  if (after === before) return false;
  try {
    await mkdir(dirname(excludePath), { recursive: true });
    // Temp file + rename: worktrees are created concurrently (a cluster starts
    // several children at once), and a truncate-then-write would let a second
    // reconcile — or git — read a partial file and lose the user's lines.
    const tmp = `${excludePath}.lazy-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      await writeFile(tmp, after);
      await rename(tmp, excludePath);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  } catch (err) {
    throw new Error(`failed to write lazy's runtime-file excludes to ${excludePath}: ${(err as Error).message}`);
  }
  return true;
}

/**
 * Best-effort form for paths that must not fail because of it (daemon start,
 * worktree creation): logs a warning naming the file and carries on. The
 * dirty-check exclusions in operations.ts still keep lazy's own gates honest.
 */
export async function ensureLazyExcludeBestEffort(cwd: string): Promise<void> {
  try {
    await ensureLazyExclude(cwd);
  } catch (err) {
    logger.warn(`Could not add lazy's runtime files to the repository's info/exclude: ${(err as Error).message}`);
  }
}
