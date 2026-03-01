import { LAZY_COAUTHOR_TRAILER } from '../constants';

export interface GitCommitInfo {
  sha: string;
  message: string;
}

/**
 * Check whether the repository has at least one commit.
 * Returns false on a freshly `git init`-ed repo with no commits.
 */
export function repoHasCommits(cwd?: string): boolean {
  const result = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
    cwd,
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return result.exitCode === 0;
}

export function getCurrentSha(cwd?: string): string {
  const result = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git rev-parse HEAD failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

export function getCurrentBranch(cwd?: string): string {
  const result = Bun.spawnSync(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to get current branch: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

export function createAndCheckoutBranch(name: string, cwd?: string): void {
  const result = Bun.spawnSync(['git', 'checkout', '-b', name], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git checkout -b ${name} failed: ${result.stderr.toString()}`);
  }
}

/**
 * Check if a branch already has a worktree checked out.
 * Returns the worktree path if found, or null if the branch has no worktree.
 */
export function findWorktreeForBranch(branch: string, cwd?: string): string | null {
  const result = Bun.spawnSync(['git', 'worktree', 'list', '--porcelain'], { cwd });
  if (result.exitCode !== 0) return null;

  const output = result.stdout.toString();
  const lines = output.split('\n');

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
  const result = Bun.spawnSync(['git', 'worktree', 'add', path, '-b', branch], { cwd });
  if (result.exitCode === 0) return;

  // Branch already exists — attach worktree to existing branch
  const retry = Bun.spawnSync(['git', 'worktree', 'add', path, branch], { cwd });
  if (retry.exitCode === 0) return;

  throw new Error(`git worktree add failed: ${retry.stderr.toString()}`);
}

export function removeWorktree(path: string, cwd?: string): void {
  const result = Bun.spawnSync(['git', 'worktree', 'remove', path, '--force'], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git worktree remove failed: ${result.stderr.toString()}`);
  }
}

export function getNewCommits(sinceSha: string, cwd?: string): GitCommitInfo[] {
  const result = Bun.spawnSync(['git', 'log', '--format=%H%n%s%n---END---', `${sinceSha}..HEAD`], { cwd });
  if (result.exitCode !== 0) {
    return [];
  }
  const output = result.stdout.toString().trim();
  if (!output) return [];

  const commits: GitCommitInfo[] = [];
  const entries = output.split('---END---').filter((e) => e.trim());
  for (const entry of entries) {
    const lines = entry.trim().split('\n');
    if (lines.length >= 2) {
      commits.push({ sha: lines[0], message: lines[1] });
    }
  }
  return commits;
}

export function getCommitDiff(sha: string, cwd?: string): string {
  const result = Bun.spawnSync(['git', 'show', '--no-color', '--format=', sha], { cwd });
  if (result.exitCode !== 0) {
    return '';
  }
  return result.stdout.toString();
}

/**
 * Get the list of files changed in a commit.
 * Returns an array of file paths (added, modified, or deleted).
 */
export function getCommitChangedFiles(sha: string, cwd?: string): string[] {
  const result = Bun.spawnSync(['git', 'diff-tree', '--no-commit-id', '--name-only', '-r', sha], { cwd });
  if (result.exitCode !== 0) {
    return [];
  }
  const output = result.stdout.toString().trim();
  if (!output) return [];
  return output.split('\n').filter(f => f.length > 0);
}

/**
 * Get the content of a file at a specific commit.
 * Returns the file content as a string, or null if the file doesn't exist at that commit.
 */
export function getFileAtCommit(sha: string, filepath: string, cwd?: string): string | null {
  const result = Bun.spawnSync(['git', 'show', `${sha}:${filepath}`], { cwd });
  if (result.exitCode !== 0) {
    return null;
  }
  return result.stdout.toString();
}

export function createTag(name: string, cwd?: string): void {
  const result = Bun.spawnSync(['git', 'tag', name], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git tag ${name} failed: ${result.stderr.toString()}`);
  }
}

export function mergeBranch(branch: string, cwd?: string): void {
  const result = Bun.spawnSync(['git', 'merge', branch, '--no-ff', '-m', `Merge ${branch}`], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git merge ${branch} failed: ${result.stderr.toString()}`);
  }
}

/**
 * Get commit messages from a branch that are not in the target branch.
 * Used to build squash commit messages.
 */
export function getBranchCommitMessages(sourceBranch: string, targetBranch: string, cwd?: string): string[] {
  const result = Bun.spawnSync(
    ['git', 'log', '--format=%s', `${targetBranch}..${sourceBranch}`],
    { cwd }
  );
  if (result.exitCode !== 0) {
    return [];
  }
  const output = result.stdout.toString().trim();
  if (!output) return [];
  return output.split('\n');
}

/**
 * Squash-merge a branch into the current branch (HEAD).
 * Stages all changes but does not auto-commit; the caller must commit separately.
 */
export function squashMergeBranch(branch: string, cwd?: string): void {
  const result = Bun.spawnSync(['git', 'merge', '--squash', branch], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git merge --squash ${branch} failed: ${result.stderr.toString()}`);
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

  const checkout = Bun.spawnSync(['git', 'checkout', targetBranch], { cwd });
  if (checkout.exitCode !== 0) {
    throw new Error(`Failed to checkout ${targetBranch}: ${checkout.stderr.toString()}`);
  }

  try {
    const merge = Bun.spawnSync(['git', 'merge', '--squash', sourceBranch], { cwd });
    if (merge.exitCode !== 0) {
      throw new Error(`Squash merge failed: ${merge.stderr.toString()}`);
    }

    const commit = Bun.spawnSync(['git', 'commit', '-m', commitMessage], { cwd });
    if (commit.exitCode !== 0) {
      throw new Error(`Commit after squash merge failed: ${commit.stderr.toString()}`);
    }
  } finally {
    Bun.spawnSync(['git', 'checkout', originalBranch], { cwd });
  }
}

export function deleteBranch(branch: string, cwd?: string): void {
  const result = Bun.spawnSync(['git', 'branch', '-D', branch], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git branch -D ${branch} failed: ${result.stderr.toString()}`);
  }
}

export function getDiffStat(fromRef: string, toRef: string = 'HEAD', cwd?: string, twoDot: boolean = false): string {
  // Two-dot diff shows tree difference (for captured upstream SHA).
  // Three-dot diff compares against merge-base (for branch comparison).
  const range = twoDot ? `${fromRef}..${toRef}` : `${fromRef}...${toRef}`;
  const result = Bun.spawnSync(['git', 'diff', '--no-color', '--stat', range], { cwd });
  if (result.exitCode !== 0) {
    return '';
  }
  let output = result.stdout.toString();

  // If toRef is HEAD and there are uncommitted changes, include them
  if (toRef === 'HEAD' && hasUncommittedChanges(cwd)) {
    const uncommittedStat = Bun.spawnSync(['git', 'diff', '--no-color', '--stat', 'HEAD'], { cwd });
    if (uncommittedStat.exitCode === 0 && uncommittedStat.stdout.toString().trim()) {
      output += '\n--- Uncommitted changes ---\n' + uncommittedStat.stdout.toString();
    }
  }

  return output;
}

export function getDiffFull(fromRef: string, toRef: string = 'HEAD', cwd?: string, twoDot: boolean = false): string {
  // Two-dot diff shows tree difference (for captured upstream SHA).
  // Three-dot diff compares against merge-base (for branch comparison).
  const range = twoDot ? `${fromRef}..${toRef}` : `${fromRef}...${toRef}`;
  const result = Bun.spawnSync(['git', 'diff', '--no-color', range], { cwd });
  if (result.exitCode !== 0) {
    return '';
  }
  let output = result.stdout.toString();

  // If toRef is HEAD and there are uncommitted changes, include them
  if (toRef === 'HEAD' && hasUncommittedChanges(cwd)) {
    const uncommittedDiff = Bun.spawnSync(['git', 'diff', '--no-color', 'HEAD'], { cwd });
    if (uncommittedDiff.exitCode === 0 && uncommittedDiff.stdout.toString().trim()) {
      output += '\n\n--- Uncommitted changes ---\n' + uncommittedDiff.stdout.toString();
    }
  }

  return output;
}

export function hasUncommittedChanges(cwd?: string): boolean {
  const result = Bun.spawnSync(['git', 'status', '--porcelain'], { cwd });
  if (result.exitCode !== 0) {
    return false;
  }
  const output = result.stdout.toString().trim();
  if (!output) return false;

  // Filter out lazy-specific control files that are not real uncommitted work
  const lines = output.split('\n');
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
  const staged = Bun.spawnSync(['git', 'diff', '--no-color', '--cached'], { cwd });
  const unstaged = Bun.spawnSync(['git', 'diff', '--no-color'], { cwd });

  let diff = '';
  if (staged.exitCode === 0 && staged.stdout.toString().trim()) {
    diff += '--- STAGED CHANGES ---\n' + staged.stdout.toString();
  }
  if (unstaged.exitCode === 0 && unstaged.stdout.toString().trim()) {
    if (diff) diff += '\n\n';
    diff += '--- UNSTAGED CHANGES ---\n' + unstaged.stdout.toString();
  }

  return diff;
}

export function applyPatch(patch: string, cwd?: string): boolean {
  // Apply a git patch to the working directory
  // Use git apply which handles both staged and unstaged changes
  const result = Bun.spawnSync(['git', 'apply'], {
    cwd,
    stdin: new TextEncoder().encode(patch)
  });

  return result.exitCode === 0;
}

/**
 * Create a worktree branching from a specific commit SHA
 * Used when creating child tasks that branch from parent's current state
 */
export function createWorktreeFromSha(path: string, branch: string, startSha: string, cwd?: string): void {
  // Create worktree with new branch starting from specified SHA
  const result = Bun.spawnSync(['git', 'worktree', 'add', path, '-b', branch, startSha], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git worktree add from SHA failed: ${result.stderr.toString()}`);
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
  const checkout = Bun.spawnSync(['git', 'checkout', targetBranch], { cwd });
  if (checkout.exitCode !== 0) {
    throw new Error(`Failed to checkout ${targetBranch}: ${checkout.stderr.toString()}`);
  }

  try {
    // Merge source branch
    const mergeMsg = message ?? `Merge ${sourceBranch} into ${targetBranch}`;
    const merge = Bun.spawnSync(['git', 'merge', sourceBranch, '--no-ff', '-m', mergeMsg], { cwd });
    if (merge.exitCode !== 0) {
      throw new Error(`Merge failed: ${merge.stderr.toString()}`);
    }
  } finally {
    // Return to original branch (best effort)
    Bun.spawnSync(['git', 'checkout', originalBranch], { cwd });
  }
}

/**
 * Check if a branch exists
 */
export function branchExists(branch: string, cwd?: string): boolean {
  const result = Bun.spawnSync(['git', 'rev-parse', '--verify', branch], { cwd });
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
  Bun.spawnSync(['git', 'worktree', 'prune'], { cwd });

  const result = Bun.spawnSync(['git', 'worktree', 'add', worktreePath, branch], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to recreate worktree: ${result.stderr.toString()}`);
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
  const ancestorCheck = Bun.spawnSync(['git', 'merge-base', '--is-ancestor', branch, targetBranch], { cwd });
  if (ancestorCheck.exitCode === 0) {
    // Branch is ancestor of target. But this is also true for freshly created branches
    // that have no new commits. Check that the branch actually has work on it by verifying
    // the branch tip is not the merge-base (i.e., they haven't diverged at all).
    const mergeBase = Bun.spawnSync(['git', 'merge-base', branch, targetBranch], { cwd });
    const branchTip = Bun.spawnSync(['git', 'rev-parse', branch], { cwd });
    if (mergeBase.exitCode === 0 && branchTip.exitCode === 0) {
      const base = mergeBase.stdout.toString().trim();
      const tip = branchTip.stdout.toString().trim();
      if (base === tip) {
        // Branch tip equals merge-base — no unique commits, freshly created branch
        return false;
      }
    }
    return true;
  }

  // Squash-merge detection: branch has unique commits but contents match target
  // First check the branch has diverged (has commits not on target)
  const branchCommits = Bun.spawnSync(
    ['git', 'rev-list', '--count', `${targetBranch}..${branch}`],
    { cwd }
  );
  if (branchCommits.exitCode !== 0) return false;
  const count = parseInt(branchCommits.stdout.toString().trim(), 10);
  if (count === 0) return false; // No unique commits — not merged, just empty

  // Guard: if ALL unique commits are empty (no file changes), this is not a squash merge.
  // This prevents false positives from --allow-empty initial commits created by `lazy start`.
  const mergeBase = Bun.spawnSync(['git', 'merge-base', branch, targetBranch], { cwd });
  if (mergeBase.exitCode === 0) {
    const base = mergeBase.stdout.toString().trim();
    const filesChanged = Bun.spawnSync(['git', 'diff', '--name-only', base, branch], { cwd });
    if (filesChanged.exitCode === 0 && filesChanged.stdout.toString().trim() === '') {
      // Branch has commits but zero file changes — not a real merge, just empty commits
      return false;
    }
  }

  // Branch has unique commits with real file changes. Check if the tree contents are
  // identical to target (squash merged).
  const diff = Bun.spawnSync(['git', 'diff', '--quiet', targetBranch, branch], { cwd });
  return diff.exitCode === 0; // exit 0 = no diff = contents match
}

/**
 * Check if a commit on `targetBranch` mentions the given text in its commit message.
 * Used to detect squash-merge commits when the source branch has been deleted.
 * Searches the last `limit` commits (default 100).
 */
export function findCommitByMessage(targetBranch: string, searchText: string, cwd?: string, limit: number = 100): boolean {
  const result = Bun.spawnSync(
    ['git', 'log', targetBranch, `--max-count=${limit}`, '--format=%s', '--grep', searchText],
    { cwd }
  );
  if (result.exitCode !== 0) return false;
  return result.stdout.toString().trim().length > 0;
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
  const result = Bun.spawnSync(
    ['git', 'rev-list', '--count', `${currentBranch}..${parentBranch}`],
    { cwd }
  );

  if (result.exitCode !== 0) {
    return false;
  }

  const count = parseInt(result.stdout.toString().trim(), 10);
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
  const result = Bun.spawnSync(
    ['git', 'rev-list', '--count', `${sourceBranch}..${targetBranch}`],
    { cwd }
  );
  if (result.exitCode !== 0) {
    return 0;
  }
  return parseInt(result.stdout.toString().trim(), 10) || 0;
}

/**
 * Get the merge base between two branches
 */
export function getMergeBase(branch1: string, branch2: string, cwd?: string): string {
  const result = Bun.spawnSync(['git', 'merge-base', branch1, branch2], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to find merge base: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

/**
 * Check if merging fromBranch into current HEAD would result in conflicts.
 * Uses git merge-tree to detect conflicts without modifying the working directory.
 */
export function checkMergeConflicts(fromBranch: string, cwd?: string): boolean {
  // Get merge base between current HEAD and the branch we want to merge
  const mergeBase = getMergeBase('HEAD', fromBranch, cwd);

  // Use git merge-tree to simulate the merge
  const result = Bun.spawnSync(['git', 'merge-tree', mergeBase, 'HEAD', fromBranch], { cwd });

  // merge-tree outputs conflict markers if there are conflicts
  const output = result.stdout.toString();
  return output.includes('<<<<<<<') || output.includes('>>>>>>>');
}

/**
 * Check if merging sourceBranch into targetBranch would result in conflicts.
 * Similar to checkMergeConflicts but allows specifying the target branch.
 */
export function checkMergeConflictsIntoTarget(sourceBranch: string, targetBranch: string, cwd?: string): boolean {
  // Get merge base between target branch and the source branch
  const mergeBase = getMergeBase(targetBranch, sourceBranch, cwd);

  // Use git merge-tree to simulate the merge
  const result = Bun.spawnSync(['git', 'merge-tree', mergeBase, targetBranch, sourceBranch], { cwd });

  // merge-tree outputs conflict markers if there are conflicts
  const output = result.stdout.toString();
  return output.includes('<<<<<<<') || output.includes('>>>>>>>');
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

