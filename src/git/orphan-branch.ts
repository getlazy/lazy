/**
 * Git operations for orphan branch storage.
 *
 * Manages the lifecycle of a git orphan branch used as a storage backend:
 * - Creating the orphan branch if it doesn't exist
 * - Setting up a dedicated worktree for the branch
 * - Staging and committing changes after storage writes
 */

/**
 * Check if a branch exists in the repository.
 */
export function orphanBranchExists(branchName: string, cwd?: string): boolean {
  const result = Bun.spawnSync(
    ['git', 'rev-parse', '--verify', `refs/heads/${branchName}`],
    { cwd }
  );
  return result.exitCode === 0;
}

/**
 * Create an orphan branch with an initial empty commit.
 *
 * Uses a temporary worktree to create the branch without disturbing the
 * current working directory. The temporary worktree is cleaned up after.
 */
export function createOrphanBranch(branchName: string, cwd?: string): void {
  // Use git's low-level commands to create an orphan branch without
  // affecting the current checkout. We create a tree object from /dev/null
  // (empty tree) and commit it directly.

  // Get the empty tree hash
  const emptyTree = Bun.spawnSync(
    ['git', 'hash-object', '-t', 'tree', '/dev/null'],
    { cwd }
  );
  if (emptyTree.exitCode !== 0) {
    throw new Error(`Failed to get empty tree hash: ${emptyTree.stderr.toString()}`);
  }
  const treeHash = emptyTree.stdout.toString().trim();

  // Create a commit object with this empty tree and no parent
  const commit = Bun.spawnSync(
    ['git', 'commit-tree', treeHash, '-m', 'Initialize lazy state storage'],
    {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'lazy',
        GIT_AUTHOR_EMAIL: 'lazy@localhost',
        GIT_COMMITTER_NAME: 'lazy',
        GIT_COMMITTER_EMAIL: 'lazy@localhost',
      },
    }
  );
  if (commit.exitCode !== 0) {
    throw new Error(`Failed to create initial commit: ${commit.stderr.toString()}`);
  }
  const commitHash = commit.stdout.toString().trim();

  // Point the branch ref at this commit
  const updateRef = Bun.spawnSync(
    ['git', 'update-ref', `refs/heads/${branchName}`, commitHash],
    { cwd }
  );
  if (updateRef.exitCode !== 0) {
    throw new Error(`Failed to create branch ${branchName}: ${updateRef.stderr.toString()}`);
  }
}

/**
 * Check if a worktree already exists at the given path.
 */
export function worktreeExists(worktreePath: string, cwd?: string): boolean {
  const result = Bun.spawnSync(['git', 'worktree', 'list', '--porcelain'], { cwd });
  if (result.exitCode !== 0) return false;

  const output = result.stdout.toString();
  // Worktree list output has lines like "worktree /absolute/path"
  return output.split('\n').some(line => {
    if (!line.startsWith('worktree ')) return false;
    const path = line.substring('worktree '.length).trim();
    return path === worktreePath;
  });
}

/**
 * Add a worktree for the orphan branch. If the worktree already exists,
 * this is a no-op.
 */
export function ensureWorktree(worktreePath: string, branchName: string, cwd?: string): void {
  if (worktreeExists(worktreePath, cwd)) {
    return;
  }

  const result = Bun.spawnSync(
    ['git', 'worktree', 'add', worktreePath, branchName],
    { cwd }
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to create worktree at ${worktreePath} for branch ${branchName}: ${result.stderr.toString()}`
    );
  }
}

/**
 * Stage all changes and commit in the orphan branch worktree.
 * If there are no changes, this is a no-op (returns false).
 *
 * @returns true if a commit was made, false if there was nothing to commit
 */
export function commitChanges(worktreePath: string, message: string): boolean {
  // Stage all changes (new files, modifications, deletions)
  const add = Bun.spawnSync(['git', 'add', '-A'], { cwd: worktreePath });
  if (add.exitCode !== 0) {
    throw new Error(`Failed to stage changes: ${add.stderr.toString()}`);
  }

  // Check if there's anything to commit (exclude lazy sandbox artifacts)
  const status = Bun.spawnSync(['git', 'status', '--porcelain', '--', ':!.lazy-task-sandbox'], { cwd: worktreePath });
  if (status.exitCode !== 0 || status.stdout.toString().trim() === '') {
    return false; // Nothing to commit
  }

  // Commit
  const commit = Bun.spawnSync(
    ['git', 'commit', '-m', message, '--allow-empty-message'],
    {
      cwd: worktreePath,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'lazy',
        GIT_AUTHOR_EMAIL: 'lazy@localhost',
        GIT_COMMITTER_NAME: 'lazy',
        GIT_COMMITTER_EMAIL: 'lazy@localhost',
      },
    }
  );
  if (commit.exitCode !== 0) {
    throw new Error(`Failed to commit changes: ${commit.stderr.toString()}`);
  }

  return true;
}

/**
 * Remove the worktree for the orphan branch.
 */
export function removeWorktree(worktreePath: string, cwd?: string): void {
  if (!worktreeExists(worktreePath, cwd)) {
    return;
  }

  const result = Bun.spawnSync(
    ['git', 'worktree', 'remove', worktreePath, '--force'],
    { cwd }
  );
  if (result.exitCode !== 0) {
    throw new Error(`Failed to remove worktree: ${result.stderr.toString()}`);
  }
}
