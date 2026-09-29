/**
 * INVARIANT: a legitimate submodule's git dir inside a task worktree's gitdir
 * (`<common>/worktrees/<id>/modules/<name>`) is part of the git-pointer
 * boundary. A task container can write it, and git in the submodule — the
 * human's, or lazy's own root `git status`, which recurses — runs its config
 * and hooks. So lazy refuses to run git in that worktree while a submodule
 * config carries a key `git submodule` never writes, or its hooks hold a live
 * hook, and repair puts both back WITHOUT deleting anything. The first test
 * reproduces the attack against plain git.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile, mkdtemp, realpath, stat, symlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { validateWorktreeGitPointers, repairWorktreeGitPointers, scanWorktreeGitPointers, GitPointerTamperError } from '../../src/git/worktree-pointers';
import { parseGitConfig, findUnsafeSubmoduleGitDirs, allowedSubmoduleConfigEntry } from '../../src/git/submodule-gitdirs';
import { runGit } from '../../src/utils/git';

let base: string;
let repo: string;
let worktree: string;
let gitdir: string;
let subGitDir: string;
let marker: string;
let payload: string;

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always',
};
function git(args: string[], cwd: string) {
  const r = Bun.spawnSync(['git', ...args], { cwd, env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}
const present = (p: string) => stat(p).then(() => true, () => false);

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'sub-gitdir-')));
  const lib = join(base, 'lib');
  await mkdir(lib);
  git(['init', '-q', '-b', 'main'], lib);
  await writeFile(join(lib, 'l.txt'), 'lib\n');
  git(['add', '.'], lib);
  git(['commit', '-q', '-m', 'lib'], lib);

  repo = join(base, 'repo');
  await mkdir(repo);
  git(['init', '-q', '-b', 'main'], repo);
  await writeFile(join(repo, 'f.txt'), 'hello\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  git(['submodule', 'add', '-q', lib, 'vendor/lib'], repo);
  git(['commit', '-q', '-m', 'sub'], repo);

  worktree = join(repo, '.lazy', 'worktrees', 'some-task');
  git(['worktree', 'add', '-q', '-b', 'lazy/some-task', worktree], repo);
  git(['submodule', 'update', '-q', '--init'], worktree);
  gitdir = join(repo, '.git', 'worktrees', 'some-task');
  subGitDir = join(gitdir, 'modules', 'vendor', 'lib');

  marker = join(base, 'PWNED');
  payload = join(base, 'payload.sh');
  await writeFile(payload, `#!/bin/sh\ntouch ${marker}\nexit 1\n`);
  await chmod(payload, 0o755);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('the attack', () => {
  test('a submodule config fsmonitor runs for plain git in the submodule — and lazy refuses, then repairs', async () => {
    expect(await present(join(subGitDir, 'HEAD'))).toBe(true);
    // A fresh submodule is not flagged: the allowlist covers what git writes.
    expect(await findUnsafeSubmoduleGitDirs(gitdir, worktree)).toEqual([]);
    await validateWorktreeGitPointers(repo, worktree);

    const config = join(subGitDir, 'config');
    const original = await readFile(config, 'utf-8');
    await writeFile(config, `${original}[core]\n\tfsmonitor = ${payload}\n`);

    // Reproduced: the human's `git status` inside the submodule runs it.
    Bun.spawnSync(['git', 'status'], { cwd: join(worktree, 'vendor', 'lib'), env });
    expect(await present(marker)).toBe(true);
    await rm(marker);

    // Stopped: lazy's git refuses at the root and inside the submodule.
    for (const cwd of [worktree, join(worktree, 'vendor', 'lib')]) {
      const r = await runGit(['status'], cwd);
      expect(r.exitCode).toBe(128);
      expect(r.stderr).toContain('core.fsmonitor');
    }
    expect(await present(marker)).toBe(false);
    const scan = await scanWorktreeGitPointers(repo);
    expect(scan.find(s => s.name === 'some-task')?.state).toBe('tampered');

    const changed = await repairWorktreeGitPointers(repo, worktree);
    expect(changed.join('\n')).toContain(config);
    // Evidence kept, git works again, the payload does not fire.
    expect((await readdir(subGitDir)).some(n => n.startsWith('config.lazy-quarantine-'))).toBe(true);
    await validateWorktreeGitPointers(repo, worktree);
    Bun.spawnSync(['git', 'status'], { cwd: join(worktree, 'vendor', 'lib'), env });
    expect(await present(marker)).toBe(false);
    expect((await runGit(['status'], worktree)).exitCode).toBe(0);
  });

  test('a live hook is refused and moved aside', async () => {
    await mkdir(join(subGitDir, 'hooks'), { recursive: true });
    await writeFile(join(subGitDir, 'hooks', 'post-checkout'), `#!/bin/sh\ntouch ${marker}\n`);
    await expect(validateWorktreeGitPointers(repo, worktree)).rejects.toBeInstanceOf(GitPointerTamperError);
    await repairWorktreeGitPointers(repo, worktree);
    expect(await present(join(subGitDir, 'hooks'))).toBe(false);
    await validateWorktreeGitPointers(repo, worktree);
  });

  test('symlinked config, commondir and config.worktree are refused', async () => {
    for (const plant of [
      async () => { await rm(join(subGitDir, 'config')); await symlink(join(base, 'x'), join(subGitDir, 'config')); },
      async () => writeFile(join(subGitDir, 'commondir'), `${base}\n`),
      async () => writeFile(join(subGitDir, 'config.worktree'), '[core]\n'),
    ]) {
      await plant();
      expect((await findUnsafeSubmoduleGitDirs(gitdir, worktree)).length).toBeGreaterThan(0);
      await repairWorktreeGitPointers(repo, worktree);
      expect(await findUnsafeSubmoduleGitDirs(gitdir, worktree)).toEqual([]);
    }
  });
});

describe('bypasses found in self-review', () => {
  test('a symlinked submodule git dir is refused and moved out', async () => {
    // The planted repository: a copy of the real one whose config runs the payload.
    const planted = join(base, 'planted');
    await rename(subGitDir, planted);
    const text = (await readFile(join(planted, 'config'), 'utf-8')).replace(/worktree = .*/, `worktree = ${join(worktree, 'vendor', 'lib')}`);
    await writeFile(join(planted, 'config'), `${text}[core]\n\tfsmonitor = ${payload}\n`);
    await symlink(planted, subGitDir);

    Bun.spawnSync(['git', 'status'], { cwd: join(worktree, 'vendor', 'lib'), env });
    expect(await present(marker)).toBe(true);
    await rm(marker);

    expect((await runGit(['status'], worktree)).exitCode).toBe(128);
    await repairWorktreeGitPointers(repo, worktree);
    expect(await findUnsafeSubmoduleGitDirs(gitdir, worktree)).toEqual([]);
    Bun.spawnSync(['git', 'status'], { cwd: join(worktree, 'vendor', 'lib'), env });
    expect(await present(marker)).toBe(false);
  });

  test('a symlinked folder above the git dir is refused', async () => {
    const vendor = join(gitdir, 'modules', 'vendor');
    await rename(vendor, join(base, 'vendor-real'));
    await symlink(join(base, 'vendor-real'), vendor);
    expect((await findUnsafeSubmoduleGitDirs(gitdir, worktree)).map(p => p.path)).toEqual([vendor]);
  });

  test('core.worktree must stay inside the task worktree', async () => {
    const config = join(subGitDir, 'config');
    const original = await readFile(config, 'utf-8');
    // What git wrote (a relative path into the worktree) passes.
    expect(original).toContain('worktree = ');
    expect(await findUnsafeSubmoduleGitDirs(gitdir, worktree)).toEqual([]);
    for (const bad of [base, join(worktree, '..', '..', '..', '..')]) {
      await writeFile(config, original.replace(/worktree = .*/, `worktree = ${bad}`));
      const found = await findUnsafeSubmoduleGitDirs(gitdir, worktree);
      expect(found[0]?.detail).toContain('core.worktree');
    }
    // Through a link inside the worktree that leads out of it.
    await symlink(base, join(worktree, 'out'));
    await writeFile(config, original.replace(/worktree = .*/, `worktree = ${join(worktree, 'out', 'x')}`));
    expect((await findUnsafeSubmoduleGitDirs(gitdir, worktree))[0]?.detail).toContain('core.worktree');
    await repairWorktreeGitPointers(repo, worktree);
    expect(await readFile(config, 'utf-8')).not.toContain('worktree =');
  });

  test('dotted subsections and refs named like git files are not flagged', async () => {
    const config = join(subGitDir, 'config');
    await writeFile(config, `${await readFile(config, 'utf-8')}[branch "release-1.0"]\n\tremote = origin\n\tmerge = refs/heads/release-1.0\n[submodule "lib.js"]\n\tactive = true\n`);
    for (const ref of ['config', 'commondir', join('hooks', 'x')]) {
      const p = join(subGitDir, 'refs', 'remotes', 'origin', ref);
      await mkdir(join(p, '..'), { recursive: true });
      await writeFile(p, `${'a'.repeat(40)}\n`);
    }
    await writeFile(join(subGitDir, 'refs', 'remotes', 'origin', 'HEAD'), 'ref: refs/remotes/origin/main\n');
    expect(await findUnsafeSubmoduleGitDirs(gitdir, worktree)).toEqual([]);
  });
});

describe('the config reader', () => {
  const keys = (t: string) => parseGitConfig(t).map(e => e.key);
  test('finds keys however git would spell them', () => {
    expect(keys('[CORE] FSMonitor=x')).toEqual(['core.fsmonitor']);
    expect(keys('[core]fsmonitor')).toEqual(['core.fsmonitor']);
    expect(keys('[core.x] a = 1')).toEqual(['core.x.a']);
    expect(keys('[remote "o"]\n\turl = "a;b" # c\n\tfetch = x \\\n y\n[include]\npath = /p')).toEqual(['remote.o.url', 'remote.o.fetch', 'include.path']);
  });
  test('reads values as git does', () => {
    expect(parseGitConfig('[core]\n\tworktree = "a b"  # c\n')[0]!.value).toBe('a b');
    expect(parseGitConfig('[core]\n\tworktree = a\\\nb\n')[0]!.value).toBe('ab');
  });
  test('throws on what it cannot place', () => {
    for (const bad of ['fsmonitor = x', '[core\nx', '[core]\n=x', '[core]\na = "b\nc"']) {
      expect(() => parseGitConfig(bad)).toThrow();
    }
  });
  test('the allowlist never admits a key that runs a program', () => {
    const entry = (section: string, subsection: string | null, name: string) => ({ section, subsection, name });
    for (const e of [entry('core', null, 'fsmonitor'), entry('core', null, 'hookspath'), entry('core', null, 'sshcommand'), entry('core', null, 'pager'),
      entry('include', null, 'path'), entry('credential', null, 'helper'), entry('filter', 'x', 'clean'), entry('alias', null, 'st'), entry('core', 'x', 'bare')]) {
      expect(allowedSubmoduleConfigEntry(e)).toBe(false);
    }
    expect(allowedSubmoduleConfigEntry(entry('remote', 'my.fork', 'url'))).toBe(true);
  });
});
