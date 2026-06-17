/**
 * Unit tests for squashMergeBranchIntoTarget's worktree-awareness.
 *
 * INVARIANT (fix-local-merge-worktree): A local squash merge MUST succeed when
 * the target branch is checked out in a SEPARATE git worktree. An intermediate
 * parent task's branch ALWAYS lives in its own worktree, so accepting any child
 * into such a parent goes through this path. A branch can only be checked out in
 * one working tree at a time, so the merge must run IN that worktree rather than
 * trying to `git checkout` the target in the repo root (which git refuses with
 * "already used by worktree at ...").
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { runGit } from '../../src/utils/git';
import { squashMergeBranchIntoTarget } from '../../src/git/operations';

async function initRepo(dir: string): Promise<void> {
  await runGit(['init', '-q', '-b', 'main'], { cwd: dir });
  await runGit(['config', 'user.email', 'test@example.com'], { cwd: dir });
  await runGit(['config', 'user.name', 'Test'], { cwd: dir });
  await writeFile(join(dir, 'README.md'), 'init\n');
  await runGit(['add', '.'], { cwd: dir });
  await runGit(['commit', '-q', '-m', 'init'], { cwd: dir });
}

async function currentBranch(cwd: string): Promise<string> {
  const r = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  return r.stdout.trim();
}

async function logSubjects(ref: string, cwd: string): Promise<string> {
  const r = await runGit(['log', '--format=%s', ref], { cwd });
  return r.stdout;
}

describe('squashMergeBranchIntoTarget: worktree-aware target', () => {
  let repo: string;
  let parentWorktree: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'lazy-squash-wt-'));
    await initRepo(repo);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    if (parentWorktree) await rm(parentWorktree, { recursive: true, force: true });
  });

  test('merges into a target branch held in a separate worktree', async () => {
    // Parent branch lives in its own worktree — exactly like an intermediate
    // parent task. The repo root stays on main.
    await runGit(['branch', 'lazy/parent'], { cwd: repo });
    parentWorktree = `${repo}-parent`;
    await runGit(['worktree', 'add', '-q', parentWorktree, 'lazy/parent'], { cwd: repo });

    // Child branch with real work, based off the parent.
    await runGit(['checkout', '-q', '-b', 'lazy/child', 'lazy/parent'], { cwd: repo });
    await writeFile(join(repo, 'child.txt'), 'child work\n');
    await runGit(['add', '.'], { cwd: repo });
    await runGit(['commit', '-q', '-m', 'child work'], { cwd: repo });
    await runGit(['checkout', '-q', 'main'], { cwd: repo });

    // This is the operation that used to hard-fail with
    // "Failed to checkout lazy/parent: ... already used by worktree".
    await squashMergeBranchIntoTarget('lazy/child', 'lazy/parent', 'Accept child', repo);

    // The squash commit landed on the parent branch.
    expect(await logSubjects('lazy/parent', repo)).toContain('Accept child');
    // The merged file is present at the parent's tip.
    const show = await runGit(['show', 'lazy/parent:child.txt'], { cwd: repo });
    expect(show.exitCode).toBe(0);
    expect(show.stdout).toContain('child work');

    // Neither the root nor the parent worktree was left on the wrong branch.
    expect(await currentBranch(repo)).toBe('main');
    expect(await currentBranch(parentWorktree)).toBe('lazy/parent');
    // The parent worktree is clean.
    const status = await runGit(['status', '--porcelain'], { cwd: parentWorktree });
    expect(status.stdout.trim()).toBe('');
  });

  test('fails clearly (without merging) when the target worktree is dirty', async () => {
    await runGit(['branch', 'lazy/parent'], { cwd: repo });
    parentWorktree = `${repo}-parent`;
    await runGit(['worktree', 'add', '-q', parentWorktree, 'lazy/parent'], { cwd: repo });

    await runGit(['checkout', '-q', '-b', 'lazy/child', 'lazy/parent'], { cwd: repo });
    await writeFile(join(repo, 'child.txt'), 'child work\n');
    await runGit(['add', '.'], { cwd: repo });
    await runGit(['commit', '-q', '-m', 'child work'], { cwd: repo });
    await runGit(['checkout', '-q', 'main'], { cwd: repo });

    // Dirty the parent worktree.
    await writeFile(join(parentWorktree, 'dirty.txt'), 'uncommitted\n');

    await expect(
      squashMergeBranchIntoTarget('lazy/child', 'lazy/parent', 'Accept child', repo)
    ).rejects.toThrow(/uncommitted changes/);

    // No squash commit was created on the parent.
    expect(await logSubjects('lazy/parent', repo)).not.toContain('Accept child');
  });

  test('still merges into a target with no worktree via root checkout', async () => {
    // Feature branch with content but NOT checked out anywhere.
    await runGit(['checkout', '-q', '-b', 'feature'], { cwd: repo });
    await writeFile(join(repo, 'feature.txt'), 'feature\n');
    await runGit(['add', '.'], { cwd: repo });
    await runGit(['commit', '-q', '-m', 'feature base'], { cwd: repo });

    // Child off feature, with work.
    await runGit(['checkout', '-q', '-b', 'lazy/child', 'feature'], { cwd: repo });
    await writeFile(join(repo, 'child.txt'), 'child work\n');
    await runGit(['add', '.'], { cwd: repo });
    await runGit(['commit', '-q', '-m', 'child work'], { cwd: repo });

    // Root sits on main; neither feature nor child is checked out.
    await runGit(['checkout', '-q', 'main'], { cwd: repo });

    await squashMergeBranchIntoTarget('lazy/child', 'feature', 'Accept child', repo);

    expect(await logSubjects('feature', repo)).toContain('Accept child');
    // Original branch restored.
    expect(await currentBranch(repo)).toBe('main');
  });

  test('merges in place when the target is checked out in the root itself', async () => {
    // Root is ON the target branch (e.g. accept into main from the repo root).
    await runGit(['checkout', '-q', '-b', 'lazy/child', 'main'], { cwd: repo });
    await writeFile(join(repo, 'child.txt'), 'child work\n');
    await runGit(['add', '.'], { cwd: repo });
    await runGit(['commit', '-q', '-m', 'child work'], { cwd: repo });
    await runGit(['checkout', '-q', 'main'], { cwd: repo });

    await squashMergeBranchIntoTarget('lazy/child', 'main', 'Accept child', repo);

    expect(await logSubjects('main', repo)).toContain('Accept child');
    expect(await currentBranch(repo)).toBe('main');
  });
});
