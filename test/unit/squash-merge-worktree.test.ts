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
import { mkdtemp, rm, writeFile, readFile, realpath } from 'fs/promises';
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
    // Canonicalize the temp path: on macOS tmpdir() lives under /var, a symlink
    // to /private/var, and `git worktree list` reports the resolved path — so the
    // worktreePath the code returns would never string-match a /var-rooted
    // expectation. Resolving here keeps all downstream path comparisons exact.
    repo = await realpath(await mkdtemp(join(tmpdir(), 'lazy-squash-wt-')));
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

  // INVARIANT (fix-accept-dirty-destination): a DIRTY destination/parent worktree
  // must NOT block accept when the dirt is unrelated to the merge. Refusing to
  // merge because the place we're merging INTO has unrelated uncommitted work is
  // surprising and wrong. The human's uncommitted work must survive intact —
  // never lost (project invariant #1) — reapplied on top of the merged result.
  test('succeeds and preserves unrelated dirt when the target worktree is dirty', async () => {
    await runGit(['branch', 'lazy/parent'], { cwd: repo });
    parentWorktree = `${repo}-parent`;
    await runGit(['worktree', 'add', '-q', parentWorktree, 'lazy/parent'], { cwd: repo });

    await runGit(['checkout', '-q', '-b', 'lazy/child', 'lazy/parent'], { cwd: repo });
    await writeFile(join(repo, 'child.txt'), 'child work\n');
    await runGit(['add', '.'], { cwd: repo });
    await runGit(['commit', '-q', '-m', 'child work'], { cwd: repo });
    await runGit(['checkout', '-q', 'main'], { cwd: repo });

    // Dirty the parent worktree with UNRELATED human work: one untracked file and
    // one modified tracked file, neither touching the merged path (child.txt).
    await writeFile(join(parentWorktree, 'untracked.txt'), 'untracked human work\n');
    await writeFile(join(parentWorktree, 'README.md'), 'init\nmodified by human\n');

    // Must NOT throw — the dirt is unrelated to the merge.
    await squashMergeBranchIntoTarget('lazy/child', 'lazy/parent', 'Accept child', repo);

    // The squash commit landed and the child work is on the parent branch.
    expect(await logSubjects('lazy/parent', repo)).toContain('Accept child');
    const show = await runGit(['show', 'lazy/parent:child.txt'], { cwd: parentWorktree });
    expect(show.exitCode).toBe(0);
    expect(show.stdout).toContain('child work');

    // The human's uncommitted work survived intact, reapplied on top of the merge.
    expect(await readFile(join(parentWorktree, 'untracked.txt'), 'utf-8')).toBe('untracked human work\n');
    expect(await readFile(join(parentWorktree, 'README.md'), 'utf-8')).toBe('init\nmodified by human\n');

    // And the merged content is present in the working tree too.
    expect(await readFile(join(parentWorktree, 'child.txt'), 'utf-8')).toBe('child work\n');

    // Both locations are still on their own branches.
    expect(await currentBranch(repo)).toBe('main');
    expect(await currentBranch(parentWorktree)).toBe('lazy/parent');
  });

  // INVARIANT (fix-accept-dirty-destination): when the merge itself genuinely
  // conflicts, we must roll back cleanly — no commit on the target, and the
  // destination worktree's uncommitted human work restored exactly as we found it.
  test('rolls back cleanly and preserves dirt on a genuine merge conflict', async () => {
    // Parent and child both edit the same file divergently → squash merge conflicts.
    await runGit(['branch', 'lazy/parent'], { cwd: repo });
    parentWorktree = `${repo}-parent`;
    await runGit(['worktree', 'add', '-q', parentWorktree, 'lazy/parent'], { cwd: repo });
    await writeFile(join(parentWorktree, 'README.md'), 'parent version\n');
    await runGit(['add', '.'], { cwd: parentWorktree });
    await runGit(['commit', '-q', '-m', 'parent edit'], { cwd: parentWorktree });

    await runGit(['checkout', '-q', '-b', 'lazy/child', 'main'], { cwd: repo });
    await writeFile(join(repo, 'README.md'), 'child version\n');
    await runGit(['add', '.'], { cwd: repo });
    await runGit(['commit', '-q', '-m', 'child edit'], { cwd: repo });
    await runGit(['checkout', '-q', 'main'], { cwd: repo });

    // Unrelated human dirt in the parent worktree.
    await writeFile(join(parentWorktree, 'human.txt'), 'human work\n');

    await expect(
      squashMergeBranchIntoTarget('lazy/child', 'lazy/parent', 'Accept child', repo)
    ).rejects.toThrow();

    // No squash commit was created on the parent.
    expect(await logSubjects('lazy/parent', repo)).not.toContain('Accept child');
    // The human's uncommitted work is restored intact.
    expect(await readFile(join(parentWorktree, 'human.txt'), 'utf-8')).toBe('human work\n');
    // The worktree is back on its branch with only the dirt we left it (untracked human.txt).
    expect(await currentBranch(parentWorktree)).toBe('lazy/parent');
    const status = await runGit(['status', '--porcelain'], { cwd: parentWorktree });
    expect(status.stdout.trim()).toBe('?? human.txt');
  });

  // INVARIANT (fix-accept-dirty-destination): when the merge commits but the
  // stashed destination work cannot be auto-restored, the merge stays DURABLE
  // and we return a structured DestinationRestoreConflict (never throw, never
  // swallow). The stash MUST be retained so no human work is lost.
  test('returns conflict-markers signal (stash retained) when the dirt overlaps the merge', async () => {
    await runGit(['branch', 'lazy/parent'], { cwd: repo });
    parentWorktree = `${repo}-parent`;
    await runGit(['worktree', 'add', '-q', parentWorktree, 'lazy/parent'], { cwd: repo });

    // Child modifies README.md divergently from the same base.
    await runGit(['checkout', '-q', '-b', 'lazy/child', 'lazy/parent'], { cwd: repo });
    await writeFile(join(repo, 'README.md'), 'child version\n');
    await runGit(['add', '.'], { cwd: repo });
    await runGit(['commit', '-q', '-m', 'child edits README'], { cwd: repo });
    await runGit(['checkout', '-q', 'main'], { cwd: repo });

    // The destination worktree has an UNCOMMITTED edit to the SAME file.
    await writeFile(join(parentWorktree, 'README.md'), 'human version\n');

    const conflict = await squashMergeBranchIntoTarget('lazy/child', 'lazy/parent', 'Accept child', repo);

    // The merge is durable: the squash commit landed on the parent.
    expect(await logSubjects('lazy/parent', repo)).toContain('Accept child');
    // A structured restore conflict is returned (not thrown, not null).
    expect(conflict).not.toBeNull();
    expect(conflict!.mode).toBe('conflict-markers');
    expect(conflict!.targetBranch).toBe('lazy/parent');
    expect(conflict!.worktreePath).toBe(parentWorktree);
    // The stash is retained so the human's work is never lost.
    const stashSha = await runGit(['rev-parse', conflict!.stashSha], { cwd: parentWorktree });
    expect(stashSha.exitCode).toBe(0);
    const stashList = await runGit(['stash', 'list'], { cwd: parentWorktree });
    expect(stashList.stdout).toContain('lazy-accept-autostash');
  });

  test('returns pop-refused signal (stash retained) when an untracked file collides with the merge', async () => {
    await runGit(['branch', 'lazy/parent'], { cwd: repo });
    parentWorktree = `${repo}-parent`;
    await runGit(['worktree', 'add', '-q', parentWorktree, 'lazy/parent'], { cwd: repo });

    // Child ADDS a new tracked file.
    await runGit(['checkout', '-q', '-b', 'lazy/child', 'lazy/parent'], { cwd: repo });
    await writeFile(join(repo, 'gen.txt'), 'from merge\n');
    await runGit(['add', '.'], { cwd: repo });
    await runGit(['commit', '-q', '-m', 'child adds gen.txt'], { cwd: repo });
    await runGit(['checkout', '-q', 'main'], { cwd: repo });

    // The destination worktree has an UNTRACKED file at the same path.
    await writeFile(join(parentWorktree, 'gen.txt'), 'human untracked\n');

    const conflict = await squashMergeBranchIntoTarget('lazy/child', 'lazy/parent', 'Accept child', repo);

    expect(await logSubjects('lazy/parent', repo)).toContain('Accept child');
    expect(conflict).not.toBeNull();
    expect(conflict!.mode).toBe('pop-refused');
    // The merged file is on disk (pop was refused, so nothing was reapplied).
    expect(await readFile(join(parentWorktree, 'gen.txt'), 'utf-8')).toBe('from merge\n');
    // The human's untracked file is safe in the retained stash.
    const stashSha = await runGit(['rev-parse', conflict!.stashSha], { cwd: parentWorktree });
    expect(stashSha.exitCode).toBe(0);
    const stashList = await runGit(['stash', 'list'], { cwd: parentWorktree });
    expect(stashList.stdout).toContain('lazy-accept-autostash');
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
