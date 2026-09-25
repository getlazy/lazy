/**
 * INVARIANT: before a member's container is launched on a task worktree, the
 * worktree's git pointers are checked on the HOST, by reading files and never
 * by running git, against what `git worktree add` wrote: `<worktree>/.git`
 * names `<repo>/.git/worktrees/<id>`, whose `commondir` and `gitdir` point
 * back, with no `config.worktree`. A turn that redirects any of them (to a
 * gitdir whose config runs code: core.fsmonitor, core.sshCommand, hooks)
 * would otherwise have the member's own git run it next to their credential.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { validateMemberGitLayout, memberGitPointerMounts, writeMemberGitPointerCopies, GitLayoutRefusedError } from '../../src/daemon/member-git-layout';

let base: string;
let repo: string;
let worktree: string;
let gitdir: string;

function git(args: string[], cwd: string) {
  const r = Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'member-git-')));
  repo = join(base, 'repo');
  await mkdir(repo);
  git(['init', '-q'], repo);
  git(['commit', '-q', '--allow-empty', '-m', 'init'], repo);
  worktree = join(repo, '.lazy', 'worktrees', 'some-task');
  git(['worktree', 'add', '-q', '-b', 'lazy/some-task', worktree], repo);
  gitdir = join(repo, '.git', 'worktrees', 'some-task');
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("a worktree's git layout", () => {
  // INVARIANT: the member's container sees daemon-written COPIES of the
  // pointer text that was checked, read-only over the originals' paths —
  // never the originals, which anything beside the worktree could rewrite
  // after the check.
  test('as git worktree add wrote it is accepted, and COPIES of its pointers are mounted read-only', async () => {
    const layout = await validateMemberGitLayout(repo, worktree);
    expect(layout.commonDir).toBe(join(repo, '.git'));
    expect(layout.worktreeGitDir).toBe(gitdir);
    expect(layout.objectsDir).toBe(join(repo, '.git', 'objects'));
    const home = join(base, 'member-home');
    await mkdir(home);
    const copies = await writeMemberGitPointerCopies(home, layout);
    expect(memberGitPointerMounts(copies)).toEqual([
      '-v', `${join(home, 'git-pointers', 'dotgit')}:${join(worktree, '.git')}:ro`,
      '-v', `${join(home, 'git-pointers', 'commondir')}:${join(gitdir, 'commondir')}:ro`,
      '-v', `${join(home, 'git-pointers', 'gitdir')}:${join(gitdir, 'gitdir')}:ro`,
    ]);
    for (const [copy, original] of [['dotgit', join(worktree, '.git')], ['commondir', join(gitdir, 'commondir')], ['gitdir', join(gitdir, 'gitdir')]] as const) {
      expect(await readFile(join(home, 'git-pointers', copy), 'utf-8')).toBe(await readFile(original, 'utf-8'));
    }
  });

  test("rewriting the source .git in place after the launch does not change what the member's container sees", async () => {
    const layout = await validateMemberGitLayout(repo, worktree);
    const home = join(base, 'member-home');
    await mkdir(home);
    const copies = await writeMemberGitPointerCopies(home, layout);
    const mountedAtDotGit = copies.find((c) => c.target === join(worktree, '.git'))!.source;
    const before = await readFile(mountedAtDotGit, 'utf-8');
    // A process left beside the worktree redirects it, in place.
    await writeFile(join(worktree, '.git'), `gitdir: ${join(base, 'evil-gitdir')}\n`);
    expect(mountedAtDotGit).not.toBe(join(worktree, '.git'));
    expect(await readFile(mountedAtDotGit, 'utf-8')).toBe(before);
    expect(before).toBe(`gitdir: ${gitdir}\n`);
  });

  test('a .git that names another gitdir is refused', async () => {
    const evil = join(base, 'evil-gitdir');
    await mkdir(evil);
    await writeFile(join(worktree, '.git'), `gitdir: ${evil}\n`);
    await expect(validateMemberGitLayout(repo, worktree)).rejects.toBeInstanceOf(GitLayoutRefusedError);
  });

  test('a .git that is a symlink is refused', async () => {
    await rm(join(worktree, '.git'));
    await symlink(join(gitdir), join(worktree, '.git'));
    await expect(validateMemberGitLayout(repo, worktree)).rejects.toThrow('symbolic link');
  });

  test('a gitdir swapped for a symlink is refused', async () => {
    const evil = join(base, 'evil-gitdir');
    await mkdir(evil);
    await rm(gitdir, { recursive: true });
    await symlink(evil, gitdir);
    await expect(validateMemberGitLayout(repo, worktree)).rejects.toThrow('symbolic link');
  });

  test('a commondir pointing elsewhere is refused', async () => {
    await writeFile(join(gitdir, 'commondir'), `${join(base, 'evil-common')}\n`);
    await expect(validateMemberGitLayout(repo, worktree)).rejects.toThrow('commondir');
  });

  test('a gitdir file pointing elsewhere is refused', async () => {
    await writeFile(join(gitdir, 'gitdir'), `${join(base, 'other', '.git')}\n`);
    await expect(validateMemberGitLayout(repo, worktree)).rejects.toThrow('other/.git');
  });

  test('a config.worktree is refused', async () => {
    await writeFile(join(gitdir, 'config.worktree'), '[core]\n\tfsmonitor = touch /tmp/pwned\n');
    await expect(validateMemberGitLayout(repo, worktree)).rejects.toThrow('config.worktree');
  });
});

describe('a member container launch on a redirected worktree', () => {
  test('is refused before anything runs', async () => {
    const { launchMemberContainer } = await import('../../src/daemon/member-container');
    const evil = join(base, 'evil-gitdir');
    await mkdir(evil);
    await writeFile(join(worktree, '.git'), `gitdir: ${evil}\n`);
    const runs: string[][] = [];
    const released: string[] = [];
    const task = { id: 'task-1', agent_id: 'claude-code', metadata: { task_ref: 'some-task' } } as never;
    const r = await launchMemberContainer({
      projectRoot: repo, storage: {} as never, task, session: { id: 's' } as never,
      memberEmail: 'alice@example.com', binary: 'docker',
      deps: {
        planCredential: async () => ({ ok: true as const, credential: { env: [], release: async () => { released.push('x'); }, pinOrigin: async () => {} } }),
        ensureNetwork: async () => {},
        ensureImage: async () => 'img', ensureAgentBinary: async () => '/bin/lazy-agent',
        run: async (argv) => { runs.push(argv); return { exitCode: 0, stderr: '' }; },
        remove: async () => {},
      },
    });
    expect(r).toMatchObject({ ok: false, status: 409 });
    if (!r.ok) expect(r.message).toContain("git setup has been changed");
    expect(runs).toEqual([]);
    expect(released).toEqual(['x']);
  });
});
