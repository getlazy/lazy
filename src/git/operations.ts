import { join, dirname } from 'path';
import { LAZY_COAUTHOR_TRAILER } from '../constants';
import { logger } from '../utils/logger';
import { runGit } from '../utils/git';
import { withRemoteRetry } from '../utils/retry';
import { pathExists, ensureDir, stat, copyFile, chmod } from '../utils/fs';
import { TaskMutex } from '../utils/task-mutex';
import type { Task } from '../types';
import { targetBranchOf } from '../task-target';
import {
  clearStaleIndexLock,
  formatIndexLockFailure,
  isIndexLockError,
  resolveAbsoluteGitDir,
  resolveIndexLockPath,
} from './index-lock';

/**
 * Serialize squash merges that target the same git directory.
 *
 * Accept's lifecycle lock is keyed on the CHILD task being accepted, so two
 * siblings accepted into the same parent can otherwise run `git merge --squash`
 * in the parent's worktree concurrently and collide on index.lock. This mutex
 * is in-process only (one daemon owns merges for a repo); cross-process
 * collisions still fail via git's lock, and {@link clearStaleIndexLock} then
 * distinguishes a live holder from a stale file.
 */
const gitDirMergeMutex = new TaskMutex();

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
 * Get the named integration branch for a top-level task, resolving "HEAD".
 *
 * Reads the canonical {@link TaskTarget}: returns undefined when the task is
 * stacked on another task (kind === 'task') or when the branch slot is an
 * unresolved sentinel, so callers can apply their own fallback (getCurrentBranch
 * or 'main'). Applies `resolveDetachedHead` when the branch is literal "HEAD"
 * (defense against legacy data started in a detached-HEAD repo).
 */
export async function getTaskTargetBranch(task: Task, cwd: string, remoteName: string = 'origin'): Promise<string | undefined> {
  const targetBranch = targetBranchOf(task);
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

export interface NewCommitsOptions {
  /**
   * Walk only the FIRST PARENT of every merge — i.e. the commits this branch
   * itself gained, with a merge counting as the single merge commit.
   *
   * Without it, `<since>..HEAD` is a reachability query: merging an upstream
   * branch in answers with every commit that upstream carried and `<since>`
   * did not, which is somebody else's history. Any caller asking "what did
   * this branch do since X" wants the first-parent walk.
   */
  firstParent?: boolean;
  /** Resolve the range against this ref instead of `HEAD`. */
  headRef?: string;
}

export async function getNewCommits(
  sinceSha: string,
  cwd?: string,
  options: NewCommitsOptions = {},
): Promise<GitCommitInfo[]> {
  const head = options.headRef ?? 'HEAD';
  const args = ['log', '--format=%H%n%s%n---END---'];
  if (options.firstParent) args.push('--first-parent');
  args.push(`${sinceSha}..${head}`);

  const result = await runGit(args, { cwd });
  // A git FAILURE is not an empty range, and the two must never look alike.
  // Returning [] here told `lazy system repair-commits` that a branch it could
  // not read carried no commits, which made every stored record look foreign
  // and deleted the lot. Callers that genuinely want best-effort say so with a
  // try/catch, where the degrading is visible.
  if (result.exitCode !== 0) {
    throw new Error(
      `git log ${sinceSha}..${head}${cwd ? ` in ${cwd}` : ''} failed: ${result.stderr?.trim() || `exit ${result.exitCode}`}`,
    );
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

/**
 * How many commits are on HEAD that `sinceSha` does not have, first-parent.
 *
 * The cheap half of `getNewCommits`, and it answers the same question, so it
 * walks the same way: `--first-parent`, or a task that merges its upstream
 * reports every commit that upstream carried as work it did this turn. This is
 * the counting twin of the range bug in `src/task/session-commits.ts`; the
 * mechanical guard in `test/unit/session-commit-scan.test.ts` covers both
 * function names for that reason.
 *
 * Unlike `getNewCommits`, this one still returns 0 rather than throwing when
 * git fails — it backs a live readout, where a missing number is a gap on a
 * display and nothing is decided from it. Do not reuse it anywhere a decision
 * depends on the answer.
 */
export async function countNewCommits(sinceSha: string, cwd?: string): Promise<number> {
  const result = await runGit(['rev-list', '--count', '--first-parent', `${sinceSha}..HEAD`], { cwd });
  if (result.exitCode !== 0) return 0;
  const count = parseInt(result.stdout.trim(), 10);
  return Number.isFinite(count) && count > 0 ? count : 0;
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

/**
 * The git tag that authoritatively marks a task as accepted (merged).
 * Uses the FULL task id for uniqueness, and is global to the repo so it
 * survives branch deletion and reparenting.
 */
export function acceptTagName(taskId: string): string {
  return `lazy-accept-${taskId}`;
}

/**
 * Create the authoritative accept tag for a task, pointing at the resulting
 * merge/FF commit. This is the single source of truth the zombie sweep uses
 * to decide whether a non-terminal task was actually accepted.
 *
 * Annotated so it carries a timestamp; forced (`-f`) so idempotent retries of
 * accept (e.g. a re-entry after a crash) update rather than fail. Must be
 * created BEFORE the task status flips to `complete`, so that a crash in the
 * window between merge and status update still leaves a recoverable signal.
 */
export async function createAcceptTag(taskId: string, commitish: string, cwd?: string): Promise<void> {
  const name = acceptTagName(taskId);
  const resolved = await runGit(['rev-parse', '--verify', `${commitish}^{commit}`], { cwd });
  if (resolved.exitCode !== 0) {
    throw new Error(`Failed to resolve ${commitish} for accept tag ${name}: ${resolved.stderr || 'unknown error'}`);
  }
  const sha = resolved.stdout.trim();
  const result = await runGit(['tag', '-a', '-f', '-m', `Accepted task ${taskId}`, name, sha], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git tag ${name} failed: ${result.stderr || 'unknown error'}`);
  }
}

/**
 * Return the commit SHA an accept tag points at, or null if the tag doesn't
 * exist or doesn't resolve to a commit.
 */
export async function getAcceptTagCommit(taskId: string, cwd?: string): Promise<string | null> {
  const name = acceptTagName(taskId);
  const result = await runGit(['rev-parse', '--verify', '--quiet', `refs/tags/${name}^{commit}`], { cwd });
  if (result.exitCode !== 0) return null;
  const sha = result.stdout.trim();
  return sha.length > 0 ? sha : null;
}

/**
 * SHA that identifies a waited task's tip for wait/comment idempotency.
 *
 * - `complete`: the accept-tag commit (the task branch may already be deleted).
 * - otherwise: HEAD of the task branch when it still resolves.
 *
 * Returned on `lazy_wait` / `lazy_wait` MCP as `head_sha`, and echoed in the
 * `[Subtask accepted]` parent comment after accept, so a parent agent can
 * de-dupe "wait already told me" vs "new note about the same merge".
 */
export async function resolveTaskTipSha(
  taskId: string,
  status: string,
  gitBranch: string | null | undefined,
  cwd?: string,
): Promise<string | null> {
  if (status === 'complete') {
    return getAcceptTagCommit(taskId, cwd);
  }
  if (!gitBranch) return null;
  const result = await runGit(
    ['rev-parse', '--verify', '--quiet', `${gitBranch}^{commit}`],
    { cwd },
  );
  if (result.exitCode !== 0) return null;
  const sha = result.stdout.trim();
  return sha.length > 0 ? sha : null;
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
 * Run the squash-merge + commit sequence in `cwd`, which MUST already have
 * `targetBranch` checked out. Does not change branches. Throws (without
 * committing) when the source has no changes relative to the target.
 *
 * Before touching the index, clears a *stale* `index.lock` when a real open-file
 * scan proves no process holds it. A live holder fails loudly without removal.
 * Concurrent callers targeting the same git dir are serialized (see
 * {@link gitDirMergeMutex}).
 */
async function runSquashMergeCommit(
  sourceBranch: string,
  targetBranch: string,
  commitMessage: string,
  cwd: string
): Promise<void> {
  const gitDir = (await resolveAbsoluteGitDir(cwd)) ?? cwd;
  return gitDirMergeMutex.withLock(gitDir, () => runSquashMergeCommitLocked(sourceBranch, targetBranch, commitMessage, cwd));
}

async function runSquashMergeCommitLocked(
  sourceBranch: string,
  targetBranch: string,
  commitMessage: string,
  cwd: string
): Promise<void> {
  // Stale index.lock from a crashed earlier git permanently wedges accept into
  // this worktree. Clear it only with evidence that no process has it open.
  await clearStaleIndexLock(cwd);

  const merge = await runGit(['merge', '--squash', sourceBranch], { cwd });
  if (merge.exitCode !== 0) {
    if (isIndexLockError(merge.stderr)) {
      // Lock appeared between our pre-check and the merge (or a race with a
      // sibling accept). Re-probe once: a lock that went stale mid-flight still
      // recovers; a live holder throws from clearStaleIndexLock with a human
      // message (and never deletes the lock).
      await clearStaleIndexLock(cwd);
      const retry = await runGit(['merge', '--squash', sourceBranch], { cwd });
      if (retry.exitCode !== 0) {
        const stderr = (retry.stderr || merge.stderr).trim();
        if (isIndexLockError(stderr)) {
          const lockPath = await resolveIndexLockPath(cwd);
          throw new Error(formatIndexLockFailure(stderr, lockPath));
        }
        throw new Error(
          `Could not squash-merge ${sourceBranch} into ${targetBranch} in ${cwd}: ${stderr}`,
        );
      }
      await finishSquashCommit(sourceBranch, targetBranch, commitMessage, cwd);
      return;
    }
    throw new Error(
      `Could not squash-merge ${sourceBranch} into ${targetBranch} in ${cwd}: ${merge.stderr.trim()}`,
    );
  }

  await finishSquashCommit(sourceBranch, targetBranch, commitMessage, cwd);
}

async function finishSquashCommit(
  sourceBranch: string,
  targetBranch: string,
  commitMessage: string,
  cwd: string,
): Promise<void> {
  // Check if the squash merge produced any staged changes
  const diffIndex = await runGit(['diff', '--cached', '--quiet'], { cwd });
  if (diffIndex.exitCode === 0) {
    throw new Error(`Nothing to merge: ${sourceBranch} has no changes relative to ${targetBranch}. Use 'lazy close' or 'lazy reject' instead.`);
  }

  const commit = await runGit(['commit', '-m', commitMessage], { cwd });
  if (commit.exitCode !== 0) {
    throw new Error(
      `Squash-merge of ${sourceBranch} into ${targetBranch} staged changes but commit failed in ${cwd}: ${commit.stderr.trim()}`,
    );
  }
}

/**
 * How a `git stash pop` failed when restoring the destination worktree's
 * uncommitted work after a (durable) squash merge:
 * - `conflict-markers`: the stash applied but conflicts with the merged content,
 *   leaving conflict markers in the working tree. The stash is RETAINED.
 * - `pop-refused`: git refused the pop entirely (an untracked file produced by
 *   the merge collides with a stashed untracked file). NOTHING was applied; the
 *   worktree sits at the clean merged state. The stash is RETAINED.
 */
export type StashRestoreMode = 'conflict-markers' | 'pop-refused';

/**
 * Signals that a squash merge into a dirty destination worktree committed
 * successfully and durably, but the worktree's stashed uncommitted work could
 * NOT be automatically restored afterward. The merge is done; this is a
 * follow-up reconciliation the destination worktree's owner must perform. The
 * stash is always retained (never dropped) so the work is never lost.
 */
export interface DestinationRestoreConflict {
  /** The worktree whose stashed work could not be auto-restored. */
  worktreePath: string;
  /** The branch the merge committed into (checked out in `worktreePath`). */
  targetBranch: string;
  /** Stable reference to the retained stash (its commit SHA). */
  stashSha: string;
  /** Human-readable label the stash was pushed with (for `git stash list`). */
  stashLabel: string;
  /** Which way the restore failed — drives the recovery instructions. */
  mode: StashRestoreMode;
}

/**
 * Squash-merge a source branch into a target branch.
 *
 * A branch can only be checked out in ONE working tree at a time. When the
 * target branch is already checked out in a worktree (an intermediate parent
 * task's branch ALWAYS is — it lives in its own worktree), we cannot
 * `git checkout` it in the repo root: git refuses with "already used by
 * worktree at ...". So we run the squash merge IN that worktree instead, where
 * the branch is already checked out — no checkout required.
 *
 * Otherwise (no worktree holds the target), we fall back to checking it out in
 * the repo root, merging, and restoring the original branch.
 *
 * In both cases we never leave any location on the wrong branch or in a dirty
 * state, on success or failure.
 */
export async function squashMergeBranchIntoTarget(
  sourceBranch: string,
  targetBranch: string,
  commitMessage: string,
  cwd?: string
): Promise<DestinationRestoreConflict | null> {
  const originalBranch = await getCurrentBranch(cwd);

  // Case 1: the target is already checked out right here (cwd is on it). Merge
  // in place — no checkout needed, and no branch to restore. This is the common
  // "accept into main from the repo root" path, byte-for-byte as before.
  if (originalBranch === targetBranch) {
    await runSquashMergeCommit(sourceBranch, targetBranch, commitMessage, cwd ?? process.cwd());
    return null;
  }

  // Case 2: the target is checked out in a SEPARATE worktree. A branch can only
  // be checked out in one working tree at a time, so we cannot `git checkout` it
  // here — git refuses with "already used by worktree at ...". An intermediate
  // parent task's branch ALWAYS lives in its own worktree, so this is the path
  // that the local-merge accept of any child-into-parent takes. Merge directly
  // in that worktree, where the branch is already checked out.
  const worktreePath = await findWorktreeForBranch(targetBranch, cwd);
  if (worktreePath) {
    // A squash merge stages changes into the worktree's index and updates its
    // working files. If the worktree has unrelated uncommitted work, running the
    // merge directly would entangle with it. We must NOT refuse the accept just
    // because the DESTINATION worktree is dirty (the dirt is usually unrelated
    // human work — e.g. merging into a `main` worktree with local edits), and we
    // must NEVER lose that work. So when the worktree is dirty, stash the human's
    // changes, merge against the now-clean worktree, then restore the stash on
    // top of the merged result — exactly like `git stash; git merge; git stash
    // pop`. When it's clean, merge in place as before.
    if (await hasUncommittedChanges(worktreePath)) {
      return await squashMergeIntoDirtyWorktree(sourceBranch, targetBranch, commitMessage, worktreePath);
    }
    try {
      await runSquashMergeCommit(sourceBranch, targetBranch, commitMessage, worktreePath);
    } catch (err) {
      // Undo any partial squash staging so the worktree is left clean.
      await runGit(['reset', '--hard', 'HEAD'], { cwd: worktreePath });
      throw err;
    }
    return null;
  }

  // Case 3: no worktree holds the target branch — safe to check it out in the
  // repo root, merge, then restore the original branch.
  const checkout = await runGit(['checkout', targetBranch], { cwd });
  if (checkout.exitCode !== 0) {
    throw new Error(`Failed to checkout ${targetBranch}: ${checkout.stderr}`);
  }

  try {
    await runSquashMergeCommit(sourceBranch, targetBranch, commitMessage, cwd ?? process.cwd());
  } finally {
    await runGit(['checkout', originalBranch], { cwd });
  }
  return null;
}

/**
 * Squash-merge `sourceBranch` into `targetBranch` when the target's worktree has
 * unrelated uncommitted changes. The destination worktree being dirty must NOT
 * block the accept, and the human's uncommitted work must NEVER be lost.
 *
 * Strategy: stash the human's changes (tracked + untracked) so the worktree is
 * clean, run the squash merge, then restore the stash on top of the merged
 * result. This mirrors `git stash; git merge; git stash pop` and is consistent
 * with the clean-worktree path, which also advances the worktree to the merged
 * state.
 *
 * Failure handling never silently discards work:
 * - If stashing fails, we abort before touching anything.
 * - If the merge fails (e.g. a real conflict), we reset the partial merge and
 *   pop the stash back, leaving the worktree exactly as we found it.
 * - If the merge succeeds but the stash cannot be reapplied (the human's changes
 *   conflict with the merged result), the merge is already durable — we do NOT
 *   fail the accept and we do NOT swallow the failure: we return a structured
 *   {@link DestinationRestoreConflict} (stash retained) so the caller can hand
 *   the reconciliation to the worktree's owning agent.
 */
async function squashMergeIntoDirtyWorktree(
  sourceBranch: string,
  targetBranch: string,
  commitMessage: string,
  worktreePath: string
): Promise<DestinationRestoreConflict | null> {
  // Stash tracked AND untracked changes so the worktree is clean for the merge
  // and no human work is left behind. `--include-untracked` keeps untracked
  // files in the stash so `stash pop` restores them too.
  const stashLabel = `lazy-accept-autostash into ${targetBranch}`;
  const stash = await runGit(['stash', 'push', '--include-untracked', '-m', stashLabel], { cwd: worktreePath });
  if (stash.exitCode !== 0) {
    throw new Error(
      `Cannot merge into ${targetBranch}: failed to stash uncommitted changes in its worktree at ` +
      `${worktreePath}: ${stash.stderr}. Commit or stash them manually, then retry.`
    );
  }
  // Capture the stash's commit SHA now — it's a stable handle to the stashed work
  // even if more stashes get pushed later (which would shift `stash@{0}`).
  const stashShaResult = await runGit(['rev-parse', 'stash@{0}'], { cwd: worktreePath });
  const stashSha = stashShaResult.exitCode === 0 ? stashShaResult.stdout.trim() : 'stash@{0}';

  try {
    await runSquashMergeCommit(sourceBranch, targetBranch, commitMessage, worktreePath);
  } catch (err) {
    // Merge failed (e.g. a genuine conflict). Undo any partial squash staging,
    // then restore the human's stashed work so the worktree is untouched.
    await runGit(['reset', '--hard', 'HEAD'], { cwd: worktreePath });
    const restore = await runGit(['stash', 'pop'], { cwd: worktreePath });
    if (restore.exitCode !== 0) {
      throw new Error(
        `Squash merge into ${targetBranch} failed, and restoring your stashed changes in ${worktreePath} ` +
        `also failed: ${restore.stderr}. Your uncommitted work is preserved in the git stash — recover it ` +
        `with 'git stash pop' in that worktree. Original merge error: ${err instanceof Error ? err.message : err}`
      );
    }
    throw err;
  }

  // Merge committed and durable. Reapply the human's uncommitted work on top.
  const pop = await runGit(['stash', 'pop'], { cwd: worktreePath });
  if (pop.exitCode === 0) {
    return null; // Clean restore — the common case.
  }

  // The merge succeeded but the stash could not be auto-restored. Do NOT fail the
  // accept and do NOT swallow this: the stash is retained, so distinguish HOW it
  // failed and surface a structured signal for the caller to act on.
  //
  // Two failure modes:
  // - untracked collision: git refuses the whole pop ("would be overwritten by
  //   merge" / "already exists"); nothing is applied, worktree is at clean merge.
  // - tracked conflict: git applies with conflict markers and keeps the stash.
  const popText = `${pop.stdout}\n${pop.stderr}`.toLowerCase();
  const mode: StashRestoreMode =
    popText.includes('would be overwritten') ||
    popText.includes('already exists') ||
    popText.includes('untracked working tree file')
      ? 'pop-refused'
      : 'conflict-markers';

  logger.warn(
    `Merged into ${targetBranch}, but the destination worktree's uncommitted work at ${worktreePath} ` +
    `could not be auto-restored (${mode}). It is preserved in git stash ${stashSha} ("${stashLabel}").`
  );

  return { worktreePath, targetBranch, stashSha, stashLabel, mode };
}

export async function deleteBranch(branch: string, cwd?: string): Promise<void> {
  const result = await runGit(['branch', '-D', branch], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git branch -D ${branch} failed: ${result.stderr}`);
  }
}

/**
 * Pathspecs to restrict a diff to, appended after a `--` separator. Empty or
 * undefined means "the whole tree". Applied to the uncommitted-changes section
 * too, so a filtered diff never leaks files the caller excluded.
 */
function withPathspecs(args: string[], paths?: string[]): string[] {
  if (!paths || paths.length === 0) return args;
  return [...args, '--', ...paths];
}

export async function getDiffStat(fromRef: string, toRef: string = 'HEAD', cwd?: string, twoDot: boolean = false, paths?: string[]): Promise<string> {
  // Two-dot diff shows tree difference (for captured upstream SHA).
  // Three-dot diff compares against merge-base (for branch comparison).
  const range = twoDot ? `${fromRef}..${toRef}` : `${fromRef}...${toRef}`;
  const result = await runGit(withPathspecs(['diff', '--no-color', '--stat', range], paths), { cwd });
  if (result.exitCode !== 0) {
    return '';
  }
  let output = result.stdout;

  // If toRef is HEAD and there are uncommitted changes, include them
  if (toRef === 'HEAD' && await hasUncommittedChanges(cwd)) {
    const uncommittedStat = await runGit(withPathspecs(['diff', '--no-color', '--stat', 'HEAD'], paths), { cwd });
    if (uncommittedStat.exitCode === 0 && uncommittedStat.stdout) {
      output += '\n--- Uncommitted changes ---\n' + uncommittedStat.stdout;
    }
  }

  return output;
}

export async function getDiffFull(fromRef: string, toRef: string = 'HEAD', cwd?: string, twoDot: boolean = false, paths?: string[]): Promise<string> {
  // Two-dot diff shows tree difference (for captured upstream SHA).
  // Three-dot diff compares against merge-base (for branch comparison).
  const range = twoDot ? `${fromRef}..${toRef}` : `${fromRef}...${toRef}`;
  const result = await runGit(withPathspecs(['diff', '--no-color', range], paths), { cwd });
  if (result.exitCode !== 0) {
    return '';
  }
  let output = result.stdout;

  // If toRef is HEAD and there are uncommitted changes, include them
  if (toRef === 'HEAD' && await hasUncommittedChanges(cwd)) {
    const uncommittedDiff = await runGit(withPathspecs(['diff', '--no-color', 'HEAD'], paths), { cwd });
    if (uncommittedDiff.exitCode === 0 && uncommittedDiff.stdout) {
      output += '\n\n--- Uncommitted changes ---\n' + uncommittedDiff.stdout;
    }
  }

  return output;
}

/** The pre- and post-image paths a diff touches. */
export interface DiffPathSets {
  /** Post-image paths — what the diff renders as `data-file`. */
  newPaths: string[];
  /** Pre-image paths, which differ from the above only for renames and deletions. */
  oldPaths: string[];
}

/**
 * The paths a diff touches, both sides, without materialising the patch.
 *
 * This is the allow-list for reading unchanged context out of a file (the review
 * page's expand controls): a reviewer may read more of a file the change already
 * shows them, and nothing else. Deriving it with --name-status rather than by
 * parsing the full patch keeps a 20-line expansion from regenerating megabytes
 * of diff, and keeps renames honest — `R100 old new` contributes one path to
 * each side.
 *
 * Uncommitted changes are included on the same terms as getDiffFull, because
 * that is what the reviewer is looking at when the worktree is dirty.
 */
export async function getDiffPathSets(
  fromRef: string,
  toRef: string = 'HEAD',
  cwd?: string,
  twoDot: boolean = false,
  /**
   * Restrict the allow-list to these pathspecs — the same restriction
   * `getDiffFull` honours. An empty array is "no files" (a scoped hub with
   * no direct changes), not "the whole tree".
   */
  paths?: string[],
): Promise<DiffPathSets> {
  const newPaths = new Set<string>();
  const oldPaths = new Set<string>();

  const absorb = (stdout: string) => {
    for (const raw of stdout.split('\n')) {
      if (!raw) continue;
      const parts = raw.split('\t');
      const status = parts[0] ?? '';
      if (status.startsWith('R') || status.startsWith('C')) {
        if (parts[1]) oldPaths.add(parts[1]);
        if (parts[2]) newPaths.add(parts[2]);
        continue;
      }
      const path = parts[1];
      if (!path) continue;
      if (status !== 'A') oldPaths.add(path);
      if (status !== 'D') newPaths.add(path);
    }
  };

  // Empty path list is a scoped-and-empty hub: nothing is readable.
  if (paths && paths.length === 0) {
    return { newPaths: [], oldPaths: [] };
  }

  const range = twoDot ? `${fromRef}..${toRef}` : `${fromRef}...${toRef}`;
  const result = await runGit(withPathspecs(['diff', '--no-color', '--name-status', range], paths), { cwd });
  if (result.exitCode === 0) absorb(result.stdout);

  if (toRef === 'HEAD' && (await hasUncommittedChanges(cwd))) {
    const dirty = await runGit(withPathspecs(['diff', '--no-color', '--name-status', 'HEAD'], paths), { cwd });
    if (dirty.exitCode === 0) absorb(dirty.stdout);
  }

  return { newPaths: [...newPaths], oldPaths: [...oldPaths] };
}

/**
 * Whether a worktree is sitting in the middle of a merge, and how far along.
 *
 * Every surface that reports on a task's worktree needs this: a mid-merge
 * worktree is not "a few uncommitted changes", it is an unfinished operation
 * that a human or an agent has to conclude. Reporting it as ordinary dirt (or,
 * worse, as nothing at all) is how a half-merged worktree once reached a human
 * as a bare `blocked` task (fix-sync-silent-conflict).
 */
export interface WorktreeMergeState {
  /** MERGE_HEAD exists — a merge was started and never concluded. */
  mergeInProgress: boolean;
  /** Paths git still reports as unmerged (conflict markers on disk). */
  unmergedFiles: string[];
}

/** True when the worktree is mid-merge in any form. */
export function isMidMerge(state: WorktreeMergeState): boolean {
  return state.mergeInProgress || state.unmergedFiles.length > 0;
}

/**
 * One-line human summary of a mid-merge worktree, or null when it is settled.
 * Shared so `show`, `wait`, `status` and `accept` all say the same thing.
 */
export function describeMergeState(state: WorktreeMergeState): string | null {
  if (!isMidMerge(state)) return null;
  const count = state.unmergedFiles.length;
  if (state.mergeInProgress) {
    return count > 0
      ? `merge in progress with ${count} unresolved conflict(s): ${state.unmergedFiles.join(', ')}`
      : 'merge in progress: conflicts are resolved but the merge is not committed';
  }
  return `${count} unmerged file(s) with no merge in progress: ${state.unmergedFiles.join(', ')}`;
}

export async function readWorktreeMergeState(cwd?: string): Promise<WorktreeMergeState> {
  const mergeHead = await runGit(['rev-parse', '--verify', 'MERGE_HEAD'], { cwd });
  const unmerged = await runGit(['diff', '--name-only', '--diff-filter=U'], { cwd });
  return {
    // `rev-parse --verify MERGE_HEAD` prints the sha; a zero exit with no sha
    // means we did not actually observe a MERGE_HEAD, so it must not be read as
    // "mid-merge" — that would strand every caller on a false positive.
    mergeInProgress: mergeHead.exitCode === 0 && mergeHead.stdout.trim().length > 0,
    unmergedFiles:
      unmerged.exitCode === 0
        ? unmerged.stdout.split('\n').map(l => l.trim()).filter(Boolean)
        : [],
  };
}

/**
 * Lazy's own runtime/control artifacts, excluded from every dirty-worktree
 * question. They are not the agent's work and must never make a worktree look
 * dirty:
 *   .lazy-task-sandbox/ — agent sessions, protocol files
 *   .lazy-lock          — the per-worktree session lock. A CRASHED session
 *     leaves a stale lock behind, so auto-resume's dirty check (which decides
 *     whether to merge upstream before resuming) would otherwise always see
 *     the worktree as dirty and skip the merge. See auto-resume.ts.
 *
 * Spelled once and shared by {@link hasUncommittedChanges} and
 * {@link listUncommittedPaths}: the predicate and the list must answer about
 * the SAME worktree, or a turn is nudged about a path accept does not consider
 * dirty — or, worse, the other way round.
 */
const DIRTY_CHECK_EXCLUSIONS = [':!.lazy-task-sandbox', ':!.lazy-lock'];

/**
 * The paths with uncommitted content — staged, unstaged and untracked alike,
 * lazy's own artifacts excluded.
 *
 * Returns `null` when the scan itself FAILED, which is deliberately not the
 * same answer as an empty array: a caller reporting "this turn left nothing
 * behind" must be able to tell a clean worktree from one it could not read.
 * ({@link hasUncommittedChanges} answers `false` in that case instead, which is
 * right for a gate — refusing an operation because git hiccuped would be worse
 * — and wrong for a record.)
 *
 * TWO commands that emit BARE PATHS, deliberately not `git status
 * --porcelain`, whose records are `XY <path>`:
 *
 *  - `runGit` TRIMS stdout, and an unstaged modification's status begins with a
 *    space (` M README.md`). Trimming eats it, so a fixed `slice(3)` returns
 *    `EADME.md` — and only ever for the FIRST record, which is why a parser
 *    like that looks correct in most tests. Recovering the lost column means
 *    guessing from how many spaces follow the status letter; bare paths need no
 *    guess.
 *  - A rename record carries a second field for the original path, and status
 *    output C-quotes any path with a space or a non-ASCII byte unless `-z` is
 *    passed. None of that applies to a list of names.
 *
 * `--others --exclude-standard` lists untracked files INDIVIDUALLY, where `git
 * status` collapses a wholly untracked directory to `public-docs/` — the thing
 * that matters being `public-docs/troubleshooting.md`. The predicate above
 * keeps `git status`: it only ever claims "something is here", where none of
 * this bites.
 *
 * Returns `null` if either command fails, including in a repository with no
 * commits (`HEAD` does not resolve) — an answer this cannot give, rather than
 * a wrong one.
 */
export async function listUncommittedPaths(cwd?: string): Promise<string[] | null> {
  // Tracked changes, staged and unstaged together, against HEAD.
  const tracked = await runGit(
    ['diff', '--name-only', '-z', 'HEAD', '--', ...DIRTY_CHECK_EXCLUSIONS],
    { cwd },
  );
  if (tracked.exitCode !== 0) return null;
  const untracked = await runGit(
    ['ls-files', '-z', '--others', '--exclude-standard', '--', ...DIRTY_CHECK_EXCLUSIONS],
    { cwd },
  );
  if (untracked.exitCode !== 0) return null;

  // NUL-separated, so a path's own spaces and newlines survive intact. Deduped
  // because a file staged and then edited again appears once in `diff`, and a
  // path can never be both tracked and untracked.
  const paths = new Set<string>();
  for (const out of [tracked.stdout, untracked.stdout]) {
    for (const path of out.split('\0')) {
      if (path) paths.add(path);
    }
  }
  return [...paths];
}

export async function hasUncommittedChanges(cwd?: string): Promise<boolean> {
  const result = await runGit(
    ['status', '--porcelain', '--', ...DIRTY_CHECK_EXCLUSIONS],
    { cwd },
  );
  if (result.exitCode !== 0) {
    return false;
  }
  if (!result.stdout) return false;

  // Any remaining porcelain line is a real uncommitted change.
  const lines = result.stdout.split('\n');
  const hasRealChanges = lines.some(line => line.trim().length > 0);

  return hasRealChanges;
}

/**
 * Per-file and total ceilings on the UNTRACKED content a snapshot carries.
 *
 * `git diff` bounds itself — it can only describe files already in the index —
 * but the untracked pass is pointed at whatever happens to be sitting in the
 * worktree, and the snapshot lives in the store. An unbounded capture is how a
 * store grows until something else breaks (the proxy audit log reached 677 MiB
 * that way). A file over the ceiling is named in the status capture and skipped
 * in the patch; losing a 4 MiB artifact nobody committed is the better trade.
 */
const MAX_UNTRACKED_FILE_BYTES = 1024 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES = 4 * 1024 * 1024;

/**
 * THE USER'S DIFF CONFIGURATION MUST NOT REACH THIS CAPTURE. `git diff` is
 * porcelain, so it honours three settings by default that each turn the output
 * into something `git apply` cannot put back — and the cost of that is not the
 * one file, it is every file in the snapshot, because a patch is rejected whole.
 *
 *  - **textconv** (`*.png diff=exif` and friends). A one-way filter, enabled by
 *    default for `git diff` alone, and it WINS over `--binary`: a modified
 *    binary comes out as `-CONVERTED-TEXT-FOR /tmp/git-blob-xxxx/f.bin` and
 *    `git apply` answers `patch does not apply` (verified, git 2.x). Worse in
 *    the untracked pass, where the `Binary files …` guard then never fires and
 *    the unappliable text is captured as if it were content.
 *  - **an external diff driver** (`diff.external`, `GIT_EXTERNAL_DIFF`), whose
 *    output is not a patch at all.
 *  - **`diff.noprefix`**, which writes `diff --git f.bin f.bin`; `git apply`
 *    strips a leading component by default and mangles every path in it.
 *
 * None of these is exotic in a user's repository, and lazy captures in THEIR
 * worktree with THEIR config. Pinning the flags is what makes "the snapshot is
 * restorable" a property of this function rather than of the project it runs in.
 */
const CONFIG_PROOF_DIFF_FLAGS = ['--no-textconv', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/'];

/** The tracked captures add `--binary`; the untracked pass deliberately does not. */
const CAPTURE_DIFF_FLAGS = ['--binary', ...CONFIG_PROOF_DIFF_FLAGS];

/**
 * The uncommitted work in a worktree, as a patch `git apply` can put back:
 * staged, unstaged, AND the content of untracked files.
 *
 * UNTRACKED FILES ARE THE POINT, not a nicety. `git diff` describes only what
 * the index already knows, so for its first years this capture held nothing at
 * all for a NEW file — and a new file is the usual shape of the work this
 * mechanism exists to protect. The loss that prompted all of this was a new
 * `public-docs/troubleshooting.md`: a snapshot would have stored its NAME, in
 * the accompanying `git status`, and not one byte of its content, while the
 * restore reported success for having put back nothing.
 *
 * Each untracked file is diffed against `/dev/null`, which yields an ordinary
 * `new file mode` patch — no `git add -N` anywhere, because that writes the
 * index of a worktree we are only supposed to be READING at turn end.
 *
 * Two files are skipped rather than captured, and both skips protect the rest
 * of the patch: one over {@link MAX_UNTRACKED_FILE_BYTES} (or past the running
 * total), and a BINARY one — `git diff` renders that as "Binary files … differ",
 * a line `git apply` cannot apply, and one of them would fail the whole patch
 * and take the tracked edits down with it.
 */
export async function getUncommittedDiff(cwd?: string): Promise<string> {
  // CAPTURED VERBATIM (`trim: false`). A patch's whitespace is CONTENT: git
  // writes an empty context line as a single space, so a section ending on a
  // blank line ends `" \n"`, and `runGit`'s default trim takes both characters
  // — leaving a hunk body one line shorter than its `@@` header promises. `git
  // apply` calls that `corrupt patch at line N` and rejects the ENTIRE patch,
  // so one blank line at the end of one file's diff loses every other file's
  // edits with it, and the unblock lands right back in "Could not restore
  // uncommitted changes from backup".
  //
  // It has to be fixed HERE rather than at apply time. `patchBytes` can restore
  // the newline ending the whole patch, but the staged section's trailing blank
  // line goes missing in the MIDDLE of the patch as soon as an unstaged or
  // untracked section follows it, and no end-of-string repair can reach that.
  // `patchBytes` stays regardless: every snapshot already in the store was
  // captured trimmed and still needs the tail put back.
  //
  // `--binary` for the same reason the untracked pass skips a binary file:
  // WITHOUT it, a tracked binary the agent edited renders as `Binary files …
  // differ`, and `git apply` refuses the ENTIRE patch over that one line
  // (`cannot apply binary patch … without full index line`) — losing every
  // text edit and every untracked new file captured alongside it. With it, git
  // emits a literal `GIT binary patch` payload that applies cleanly, and the
  // only thing left to bound is its SIZE, which `dropOversizedBinaries` does.
  const staged = await runGit(
    ['diff', '--no-color', ...CAPTURE_DIFF_FLAGS, '--cached'],
    { cwd, trim: false },
  );
  const unstaged = await runGit(['diff', '--no-color', ...CAPTURE_DIFF_FLAGS], { cwd, trim: false });

  const sections: string[] = [];
  // ONE budget across both captures: a file that is staged and edited again
  // appears in each, and six modified binaries are six either way.
  const budget = { binaryBytesUsed: 0 };
  const stagedPatch = staged.exitCode === 0 ? dropOversizedBinaries(staged.stdout, budget) : '';
  const unstagedPatch = unstaged.exitCode === 0 ? dropOversizedBinaries(unstaged.stdout, budget) : '';
  if (stagedPatch) {
    sections.push('--- STAGED CHANGES ---\n' + stagedPatch);
  }
  if (unstagedPatch) {
    sections.push('--- UNSTAGED CHANGES ---\n' + unstagedPatch);
  }

  const untracked = await captureUntrackedFiles(cwd);
  if (untracked) sections.push('--- UNTRACKED FILES ---\n' + untracked);

  // Each section now ends with its own newline, so sections are joined by the
  // marker line alone — a blank line between them would be read as patch
  // content, which is the mistake this capture just stopped making.
  return sections.join('');
}

/**
 * The same two ceilings as the untracked pass, applied to the `GIT binary
 * patch` payloads of TRACKED binaries. `git diff` bounds itself to files the
 * index knows, but a tracked 8 MiB fixture the agent rewrote is still 8 MiB of
 * base85 in a store that is not a place for it — and the TOTAL matters as much
 * as the per-file figure: a snapshot is written on every dirty turn, nothing
 * ever consumes or supersedes one, so a worktree holding six modified binaries
 * would deposit all six, again, every turn.
 */
const MAX_TRACKED_BINARY_BYTES = MAX_UNTRACKED_FILE_BYTES;
const MAX_TRACKED_BINARY_TOTAL_BYTES = MAX_UNTRACKED_TOTAL_BYTES;

/**
 * Drop the whole `diff --git` section of any binary file this snapshot cannot
 * afford or cannot apply, leaving every other file's edits intact.
 *
 * Three reasons a section goes:
 *  - its payload is over {@link MAX_TRACKED_BINARY_BYTES};
 *  - the running binary total is spent ({@link MAX_TRACKED_BINARY_TOTAL_BYTES},
 *    shared across the staged and unstaged captures via `budget`);
 *  - it still carries a `Binary files … differ` line. With `--binary` and
 *    {@link CONFIG_PROOF_DIFF_FLAGS} that should be unreachable, and it is
 *    checked anyway: that one line makes `git apply` reject the patch WHOLE, so
 *    the cost of being wrong about "unreachable" is every other file in it.
 *
 * A WHOLE section, never a truncation: half a binary payload is a patch `git
 * apply` rejects too. The file is still NAMED in the snapshot's `git status`,
 * and the restore-failure message reports it as recorded by name only.
 *
 * Sections are split on `diff --git ` at the start of a line. A base85 payload
 * line can never look like that: git writes each one as a length letter
 * (`A`–`z`) followed by base85, so it has no space in it at all. Nor can a text
 * file's own content, which is always prefixed with `+`, `-` or a space.
 */
function dropOversizedBinaries(patch: string, budget: { binaryBytesUsed: number }): string {
  if (!patch) return '';
  const kept: string[] = [];
  // The leading '' from a patch that starts with the delimiter is dropped by
  // the emptiness check below.
  for (const chunk of patch.split(/^(?=diff --git )/m)) {
    if (!chunk) continue;
    const name = /^diff --git a\/(.*?) b\//.exec(chunk)?.[1] ?? 'a binary file';

    if (/^Binary files /m.test(chunk)) {
      logger.debug(
        `Worktree snapshot: ${name} came back as an unappliable binary diff; naming it without capturing its content`,
      );
      continue;
    }

    const isBinary = chunk.includes('\nGIT binary patch\n');
    if (isBinary) {
      if (chunk.length > MAX_TRACKED_BINARY_BYTES) {
        logger.debug(
          `Worktree snapshot: ${name} is a binary over the per-file ceiling; naming it without capturing its content`,
        );
        continue;
      }
      if (budget.binaryBytesUsed + chunk.length > MAX_TRACKED_BINARY_TOTAL_BYTES) {
        logger.debug(
          `Worktree snapshot: the binary capture is full; naming ${name} without capturing its content`,
        );
        continue;
      }
      budget.binaryBytesUsed += chunk.length;
    }

    kept.push(chunk);
  }
  return kept.join('');
}

/** The new-file patches for the worktree's untracked files, within the ceilings. */
async function captureUntrackedFiles(cwd?: string): Promise<string> {
  const listed = await runGit(
    ['ls-files', '-z', '--others', '--exclude-standard', '--', ...DIRTY_CHECK_EXCLUSIONS],
    { cwd },
  );
  if (listed.exitCode !== 0) return '';

  const patches: string[] = [];
  let total = 0;
  for (const path of listed.stdout.split('\0')) {
    if (!path) continue;
    if (total >= MAX_UNTRACKED_TOTAL_BYTES) {
      logger.debug(`Worktree snapshot: untracked capture is full; not capturing ${path}`);
      continue;
    }

    // `--no-index` compares two paths outside the index and answers 1 for
    // "they differ", which is the normal case here — anything above that is a
    // real failure. An EMPTY untracked file is exit 0 with no output: nothing
    // to restore, so nothing to store.
    // `trim: false` for the same reason as the two captures above: an
    // untracked file ending in a blank line would otherwise lose it, and take
    // the whole patch down with it.
    const result = await runGit(
      ['diff', '--no-color', ...CONFIG_PROOF_DIFF_FLAGS, '--no-index', '--', '/dev/null', path],
      { cwd, trim: false },
    );
    if (result.exitCode > 1 || !result.stdout) continue;
    if (/^Binary files /m.test(result.stdout)) {
      logger.debug(`Worktree snapshot: ${path} is binary; naming it without capturing its content`);
      continue;
    }
    if (result.stdout.length > MAX_UNTRACKED_FILE_BYTES) {
      logger.debug(`Worktree snapshot: ${path} is over the per-file ceiling; not capturing its content`);
      continue;
    }

    patches.push(result.stdout);
    total += result.stdout.length;
  }

  // Joined bare: each patch was captured verbatim and already ends with its own
  // newline, so anything added here would be read as patch content.
  return patches.join('');
}

/**
 * A patch, as bytes `git apply` will accept.
 *
 * THE TRAILING NEWLINE IS LOAD-BEARING, and its absence is why the worktree
 * backup could never be restored. `runGit` trims every command's stdout, so the
 * patch `getUncommittedDiff` captures has lost the newline that ends its last
 * line — and `git apply` answers a patch that ends mid-line with `error:
 * corrupt patch at line N`, for the `--check` dry run just as much as for the
 * real thing. Every snapshot lazy has ever stored is trimmed that way, so this
 * has to be fixed HERE, at apply time, rather than by capturing new snapshots
 * correctly: the ones already in the store are exactly the ones somebody needs
 * back.
 */
function patchBytes(patch: string): Uint8Array {
  return new TextEncoder().encode(patch.endsWith('\n') ? patch : patch + '\n');
}

/**
 * Is this patch's content ALREADY in the working tree (typically because it was
 * committed since the patch was taken)?
 *
 * `git apply -R --check` asks exactly that: a patch that reverses cleanly is
 * one whose additions are all present. It is the difference between "your
 * backup could not be restored" and "your backup is redundant" — two messages
 * an operator reads very differently, and one failed `git apply` produces both.
 *
 * Never throws and never writes: `--check` is a dry run.
 */
export async function patchIsAlreadyApplied(patch: string, cwd?: string): Promise<boolean> {
  const result = await runGit(['apply', '-R', '--check'], {
    cwd,
    stdin: patchBytes(patch),
  });
  return result.exitCode === 0;
}

/**
 * Paths out of a stored `git status --porcelain` capture, for naming files in a
 * message.
 *
 * Plain porcelain (not `-z`) because that is the format snapshots were captured
 * in — a path holding a space or a non-ASCII byte comes back C-quoted, as git
 * wrote it. Good enough to name a file to a human; use
 * {@link listUncommittedPaths} for anything that has to be an exact path.
 *
 * The status field is dropped by MATCHING it, never by slicing three fixed
 * columns. Snapshots were captured through `runGit`, which trims stdout, so a
 * status whose first record is an unstaged modification (` M README.md`) is
 * stored having already lost its leading space — and `slice(3)` on that yields
 * `EADME.md`. Only ever the first record, which is why the mistake survives
 * most tests; it is the same trim that made the patch itself unusable.
 */
export function snapshotFiles(gitStatus: string): string[] {
  return gitStatus
    .split('\n')
    .map(line => {
      // `XY <path>`, or `Y <path>` when the leading space was trimmed away.
      const match = /^[ MADRCU?!]{1,2}\s+(.*)$/.exec(line);
      const path = (match ? match[1] : line).trim();
      // A rename reads `old -> new`; name the file that exists now.
      const arrow = path.lastIndexOf(' -> ');
      return arrow === -1 ? path : path.slice(arrow + 4).trim();
    })
    .filter(Boolean);
}

/**
 * The paths a patch actually carries, and can therefore put back.
 *
 * Needed because a snapshot's file NAMES and its file CONTENT come from two
 * different captures, and they do not always agree: the status names everything
 * the worktree held, while the patch skips a file that was unappliable or over
 * a capture ceiling. Telling a human their work "is still in the task's
 * snapshot" when the snapshot never held a byte of it sends them to a store
 * that cannot give it back — the worst possible answer to give somebody who is
 * already looking for lost work. The message is built from the intersection, so
 * a path missing HERE is reported to them as recorded by name only.
 *
 * READ PER SECTION, not per `+++ b/<path>` line, because three kinds of change
 * git can replay perfectly have no `+++` line naming them, and each one used to
 * fall into that "content was not captured" bucket — the opposite of the truth:
 *
 *  - a DELETION, whose `+++` is `/dev/null` (the a-side names the file);
 *  - a BINARY file captured with `--binary`, which carries no `---`/`+++` pair
 *    at all, just `GIT binary patch` and its payload;
 *  - a pure RENAME or a mode-only change, which is `rename from`/`rename to` or
 *    `old mode`/`new mode` and nothing else.
 *
 * So every `diff --git` section counts, named by its `+++` target where it has
 * one and by its b-side header otherwise. That is exactly true of a snapshot:
 * a section the capture could not replay was dropped WHOLE before it was
 * stored, so a section that is present is a change this patch can apply.
 */
export function patchPaths(patch: string): string[] {
  const paths: string[] = [];
  const strip = (p: string) => (/^[ab]\//.test(p) ? p.slice(2) : p);

  // The section in hand: the file its `diff --git` header names, and whether
  // some line inside it has already named the file more precisely.
  let headerName: string | undefined;
  let source: string | undefined;
  let named = false;
  const endSection = () => {
    if (!named && headerName) paths.push(headerName);
    headerName = undefined;
    source = undefined;
    named = false;
  };

  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      endSection();
      // `a/<path> b/<path>`; the b-side is the file as it exists after the patch.
      headerName = /^diff --git a\/(.*?) b\/(.*)$/.exec(line)?.[2];
      continue;
    }
    if (line.startsWith('--- ')) {
      source = line.slice(4).trim();
      continue;
    }
    if (!line.startsWith('+++ ')) continue;
    const target = line.slice(4).trim();
    if (target === '/dev/null') {
      const deleted = source && source !== '/dev/null' ? strip(source) : headerName;
      if (deleted) paths.push(deleted);
    } else {
      paths.push(strip(target));
    }
    named = true;
  }
  endSection();

  return paths;
}

export async function applyPatch(patch: string, cwd?: string): Promise<boolean> {
  // Apply a git patch to the working directory. `git apply` handles a capture
  // holding both the staged and the unstaged diff back to back — what it will
  // not accept is a patch that ends mid-line, hence patchBytes.
  const result = await runGit(['apply'], {
    cwd,
    stdin: patchBytes(patch),
  });

  if (result.exitCode !== 0) {
    // The caller decides what a failure MEANS (redundant backup vs lost one),
    // but git's own reason must not vanish on the way: "corrupt patch at line
    // N" and "patch does not apply" send an investigation to different places.
    logger.debug(`applyPatch failed: ${result.stderr || `git apply exited ${result.exitCode}`}`);
  }
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
 * Check whether a git remote is configured in this repo.
 */
export async function remoteExists(remoteName: string, cwd?: string): Promise<boolean> {
  const result = await runGit(['remote', 'get-url', remoteName], { cwd });
  return result.exitCode === 0;
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
  // A project with no such remote configured is a normal local-only setup, not
  // a network failure — the branch simply isn't reachable anywhere. Retrying a
  // fetch against a non-existent remote three times with backoff only delays a
  // wrong, network-flavored error ("Check your network connection and retry").
  if (!await remoteExists(remoteName, cwd)) {
    return false;
  }

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
/**
 * Is `ancestor` contained in `descendant`'s history?
 *
 * Returns false — never throws — when either ref is unknown to this
 * repository, so a caller can treat "not an ancestor" and "gone" the same way
 * when all it needs is "can I safely use this as a range start".
 */
export async function isAncestorCommit(
  ancestor: string,
  descendant: string,
  cwd?: string,
): Promise<boolean> {
  const result = await runGit(['merge-base', '--is-ancestor', ancestor, descendant], { cwd });
  return result.exitCode === 0;
}

export async function getMergeBase(branch1: string, branch2: string, cwd?: string): Promise<string> {
  const result = await runGit(['merge-base', branch1, branch2], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to find merge base: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * Simulate merging `sourceBranch` into `oursBranch` and report whether it
 * conflicts — without touching the working tree or index.
 *
 * Uses `git merge-tree --write-tree` (git ≥2.38), which performs a real 3-way
 * merge in-memory and communicates the outcome through its EXIT STATUS:
 *   - exit 0  → clean merge
 *   - exit 1  → merge conflict (conflicted paths are listed on stdout)
 *   - exit ≥2 → error (bad ref, unsupported flag, corrupt repo, etc.)
 *
 * We deliberately do NOT scan stdout for the textual conflict markers (the
 * 7-char "ours"/"theirs"/separator lines). Those sequences legitimately appear
 * in committed file CONTENT — conflict-handling test fixtures, docs about merge
 * conflicts — and a content grep false-positives on them, aborting accepts for
 * merges that cannot actually conflict. The exit status reflects the merge
 * algorithm's own verdict and is immune to content.
 *
 * (This comment itself avoids writing a literal 7-char marker run so that, until
 * the fixed detector is deployed everywhere, the still-running pre-fix detector
 * on the merging daemon does not false-positive on this very file.)
 *
 * Per CLAUDE.md (fail hard, no silent fallbacks): an error exit throws rather
 * than being papered over as "no conflict" (which would let a broken check wave
 * through an unmergeable branch) or as "conflict" (which would block a mergeable
 * branch on a transient git error). Note that some git versions also return
 * exit 1 when a ref cannot be resolved, so we validate both refs up front to
 * keep exit 1 an unambiguous signal for a genuine conflict.
 */
async function mergeWouldConflict(oursBranch: string, sourceBranch: string, cwd?: string): Promise<boolean> {
  // Resolve both refs first. merge-tree reports an unresolvable ref with the
  // same exit 1 as a real conflict on some git versions (e.g. 2.39), so without
  // this a typo'd branch would masquerade as a conflict. rev-parse --verify
  // gives us a clear, actionable error naming the offending ref instead.
  for (const ref of [oursBranch, sourceBranch]) {
    const rev = await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd });
    if (rev.exitCode !== 0) {
      throw new Error(
        `Cannot check merge conflicts: ref '${ref}' does not resolve to a commit` +
        `${cwd ? ` in ${cwd}` : ''}: ${rev.stderr || 'unknown ref'}`,
      );
    }
  }

  // With two commit args, merge-tree finds the merge base itself and performs
  // the full recursive merge. `--write-tree` is the modern mode that surfaces
  // conflicts via exit status; it is the default in git ≥2.38 but we pass it
  // explicitly so behavior is pinned regardless of git's default mode.
  const result = await runGit(['merge-tree', '--write-tree', oursBranch, sourceBranch], { cwd });

  if (result.exitCode === 0) return false;
  if (result.exitCode === 1) return true;

  throw new Error(
    `git merge-tree --write-tree ${oursBranch} ${sourceBranch} failed with exit code ${result.exitCode}` +
    `${cwd ? ` in ${cwd}` : ''}: ${result.stderr || result.stdout || 'unknown error'}`,
  );
}

/**
 * Check if merging fromBranch into current HEAD would result in conflicts.
 */
export async function checkMergeConflicts(fromBranch: string, cwd?: string): Promise<boolean> {
  return await mergeWouldConflict('HEAD', fromBranch, cwd);
}

/**
 * Check if merging sourceBranch into targetBranch would result in conflicts.
 * Similar to checkMergeConflicts but allows specifying the target branch.
 */
export async function checkMergeConflictsIntoTarget(sourceBranch: string, targetBranch: string, cwd?: string): Promise<boolean> {
  return await mergeWouldConflict(targetBranch, sourceBranch, cwd);
}

/**
 * The same merge-tree dry run as {@link mergeWouldConflict}, but also names
 * the conflicted paths so a reviewer can see *where* before they press Sync.
 *
 * Parsing is a pure function of stdout ({@link parseMergeTreeConflictFiles})
 * so the unit tests do not need a repo. Exit-status rules stay identical:
 * 0 = clean, 1 = conflict, anything else throws.
 */
export interface MergeConflictPreview {
  wouldConflict: boolean;
  files: string[];
}

/**
 * Collect unique conflicted paths from `git merge-tree --write-tree` stdout.
 *
 * The modern informational format lists each path under a "changed in both"
 * (or "added in both", …) block; some git versions also emit unmerged-index
 * lines (`mode oid stage<TAB>path`) or `CONFLICT (content): Merge conflict in
 * <path>`. We accept all three so a stale git still names the files.
 */
export function parseMergeTreeConflictFiles(stdout: string): string[] {
  const files = new Set<string>();
  for (const raw of stdout.split('\n')) {
    const line = raw.trimEnd();
    const conflictMsg = line.match(/^CONFLICT \([^)]+\): Merge conflict in (.+)$/);
    if (conflictMsg) {
      files.add(conflictMsg[1]);
      continue;
    }
    const indexStage = line.match(/^\d{6} \S+ [123]\t(.+)$/);
    if (indexStage) {
      files.add(indexStage[1]);
      continue;
    }
    const sideLine = line.match(/^\s+(?:base|our|their)\s+\d{6}\s+\S+\s+(.+)$/);
    if (sideLine) {
      files.add(sideLine[1].trim());
    }
  }
  return [...files];
}

export async function mergeConflictPreview(
  oursBranch: string,
  sourceBranch: string,
  cwd?: string,
): Promise<MergeConflictPreview> {
  for (const ref of [oursBranch, sourceBranch]) {
    const rev = await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd });
    if (rev.exitCode !== 0) {
      throw new Error(
        `Cannot check merge conflicts: ref '${ref}' does not resolve to a commit` +
        `${cwd ? ` in ${cwd}` : ''}: ${rev.stderr || 'unknown ref'}`,
      );
    }
  }

  const result = await runGit(['merge-tree', '--write-tree', oursBranch, sourceBranch], { cwd });
  if (result.exitCode === 0) return { wouldConflict: false, files: [] };
  if (result.exitCode === 1) {
    return { wouldConflict: true, files: parseMergeTreeConflictFiles(result.stdout) };
  }
  throw new Error(
    `git merge-tree --write-tree ${oursBranch} ${sourceBranch} failed with exit code ${result.exitCode}` +
    `${cwd ? ` in ${cwd}` : ''}: ${result.stderr || result.stdout || 'unknown error'}`,
  );
}

/**
 * Build a squash commit message for a task merge.
 *
 * When `fidelityBody` is provided (a synthesized summary of what the work
 * actually became), it replaces the raw commit-subject list — this is the
 * local-driver sink for commit/PR fidelity. When it is absent (synthesis
 * unavailable, or non-fidelity callers), we fall back to the deterministic
 * goal + commit-subjects message.
 */
async function buildSquashCommitMessage(taskShortId: string, goal: string, sourceBranch: string, targetBranch: string, root: string, fidelityBody?: string): Promise<string> {
  let message = `Accept task ${taskShortId}: ${goal}`;
  const body = fidelityBody?.trim();
  if (body) {
    message += `\n\n${body}`;
  } else {
    const commitMsgs = await getBranchCommitMessages(sourceBranch, targetBranch, root);
    if (commitMsgs.length > 0) {
      message += '\n\nSquashed commit of the following:\n' +
        commitMsgs.map(m => `  ${m}`).join('\n');
    }
  }
  // Add Lazy co-author trailer
  message += `\n\n${LAZY_COAUTHOR_TRAILER}`;
  return message;
}

/**
 * Squash-merge a task branch into its target branch.
 *
 * `fidelityBody`, when provided, is a synthesized faithful summary used as the
 * squash commit body instead of the raw commit-subject list. See
 * buildSquashCommitMessage.
 */
export async function squashMergeTaskBranch(
  sourceBranch: string,
  targetBranch: string,
  taskShortId: string,
  goal: string,
  root: string,
  fidelityBody?: string,
): Promise<DestinationRestoreConflict | null> {
  const commitMessage = await buildSquashCommitMessage(taskShortId, goal, sourceBranch, targetBranch, root, fidelityBody);
  return await squashMergeBranchIntoTarget(sourceBranch, targetBranch, commitMessage, root);
}

/**
 * Would merging `sourceBranch` into `targetBranch` change nothing?
 *
 * True when a clean 3-way merge of the two yields exactly the target's tree —
 * every change the source carries is already on the target. Used ONLY to make a
 * RESUMED accept's squash idempotent; a conflicted merge-tree answers false so
 * the caller takes its ordinary path and reports the conflict.
 */
export async function branchChangesAlreadyIn(sourceBranch: string, targetBranch: string, cwd: string): Promise<boolean> {
  const merged = await runGit(['merge-tree', '--write-tree', targetBranch, sourceBranch], { cwd });
  if (merged.exitCode !== 0) return false;
  const mergedTree = merged.stdout.split('\n')[0]?.trim();
  const target = await runGit(['rev-parse', '--verify', `${targetBranch}^{tree}`], { cwd });
  if (target.exitCode !== 0) {
    throw new Error(`Failed to resolve the tree of ${targetBranch}: ${target.stderr || 'unknown error'}`);
  }
  return !!mergedTree && mergedTree === target.stdout.trim();
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
