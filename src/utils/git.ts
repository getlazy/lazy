/**
 * Shared git utilities for repository operations.
 */

import { existsSync } from 'node:fs';
import { logger } from './logger';
import { spawn } from './spawn';

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunGitOptions {
  cwd?: string;
  stdout?: 'pipe' | 'ignore';
  stderr?: 'pipe' | 'ignore';
  stdin?: Uint8Array;
  timeout?: number;
  /**
   * Extra environment for this invocation, MERGED over the current process
   * env (Bun's `env` option replaces it wholesale, which would strip PATH,
   * HOME and the git config discovery vars).
   *
   * Exists for the handful of git behaviours that have no command-line form —
   * `GIT_INDEX_FILE` in particular, which is how `src/git/lfs.ts` reads
   * attributes at an arbitrary ref on git versions predating
   * `check-attr --source`.
   */
  env?: Record<string, string>;
}

/**
 * Execute a git command asynchronously and return the result.
 * All git operations should use this to avoid blocking the event loop.
 * Can be overridden for testing via dependency injection.
 */
export async function runGit(args: string[], opts?: RunGitOptions | string): Promise<GitResult> {
  // Support legacy signature: runGit(args, cwd)
  const options: RunGitOptions = typeof opts === 'string' ? { cwd: opts } : (opts ?? {});

  const stdoutMode = options.stdout ?? 'pipe';
  const stderrMode = options.stderr ?? 'pipe';

  if (options.cwd && !existsSync(options.cwd)) {
    logger.warn(`runGit: working directory '${options.cwd}' does not exist, args: ${args.join(' ')}`);
    return {
      stdout: '',
      stderr: `git: working directory '${options.cwd}' does not exist`,
      exitCode: 1,
    };
  }

  const spawnOpts: Record<string, unknown> = {
    stdout: stdoutMode,
    stderr: stderrMode,
  };
  if (options.cwd) spawnOpts.cwd = options.cwd;
  if (options.stdin) spawnOpts.stdin = options.stdin;
  if (options.env) spawnOpts.env = { ...process.env, ...options.env };
  if (options.timeout !== undefined) spawnOpts.timeout = options.timeout;

  try {
    const proc = spawn(['git', ...args], spawnOpts) as any;
    const result = await proc.exited;
    return {
      stdout: stdoutMode === 'pipe' ? (await Bun.readableStreamToText(proc.stdout)).trim() : '',
      stderr: stderrMode === 'pipe' ? (await Bun.readableStreamToText(proc.stderr)).trim() : '',
      exitCode: proc.exitCode ?? result,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`runGit: git command failed with exception: ${message}, args: ${args.join(' ')}`);
    return {
      stdout: '',
      stderr: `git: command failed (${message})`,
      exitCode: 1,
    };
  }
}

/**
 * Finds the worktree path where the given branch is checked out.
 * Returns null if the branch is not checked out in any worktree.
 */
export async function findWorktreeForBranch(
  branch: string,
  root: string,
  git: (args: string[], cwd?: string) => Promise<GitResult> = runGit,
): Promise<string | null> {
  const listResult = await git(['worktree', 'list', '--porcelain'], root);
  if (listResult.exitCode !== 0) {
    return null;
  }

  // Parse worktree list output
  // Format:
  // worktree /path/to/worktree
  // HEAD <sha>
  // branch refs/heads/branchname
  // ...
  const lines = listResult.stdout.split('\n');
  let currentWorktreePath: string | null = null;

  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      currentWorktreePath = line.substring('worktree '.length);
    } else if (line.startsWith('branch ')) {
      const branchRef = line.substring('branch '.length);
      if (branchRef === `refs/heads/${branch}`) {
        return currentWorktreePath;
      }
    } else if (line === '') {
      // Empty line marks end of worktree entry
      currentWorktreePath = null;
    }
  }

  return null;
}

/**
 * Attempts to fast-forward a branch checked out in a worktree.
 * Returns { success: true } if the merge succeeds or if it's already up to date.
 * Returns { success: true, warning } if the merge fails (non-blocking — remote merge succeeded).
 */
export async function tryFastForwardInWorktree(
  targetBranch: string,
  worktreePath: string,
  remoteRef: string,
  remoteName: string,
  root: string,
  git: (args: string[], cwd?: string) => Promise<GitResult> = runGit,
): Promise<{ success: boolean; warning?: string }> {
  logger.debug(`fastForwardLocal: ${targetBranch} is checked out at ${worktreePath}, attempting ff-only merge`);

  // First fetch in the worktree to ensure we have the latest remote ref
  const fetchResult = await git(['fetch', remoteName, targetBranch], worktreePath);
  if (fetchResult.exitCode !== 0) {
    // INVARIANT: Fetch failure is a real failure — no silent fallback to success.
    // The caller must handle this (retry, inform user, etc.).
    const warning = `Branch ${targetBranch} is checked out in worktree at ${worktreePath}, but fetch failed: ${fetchResult.stderr.trim() || 'unknown error'}. Run \`git -C ${worktreePath} fetch && git -C ${worktreePath} pull\` to update manually.`;
    logger.warn(`fastForwardLocal: ${warning}`);
    return { success: false, warning };
  }

  const mergeResult = await git(['merge', '--ff-only', remoteRef], worktreePath);
  if (mergeResult.exitCode === 0) {
    logger.debug(`fastForwardLocal: ${targetBranch} fast-forwarded in worktree at ${worktreePath}`);
    return { success: true };
  }

  // Check if already up to date
  const stderr = mergeResult.stderr;
  if (stderr.includes('Already up to date') || mergeResult.stdout.includes('Already up to date')) {
    logger.debug(`fastForwardLocal: ${targetBranch} already up to date in worktree`);
    return { success: true };
  }

  // INVARIANT: A failed merge is a failure — never return success:true with a warning
  // to paper over it. The caller decides how to handle (retry, inform user, etc.).
  const warning = `Branch ${targetBranch} is checked out in worktree at ${worktreePath} and could not be fast-forwarded: ${mergeResult.stderr.trim() || 'unknown error'}. Run \`git -C ${worktreePath} pull\` to update manually.`;
  logger.warn(`fastForwardLocal: ${warning}`);
  return { success: false, warning };
}

/**
 * Fast-forward a local branch to match its remote counterpart.
 * Handles cases where the branch is checked out in the current repo or in a worktree.
 */
export async function fastForwardLocal(
  targetBranch: string,
  remoteName: string,
  root: string,
  git: (args: string[], cwd?: string) => Promise<GitResult> = runGit,
  shouldSkipWorktree?: (worktreePath: string) => boolean,
): Promise<{ success: boolean; warning?: string }> {
  // Detect whether targetBranch is currently checked out in the root repo.
  // `git fetch <remote> main:main` fails with "refusing to fetch into branch
  // checked out at ..." when main is the current branch. The accept command
  // typically runs from the user's main repo which is on main.
  const headResult = await git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  const currentBranch = headResult.exitCode === 0 ? headResult.stdout.trim() : null;
  const remoteRef = `${remoteName}/${targetBranch}`;

  if (currentBranch === targetBranch) {
    // Target branch IS checked out — fetch then ff-only merge.
    const fetchResult = await git(['fetch', remoteName, targetBranch], root);
    if (fetchResult.exitCode !== 0) {
      const warning = `Local ${targetBranch} has diverged from ${remoteRef}. Run \`git pull\` to reconcile.`;
      logger.warn(`fastForwardLocal: fetch failed: ${fetchResult.stderr}`);
      return { success: false, warning };
    }

    const mergeResult = await git(['merge', '--ff-only', remoteRef], root);
    if (mergeResult.exitCode === 0) {
      logger.debug(`fastForwardLocal: ${targetBranch} fast-forwarded to ${remoteRef}`);
      return { success: true };
    }

    // ff-only failed — local has diverged or is already up to date
    const stderr = mergeResult.stderr;
    if (stderr.includes('Already up to date') || mergeResult.stdout.includes('Already up to date')) {
      logger.debug(`fastForwardLocal: ${targetBranch} already up to date`);
      return { success: true };
    }

    const warning = `Local ${targetBranch} has diverged from ${remoteRef}. Run \`git pull\` to reconcile.`;
    logger.warn(`fastForwardLocal: ${warning}`);
    return { success: false, warning };
  }

  // Target branch is NOT checked out — use refspec fetch to advance the local ref.
  const result = await git(['fetch', remoteName, `${targetBranch}:${targetBranch}`], root);
  if (result.exitCode === 0) {
    logger.debug(`fastForwardLocal: ${targetBranch} fast-forwarded to ${remoteRef}`);
    return { success: true };
  }

  // Refspec fetch failed — check if it's because the branch is checked out in a worktree
  if (result.stderr.includes('checked out at') || result.stderr.includes('refusing to fetch')) {
    const worktreePath = await findWorktreeForBranch(targetBranch, root, git);
    if (worktreePath) {
      if (shouldSkipWorktree?.(worktreePath)) {
        const warning = `Skipped fast-forward of ${targetBranch}: worktree at ${worktreePath} belongs to an active task.`;
        logger.warn(`fastForwardLocal: ${warning}`);
        return { success: true, warning };
      }
      return await tryFastForwardInWorktree(targetBranch, worktreePath, remoteRef, remoteName, root, git);
    }
  }

  // Fetch failed — check if local is just behind (can fast-forward) vs truly diverged
  // First, ensure we have the latest remote ref
  const fetchRemoteResult = await git(['fetch', remoteName, targetBranch], root);
  if (fetchRemoteResult.exitCode !== 0) {
    const warning = `Failed to fetch ${remoteRef}. Run \`git fetch\` to update.`;
    logger.warn(`fastForwardLocal: ${warning}`);
    return { success: false, warning };
  }

  // Get local and remote SHAs
  const localShaResult = await git(['rev-parse', targetBranch], root);
  const remoteShaResult = await git(['rev-parse', remoteRef], root);

  if (localShaResult.exitCode !== 0 || remoteShaResult.exitCode !== 0) {
    const warning = `Failed to get SHA for ${targetBranch} or ${remoteRef}.`;
    logger.warn(`fastForwardLocal: ${warning}`);
    return { success: false, warning };
  }

  const localSha = localShaResult.stdout.trim();
  const remoteSha = remoteShaResult.stdout.trim();

  // Check if they're already the same (shouldn't happen after fetch failure, but check anyway)
  if (localSha === remoteSha) {
    logger.debug(`fastForwardLocal: ${targetBranch} already up to date`);
    return { success: true };
  }

  // Check if local is an ancestor of remote (i.e., local is behind, can fast-forward)
  const isAncestorResult = await git(['merge-base', '--is-ancestor', localSha, remoteSha], root);
  if (isAncestorResult.exitCode === 0) {
    // Local is behind — force-update the local ref to match remote
    logger.debug(`fastForwardLocal: ${targetBranch} is behind ${remoteRef}, force-updating local ref`);
    const updateResult = await git(['branch', '-f', targetBranch, remoteRef], root);
    if (updateResult.exitCode === 0) {
      logger.debug(`fastForwardLocal: ${targetBranch} fast-forwarded to ${remoteRef}`);
      return { success: true };
    }

    // git branch -f failed — check if it's because the branch is checked out in a worktree
    if (updateResult.stderr.includes('checked out at') || updateResult.stderr.includes('cannot force update')) {
      const worktreePath = await findWorktreeForBranch(targetBranch, root, git);
      if (worktreePath) {
        if (shouldSkipWorktree?.(worktreePath)) {
          const warning = `Skipped fast-forward of ${targetBranch}: worktree at ${worktreePath} belongs to an active task.`;
          logger.warn(`fastForwardLocal: ${warning}`);
          return { success: true, warning };
        }
        return await tryFastForwardInWorktree(targetBranch, worktreePath, remoteRef, remoteName, root, git);
      }
    }

    const warning = `Failed to update ${targetBranch} to ${remoteRef}: ${updateResult.stderr}`;
    logger.warn(`fastForwardLocal: ${warning}`);
    return { success: false, warning };
  }

  // Local has truly diverged (both have commits the other doesn't)
  const warning = `Local ${targetBranch} has diverged from ${remoteRef}. Run \`git pull\` to reconcile.`;
  logger.warn(`fastForwardLocal: ${warning}`);
  return { success: false, warning };
}

/**
 * Pre-flight check: validate that a local branch is in sync with the driver's
 * configured remote before performing an irreversible remote merge.
 *
 * "In sync" means local is equal to, behind, or ahead of the remote — any
 * linear relationship is fine. True divergence (both sides have commits the
 * other doesn't) is the failure case — it means fastForwardLocal will fail
 * after the remote merge, leaving things half-merged.
 *
 * Only checks the single remote that the driver uses — not all git remotes.
 * Users may have other remotes (heroku, personal forks) that are irrelevant.
 */
export async function validateBranchInSyncWithRemote(
  branch: string,
  remote: string,
  root: string,
  git: (args: string[], cwd?: string) => Promise<GitResult> = runGit,
): Promise<{ inSync: boolean; error?: string }> {
  // Fetch the branch from the driver's remote
  const fetchResult = await git(['fetch', remote, branch], root);
  if (fetchResult.exitCode !== 0) {
    // INVARIANT: Fetch failure is a real failure — no silent fallback.
    // If we can't verify sync, we must not proceed with an irreversible
    // remote merge that could leave local and remote diverged.
    return {
      inSync: false,
      error: `Failed to fetch ${branch} from ${remote}: ${fetchResult.stderr.trim() || 'unknown error'}. Check your network connection and retry.`,
    };
  }

  const remoteRef = `${remote}/${branch}`;

  // Get local and remote SHAs
  const localShaResult = await git(['rev-parse', branch], root);
  const remoteShaResult = await git(['rev-parse', remoteRef], root);

  if (localShaResult.exitCode !== 0 || remoteShaResult.exitCode !== 0) {
    // Can't resolve refs — fail rather than silently proceeding
    return {
      inSync: false,
      error: `Failed to resolve refs for ${branch} or ${remoteRef}. Ensure both branches exist.`,
    };
  }

  const localSha = localShaResult.stdout.trim();
  const remoteSha = remoteShaResult.stdout.trim();

  if (localSha === remoteSha) {
    return { inSync: true };
  }

  // Check if local is an ancestor of remote (local is behind — can fast-forward, OK)
  const localBehind = await git(['merge-base', '--is-ancestor', localSha, remoteSha], root);
  if (localBehind.exitCode === 0) {
    return { inSync: true };
  }

  // Check if remote is an ancestor of local (local is ahead — has unpushed commits, OK)
  // This is fine because local has everything remote has plus more. The post-merge
  // fast-forward will succeed since local can only be further ahead after merging.
  const localAhead = await git(['merge-base', '--is-ancestor', remoteSha, localSha], root);
  if (localAhead.exitCode === 0) {
    return { inSync: true };
  }

  // True divergence: both sides have commits the other doesn't
  return {
    inSync: false,
    error: `Local ${branch} has diverged from ${remoteRef} (both have commits the other doesn't). Reconcile with \`git pull\` or \`git push\` before accepting.`,
  };
}
