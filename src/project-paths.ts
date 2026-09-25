/**
 * Where a lazy project lives on disk.
 *
 * Resolving the git root, the lazy root, and the data directory name is
 * something every layer needs — the daemon opening storage, the logger picking
 * a log directory, the storage lock, the CLI. It is not a CLI concern and lives
 * here so nothing outside `src/cli/` has to import a CLI module to ask where
 * the project is.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getCredentialIndexPath } from './daemon/paths';

export const LAZY_DIR = '.lazy';
export const LEGACY_DIR = '.workshop';
export const CONFIG_FILENAME = 'lazy.toml';
export const LEGACY_CONFIG_FILENAME = 'workshop.toml';

/**
 * Find the git repository root from startDir, walking up the directory tree.
 * Handles worktrees by following the .git file to the main repo path.
 * Returns the main repo path, or null if not in a git repo.
 */
export function findGitRoot(startDir: string = process.cwd()): string | null {
  let dir = startDir;

  while (true) {
    const gitPath = join(dir, '.git');

    if (existsSync(gitPath)) {
      // Check if .git is a file (worktree) or directory (main repo)
      try {
        const gitContent = readFileSync(gitPath, 'utf-8');
        if (gitContent.startsWith('gitdir:')) {
          // This is a worktree - extract the main repo path
          const match = gitContent.match(/gitdir:\s*(.+?)\/\.git\/worktrees\//);
          if (match) {
            return match[1];
          }
        }
      } catch {
        // .git is a directory (main repo) - fall through
      }
      return dir;
    }

    const parent = join(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Find the lazy root, which is always in the main git repository (not worktrees).
 * In a worktree, .git is a file containing "gitdir: /path/to/main/.git/worktrees/xxx"
 * We parse this to find the main repository, which is where lazy.toml lives.
 *
 * A repo is considered a lazy project if it has:
 * 1. lazy.toml config file, OR
 * 2. .lazy/ directory (worktrees, logs, tmp), OR
 * 3. .workshop/ directory (legacy un-migrated repos), OR
 * 4. a Teams login bound to this git root (design doc §4.4, §4.7) — see
 *    `isBoundToTeamsSync` below.
 */
export function findLazyRoot(startDir: string = process.cwd()): string | null {
  const gitRoot = findGitRoot(startDir);
  if (!gitRoot) return null;

  // Check if the git root has lazy.toml, .lazy, or legacy .workshop
  if (existsSync(join(gitRoot, CONFIG_FILENAME))) {
    return gitRoot;
  }
  if (existsSync(join(gitRoot, LAZY_DIR))) {
    return gitRoot;
  }
  if (existsSync(join(gitRoot, LEGACY_DIR))) {
    return gitRoot;
  }
  if (isBoundToTeamsSync(gitRoot)) {
    return gitRoot;
  }
  return null;
}

/**
 * Sync, best-effort: does this git root hold a Teams login?
 *
 * `lazy login` anchors at the GIT root rather than requiring `lazy init` to
 * have run first (`src/teams/login.ts`'s own doc comment: "a bound clone has
 * no local daemon and no local store... requiring lazy init to have run
 * first would contradict the model this command exists to set up"). Without
 * this, that promise was false: `findLazyRoot` recognized none of the three
 * markers above for a freshly bound, never-`lazy init`-ed clone, so
 * `resolveLazyRoot()` — and therefore EVERY command, including the ones that
 * exist to drive a bound clone — refused with "not in a lazy project. Run
 * `lazy init` first", which then refuses too (`refuseIfBoundClone`). A
 * person who had just followed the documented happy path had no way out
 * except `lazy logout`.
 *
 * Deliberately SYNC and best-effort, mirroring `findGitRoot`/`findLazyRoot`
 * themselves (this file's own doc comment: "not a CLI concern", called from
 * every layer, long before an event loop is doing anything else) — the full,
 * throwing, async `readTeamsLogin` (`src/teams/login.ts`) is for a caller
 * that needs the login's CONTENTS and can afford to await one; this is for
 * the one yes/no `findLazyRoot` needs synchronously. It reads the credential
 * INDEX only (never a secret, so no keychain prompt), and answers `false` —
 * never throws — for anything it cannot parse, including the "more than one
 * login" case `readTeamsLogin` refuses on: that state is for
 * `MultipleTeamsLoginsError` and `lazy logout` to sort out, not for a marker
 * check to fail loudly over.
 */
function isBoundToTeamsSync(gitRoot: string): boolean {
  const indexPath = getCredentialIndexPath(gitRoot);
  if (!existsSync(indexPath)) return false;

  try {
    const parsed: unknown = JSON.parse(readFileSync(indexPath, 'utf-8'));
    const entries = (parsed as { credentials?: unknown } | null)?.credentials;
    if (!Array.isArray(entries)) return false;

    // 'teams:' must match TEAMS_CREDENTIAL_PREFIX in src/teams/login.ts —
    // not imported directly to keep this module free of that one's async
    // dependency chain (credentials/store.ts, config/loader.ts).
    return entries.some((entry) =>
      entry && typeof entry === 'object' &&
      typeof (entry as { provider?: unknown }).provider === 'string' &&
      (entry as { provider: string }).provider.startsWith('teams:') &&
      Boolean((entry as { binding?: unknown }).binding),
    );
  } catch {
    return false;
  }
}

/**
 * Get the data directory name for a lazy root.
 * Returns '.lazy' if it exists, otherwise '.workshop' for un-migrated repos.
 * Fallback: if .lazy/ does not exist but .workshop/ does, use .workshop/ (un-migrated repos).
 * If neither exists, returns '.lazy' (new projects).
 */
export function getDataDir(lazyRoot: string): string {
  if (existsSync(join(lazyRoot, LAZY_DIR))) {
    return LAZY_DIR;
  }
  if (existsSync(join(lazyRoot, LEGACY_DIR))) {
    return LEGACY_DIR;
  }
  return LAZY_DIR;
}
