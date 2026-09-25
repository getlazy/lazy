/**
 * Recovery patches — "we are about to destroy worktree state, save it first".
 *
 * CLAUDE.md's recovery-file rule: work that cannot be kept must at least be
 * retrievable. `.lazy/recovery/` is gitignored, so writing here never dirties
 * the worktree the caller is about to clean, and it survives whatever the
 * caller does next.
 *
 * Lives in its own module because BOTH the pre-turn rollback (src/supervisor/
 * index.ts) and the last-resort settle in the merge phase (src/supervisor/
 * merge.ts) must save before they discard, and merge.ts cannot import from
 * index.ts (index.ts imports merge.ts).
 */

import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { runGit } from '../utils/git';
import { logWarn } from './log';

/**
 * What happened when we tried to preserve the worktree before discarding it.
 *
 * Three-valued on purpose. "Nothing to save" and "the save FAILED" look
 * identical from a `null` return, and a caller that treats them the same
 * destroys real work while telling the human there was none — the exact
 * failure mode a destructive recovery step must not have. A caller may only
 * discard on `saved` or `empty`; `failed` means it does not know what is on
 * disk, and must leave it alone.
 */
export type PatchSaveResult =
  | { outcome: 'saved'; path: string }
  | { outcome: 'empty' }
  | { outcome: 'failed'; reason: string };

/**
 * Save the worktree's current diff against HEAD so a discard is recoverable.
 *
 * `prefix` names the situation in the filename (`merge-rollback`,
 * `merge-settle`) so a human finding two patches can tell which is which.
 */
export async function saveWorktreePatch(
  worktreePath: string,
  prefix: string,
): Promise<PatchSaveResult> {
  try {
    const diff = await runGit(['diff', 'HEAD'], { cwd: worktreePath });
    if (diff.exitCode !== 0) {
      // NOT "nothing to save": git could not tell us what is uncommitted, so
      // anything uncommitted is now invisible to us rather than absent.
      const reason = diff.stderr.trim() || `git diff HEAD exited ${diff.exitCode}`;
      logWarn(
        `[supervisor] Could not read the worktree diff before discarding state: ${reason}`,
      );
      return { outcome: 'failed', reason };
    }
    if (!diff.stdout.trim()) return { outcome: 'empty' };
    const dir = join(worktreePath, '.lazy', 'recovery');
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const patchPath = join(dir, `${prefix}-${stamp}.patch`);
    await writeFile(patchPath, diff.stdout.endsWith('\n') ? diff.stdout : `${diff.stdout}\n`, 'utf-8');
    return { outcome: 'saved', path: patchPath };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logWarn(
      `[supervisor] Could not save a recovery patch before discarding worktree state: ${reason}`,
    );
    return { outcome: 'failed', reason };
  }
}
