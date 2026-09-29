/**
 * INVARIANT: a task worktree must not carry a nested repository the base
 * branch does not account for. A task can plant `<worktree>/<sub>/.git` whose
 * config sets core.fsmonitor (or hooksPath / sshCommand / a filter); a human
 * who runs git in `<sub>` — or an IDE scanning the folder — then runs the
 * task's code with the human's credentials. Legitimacy comes from the BASE
 * branch's tree only (its `.gitmodules`, its tracked fixtures), never from the
 * worktree, which the task writes. Quarantine moves aside, never deletes, and
 * nothing is skipped by NAME. The first tests reproduce the attack against
 * plain git and against lazy's own root-level git.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  baseFileReader,
  quarantineNestedGit,
  resetNestedGitSweepForTests,
  scanNestedGitDirs,
  submodulePaths,
  SWEEP_WORKTREES_PER_TICK,
  type NestedGitFinding,
} from '../../src/git/nested-git';
import { runGit } from '../../src/utils/git';
import type { Task } from '../../src/types';
import type { Storage } from '../../src/storage/interface';

let base: string;
let repo: string;
let worktree: string;
let marker: string;
let payload: string;

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
function git(args: string[], cwd: string) {
  const r = Bun.spawnSync(['git', ...args], { cwd, env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}
const present = (p: string) => stat(p).then(() => true, () => false);
const scan = (wt = worktree, ref = 'main') => scanNestedGitDirs(wt, baseFileReader(repo, ref), { commonDir: join(repo, '.git') });
const quarantine = (f: NestedGitFinding[]) => quarantineNestedGit(f, join(repo, '.lazy', 'nested-git-quarantine', 'some-task'));
const kinds = (f: NestedGitFinding[]) => f.map(x => [x.rel, x.kind]).sort();

/** What the task plants: a nested repo whose config runs `payload` on every git status. */
async function plantNestedRepo(dir: string) {
  await mkdir(dir, { recursive: true });
  git(['init', '-q'], dir);
  await writeFile(join(dir, '.git', 'config'), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tfsmonitor = ${payload}\n`);
}

beforeEach(async () => {
  resetNestedGitSweepForTests();
  base = await realpath(await mkdtemp(join(tmpdir(), 'nested-git-')));
  repo = join(base, 'repo');
  await mkdir(repo);
  git(['init', '-q', '-b', 'main'], repo);
  await writeFile(join(repo, 'f.txt'), 'hello\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  worktree = join(repo, '.lazy', 'worktrees', 'some-task');
  git(['worktree', 'add', '-q', '-b', 'lazy/some-task', worktree], repo);
  marker = join(base, 'PWNED');
  payload = join(base, 'payload.sh');
  await writeFile(payload, `#!/bin/sh\ntouch ${marker}\nexit 1\n`);
  await chmod(payload, 0o755);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('the attack', () => {
  test('a human running git in a planted nested repo executes the task\'s config', async () => {
    await plantNestedRepo(join(worktree, 'sub'));
    Bun.spawnSync(['git', 'status'], { cwd: join(worktree, 'sub'), env });
    expect(await present(marker)).toBe(true);
  });

  test('after quarantine the same git — in the folder or inside the renamed git dir — no longer runs it', async () => {
    await plantNestedRepo(join(worktree, 'sub'));
    await quarantine(await scan());
    Bun.spawnSync(['git', 'status'], { cwd: join(worktree, 'sub'), env });
    Bun.spawnSync(['git', 'status'], { cwd: join(worktree, 'sub', '.git.lazy-quarantine-1'), env });
    expect(await present(marker)).toBe(false);
  });

  // INVARIANT: lazy's OWN git at the worktree root must not run a nested
  // repository's config. Staged as a gitlink (the agent can `git add sub` in
  // its container), plain `git status` at the root runs `git status` inside
  // `sub` to ask whether it is dirty — reproduced here — and runGit's
  // task-worktree config stops that question.
  test('a staged nested repo runs its payload from plain root git, but not from lazy\'s runGit', async () => {
    await plantNestedRepo(join(worktree, 'sub'));
    git(['-c', 'core.fsmonitor=false', 'commit', '-q', '--allow-empty', '-m', 's'], join(worktree, 'sub'));
    Bun.spawnSync(['git', '-c', 'core.fsmonitor=false', 'add', 'sub'], { cwd: worktree, env });
    Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: worktree, env });
    expect(await present(marker)).toBe(true);
    await rm(marker);

    for (const args of [['status', '--porcelain'], ['diff', 'HEAD'], ['diff', '--cached', '--stat'], ['commit', '-q', '-m', 'x']]) {
      await runGit(args, { cwd: worktree, env });
    }
    expect(await present(marker)).toBe(false);
  });
});

describe('scanNestedGitDirs', () => {
  test('a clean worktree has no findings (its own .git pointer is not one)', async () => {
    expect(await scan()).toEqual([]);
  });

  test('finds a nested .git directory, a .git file and a bare-shaped directory, at any depth', async () => {
    await plantNestedRepo(join(worktree, 'a', 'b', 'sub'));
    await mkdir(join(worktree, 'ptr'));
    await writeFile(join(worktree, 'ptr', '.git'), `gitdir: ${join(base, 'elsewhere')}\n`);
    git(['init', '-q', '--bare', join(worktree, 'fixtures', 'bare.git')], base);
    expect(kinds(await scan())).toEqual([
      ['a/b/sub/.git', 'git-dir'],
      ['fixtures/bare.git', 'bare-repo'],
      ['ptr/.git', 'git-file'],
    ]);
  });

  // INVARIANT: nothing is skipped by name — a directory NAMED like a
  // quarantined entry is walked like any other.
  test('a quarantine-shaped name hides nothing', async () => {
    await plantNestedRepo(join(worktree, 'x.lazy-quarantine-1'));
    await plantNestedRepo(join(worktree, 'y'));
    await rename(join(worktree, 'y', '.git'), join(worktree, 'y', '.git.lazy-quarantine-1'));
    expect(kinds(await scan())).toEqual([
      ['x.lazy-quarantine-1/.git', 'git-dir'],
      ['y/.git.lazy-quarantine-1', 'bare-repo'],
    ]);
  });

  test('spellings git accepts are caught: .GIT, a symlinked HEAD, symlinked objects/refs', async () => {
    await plantNestedRepo(join(worktree, 'upper'));
    await rename(join(worktree, 'upper', '.git'), join(worktree, 'upper', '.GIT'));
    const b = join(worktree, 'linky');
    git(['init', '-q', '--bare', b], base);
    await rename(join(b, 'HEAD'), join(base, 'HEAD-real'));
    await symlink(join(base, 'HEAD-real'), join(b, 'HEAD'));
    await rename(join(b, 'objects'), join(base, 'objects-real'));
    await symlink(join(base, 'objects-real'), join(b, 'objects'));
    expect(kinds(await scan())).toEqual([
      ['linky', 'bare-repo'],
      ['upper/.GIT', 'git-dir'],
    ]);
  });

  test('a symbolic link to a repository is caught, and quarantine moves it out of the worktree', async () => {
    await plantNestedRepo(join(base, 'outside'));
    await symlink(join(base, 'outside'), join(worktree, 'sub'));
    const found = await scan();
    expect(kinds(found)).toEqual([['sub', 'symlink-to-repo']]);
    const moved = await quarantine(found);
    expect(await present(join(worktree, 'sub'))).toBe(false);
    expect(moved[0].movedTo.startsWith(join(repo, '.lazy', 'nested-git-quarantine', 'some-task'))).toBe(true);
    expect(await scan()).toEqual([]);
  });

  describe('submodules', () => {
    beforeEach(async () => {
      const lib = join(base, 'lib');
      await mkdir(lib);
      git(['init', '-q', '-b', 'main'], lib);
      await writeFile(join(lib, 'x'), 'x\n');
      git(['add', '.'], lib);
      git(['commit', '-q', '-m', 'lib'], lib);
      git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'vendor/lib'], repo);
      git(['commit', '-q', '-m', 'submodule'], repo);
      git(['merge', '-q', 'main'], worktree);
      git(['-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init'], worktree);
    });

    test('a submodule recorded in the BASE branch\'s .gitmodules, as git laid it out, is legitimate', async () => {
      expect(await present(join(worktree, 'vendor', 'lib', '.git'))).toBe(true);
      expect(await scan()).toEqual([]);
    });

    test('a submodule path whose .git was replaced by a planted directory is caught', async () => {
      await rm(join(worktree, 'vendor', 'lib', '.git'));
      await plantNestedRepo(join(worktree, 'vendor', 'lib'));
      expect(kinds(await scan())).toEqual([['vendor/lib/.git', 'git-dir']]);
    });

    test('a submodule .git file repointed outside the project\'s modules is caught', async () => {
      await plantNestedRepo(join(base, 'evil'));
      await writeFile(join(worktree, 'vendor', 'lib', '.git'), `gitdir: ${join(base, 'evil', '.git')}\n`);
      expect(kinds(await scan())).toEqual([['vendor/lib/.git', 'git-file']]);
    });
  });

  test('a .gitmodules the TASK wrote does not make its nested repo legitimate', async () => {
    await plantNestedRepo(join(worktree, 'sub'));
    await writeFile(join(worktree, '.gitmodules'), '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n');
    expect((await scan()).map(f => f.rel)).toEqual(['sub/.git']);
  });

  describe('bare fixtures tracked by the base', () => {
    let fx: string;
    beforeEach(async () => {
      fx = join(repo, 'fixtures', 'bare.git');
      git(['init', '-q', '--bare', fx], base);
      // objects/ and refs/ are empty dirs git will not track; keep them with placeholders.
      await writeFile(join(fx, 'objects', '.keep'), '');
      await writeFile(join(fx, 'refs', '.keep'), '');
      git(['add', '-f', 'fixtures'], repo);
      git(['commit', '-q', '-m', 'fixture'], repo);
      git(['merge', '-q', 'main'], worktree);
    });
    const wfx = () => join(worktree, 'fixtures', 'bare.git');

    test('are legitimate while unchanged', async () => {
      expect(await scan()).toEqual([]);
    });
    test('not once the config changes', async () => {
      await writeFile(join(wfx(), 'config'), `[core]\n\tfsmonitor = ${payload}\n`);
      expect(kinds(await scan())).toEqual([['fixtures/bare.git', 'bare-repo']]);
    });
    test('not once a commondir is added', async () => {
      await writeFile(join(wfx(), 'commondir'), `${base}/evil\n`);
      expect(kinds(await scan())).toEqual([['fixtures/bare.git', 'bare-repo']]);
    });
    test('not once a hook is added', async () => {
      await writeFile(join(wfx(), 'hooks', 'post-checkout'), '#!/bin/sh\n');
      expect(kinds(await scan())).toEqual([['fixtures/bare.git', 'bare-repo']]);
    });
  });

  test('a base ref that does not resolve is an error naming it, never "no submodules"', async () => {
    await expect(scan(worktree, 'no-such-branch')).rejects.toThrow('no-such-branch');
  });

  test('already-quarantined entries are not reported again', async () => {
    await plantNestedRepo(join(worktree, 'sub'));
    git(['init', '-q', '--bare', join(worktree, 'b.git')], base);
    await quarantine(await scan());
    expect(await scan()).toEqual([]);
  });
});

describe('quarantineNestedGit', () => {
  test('moves aside, never deletes, and numbers collisions', async () => {
    await plantNestedRepo(join(worktree, 'sub'));
    await quarantine(await scan());
    await plantNestedRepo(join(worktree, 'sub'));
    const moved = await quarantine(await scan());
    expect(moved[0].movedTo).toBe(join(worktree, 'sub', '.git.lazy-quarantine-2'));
    expect((await readdir(join(worktree, 'sub'))).sort()).toEqual(['.git.lazy-quarantine-1', '.git.lazy-quarantine-2']);
    expect(await present(join(worktree, 'sub', '.git.lazy-quarantine-2', 'config'))).toBe(true);
    expect(await present(join(worktree, 'sub', '.git.lazy-quarantine-2', 'HEAD.lazy-quarantine-1'))).toBe(true);
  });
});

describe('submodulePaths', () => {
  test('reads path keys, quoted or not', () => {
    expect([...submodulePaths('[submodule "a"]\n\tpath = vendor/a\n[submodule "b"]\n  path=" b c "\n')]).toEqual(['vendor/a', ' b c ']);
    expect(submodulePaths(null).size).toBe(0);
  });
});

describe('sweepNestedGit (the reconciler sweep)', () => {
  const task = (status: string, ref = 'some-task') => ({
    id: `${ref}-id`, status, metadata: { task_ref: ref },
    target: { kind: 'branch', branch: 'main' },
  }) as unknown as Task;
  const storageWith = (...t: Task[]) => ({ listTasks: async () => t }) as unknown as Storage;

  // INVARIANT: never quarantine under a live turn — moving a directory out
  // from under a running agent corrupts its turn. It waits for the turn to end.
  test('leaves a live turn alone, then quarantines once the turn is over', async () => {
    const { sweepNestedGit } = await import('../../src/git/nested-git');
    await plantNestedRepo(join(worktree, 'sub'));
    expect(await sweepNestedGit(repo, storageWith(task('working')))).toEqual([]);
    expect(await present(join(worktree, 'sub', '.git'))).toBe(true);

    const r = await sweepNestedGit(repo, storageWith(task('blocked')));
    expect(r.map(x => x.moved)).toEqual([[{ rel: 'sub/.git', movedTo: 'sub/.git.lazy-quarantine-1' }]]);
    expect(await present(join(worktree, 'sub', '.git'))).toBe(false);
  });

  // INVARIANT: a clean mark expires. A repo planted after the task's last turn
  // (a process the agent left behind) is still found without a new turn.
  test('a worktree found clean is walked again once the mark expires', async () => {
    const { sweepNestedGit, SWEEP_CLEAN_TTL_MS } = await import('../../src/git/nested-git');
    const s = storageWith(task('blocked'));
    expect(await sweepNestedGit(repo, s, () => 0)).toEqual([]);
    await plantNestedRepo(join(worktree, 'sub'));
    expect(await sweepNestedGit(repo, s, () => 1000)).toEqual([]);
    const r = await sweepNestedGit(repo, s, () => SWEEP_CLEAN_TTL_MS + 1);
    expect(r.map(x => x.name)).toEqual(['some-task']);
  });

  test('walks at most a bounded number of worktrees per tick, reaching the rest on later ticks', async () => {
    const { sweepNestedGit } = await import('../../src/git/nested-git');
    const refs = Array.from({ length: SWEEP_WORKTREES_PER_TICK + 2 }, (_, i) => `t${i}`);
    for (const ref of refs) {
      const wt = join(repo, '.lazy', 'worktrees', ref);
      git(['worktree', 'add', '-q', '-b', `lazy/${ref}`, wt], repo);
      await plantNestedRepo(join(wt, 'sub'));
    }
    const s = storageWith(task('blocked'), ...refs.map(r => task('blocked', r)));
    let total = 0;
    const ticks = Math.ceil((refs.length + 1) / SWEEP_WORKTREES_PER_TICK);
    for (let i = 0; i < ticks; i++) {
      const r = await sweepNestedGit(repo, s, () => i);
      expect(r.length).toBeLessThanOrEqual(SWEEP_WORKTREES_PER_TICK);
      if (i === 0) expect(r.length).toBeLessThan(refs.length);
      total += r.length;
    }
    expect(total).toBe(refs.length);
  });

  test('the reconciler runs it', async () => {
    const reconcile = await Bun.file(join(import.meta.dir, '../../src/utils/reconcile.ts')).text();
    expect(reconcile).toContain("sweep('nested-git'");
    expect(reconcile).toContain('sweepNestedGit(lazyRoot, storage)');
  });
});

describe('lazy_commit', () => {
  // INVARIANT: lazy's commit tool stages nothing while a nested repository is
  // present — `git add` asks a gitlink whether it is dirty by running git
  // INSIDE it, which no config lazy passes can stop.
  test('refuses to stage over a planted nested repository, naming it', async () => {
    const { createCommitHandler } = await import('../../src/mcp/tools');
    const t = { id: 'some-task-id', status: 'working', metadata: { task_ref: 'some-task' }, target: { kind: 'branch', branch: 'main' } } as unknown as Task;
    const storage = { getTask: async () => t, listTasks: async () => [t], getSessionByTaskId: async () => ({ id: 's', git_branch: 'lazy/some-task' }), close: async () => {} } as unknown as Storage;
    await plantNestedRepo(join(worktree, 'sub'));
    const commit = createCommitHandler({ taskId: t.id, worktreePath: worktree, storage } as any);
    await expect(commit({ message: 'x' })).rejects.toThrow('sub/.git');
    expect(await present(marker)).toBe(false);
    expect(git(['diff', '--cached', '--name-only'], worktree)).toBe('');
  });
});
