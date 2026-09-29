/**
 * INVARIANT: a task worktree's git pointers (`<worktree>/.git`,
 * `<gitdir>/commondir`, `<gitdir>/gitdir`) are a security boundary. A task
 * that redirects them to a git dir whose config runs code (core.fsmonitor,
 * core.hooksPath, core.sshCommand) gets that code run by the NEXT git outside
 * its container — lazy's commit/sync/accept, or the human's own. So:
 *   1. task containers see read-only COPIES bound over all three paths;
 *   2. lazy's own git (runGit) refuses to run in a worktree whose pointers
 *      differ from what lazy created, WITHOUT running git to find out;
 *   3. the pointers can be rewritten to what `git worktree add` wrote from
 *      paths alone (doctor --repair-git-pointers and the daemon sweep).
 * The first test reproduces the attack against plain git, so the refusal is
 * proven against a vector that really fires, not an imagined one.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { chmod, mkdir, readFile, rm, symlink, writeFile, mkdtemp, realpath, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  validateWorktreeGitPointers,
  repairWorktreeGitPointers,
  repairTamperedWorktrees,
  scanWorktreeGitPointers,
  taskWorktreeOf,
  worktreeConfigEnabled,
  GitPointerTamperError,
  UnsupportedGitLayoutError,
} from '../../src/git/worktree-pointers';
import { buildSupervisorWrapperScript } from '../../src/capture/claude';
import { buildTaskGitMounts } from '../../src/capture/git-mounts';
import { runGit } from '../../src/utils/git';

let base: string;
let repo: string;
let worktree: string;
let gitdir: string;
let marker: string;
let evil: string;

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
function git(args: string[], cwd: string) {
  const r = Bun.spawnSync(['git', ...args], { cwd, env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}
/** Plain git, NOT lazy's runGit — what a human would type. */
function rawGit(args: string[], cwd: string) {
  return Bun.spawnSync(['git', ...args], { cwd, env, stdout: 'pipe', stderr: 'pipe' });
}
const present = (p: string) => stat(p).then(() => true, () => false);

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'wt-pointers-')));
  repo = join(base, 'repo');
  await mkdir(repo);
  git(['init', '-q', '-b', 'main'], repo);
  await writeFile(join(repo, 'f.txt'), 'hello\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  worktree = join(repo, '.lazy', 'worktrees', 'some-task');
  git(['worktree', 'add', '-q', '-b', 'lazy/some-task', worktree], repo);
  gitdir = join(repo, '.git', 'worktrees', 'some-task');

  // The attacker's git dir: a copy of the real common dir's shape whose config
  // runs a script on every index refresh.
  marker = join(base, 'PWNED');
  const payload = join(base, 'payload.sh');
  await writeFile(payload, `#!/bin/sh\ntouch ${marker}\nexit 1\n`);
  await chmod(payload, 0o755);
  evil = join(base, 'evil');
  git(['clone', '-q', '--bare', repo, evil], base);
  await writeFile(join(evil, 'config'), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tfsmonitor = ${payload}\n`);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('the attack', () => {
  test('a rewritten commondir makes plain git run the planted fsmonitor — and lazy refuses to', async () => {
    await writeFile(join(gitdir, 'commondir'), `${evil}\n`);

    // Reproduced: the human's own `git status` in the worktree runs the payload.
    rawGit(['status'], worktree);
    expect(await present(marker)).toBe(true);
    await rm(marker);

    // Stopped: lazy's git refuses before spawning anything.
    const r = await runGit(['status'], worktree);
    expect(r.exitCode).toBe(128);
    expect(r.stderr).toContain('some-task');
    expect(r.stderr).toContain('commondir');
    expect(await present(marker)).toBe(false);
    // ...from a subdirectory of the worktree too.
    await mkdir(join(worktree, 'sub'));
    expect((await runGit(['status'], join(worktree, 'sub'))).exitCode).toBe(128);
    expect(await present(marker)).toBe(false);
  });

  test('a rewritten .git naming an attacker gitdir is refused', async () => {
    await writeFile(join(worktree, '.git'), `gitdir: ${evil}\n`);
    rawGit(['status'], worktree);
    expect(await present(marker)).toBe(true);
    await rm(marker);
    expect((await runGit(['status'], worktree)).exitCode).toBe(128);
    expect(await present(marker)).toBe(false);
  });

  test('an intact worktree runs git as before', async () => {
    const r = await runGit(['status', '--porcelain'], worktree);
    expect(r.exitCode).toBe(0);
  });
});

describe('validateWorktreeGitPointers', () => {
  test('accepts what git worktree add wrote', async () => {
    const layout = await validateWorktreeGitPointers(repo, worktree);
    expect(layout.worktreeGitDir).toBe(gitdir);
    expect(layout.pointerFiles.map((f) => f.target)).toEqual([
      join(worktree, '.git'), join(gitdir, 'commondir'), join(gitdir, 'gitdir'),
    ]);
  });

  test('refuses a back-pointer naming another worktree, a symlinked pointer, and a config.worktree', async () => {
    await writeFile(join(gitdir, 'gitdir'), `${join(base, 'other', '.git')}\n`);
    await expect(validateWorktreeGitPointers(repo, worktree)).rejects.toThrow(GitPointerTamperError);
    await repairWorktreeGitPointers(repo, worktree);

    await rm(join(worktree, '.git'));
    await writeFile(join(base, 'dotgit'), `gitdir: ${gitdir}\n`);
    await symlink(join(base, 'dotgit'), join(worktree, '.git'));
    await expect(validateWorktreeGitPointers(repo, worktree)).rejects.toThrow('symbolic link');
    await repairWorktreeGitPointers(repo, worktree);

    await writeFile(join(gitdir, 'config.worktree'), '[core]\n\tfsmonitor = x\n');
    await expect(validateWorktreeGitPointers(repo, worktree)).rejects.toThrow('config.worktree');
  });

  test('refuses while the common config turns extensions.worktreeConfig on', async () => {
    git(['config', 'extensions.worktreeConfig', 'true'], repo);
    await expect(validateWorktreeGitPointers(repo, worktree)).rejects.toThrow('worktreeConfig');
  });
});

describe('worktreeConfigEnabled', () => {
  test("reads git's spellings", () => {
    expect(worktreeConfigEnabled('[extensions]\n\tworktreeConfig = true\n')).toBe(true);
    expect(worktreeConfigEnabled('[Extensions]\n\tWorktreeConfig\n')).toBe(true);
    expect(worktreeConfigEnabled('[extensions] worktreeconfig = yes\n')).toBe(true);
    expect(worktreeConfigEnabled('[extensions]\n\tworktreeConfig = false\n')).toBe(false);
    expect(worktreeConfigEnabled('[core]\n\tworktreeConfig = true\n')).toBe(false);
    expect(worktreeConfigEnabled('[extensions]\n\t# worktreeConfig = true\n')).toBe(false);
  });
});

describe('repair', () => {
  test('rewrites all three pointers and removes config.worktree, and git works again', async () => {
    await writeFile(join(worktree, '.git'), `gitdir: ${evil}\n`);
    await writeFile(join(gitdir, 'commondir'), `${evil}\n`);
    await writeFile(join(gitdir, 'gitdir'), '/elsewhere/.git\n');
    await writeFile(join(gitdir, 'config.worktree'), '[core]\n\tfsmonitor = x\n');

    const scan = await scanWorktreeGitPointers(repo);
    expect(scan).toHaveLength(1);
    expect(scan[0]!.problem).not.toBeNull();

    const results = await repairTamperedWorktrees(repo);
    expect(results).toHaveLength(1);
    expect(results[0]!.repaired).toHaveLength(4);

    await validateWorktreeGitPointers(repo, worktree);
    expect((await scanWorktreeGitPointers(repo))[0]!.problem).toBeNull();
    expect(await readFile(join(gitdir, 'commondir'), 'utf-8')).toBe('../..\n');
    rawGit(['status'], worktree);
    expect(await present(marker)).toBe(false);
    expect((await runGit(['status', '--porcelain'], worktree)).exitCode).toBe(0);
  });

  test('an intact worktree is left alone', async () => {
    expect(await repairWorktreeGitPointers(repo, worktree)).toEqual([]);
    expect(await repairTamperedWorktrees(repo)).toEqual([]);
  });

  test('a worktreeConfig a human turned on is a project setting: not tampering, never reverted, and no container launches', async () => {
    git(['config', 'extensions.worktreeConfig', 'true'], repo);
    expect((await scanWorktreeGitPointers(repo))[0]!.state).toBe('ok');
    expect(await repairTamperedWorktrees(repo)).toEqual([]);
    await expect(buildTaskGitMounts(repo, worktree)).rejects.toThrow(UnsupportedGitLayoutError);
    expect(git(['config', 'extensions.worktreeConfig'], repo).trim()).toBe('true');
  });

  // INVARIANT: repair never re-attaches a worktree to a gitdir that is not its
  // own. git names the gitdir foo1 when a stale foo is still registered, so
  // the folder name is not the id.
  test('keeps a numbered gitdir, and refuses when two gitdirs claim the worktree', async () => {
    // Another worktree already holds the id "again", so git names ours again1.
    const other = join(base, 'elsewhere', 'again');
    git(['worktree', 'add', '-q', '-b', 'lazy/other', other], repo);
    const wt = join(repo, '.lazy', 'worktrees', 'again');
    git(['worktree', 'add', '-q', '-b', 'lazy/again', wt], repo);
    const own = join(repo, '.git', 'worktrees', 'again1');
    expect(await readFile(join(wt, '.git'), 'utf-8')).toBe(`gitdir: ${own}\n`);

    await writeFile(join(own, 'commondir'), `${evil}\n`);
    await repairWorktreeGitPointers(repo, wt);
    expect(await readFile(join(wt, '.git'), 'utf-8')).toBe(`gitdir: ${own}\n`);
    await validateWorktreeGitPointers(repo, wt);

    // The folder-named gitdir belongs to the OTHER worktree: never taken.
    await writeFile(join(wt, '.git'), `gitdir: ${evil}\n`);
    await writeFile(join(own, 'gitdir'), '/nowhere/.git\n');
    await expect(repairWorktreeGitPointers(repo, wt)).rejects.toThrow('cannot tell');
    expect(await readFile(join(repo, '.git', 'worktrees', 'again', 'gitdir'), 'utf-8')).toBe(`${join(other, '.git')}\n`);

    // Both again/ and again1/ point back at this worktree: without git there is
    // no telling which is live, so nothing is changed.
    await writeFile(join(own, 'gitdir'), `${join(wt, '.git')}\n`);
    await writeFile(join(repo, '.git', 'worktrees', 'again', 'gitdir'), `${join(wt, '.git')}\n`);
    await expect(repairWorktreeGitPointers(repo, wt)).rejects.toThrow('cannot tell');
    expect(await readFile(join(wt, '.git'), 'utf-8')).toBe(`gitdir: ${evil}\n`);
  });

  test('a directory with no .git is not a worktree: never repaired, and lazy will not run git there', async () => {
    await rm(join(worktree, '.git'));
    const scan = await scanWorktreeGitPointers(repo);
    expect(scan[0]!.state).toBe('not-a-worktree');
    expect(await repairTamperedWorktrees(repo)).toEqual([]);
    expect(await present(join(worktree, '.git'))).toBe(false);
    expect((await runGit(['status'], worktree)).exitCode).toBe(128);
  });

  test('a planted .git directory is moved aside, and the pointer restored', async () => {
    await rm(join(worktree, '.git'));
    git(['init', '-q', worktree], base);
    const changed = await repairWorktreeGitPointers(repo, worktree);
    expect(changed.some((c) => c.includes('lazy-quarantine'))).toBe(true);
    await validateWorktreeGitPointers(repo, worktree);
  });
});

describe('task container mounts', () => {
  test('bind read-only copies of the checked text over all three pointers, from a dir no container can write', async () => {
    const { args, pointerTargets } = await buildTaskGitMounts(repo, worktree);
    const mounts = args.filter((_, i) => args[i - 1] === '-v');
    const copyDir = join(repo, '.lazy', 'git-pointers', 'some-task');
    for (const [name, target] of [['dotgit', join(worktree, '.git')], ['commondir', join(gitdir, 'commondir')], ['gitdir', join(gitdir, 'gitdir')]] as const) {
      expect(mounts).toContain(`${join(copyDir, name)}:${target}:ro`);
      expect(await readFile(join(copyDir, name), 'utf-8')).toBe(await readFile(target, 'utf-8'));
      expect(pointerTargets).toContain(target);
    }
    // The copies sit under the project root (mounted :ro into every task
    // container) and outside every writable mount: the worktree, the
    // per-worktree gitdir and the object store.
    expect(copyDir.startsWith(`${worktree}/`)).toBe(false);
    expect(copyDir.startsWith(`${gitdir}/`)).toBe(false);
    expect(mounts).toContain(`${join(repo, '.git')}:${join(repo, '.git')}:ro`);
  });

  test('a tampered worktree gets no container', async () => {
    await writeFile(join(gitdir, 'commondir'), `${evil}\n`);
    await expect(buildTaskGitMounts(repo, worktree)).rejects.toThrow(GitPointerTamperError);
  });
});

describe('fails closed', () => {
  test('a pointer lazy cannot read is a refusal, not a throw and not a pass', async () => {
    if (process.getuid?.() === 0) return; // root reads through mode 000
    await chmod(join(gitdir, 'commondir'), 0o000);
    const r = await runGit(['status'], worktree);
    expect(r.exitCode).toBe(128);
    expect(r.stderr).toContain('some-task');
    await chmod(join(gitdir, 'commondir'), 0o644);
  });
});

describe('other project layouts', () => {
  test('a legacy .workshop data dir gets the same check, scan and copies', async () => {
    const legacy = join(base, 'legacy');
    await mkdir(legacy);
    git(['init', '-q', '-b', 'main'], legacy);
    git(['commit', '-q', '--allow-empty', '-m', 'init'], legacy);
    await mkdir(join(legacy, '.workshop'));
    const wt = join(legacy, '.workshop', 'worktrees', 'old-task');
    git(['worktree', 'add', '-q', '-b', 'lazy/old-task', wt], legacy);
    const { args } = await buildTaskGitMounts(legacy, wt);
    expect(args.some((a) => a.startsWith(join(legacy, '.workshop', 'git-pointers', 'old-task')))).toBe(true);
    expect(await present(join(legacy, '.lazy'))).toBe(false);
    await writeFile(join(legacy, '.git', 'worktrees', 'old-task', 'commondir'), `${evil}\n`);
    expect((await runGit(['status'], wt)).exitCode).toBe(128);
    expect((await scanWorktreeGitPointers(legacy))[0]!.state).toBe('tampered');
  });

  test('a project that is itself a linked worktree resolves its common dir from files', async () => {
    const proj = join(base, 'proj');
    git(['worktree', 'add', '-q', '-b', 'proj', proj], repo);
    const wt = join(proj, '.lazy', 'worktrees', 'nested');
    git(['worktree', 'add', '-q', '-b', 'lazy/nested', wt], proj);
    const layout = await validateWorktreeGitPointers(proj, wt);
    expect(layout.commonDir).toBe(join(repo, '.git'));
    expect((await runGit(['status', '--porcelain'], wt)).exitCode).toBe(0);
    await writeFile(join(repo, '.git', 'worktrees', 'nested', 'commondir'), `${evil}\n`);
    expect((await runGit(['status'], wt)).exitCode).toBe(128);
  });
});

describe('the launch and the sweep use this', () => {
  // INVARIANT: both docker argv builders in claude.ts get their git mounts
  // from buildTaskGitMounts (checked pointers + read-only copies), never from
  // git rev-parse in the worktree; the reconciler runs the repair sweep.
  test('source wiring', async () => {
    const claude = await Bun.file(join(import.meta.dir, '../../src/capture/claude.ts')).text();
    expect(claude.match(/await buildTaskGitMounts\(/g)?.length).toBe(2);
    expect(claude).not.toContain('resolveGitMountPaths');
    const reconcile = await Bun.file(join(import.meta.dir, '../../src/utils/reconcile.ts')).text();
    expect(reconcile).toContain("sweep('git-pointers'");
    expect(reconcile).toContain('repairTamperedWorktrees(lazyRoot, ');
  });

  test('the supervisor wrapper leaves the read-only copies out of the adopt probe and chown', () => {
    const script = buildSupervisorWrapperScript('/p', '/w', ['/w'], ['/w/.git']);
    expect(script).toContain('find "$p" ! -writable ! -path "/w/.git" -print -quit');
    expect(script).toContain('sudo -n find "$p" ! -path "/w/.git" -exec chown -h');
    expect(script).not.toContain('chown -R');
  });
});

describe('taskWorktreeOf', () => {
  test('finds the worktree from any path inside it, and nothing outside one', () => {
    expect(taskWorktreeOf('/p/.lazy/worktrees/t/src/x')).toEqual({ projectRoot: '/p', worktreePath: '/p/.lazy/worktrees/t' });
    expect(taskWorktreeOf('/p/.lazy/worktrees/t')).toEqual({ projectRoot: '/p', worktreePath: '/p/.lazy/worktrees/t' });
    expect(taskWorktreeOf('/p/.workshop/worktrees/t/a')).toEqual({ projectRoot: '/p', worktreePath: '/p/.workshop/worktrees/t' });
    expect(taskWorktreeOf('/p')).toBeNull();
    expect(taskWorktreeOf('/p/.lazy/worktrees/')).toBeNull();
  });
});
