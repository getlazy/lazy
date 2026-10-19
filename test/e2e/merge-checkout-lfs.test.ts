/**
 * Syncs and accepts on a repository whose checkout is SLOW — the shape of a
 * repository with large Git LFS files, whose smudge filter downloads each one
 * as git writes it into the working tree.
 *
 * spawn()'s default 60s kill timer used to apply to every merge, checkout and
 * fast-forward lazy runs in a task worktree or the project root, so a sync or
 * accept that pulled in big LFS files was killed partway through and left the
 * checkout half-updated. runGit now runs every working-tree-writing git
 * command with no kill timer unless the caller asks for one.
 *
 * A filter driver that sleeps stands in for git-lfs (see
 * worktree-restore-lfs.test.ts): what matters is that writing files is slow.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtemp, writeFile, readFile, rm, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { runGit, writesWorkingTree } from '../../src/utils/git';
import { squashMergeBranchIntoTarget } from '../../src/git/operations';
import { slowSuiteSkipped } from '../helpers/slow-suite';

const dirs: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (await proc.exited !== 0) throw new Error(`git ${args.join(' ')}: ${await new Response(proc.stderr).text()}`);
}

/**
 * A repo on `main` with branch `lazy/slow` adding `files` LFS-like files whose
 * smudge filter sleeps `sleepSeconds` each — merging the branch is slow.
 */
async function slowMergeRepo(files: number, sleepSeconds: number): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lazy-merge-lfs-')));
  dirs.push(root);
  await git(root, 'init', '-q', '-b', 'main');
  await git(root, 'config', 'user.email', 't@example.com');
  await git(root, 'config', 'user.name', 't');
  await writeFile(join(root, '.gitattributes'), '*.sqlite filter=slowlfs\n');
  await git(root, 'add', '-A');
  await git(root, 'commit', '-qm', 'init');
  await git(root, 'checkout', '-q', '-b', 'lazy/slow');
  for (let i = 0; i < files; i++) await writeFile(join(root, `f${i}.sqlite`), `payload ${i}\n`);
  await git(root, 'add', '-A');
  await git(root, 'commit', '-qm', 'add data');
  await git(root, 'checkout', '-q', 'main');
  await git(root, 'config', 'filter.slowlfs.smudge', `sleep ${sleepSeconds}; cat`);
  await git(root, 'config', 'filter.slowlfs.clean', 'cat');
  await git(root, 'config', 'filter.slowlfs.required', 'true');
  return root;
}

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('which git commands run without a kill timer', () => {
  // INVARIANT: every git command that can write a working tree (and so run
  // LFS smudging) is exempt from the 60s default kill timer; read-only and
  // network commands keep it.
  test('working-tree writers are recognised, others are not', () => {
    for (const args of [
      ['merge', 'x', '--no-ff'], ['merge', '--ff-only', 'origin/main'], ['merge', '--squash', 'x'],
      ['checkout', 'main'], ['reset', '--hard', 'HEAD'], ['stash', 'pop'], ['pull'],
      ['worktree', 'add', '/p', 'b'], ['-C', '/repo', 'merge', 'x'], ['-c', 'a=b', 'checkout', 'x'],
    ]) expect(writesWorkingTree(args)).toBe(true);
    for (const args of [
      ['status'], ['fetch', 'origin'], ['rev-parse', 'HEAD'], ['worktree', 'prune'], ['-C', '/repo', 'log'], [],
    ]) expect(writesWorkingTree(args)).toBe(false);
  });

  test('a slow merge completes through runGit', async () => {
    const root = await slowMergeRepo(2, 1);
    const r = await runGit(['merge', 'lazy/slow', '--no-ff', '-m', 'sync'], { cwd: root });
    expect(r.exitCode).toBe(0);
    expect(await readFile(join(root, 'f1.sqlite'), 'utf8')).toBe('payload 1\n');
  }, 30_000);
});

describe('merges longer than 60 seconds', () => {
  // INVARIANT: a sync's merge is never killed by the generic 60s backstop —
  // a killed merge leaves the task's checkout half-updated.
  test.skipIf(slowSuiteSkipped('merge with checkout longer than 60s'))('a sync-style merge completes', async () => {
    const root = await slowMergeRepo(3, 23);
    const r = await runGit(['merge', 'lazy/slow', '--no-ff', '-m', 'sync'], { cwd: root });
    expect(r.exitCode).toBe(0);
    expect(await readFile(join(root, 'f2.sqlite'), 'utf8')).toBe('payload 2\n');
  }, 150_000);

  // INVARIANT: accept's squash merge is never killed by the generic 60s backstop.
  test.skipIf(slowSuiteSkipped('accept squash merge longer than 60s'))('an accept squash merge completes', async () => {
    const root = await slowMergeRepo(3, 23);
    expect(await squashMergeBranchIntoTarget('lazy/slow', 'main', 'Accept', root)).toBeNull();
    expect(await readFile(join(root, 'f2.sqlite'), 'utf8')).toBe('payload 2\n');
  }, 150_000);
});
