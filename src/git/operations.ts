import { existsSync, mkdirSync, copyFileSync, statSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { LAZY_COAUTHOR_TRAILER } from '../constants';
import { logger } from '../utils/logger';
import { runGit } from '../utils/git';

export interface GitCommitInfo {
  sha: string;
  message: string;
}

/**
 * Check whether the repository has at least one commit.
 * Returns false on a freshly `git init`-ed repo with no commits.
 */
export function repoHasCommits(cwd?: string): boolean {
  const result = runGit(['rev-parse', 'HEAD'], {
    cwd,
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return result.exitCode === 0;
}

export function getCurrentSha(cwd?: string): string {
  const result = runGit(['rev-parse', 'HEAD'], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git rev-parse HEAD failed: ${result.stderr}`);
  }
  return result.stdout;
}

export function getCurrentBranch(cwd?: string): string {
  const result = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to get current branch: ${result.stderr}`);
  }
  return result.stdout;
}

export function createAndCheckoutBranch(name: string, cwd?: string): void {
  const result = runGit(['checkout', '-b', name], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git checkout -b ${name} failed: ${result.stderr}`);
  }
}

/**
 * Check if a branch already has a worktree checked out.
 * Returns the worktree path if found, or null if the branch has no worktree.
 */
export function findWorktreeForBranch(branch: string, cwd?: string): string | null {
  const result = runGit(['worktree', 'list', '--porcelain'], { cwd });
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

export function createWorktree(path: string, branch: string, cwd?: string): void {
  // Try creating with new branch first
  const result = runGit(['worktree', 'add', path, '-b', branch], { cwd });
  if (result.exitCode === 0) return;

  // Branch already exists — attach worktree to existing branch
  const retry = runGit(['worktree', 'add', path, branch], { cwd });
  if (retry.exitCode === 0) return;

  throw new Error(`git worktree add failed: ${retry.stderr}`);
}

export function removeWorktree(path: string, cwd?: string): void {
  const result = runGit(['worktree', 'remove', path, '--force'], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git worktree remove failed: ${result.stderr}`);
  }
}

export function getNewCommits(sinceSha: string, cwd?: string): GitCommitInfo[] {
  const result = runGit(['log', '--format=%H%n%s%n---END---', `${sinceSha}..HEAD`], { cwd });
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

export function getCommitDiff(sha: string, cwd?: string): string {
  const result = runGit(['show', '--no-color', '--format=', sha], { cwd });
  if (result.exitCode !== 0) {
    return '';
  }
  return result.stdout;
}

/**
 * Get the list of files changed in a commit.
 * Returns an array of file paths (added, modified, or deleted).
 */
export function getCommitChangedFiles(sha: string, cwd?: string): string[] {
  const result = runGit(['diff-tree', '--no-commit-id', '--name-only', '-r', sha], { cwd });
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
export function getFileAtCommit(sha: string, filepath: string, cwd?: string): string | null {
  const result = runGit(['show', `${sha}:${filepath}`], { cwd });
  if (result.exitCode !== 0) {
    return null;
  }
  return result.stdout;
}

export function createTag(name: string, cwd?: string): void {
  const result = runGit(['tag', name], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git tag ${name} failed: ${result.stderr}`);
  }
}

export function mergeBranch(branch: string, cwd?: string): void {
  const result = runGit(['merge', branch, '--no-ff', '-m', `Merge ${branch}`], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git merge ${branch} failed: ${result.stderr}`);
  }
}

/**
 * Get commit messages from a branch that are not in the target branch.
 * Used to build squash commit messages.
 */
export function getBranchCommitMessages(sourceBranch: string, targetBranch: string, cwd?: string): string[] {
  const result = runGit(
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
export function squashMergeBranch(branch: string, cwd?: string): void {
  const result = runGit(['merge', '--squash', branch], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git merge --squash ${branch} failed: ${result.stderr}`);
  }
}

/**
 * Squash-merge a source branch into a target branch.
 * Checks out the target, squash-merges, commits, then returns to the original branch.
 */
export function squashMergeBranchIntoTarget(
  sourceBranch: string,
  targetBranch: string,
  commitMessage: string,
  cwd?: string
): void {
  const originalBranch = getCurrentBranch(cwd);

  const checkout = runGit(['checkout', targetBranch], { cwd });
  if (checkout.exitCode !== 0) {
    throw new Error(`Failed to checkout ${targetBranch}: ${checkout.stderr}`);
  }

  try {
    const merge = runGit(['merge', '--squash', sourceBranch], { cwd });
    if (merge.exitCode !== 0) {
      throw new Error(`Squash merge failed: ${merge.stderr}`);
    }

    const commit = runGit(['commit', '-m', commitMessage], { cwd });
    if (commit.exitCode !== 0) {
      throw new Error(`Commit after squash merge failed: ${commit.stderr}`);
    }
  } finally {
    runGit(['checkout', originalBranch], { cwd });
  }
}

export function deleteBranch(branch: string, cwd?: string): void {
  const result = runGit(['branch', '-D', branch], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git branch -D ${branch} failed: ${result.stderr}`);
  }
}

export function getDiffStat(fromRef: string, toRef: string = 'HEAD', cwd?: string, twoDot: boolean = false): string {
  // Two-dot diff shows tree difference (for captured upstream SHA).
  // Three-dot diff compares against merge-base (for branch comparison).
  const range = twoDot ? `${fromRef}..${toRef}` : `${fromRef}...${toRef}`;
  const result = runGit(['diff', '--no-color', '--stat', range], { cwd });
  if (result.exitCode !== 0) {
    return '';
  }
  let output = result.stdout;

  // If toRef is HEAD and there are uncommitted changes, include them
  if (toRef === 'HEAD' && hasUncommittedChanges(cwd)) {
    const uncommittedStat = runGit(['diff', '--no-color', '--stat', 'HEAD'], { cwd });
    if (uncommittedStat.exitCode === 0 && uncommittedStat.stdout) {
      output += '\n--- Uncommitted changes ---\n' + uncommittedStat.stdout;
    }
  }

  return output;
}

export function getDiffFull(fromRef: string, toRef: string = 'HEAD', cwd?: string, twoDot: boolean = false): string {
  // Two-dot diff shows tree difference (for captured upstream SHA).
  // Three-dot diff compares against merge-base (for branch comparison).
  const range = twoDot ? `${fromRef}..${toRef}` : `${fromRef}...${toRef}`;
  const result = runGit(['diff', '--no-color', range], { cwd });
  if (result.exitCode !== 0) {
    return '';
  }
  let output = result.stdout;

  // If toRef is HEAD and there are uncommitted changes, include them
  if (toRef === 'HEAD' && hasUncommittedChanges(cwd)) {
    const uncommittedDiff = runGit(['diff', '--no-color', 'HEAD'], { cwd });
    if (uncommittedDiff.exitCode === 0 && uncommittedDiff.stdout) {
      output += '\n\n--- Uncommitted changes ---\n' + uncommittedDiff.stdout;
    }
  }

  return output;
}

export function hasUncommittedChanges(cwd?: string): boolean {
  // Exclude .lazy-task-sandbox/ from dirty worktree checks — it contains lazy's own
  // runtime artifacts (agent sessions, protocol files) and should never affect dirty state.
  const result = runGit(['status', '--porcelain', '--', ':!.lazy-task-sandbox'], { cwd });
  if (result.exitCode !== 0) {
    return false;
  }
  if (!result.stdout) return false;

  // Filter out lazy-specific control files that are not real uncommitted work
  const lines = result.stdout.split('\n');
  const hasRealChanges = lines.some(line => {
    if (!line.trim()) return false; // Empty line
    // Lines start with 2-char status code (e.g., " M" for modified, "??" for untracked)
    // followed by the filename.
    const filename = line.slice(3); // Skip 2-char status code + 1 space
    // Ignore .lazy-pairing (pairing lock file) — it's a control file, not work
    if (filename === '.lazy-pairing') {
      return false;
    }
    // All other changes are real
    return true;
  });

  return hasRealChanges;
}

export function getUncommittedDiff(cwd?: string): string {
  // Get both staged and unstaged changes
  const staged = runGit(['diff', '--no-color', '--cached'], { cwd });
  const unstaged = runGit(['diff', '--no-color'], { cwd });

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

export function applyPatch(patch: string, cwd?: string): boolean {
  // Apply a git patch to the working directory
  // Use git apply which handles both staged and unstaged changes
  const result = runGit(['apply'], {
    cwd,
    stdin: new TextEncoder().encode(patch),
  });

  return result.exitCode === 0;
}

/**
 * Create a worktree branching from a specific commit SHA
 * Used when creating child tasks that branch from parent's current state
 */
export function createWorktreeFromSha(path: string, branch: string, startSha: string, cwd?: string): void {
  // Create worktree with new branch starting from specified SHA
  const result = runGit(['worktree', 'add', path, '-b', branch, startSha], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git worktree add from SHA failed: ${result.stderr}`);
  }
}

/**
 * Merge a source branch into a target branch (used for child→parent merges)
 * This checks out the target branch in the main repo, merges, then returns to original branch
 */
export function mergeBranchIntoTarget(sourceBranch: string, targetBranch: string, message?: string, cwd?: string): void {
  // Save current branch
  const originalBranch = getCurrentBranch(cwd);

  // Checkout target branch
  const checkout = runGit(['checkout', targetBranch], { cwd });
  if (checkout.exitCode !== 0) {
    throw new Error(`Failed to checkout ${targetBranch}: ${checkout.stderr}`);
  }

  try {
    // Merge source branch
    const mergeMsg = message ?? `Merge ${sourceBranch} into ${targetBranch}`;
    const merge = runGit(['merge', sourceBranch, '--no-ff', '-m', mergeMsg], { cwd });
    if (merge.exitCode !== 0) {
      throw new Error(`Merge failed: ${merge.stderr}`);
    }
  } finally {
    // Return to original branch (best effort)
    runGit(['checkout', originalBranch], { cwd });
  }
}

/**
 * Check if a branch exists
 */
export function branchExists(branch: string, cwd?: string): boolean {
  const result = runGit(['rev-parse', '--verify', branch], { cwd });
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
export function recoverMissingWorktree(
  worktreePath: string,
  branch: string,
  cwd?: string,
): WorktreeRecoveryResult {
  if (!branchExists(branch, cwd)) {
    return { recovered: false, branchExists: false, dirty: false };
  }

  // Prune stale worktree entries so git doesn't reject the add
  runGit(['worktree', 'prune'], { cwd });

  const result = runGit(['worktree', 'add', worktreePath, branch], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to recreate worktree: ${result.stderr}`);
  }

  // Check if the recreated worktree has uncommitted changes
  const dirty = hasUncommittedChanges(worktreePath);

  return { recovered: true, branchExists: true, dirty };
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
export function isBranchMergedInto(branch: string, targetBranch: string, cwd?: string): boolean {
  // Fast path: check if this is a regular (non-squash) merge
  const ancestorCheck = runGit(['merge-base', '--is-ancestor', branch, targetBranch], { cwd });
  if (ancestorCheck.exitCode === 0) {
    // Branch is ancestor of target. But this is also true for freshly created branches
    // that have no new commits. Check that the branch actually has work on it by verifying
    // the branch tip is not the merge-base (i.e., they haven't diverged at all).
    const mergeBase = runGit(['merge-base', branch, targetBranch], { cwd });
    const branchTip = runGit(['rev-parse', branch], { cwd });
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
  const branchCommits = runGit(
    ['rev-list', '--count', `${targetBranch}..${branch}`],
    { cwd }
  );
  if (branchCommits.exitCode !== 0) return false;
  const count = parseInt(branchCommits.stdout, 10);
  if (count === 0) return false; // No unique commits — not merged, just empty

  // Guard: if ALL unique commits are empty (no file changes), this is not a squash merge.
  // This prevents false positives from --allow-empty initial commits created by `lazy start`.
  const mergeBase = runGit(['merge-base', branch, targetBranch], { cwd });
  if (mergeBase.exitCode === 0) {
    const filesChanged = runGit(['diff', '--name-only', mergeBase.stdout, branch], { cwd });
    if (filesChanged.exitCode === 0 && filesChanged.stdout === '') {
      // Branch has commits but zero file changes — not a real merge, just empty commits
      return false;
    }
  }

  // Branch has unique commits with real file changes. Check if the tree contents are
  // identical to target (squash merged).
  const diff = runGit(['diff', '--quiet', targetBranch, branch], { cwd });
  return diff.exitCode === 0; // exit 0 = no diff = contents match
}

/**
 * Check if a commit on `targetBranch` mentions the given text in its commit message.
 * Used to detect squash-merge commits when the source branch has been deleted.
 * Searches the last `limit` commits (default 100).
 */
export function findCommitByMessage(targetBranch: string, searchText: string, cwd?: string, limit: number = 100): boolean {
  const result = runGit(
    ['log', targetBranch, `--max-count=${limit}`, '--format=%s', '--grep', searchText],
    { cwd }
  );
  if (result.exitCode !== 0) return false;
  return result.stdout.length > 0;
}

/**
 * Check if a given parent branch has commits that are not yet in the current branch.
 * Returns true if the parent branch has upstream changes that should be merged.
 */
export function hasUpstreamChanges(parentBranch: string, cwd?: string): boolean {
  const currentBranch = getCurrentBranch(cwd);

  if (!branchExists(parentBranch, cwd)) {
    return false;
  }

  // Check if there are commits in parent that are not in current branch
  const result = runGit(
    ['rev-list', '--count', `${currentBranch}..${parentBranch}`],
    { cwd }
  );

  if (result.exitCode !== 0) {
    return false;
  }

  const count = parseInt(result.stdout, 10);
  return count > 0;
}

/**
 * Count how many commits targetBranch has that are not in sourceBranch.
 * Returns 0 if the count cannot be determined.
 */
export function getCommitsBehindCount(sourceBranch: string, targetBranch: string, cwd?: string): number {
  if (!branchExists(targetBranch, cwd)) {
    return 0;
  }
  const result = runGit(
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
export function getMergeBase(branch1: string, branch2: string, cwd?: string): string {
  const result = runGit(['merge-base', branch1, branch2], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to find merge base: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * Check if merging fromBranch into current HEAD would result in conflicts.
 * Uses git merge-tree to detect conflicts without modifying the working directory.
 */
export function checkMergeConflicts(fromBranch: string, cwd?: string): boolean {
  // Get merge base between current HEAD and the branch we want to merge
  const mergeBase = getMergeBase('HEAD', fromBranch, cwd);

  // Use git merge-tree to simulate the merge
  const result = runGit(['merge-tree', mergeBase, 'HEAD', fromBranch], { cwd });

  // merge-tree outputs conflict markers if there are conflicts
  return result.stdout.includes('<<<<<<<') || result.stdout.includes('>>>>>>>');
}

/**
 * Check if merging sourceBranch into targetBranch would result in conflicts.
 * Similar to checkMergeConflicts but allows specifying the target branch.
 */
export function checkMergeConflictsIntoTarget(sourceBranch: string, targetBranch: string, cwd?: string): boolean {
  // Get merge base between target branch and the source branch
  const mergeBase = getMergeBase(targetBranch, sourceBranch, cwd);

  // Use git merge-tree to simulate the merge
  const result = runGit(['merge-tree', mergeBase, targetBranch, sourceBranch], { cwd });

  // merge-tree outputs conflict markers if there are conflicts
  return result.stdout.includes('<<<<<<<') || result.stdout.includes('>>>>>>>');
}

/**
 * Build a squash commit message for a task merge.
 */
function buildSquashCommitMessage(taskShortId: string, goal: string, sourceBranch: string, targetBranch: string, root: string): string {
  const commitMsgs = getBranchCommitMessages(sourceBranch, targetBranch, root);
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
export function squashMergeTaskBranch(
  sourceBranch: string,
  targetBranch: string,
  taskShortId: string,
  goal: string,
  root: string,
): void {
  const commitMessage = buildSquashCommitMessage(taskShortId, goal, sourceBranch, targetBranch, root);
  squashMergeBranchIntoTarget(sourceBranch, targetBranch, commitMessage, root);
}

/**
 * Copy untracked files matching glob patterns into a worktree.
 * Used to copy files like .env that aren't checked into git but are needed at runtime.
 */
export function copyUntrackedFilesIntoWorktree(
  repoRoot: string,
  worktreePath: string,
  includePatterns: string[],
): void {
  if (includePatterns.length === 0) return;

  for (const pattern of includePatterns) {
    const glob = new Bun.Glob(pattern);

    // Scan the repo root for matches (dot: true enables matching dotfiles like .env)
    for (const relativePath of glob.scanSync({ cwd: repoRoot, absolute: false, onlyFiles: true, dot: true })) {
      const sourcePath = join(repoRoot, relativePath);
      const destPath = join(worktreePath, relativePath);

      // Skip if file doesn't exist (shouldn't happen with scanSync but be safe)
      if (!existsSync(sourcePath)) continue;

      // Skip if file is tracked by git
      const checkTracked = runGit(
        ['ls-files', '--error-unmatch', relativePath],
        { cwd: repoRoot, stdout: 'ignore', stderr: 'ignore' }
      );
      if (checkTracked.exitCode === 0) {
        // File is tracked, skip it
        continue;
      }

      // Create parent directories in worktree
      const destDir = dirname(destPath);
      if (!existsSync(destDir)) {
        mkdirSync(destDir, { recursive: true });
      }

      // Copy file preserving permissions
      copyFileSync(sourcePath, destPath);
      const stats = statSync(sourcePath);
      chmodSync(destPath, stats.mode);

      logger.info(`Copied ${relativePath} to worktree`);
    }
  }
}
