/**
 * A sync must never return over a half-merged worktree, and every surface that
 * reports on a task must say so when one exists.
 *
 * These tests cover the three primitives that make that possible:
 *  - `readWorktreeMergeState` / `isMidMerge` / `describeMergeState` — the one
 *    shared probe `show`, `wait`, `status` and `accept` all read from,
 *  - `settleConflictedWorktree` — the settle-or-shout step every merge failure
 *    path goes through,
 *  - the `merge_commit` elevated op — concluding a merge whose conflicts are
 *    already resolved, instead of throwing that work away.
 *
 * They use real git repos: the states under test (MERGE_HEAD present, unmerged
 * paths on disk) only exist in a real index, and mocking them would test the
 * mock rather than git's actual behaviour.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readWorktreeMergeState,
  isMidMerge,
  describeMergeState,
} from '../../src/git/operations';
import { settleConflictedWorktree } from '../../src/supervisor/merge';
import { resetElevatedGitChannel } from '../../src/supervisor/elevated-git';
import { createInternalGitHandler } from '../../src/mcp/internal-git';
import type { McpToolContext } from '../../src/mcp/tools';

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return {
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    exitCode: result.exitCode,
  };
}

/** Temp repo on `main` with one commit. */
async function createTestRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lazy-merge-settle-'));
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'test@lazy.test');
  git(dir, 'config', 'user.name', 'Lazy Test');
  git(dir, 'checkout', '-b', 'main');
  await writeFile(join(dir, 'README.md'), '# Test\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'Initial commit');
  return dir;
}

/**
 * Repo whose `feature` branch (checked out) conflicts with `main` on file.txt —
 * the shape of the live incident: one file conflicts, everything else merges.
 */
async function createConflictingRepo(): Promise<string> {
  const dir = await createTestRepo();
  await writeFile(join(dir, 'file.txt'), 'main content\n');
  git(dir, 'add', 'file.txt');
  git(dir, 'commit', '-m', 'Add file on main');

  git(dir, 'checkout', '-b', 'feature', 'HEAD~1');
  await writeFile(join(dir, 'file.txt'), 'feature content\n');
  git(dir, 'add', 'file.txt');
  git(dir, 'commit', '-m', 'Add file on feature');
  return dir;
}

/** Start the conflicting merge and assert it really did conflict. */
function startConflictingMerge(dir: string): void {
  const result = git(dir, 'merge', 'main');
  expect(result.exitCode).not.toBe(0);
}

describe('worktree merge state', () => {
  let repoDir = '';

  afterEach(async () => {
    resetElevatedGitChannel();
    if (repoDir) await rm(repoDir, { recursive: true, force: true });
    repoDir = '';
  });

  test('a clean worktree is not mid-merge and has nothing to describe', async () => {
    repoDir = await createTestRepo();
    const state = await readWorktreeMergeState(repoDir);
    expect(state).toEqual({ mergeInProgress: false, unmergedFiles: [] });
    expect(isMidMerge(state)).toBe(false);
    expect(describeMergeState(state)).toBeNull();
  });

  test('a conflicted merge reports MERGE_HEAD and names the unmerged files', async () => {
    repoDir = await createConflictingRepo();
    startConflictingMerge(repoDir);

    const state = await readWorktreeMergeState(repoDir);
    expect(state.mergeInProgress).toBe(true);
    expect(state.unmergedFiles).toEqual(['file.txt']);
    expect(isMidMerge(state)).toBe(true);
    expect(describeMergeState(state)).toContain('file.txt');
  });

  test('a resolved-but-uncommitted merge is still mid-merge', async () => {
    // INVARIANT (fix-sync-silent-conflict): "conflicts resolved" is NOT "merge
    // finished". A staged-but-uncommitted merge is exactly the state the
    // release-v021 hub was interrupted in, and reporting it as settled is what
    // let the strand go unnoticed.
    repoDir = await createConflictingRepo();
    startConflictingMerge(repoDir);
    await writeFile(join(repoDir, 'file.txt'), 'resolved content\n');
    git(repoDir, 'add', 'file.txt');

    const state = await readWorktreeMergeState(repoDir);
    expect(state.mergeInProgress).toBe(true);
    expect(state.unmergedFiles).toEqual([]);
    expect(isMidMerge(state)).toBe(true);
    expect(describeMergeState(state)).toBe(
      'merge in progress: conflicts are resolved but the merge is not committed',
    );
  });
});

describe('settleConflictedWorktree', () => {
  let repoDir = '';

  afterEach(async () => {
    resetElevatedGitChannel();
    if (repoDir) await rm(repoDir, { recursive: true, force: true });
    repoDir = '';
  });

  test('is a no-op on a settled worktree', async () => {
    repoDir = await createTestRepo();
    const result = await settleConflictedWorktree(repoDir);
    expect(result.settled).toBe(true);
    expect(result.detail).toContain('no merge in progress');
  });

  test('aborts a conflicted merge and reports what it found', async () => {
    // INVARIANT (fix-sync-silent-conflict): every merge failure path settles the
    // worktree before returning, and says what it did. A worktree with UU files
    // and no in-flight resolution must be impossible after a sync returns.
    repoDir = await createConflictingRepo();
    startConflictingMerge(repoDir);
    const headBefore = git(repoDir, 'rev-parse', 'HEAD').stdout;

    const result = await settleConflictedWorktree(repoDir);
    expect(result.settled).toBe(true);
    expect(result.detail).toContain('file.txt');

    const after = await readWorktreeMergeState(repoDir);
    expect(isMidMerge(after)).toBe(false);
    // Abort restores the pre-merge commit, it does not invent a new one.
    expect(git(repoDir, 'rev-parse', 'HEAD').stdout).toBe(headBefore);
  });

  test('reports settled: false with an actionable message when the abort fails', async () => {
    // INVARIANT (fix-sync-silent-conflict): a failed abort is NOT swallowed. The
    // one situation that absolutely has to be shouted about is a worktree we
    // could not put back — the caller gets `settled: false` and a command to run.
    repoDir = await createConflictingRepo();
    startConflictingMerge(repoDir);

    // Unmerged paths with no MERGE_HEAD: `git merge --abort` refuses ("There is
    // no merge to abort"), so settling cannot succeed. This is the shape the
    // live incident left behind after something reset the merge out from under
    // the conflict markers.
    await rm(join(repoDir, '.git', 'MERGE_HEAD'), { force: true });

    const result = await settleConflictedWorktree(repoDir);
    expect(result.settled).toBe(false);
    expect(result.detail).toContain('STILL mid-merge');
    expect(result.detail).toContain('git merge --abort');
    expect(result.detail).toContain(repoDir);
  });
});

describe('lazy_internal_git merge_commit', () => {
  let repoDir = '';

  afterEach(async () => {
    resetElevatedGitChannel();
    if (repoDir) await rm(repoDir, { recursive: true, force: true });
    repoDir = '';
  });

  /** merge_commit needs no storage — it validates only the worktree it is given. */
  function handlerFor(worktreePath: string) {
    const ctx = { taskId: 'a'.repeat(32), worktreePath } as McpToolContext;
    return createInternalGitHandler(ctx);
  }

  test('refuses when no merge is in progress', async () => {
    // INVARIANT (fix-sync-silent-conflict): without MERGE_HEAD this op would
    // commit arbitrary worktree changes as if they were a merge.
    repoDir = await createTestRepo();
    await writeFile(join(repoDir, 'stray.txt'), 'not a merge\n');
    git(repoDir, 'add', 'stray.txt');

    await expect(handlerFor(repoDir)({ op: 'merge_commit' })).rejects.toThrow(
      /no merge is in progress/,
    );
  });

  test('refuses when conflicts are still unresolved', async () => {
    // INVARIANT (fix-sync-silent-conflict): committing here would bake conflict
    // markers into the branch.
    repoDir = await createConflictingRepo();
    startConflictingMerge(repoDir);

    await expect(handlerFor(repoDir)({ op: 'merge_commit' })).rejects.toThrow(
      /unresolved conflicts/,
    );
  });

  test('concludes a fully-resolved merge instead of discarding it', async () => {
    // INVARIANT (fix-sync-silent-conflict): an agent that resolved every
    // conflict but could not commit (it cannot move refs from inside the
    // container) must have that work concluded, not aborted and re-requested.
    repoDir = await createConflictingRepo();
    startConflictingMerge(repoDir);
    await writeFile(join(repoDir, 'file.txt'), 'resolved content\n');
    git(repoDir, 'add', 'file.txt');
    const headBefore = git(repoDir, 'rev-parse', 'HEAD').stdout;

    const result = await handlerFor(repoDir)({ op: 'merge_commit' }) as { exit_code: number; head: string };
    expect(result.exit_code).toBe(0);
    expect(result.head).not.toBe(headBefore);

    const after = await readWorktreeMergeState(repoDir);
    expect(isMidMerge(after)).toBe(false);
    // A real merge commit: two parents, and the resolution is what landed.
    expect(git(repoDir, 'rev-list', '--parents', '-n', '1', 'HEAD').stdout.split(' ')).toHaveLength(3);
    expect(git(repoDir, 'show', 'HEAD:file.txt').stdout).toBe('resolved content');
  });
});
