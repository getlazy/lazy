import { join, dirname } from 'path';
import { LAZY_COAUTHOR_TRAILER } from '../constants';
import { logger } from '../utils/logger';
import { runGit } from '../utils/git';
import { withRemoteRetry } from '../utils/retry';
import { pathExists, ensureDir, stat, copyFile, chmod } from '../utils/fs';
import type { Task } from '../types';

export interface GitCommitInfo {
  sha: string;
  message: string;
}

/**
 * Check whether the repository has at least one commit.
 * Returns false on a freshly `git init`-ed repo with no commits.
 */
export async function repoHasCommits(cwd?: string): Promise<boolean> {
  const result = await runGit(['rev-parse', 'HEAD'], {
    cwd,
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return result.exitCode === 0;
}

export async function getCurrentSha(cwd?: string): Promise<string> {
  const result = await runGit(['rev-parse', 'HEAD'], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git rev-parse HEAD failed: ${result.stderr}`);
  }
  return result.stdout;
}

export async function getCurrentBranch(cwd?: string): Promise<string> {
  const result = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to get current branch: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * Get the remote's default branch name (e.g., "main" or "master").
 * Returns the branch name, falling back to "main" if it cannot be determined.
 *
 * This resolves the branch via `git symbolic-ref refs/remotes/<remote>/HEAD`,
 * which returns the remote's default branch regardless of what's checked out locally.
 */
export async function getRemoteDefaultBranch(cwd?: string, remoteName: string = 'origin'): Promise<string> {
  // Try to resolve the remote's default branch via symbolic-ref
  const result = await runGit(['symbolic-ref', `refs/remotes/${remoteName}/HEAD`], { cwd });
  if (result.exitCode === 0) {
    // Returns something like "refs/remotes/origin/main" — extract the branch name
    const ref = result.stdout.trim();
    const prefix = `refs/remotes/${remoteName}/`;
    if (ref.startsWith(prefix)) {
      return ref.slice(prefix.length);
    }
  }

  // Fallback to "main" if remote default cannot be determined
  logger.warn(`Could not resolve remote default branch for ${remoteName} — falling back to "main". Run "git remote set-head ${remoteName} --auto" to configure.`);
  return 'main';
}

/**
 * Resolve the literal "HEAD" (returned by getCurrentBranch in detached HEAD state)
 * to the remote's default branch name. Returns the branch unchanged if it's not "HEAD".
 *
 * This is needed because `git rev-parse --abbrev-ref HEAD` returns the literal string
 * "HEAD" when the repo is in detached HEAD state (e.g., when the main branch is checked
 * out in a worktree). Passing "HEAD" as a base ref to GitHub's PR API causes failures
 * like "Base ref must be a branch".
 */
export async function resolveDetachedHead(branch: string, cwd?: string, remoteName: string = 'origin'): Promise<string> {
  if (branch !== 'HEAD') return branch;

  const resolved = await getRemoteDefaultBranch(cwd, remoteName);
  logger.warn(`Detached HEAD detected — resolved to remote default branch '${resolved}'`);
  return resolved;
}

/**
 * Get the target branch for a task, resolving "HEAD" if present.
 *
 * Reads `remote_target_branch` from task metadata and applies `resolveDetachedHead`
 * if the value is "HEAD" (defense against legacy metadata with literal "HEAD" stored).
 *
 * Returns undefined if the task has no `remote_target_branch` metadata, allowing
 * callers to provide their own fallback (e.g., getCurrentBranch or 'main').
 */
export async function getTaskTargetBranch(task: Task, cwd: string, remoteName: string = 'origin'): Promise<string | undefined> {
  const targetBranch = task.metadata?.remote_target_branch;
  if (!targetBranch) return undefined;
  return await resolveDetachedHead(targetBranch, cwd, remoteName);
}

export async function createAndCheckoutBranch(name: string, cwd?: string): Promise<void> {
  const result = await runGit(['checkout', '-b', name], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git checkout -b ${name} failed: ${result.stderr}`);
  }
}

/**
 * Check if a branch already has a worktree checked out.
 * Returns the worktree path if found, or null if the branch has no worktree.
 */
export async function findWorktreeForBranch(branch: string, cwd?: string): Promise<string | null> {
  const result = await runGit(['worktree', 'list', '--porcelain'], { cwd });
  if (result.exitCode !== 0) return null;

  const lines = result.stdout.split('\n');

  let currentPath: string | null = null;
  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      currentPath = line.slice('worktree '.length);
    } else if (line.startsWith('branch refs/heads/') && currentPath) {
      const branchName = line.slice('branch refs/heads/'.length);
      if (branchName === branch) {
        return currentPath;
      }
    } else if (line === '') {
      currentPath = null;
    }
  }

  return null;
}

export async function createWorktree(path: string, branch: string, cwd?: string): Promise<void> {
  // Try creating with new branch first
  const result = await runGit(['worktree', 'add', path, '-b', branch], { cwd });
  if (result.exitCode === 0) return;

  // Branch already exists — attach worktree to existing branch
  const retry = await runGit(['worktree', 'add', path, branch], { cwd });
  if (retry.exitCode === 0) return;

  throw new Error(`git worktree add failed: ${retry.stderr}`);
}

export async function removeWorktree(path: string, cwd?: string): Promise<void> {
  const result = await runGit(['worktree', 'remove', path, '--force'], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git worktree remove failed: ${result.stderr}`);
  }
}

export async function getNewCommits(sinceSha: string, cwd?: string): Promise<GitCommitInfo[]> {
  const result = await runGit(['log', '--format=%H%n%s%n---END---', `${sinceSha}..HEAD`], { cwd });
  if (result.exitCode !== 0) {
    return [];
  }
  if (!result.stdout) return [];

  const commits: GitCommitInfo[] = [];
  const entries = result.stdout.split('---END---').filter((e) => e.trim());
  for (const entry of entries) {
    const lines = entry.trim().split('\n');
    if (lines.length >= 2) {
      commits.push({ sha: lines[0], message: lines[1] });
    }
  }
  return commits;
}

export async function getCommitDiff(sha: string, cwd?: string): Promise<string> {
  const result = await runGit(['show', '--no-color', '--format=', sha], { cwd });
  if (result.exitCode !== 0) {
    return '';
  }
  return result.stdout;
}

/**
 * Get the list of files changed in a commit.
 * Returns an array of file paths (added, modified, or deleted).
 */
export async function getCommitChangedFiles(sha: string, cwd?: string): Promise<string[]> {
  const result = await runGit(['diff-tree', '--no-commit-id', '--name-only', '-r', sha], { cwd });
  if (result.exitCode !== 0) {
    return [];
  }
  if (!result.stdout) return [];
  return result.stdout.split('\n').filter(f => f.length > 0);
}

/**
 * Get the content of a file at a specific commit.
 * Returns the file content as a string, or null if the file doesn't exist at that commit.
 */
export async function getFileAtCommit(sha: string, filepath: string, cwd?: string): Promise<string | null> {
  const result = await runGit(['show', `${sha}:${filepath}`], { cwd });
  if (result.exitCode !== 0) {
    return null;
  }
  return result.stdout;
}

export async function createTag(name: string, cwd?: string): Promise<void> {
  const result = await runGit(['tag', name], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git tag ${name} failed: ${result.stderr}`);
  }
}

export async function mergeBranch(branch: string, cwd?: string): Promise<void> {
  const result = await runGit(['merge', branch, '--no-ff', '-m', `Merge ${branch}`], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git merge ${branch} failed: ${result.stderr}`);
  }
}

/**
 * Get commit messages from a branch that are not in the target branch.
 * Used to build squash commit messages.
 */
export async function getBranchCommitMessages(sourceBranch: string, targetBranch: string, cwd?: string): Promise<string[]> {
  const result = await runGit(
    ['log', '--format=%s', `${targetBranch}..${sourceBranch}`],
    { cwd }
  );
  if (result.exitCode !== 0) {
    return [];
  }
  if (!result.stdout) return [];
  return result.stdout.split('\n');
}

/**
 * Squash-merge a branch into the current branch (HEAD).
 * Stages all changes but does not auto-commit; the caller must commit separately.
 */
export async function squashMergeBranch(branch: string, cwd?: string): Promise<void> {
  const result = await runGit(['merge', '--squash', branch], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git merge --squash ${branch} failed: ${result.stderr}`);
  }
}

/**
 * Squash-merge a source branch into a target branch.
 * Checks out the target, squash-merges, commits, then returns to the original branch.
 */
export async function squashMergeBranchIntoTarget(
  sourceBranch: string,
  targetBranch: string,
  commitMessage: string,
  cwd?: string
): Promise<void> {
  const originalBranch = await getCurrentBranch(cwd);

  const checkout = await runGit(['checkout', targetBranch], { cwd });
  if (checkout.exitCode !== 0) {
    throw new Error(`Failed to checkout ${targetBranch}: ${checkout.stderr}`);
  }

  try {
    const merge = await runGit(['merge', '--squash', sourceBranch], { cwd });
    if (merge.exitCode !== 0) {
      throw new Error(`Squash merge failed: ${merge.stderr}`);
    }

    // Check if the squash merge produced any staged changes
    const diffIndex = await runGit(['diff', '--cached', '--quiet'], { cwd });
    if (diffIndex.exitCode === 0) {
      throw new Error(`Nothing to merge: ${sourceBranch} has no changes relative to ${targetBranch}. Use 'lazy close' or 'lazy reject' instead.`);
    }

    const commit = await runGit(['commit', '-m', commitMessage], { cwd });
    if (commit.exitCode !== 0) {
      throw new Error(`Commit after squash merge failed: ${commit.stderr}`);
    }
  } finally {
    await runGit(['checkout', originalBranch], { cwd });
  }
}

export async function deleteBranch(branch: string, cwd?: string): Promise<void> {
  const result = await runGit(['branch', '-D', branch], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git branch -D ${branch} failed: ${result.stderr}`);
  }
}

export async function getDiffStat(fromRef: string, toRef: string = 'HEAD', cwd?: string, twoDot: boolean = false): Promise<string> {
  // Two-dot diff shows tree difference (for captured upstream SHA).
  // Three-dot diff compares against merge-base (for branch comparison).
  const range = twoDot ? `${fromRef}..${toRef}` : `${fromRef}...${toRef}`;
  const result = await runGit(['diff', '--no-color', '--stat', range], { cwd });
  if (result.exitCode !== 0) {
    return '';
  }
  let output = result.stdout;

  // If toRef is HEAD and there are uncommitted changes, include them
  if (toRef === 'HEAD' && await hasUncommittedChanges(cwd)) {
    const uncommittedStat = await runGit(['diff', '--no-color', '--stat', 'HEAD'], { cwd });
    if (uncommittedStat.exitCode === 0 && uncommittedStat.stdout) {
      output += '\n--- Uncommitted changes ---\n' + uncommittedStat.stdout;
    }
  }

  return output;
}

export async function getDiffFull(fromRef: string, toRef: string = 'HEAD', cwd?: string, twoDot: boolean = false): Promise<string> {
  // Two-dot diff shows tree difference (for captured upstream SHA).
  // Three-dot diff compares against merge-base (for branch comparison).
  const range = twoDot ? `${fromRef}..${toRef}` : `${fromRef}...${toRef}`;
  const result = await runGit(['diff', '--no-color', range], { cwd });
  if (result.exitCode !== 0) {
    return '';
  }
  let output = result.stdout;

  // If toRef is HEAD and there are uncommitted changes, include them
  if (toRef === 'HEAD' && await hasUncommittedChanges(cwd)) {
    const uncommittedDiff = await runGit(['diff', '--no-color', 'HEAD'], { cwd });
    if (uncommittedDiff.exitCode === 0 && uncommittedDiff.stdout) {
      output += '\n\n--- Uncommitted changes ---\n' + uncommittedDiff.stdout;
    }
  }

  return output;
}

export async function hasUncommittedChanges(cwd?: string): Promise<boolean> {
  // Exclude .lazy-task-sandbox/ from dirty worktree checks — it contains lazy's own
  // runtime artifacts (agent sessions, protocol files) and should never affect dirty state.
  const result = await runGit(['status', '--porcelain', '--', ':!.lazy-task-sandbox'], { cwd });
  if (result.exitCode !== 0) {
    return false;
  }
  if (!result.stdout) return false;

  // Filter out lazy-specific control files that are not real uncommitted work
  const lines = result.stdout.split('\n');
  const hasRealChanges = lines.some(line => {
    if (!line.trim()) return false; // Empty line
    // All other changes are real
    return true;
  });

  return hasRealChanges;
}

export async function getUncommittedDiff(cwd?: string): Promise<string> {
  // Get both staged and unstaged changes
  const staged = await runGit(['diff', '--no-color', '--cached'], { cwd });
  const unstaged = await runGit(['diff', '--no-color'], { cwd });

  let diff = '';
  if (staged.exitCode === 0 && staged.stdout) {
    diff += '--- STAGED CHANGES ---\n' + staged.stdout;
  }
  if (unstaged.exitCode === 0 && unstaged.stdout) {
    if (diff) diff += '\n\n';
    diff += '--- UNSTAGED CHANGES ---\n' + unstaged.stdout;
  }

  return diff;
}

export async function applyPatch(patch: string, cwd?: string): Promise<boolean> {
  // Apply a git patch to the working directory
  // Use git apply which handles both staged and unstaged changes
  const result = await runGit(['apply'], {
    cwd,
    stdin: new TextEncoder().encode(patch),
  });

  return result.exitCode === 0;
}

/**
 * Create a worktree branching from a specific commit SHA
 * Used when creating child tasks that branch from parent's current state
 */
export async function createWorktreeFromSha(path: string, branch: string, startSha: string, cwd?: string): Promise<void> {
  // Create worktree with new branch starting from specified SHA
  const result = await runGit(['worktree', 'add', path, '-b', branch, startSha], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git worktree add from SHA failed: ${result.stderr}`);
  }
}

/**
 * Merge a source branch into a target branch (used for child→parent merges)
 * This checks out the target branch in the main repo, merges, then returns to original branch
 */
export async function mergeBranchIntoTarget(sourceBranch: string, targetBranch: string, message?: string, cwd?: string): Promise<void> {
  // Save current branch
  const originalBranch = await getCurrentBranch(cwd);

  // Checkout target branch
  const checkout = await runGit(['checkout', targetBranch], { cwd });
  if (checkout.exitCode !== 0) {
    throw new Error(`Failed to checkout ${targetBranch}: ${checkout.stderr}`);
  }

  try {
    // Merge source branch
    const mergeMsg = message ?? `Merge ${sourceBranch} into ${targetBranch}`;
    const merge = await runGit(['merge', sourceBranch, '--no-ff', '-m', mergeMsg], { cwd });
    if (merge.exitCode !== 0) {
      throw new Error(`Merge failed: ${merge.stderr}`);
    }
  } finally {
    // Return to original branch (best effort)
    await runGit(['checkout', originalBranch], { cwd });
  }
}

/**
 * Check if a branch exists (any ref — local, remote, or tag).
 */
export async function branchExists(branch: string, cwd?: string): Promise<boolean> {
  const result = await runGit(['rev-parse', '--verify', branch], { cwd });
  return result.exitCode === 0;
}

/**
 * Check if a LOCAL branch exists (refs/heads/ only).
 *
 * Unlike branchExists(), this explicitly checks refs/heads/<branch> so it
 * won't match remote tracking branches (refs/remotes/origin/<branch>).
 * Use this before git push to avoid "src refspec does not match any" errors
 * on machines where the local branch was never created (e.g., after migration).
 */
export async function localBranchExists(branch: string, cwd?: string): Promise<boolean> {
  const result = await runGit(['rev-parse', '--verify', `refs/heads/${branch}`], { cwd });
  return result.exitCode === 0;
}

export interface WorktreeRecoveryResult {
  recovered: boolean;
  branchExists: boolean;
  dirty: boolean;
}

/**
 * Attempt to recover a missing worktree by recreating it from an existing branch.
 * Returns recovery status including whether the worktree is dirty after recreation.
 *
 * If the branch exists in git, the worktree is recreated at the given path.
 * If the branch is gone, recovery fails and the caller should show an error.
 */
export async function recoverMissingWorktree(
  worktreePath: string,
  branch: string,
  cwd?: string,
): Promise<WorktreeRecoveryResult> {
  if (!await branchExists(branch, cwd)) {
    return { recovered: false, branchExists: false, dirty: false };
  }

  // Prune stale worktree entries so git doesn't reject the add
  await runGit(['worktree', 'prune'], { cwd });

  const result = await runGit(['worktree', 'add', worktreePath, branch], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to recreate worktree: ${result.stderr}`);
  }

  // Check if the recreated worktree has uncommitted changes
  const dirty = await hasUncommittedChanges(worktreePath);

  return { recovered: true, branchExists: true, dirty };
}

/**
 * Fetch a branch from a remote and create a local tracking branch.
 *
 * Returns true if the branch was fetched and now exists locally,
 * false if the branch doesn't exist on the remote.
 * Throws if a network/auth error persists after retries.
 */
export async function fetchRemoteBranch(
  branch: string,
  remoteName: string = 'origin',
  cwd?: string,
): Promise<boolean> {
  let branchNotOnRemote = false;

  await withRemoteRetry(
    async () => {
      const result = await runGit(
        ['fetch', remoteName, `${branch}:refs/heads/${branch}`],
        { cwd },
      );
      if (result.exitCode !== 0) {
        const stderr = result.stderr.toLowerCase();
        // "couldn't find remote ref" / "no such remote ref" means the branch
        // genuinely doesn't exist on the remote — retrying won't help.
        if (
          stderr.includes("couldn't find remote ref") ||
          stderr.includes('no such remote ref')
        ) {
          branchNotOnRemote = true;
          return;
        }
        throw new Error(result.stderr.trim());
      }
    },
    `fetch branch ${branch} from ${remoteName}`,
  );

  if (branchNotOnRemote) {
    return false;
  }
  return await branchExists(branch, cwd);
}

/**
 * Attempt to recover a missing worktree, fetching the branch from a remote
 * if it doesn't exist locally.
 *
 * This is the async counterpart of recoverMissingWorktree — it first tries
 * a local recovery, and if the branch is missing locally, fetches from the
 * remote before retrying.
 */
export async function recoverMissingWorktreeWithFetch(
  worktreePath: string,
  branch: string,
  remoteName: string = 'origin',
  cwd?: string,
): Promise<WorktreeRecoveryResult> {
  // Try local recovery first (fast path)
  if (await branchExists(branch, cwd)) {
    return await recoverMissingWorktree(worktreePath, branch, cwd);
  }

  // Branch not local — try fetching from remote
  logger.info(`Branch '${branch}' not found locally. Fetching from ${remoteName}...`);
  const fetched = await fetchRemoteBranch(branch, remoteName, cwd);
  if (!fetched) {
    return { recovered: false, branchExists: false, dirty: false };
  }

  logger.info(`Fetched branch '${branch}' from ${remoteName}.`);
  return await recoverMissingWorktree(worktreePath, branch, cwd);
}

/**
 * Check if `branch` has been squash-merged into `targetBranch`.
 *
 * After a squash merge, the branch's commits are NOT ancestors of the target (since the
 * squash creates a new single commit), but the tree contents are identical. This function
 * detects that case by checking:
 * 1. The branch has diverged from the target (has unique commits — not a freshly created branch)
 * 2. The diff between the branch and target is empty (contents are identical)
 *
 * Also returns true for regular merges where the branch is an ancestor of the target.
 */
export async function isBranchMergedInto(branch: string, targetBranch: string, cwd?: string): Promise<boolean> {
  // Fast path: check if this is a regular (non-squash) merge
  const ancestorCheck = await runGit(['merge-base', '--is-ancestor', branch, targetBranch], { cwd });
  if (ancestorCheck.exitCode === 0) {
    // Branch is ancestor of target. But this is also true for freshly created branches
    // that have no new commits. Check that the branch actually has work on it by verifying
    // the branch tip is not the merge-base (i.e., they haven't diverged at all).
    const mergeBase = await runGit(['merge-base', branch, targetBranch], { cwd });
    const branchTip = await runGit(['rev-parse', branch], { cwd });
    if (mergeBase.exitCode === 0 && branchTip.exitCode === 0) {
      if (mergeBase.stdout === branchTip.stdout) {
        // Branch tip equals merge-base — no unique commits, freshly created branch
        return false;
      }
    }
    return true;
  }

  // Squash-merge detection: branch has unique commits but contents match target
  // First check the branch has diverged (has commits not on target)
  const branchCommits = await runGit(
    ['rev-list', '--count', `${targetBranch}..${branch}`],
    { cwd }
  );
  if (branchCommits.exitCode !== 0) return false;
  const count = parseInt(branchCommits.stdout, 10);
  if (count === 0) return false; // No unique commits — not merged, just empty

  // Guard: if ALL unique commits are empty (no file changes), this is not a squash merge.
  // This prevents false positives from --allow-empty initial commits created by `lazy start`.
  const mergeBase = await runGit(['merge-base', branch, targetBranch], { cwd });
  if (mergeBase.exitCode === 0) {
    const filesChanged = await runGit(['diff', '--name-only', mergeBase.stdout, branch], { cwd });
    if (filesChanged.exitCode === 0 && filesChanged.stdout === '') {
      // Branch has commits but zero file changes — not a real merge, just empty commits
      return false;
    }
  }

  // Branch has unique commits with real file changes. Check if the tree contents are
  // identical to target (squash merged).
  const diff = await runGit(['diff', '--quiet', targetBranch, branch], { cwd });
  return diff.exitCode === 0; // exit 0 = no diff = contents match
}

/**
 * Check if a commit on `targetBranch` mentions the given text in its commit message.
 * Used to detect squash-merge commits when the source branch has been deleted.
 * Searches the last `limit` commits (default 100).
 */
export async function findCommitByMessage(targetBranch: string, searchText: string, cwd?: string, limit: number = 100): Promise<boolean> {
  const result = await runGit(
    ['log', targetBranch, `--max-count=${limit}`, '--format=%s', '--grep', searchText],
    { cwd }
  );
  if (result.exitCode !== 0) return false;
  return result.stdout.length > 0;
}

/**
 * True iff `target` (a commit-ish — branch, ref, or SHA) has commits that
 * aren't reachable from HEAD. Used to decide whether an upstream merge is
 * needed.
 *
 * INVARIANT (fix-sync-no-merge): errors throw with an actionable message —
 * they do NOT return false. The previous silent-false behavior was the
 * mechanism by which `lazy sync` reported fake "completed successfully"
 * responses while no merge ran. Per CLAUDE.md "errors are actionable",
 * a broken rev-list, a missing ref, or a malformed working tree must
 * surface to the caller rather than masquerading as "up to date".
 */
export async function hasUpstreamChanges(target: string, cwd?: string): Promise<boolean> {
  const result = await runGit(
    ['rev-list', '--count', `HEAD..${target}`],
    { cwd }
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `git rev-list HEAD..${target} failed${cwd ? ` in ${cwd}` : ''}: ${result.stderr || 'unknown error'}`,
    );
  }
  const count = parseInt(result.stdout, 10);
  if (Number.isNaN(count)) {
    throw new Error(
      `git rev-list HEAD..${target} returned non-numeric output: ${JSON.stringify(result.stdout)}`,
    );
  }
  return count > 0;
}

/**
 * Count how many commits targetBranch has that are not in sourceBranch.
 * Returns 0 if the count cannot be determined.
 */
export async function getCommitsBehindCount(sourceBranch: string, targetBranch: string, cwd?: string): Promise<number> {
  if (!await branchExists(targetBranch, cwd)) {
    return 0;
  }
  const result = await runGit(
    ['rev-list', '--count', `${sourceBranch}..${targetBranch}`],
    { cwd }
  );
  if (result.exitCode !== 0) {
    return 0;
  }
  return parseInt(result.stdout, 10) || 0;
}

/**
 * Get the merge base between two branches
 */
export async function getMergeBase(branch1: string, branch2: string, cwd?: string): Promise<string> {
  const result = await runGit(['merge-base', branch1, branch2], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to find merge base: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * Check if merging fromBranch into current HEAD would result in conflicts.
 * Uses git merge-tree to detect conflicts without modifying the working directory.
 */
export async function checkMergeConflicts(fromBranch: string, cwd?: string): Promise<boolean> {
  // Get merge base between current HEAD and the branch we want to merge
  const mergeBase = await getMergeBase('HEAD', fromBranch, cwd);

  // Use git merge-tree to simulate the merge
  const result = await runGit(['merge-tree', mergeBase, 'HEAD', fromBranch], { cwd });

  // merge-tree outputs conflict markers if there are conflicts
  return result.stdout.includes('<<<<<<<') || result.stdout.includes('>>>>>>>');
}

/**
 * Check if merging sourceBranch into targetBranch would result in conflicts.
 * Similar to checkMergeConflicts but allows specifying the target branch.
 */
export async function checkMergeConflictsIntoTarget(sourceBranch: string, targetBranch: string, cwd?: string): Promise<boolean> {
  // Get merge base between target branch and the source branch
  const mergeBase = await getMergeBase(targetBranch, sourceBranch, cwd);

  // Use git merge-tree to simulate the merge
  const result = await runGit(['merge-tree', mergeBase, targetBranch, sourceBranch], { cwd });

  // merge-tree outputs conflict markers if there are conflicts
  return result.stdout.includes('<<<<<<<') || result.stdout.includes('>>>>>>>');
}

/**
 * Build a squash commit message for a task merge.
 */
async function buildSquashCommitMessage(taskShortId: string, goal: string, sourceBranch: string, targetBranch: string, root: string): Promise<string> {
  const commitMsgs = await getBranchCommitMessages(sourceBranch, targetBranch, root);
  let message = `Accept task ${taskShortId}: ${goal}`;
  if (commitMsgs.length > 0) {
    message += '\n\nSquashed commit of the following:\n' +
      commitMsgs.map(m => `  ${m}`).join('\n');
  }
  // Add Lazy co-author trailer
  message += `\n\n${LAZY_COAUTHOR_TRAILER}`;
  return message;
}

/**
 * Squash-merge a task branch into its target branch.
 */
export async function squashMergeTaskBranch(
  sourceBranch: string,
  targetBranch: string,
  taskShortId: string,
  goal: string,
  root: string,
): Promise<void> {
  const commitMessage = await buildSquashCommitMessage(taskShortId, goal, sourceBranch, targetBranch, root);
  await squashMergeBranchIntoTarget(sourceBranch, targetBranch, commitMessage, root);
}

/**
 * Copy untracked files matching glob patterns into a worktree.
 * Used to copy files like .env that aren't checked into git but are needed at runtime.
 */
export async function copyUntrackedFilesIntoWorktree(
  repoRoot: string,
  worktreePath: string,
  includePatterns: string[],
): Promise<void> {
  if (includePatterns.length === 0) return;

  for (const pattern of includePatterns) {
    const glob = new Bun.Glob(pattern);

    // Scan the repo root for matches (dot: true enables matching dotfiles like .env)
    for (const relativePath of glob.scanSync({ cwd: repoRoot, absolute: false, onlyFiles: true, dot: true })) {
      const sourcePath = join(repoRoot, relativePath);
      const destPath = join(worktreePath, relativePath);

      // Skip if file doesn't exist (shouldn't happen with scanSync but be safe)
      if (!(await pathExists(sourcePath))) continue;

      // Skip if file is tracked by git
      const checkTracked = await runGit(
        ['ls-files', '--error-unmatch', relativePath],
        { cwd: repoRoot, stdout: 'ignore', stderr: 'ignore' }
      );
      if (checkTracked.exitCode === 0) {
        // File is tracked, skip it
        continue;
      }

      // Create parent directories in worktree
      const destDir = dirname(destPath);
      await ensureDir(destDir);

      // Copy file preserving permissions
      await copyFile(sourcePath, destPath);
      const stats = await stat(sourcePath);
      await chmod(destPath, stats.mode);

      logger.info(`Copied ${relativePath} to worktree`);
    }
  }
}
