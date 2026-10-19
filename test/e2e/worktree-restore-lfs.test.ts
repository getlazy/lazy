/**
 * Restoring a task's files when the checkout is SLOW — the shape of a
 * repository with large Git LFS files in subdirectories, whose smudge filter
 * downloads each one during checkout.
 *
 * The incident: Start services in Lazy Teams failed after a long wait with
 * "error: unable to create file datasets/…sqlite: No such file or directory …
 * fatal: Could not reset index file to revision 'HEAD'". Cause, reproduced
 * here: `git worktree add` ran under spawn()'s default 60s kill timer; the
 * kill made git's signal handler DELETE the half-made worktree while its
 * `git reset --hard` child (and the LFS filter) kept writing into it.
 *
 * A filter driver that sleeps stands in for git-lfs: what matters is that the
 * checkout is slow and writes into a subdirectory, not where bytes come from.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { recoverMissingWorktree, describeWorktreeAddFailure, checkoutProgressParser } from '../../src/git/operations';
import { slowSuiteSkipped } from '../helpers/slow-suite';
import { ensureTaskWorktree } from '../../src/daemon/task-worktree';
import { RpcError } from '../../src/daemon/rpc-error';
import type { Task } from '../../src/types';

const dirs: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (await proc.exited !== 0) throw new Error(`git ${args.join(' ')}: ${await new Response(proc.stderr).text()}`);
}

/** A repo whose `datasets/*.sqlite` pass through a smudge filter sleeping `sleepSeconds` per file. */
async function slowLfsLikeRepo(files: number, sleepSeconds: number): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lazy-restore-lfs-')));
  dirs.push(root);
  await git(root, 'init', '-q', '-b', 'main');
  await mkdir(join(root, 'datasets'));
  for (let i = 0; i < files; i++) await writeFile(join(root, 'datasets', `f${i}.sqlite`), `payload ${i}\n`);
  await writeFile(join(root, '.gitattributes'), 'datasets/*.sqlite filter=slowlfs\n');
  await git(root, 'add', '-A');
  await git(root, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init');
  await git(root, 'branch', 'lazy/slow');
  await git(root, 'config', 'filter.slowlfs.smudge', `sleep ${sleepSeconds}; cat`);
  await git(root, 'config', 'filter.slowlfs.clean', 'cat');
  await git(root, 'config', 'filter.slowlfs.required', 'true');
  return root;
}

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('restoring task files with a slow (LFS-like) checkout', () => {
  test('restores files in a subdirectory and reports checkout progress', async () => {
    const root = await slowLfsLikeRepo(4, 1);
    const wt = join(root, '.lazy', 'worktrees', 'slow');
    const notes: string[] = [];
    const result = await recoverMissingWorktree(wt, 'lazy/slow', root, { onProgress: (d) => notes.push(d) });
    expect(result.recovered).toBe(true);
    expect(await readFile(join(wt, 'datasets', 'f3.sqlite'), 'utf8')).toBe('payload 3\n');
    expect(notes.some((n) => /^Checking out files: \d+\/\d+ \(\d+%\)$/.test(n))).toBe(true);
  }, 30_000);

  // INVARIANT: a worktree restore is never killed by the generic 60s subprocess
  // backstop. Killing `git worktree add` deletes the half-made worktree while
  // its checkout child keeps writing — the "unable to create file … No such
  // file or directory" failure that broke Start services on LFS repositories.
  test.skipIf(slowSuiteSkipped('worktree restore: checkout longer than 60s'))('a checkout longer than 60 seconds still completes', async () => {
    const root = await slowLfsLikeRepo(3, 23);
    const wt = join(root, '.lazy', 'worktrees', 'slow');
    const result = await recoverMissingWorktree(wt, 'lazy/slow', root);
    expect(result.recovered).toBe(true);
    expect(await readFile(join(wt, 'datasets', 'f2.sqlite'), 'utf8')).toBe('payload 2\n');
  }, 150_000);
});

describe('restore failure message', () => {
  const incident = [
    "Preparing worktree (checking out 'lazy/llm-call-streaming')",
    'Filtering content:   7% (2/28)\rFiltering content:  92% (26/28), 69.40 MiB | 5.95 MiB/s',
    'error: unable to create file datasets/locations.us.sqlite: No such file or directory',
    'error: unable to create file datasets/locations.global.sqlite: No such file or directory',
    'error: unable to create file datasets/places.full.sqlite: No such file or directory',
    'error: unable to create file datasets/more.sqlite: No such file or directory',
    "fatal: Could not reset index file to revision 'HEAD'.",
  ].join('\n');

  test('names the files, the directory and what to do — never the progress spew', () => {
    const msg = describeWorktreeAddFailure(incident, '/w/llm', 'lazy/llm-call-streaming');
    expect(msg).toContain("branch 'lazy/llm-call-streaming' into /w/llm");
    expect(msg).toContain('4 file(s) could not be written (datasets/locations.us.sqlite, datasets/locations.global.sqlite, datasets/places.full.sqlite and 1 more): No such file or directory');
    expect(msg).toContain("Could not reset index file to revision 'HEAD'");
    expect(msg).toContain('daemon log');
    expect(msg).not.toContain('Filtering content');
    expect(msg).not.toContain('MiB');
  });

  test('progress parser turns git progress into one note per percentage', () => {
    const notes: string[] = [];
    const parse = checkoutProgressParser((d) => notes.push(d));
    parse('Filtering content:   7% (2/28)\rFiltering con');
    parse('tent:   7% (2/28)\rFiltering content:  92% (26/28), 69.40 MiB | 5.95 MiB/s\r');
    expect(notes).toEqual(['Downloading large files: 2/28 (7%)', 'Downloading large files: 26/28 (92%), 69.40 MiB']);
  });
});

// The real restore path behind Start services' "Cannot restore task files".
describe('ensureTaskWorktree (the restore Start services runs)', () => {
  const task = { id: 'abcdef1234567890', metadata: { task_ref: 'slow' } } as unknown as Task;

  test('narrates checkout progress through its notifier', async () => {
    const root = await slowLfsLikeRepo(4, 1);
    await mkdir(join(root, '.lazy'), { recursive: true });
    const notes: string[] = [];
    const path = await ensureTaskWorktree(root, task, 'lazy/slow', (d) => notes.push(d));
    expect(path).toBe(join(root, '.lazy', 'worktrees', 'slow'));
    expect(notes[0]).toBe('Restoring task files…');
    expect(notes.some((n) => n.startsWith('Checking out files: '))).toBe(true);
  }, 30_000);

  test('a failed checkout is a 409 in plain words, without git progress output', async () => {
    const root = await slowLfsLikeRepo(4, 0);
    await mkdir(join(root, '.lazy'), { recursive: true });
    await git(root, 'config', 'filter.slowlfs.smudge', 'false');
    const err = await ensureTaskWorktree(root, task, 'lazy/slow').then(() => null, (e) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).status).toBe(409);
    expect(err.message.startsWith("Cannot restore task files: Could not check out branch 'lazy/slow'")).toBe(true);
    expect(err.message).not.toContain('Updating files');
    expect(err.message).not.toContain('Filtering content');
  }, 30_000);
});
