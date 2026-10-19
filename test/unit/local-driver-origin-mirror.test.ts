/**
 * The local driver MIRRORS task branches to origin in managed mode
 * (src/remote/origin-mirror.ts).
 *
 * A project Lazy Teams hosts itself is not on GitHub or GitLab, so `lazy init`
 * gives it the `local` driver — whose push and fetch were no-ops. Every member
 * who cloned the team's repository therefore saw `main` and no task branches,
 * and a commit a member pushed to a task branch could never reach sync's first
 * step. These tests drive real git against a real bare "origin".
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { runGit } from '../../src/utils/git';
import { createDriver, LocalDriver } from '../../src/remote';
import { localDriverMirrorsOrigin, acceptPushesTargetToMirror, isNonFastForwardRejection, fastForwardTargetFromMirror, MirrorTargetDivergedError } from '../../src/remote/origin-mirror';
import { pushBranchAfterStateChange, _resetPushState } from '../../src/daemon/push';
import type { ResolvedConfig } from '../../src/config/types';

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await runGit(args, { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

const localConfig = { remote: { driver: 'local', git_remote: 'origin' } } as unknown as ResolvedConfig;

describe('local driver origin mirror', () => {
  let root: string;
  let origin: string;
  let daemonClone: string;
  let member: string;
  let savedCwd: string;
  let savedManaged: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-origin-mirror-'));
    origin = join(root, 'hosted.git');
    daemonClone = join(root, 'daemon');
    member = join(root, 'member');
    await runGit(['init', '-q', '--bare', '-b', 'main', origin], { cwd: root });
    await runGit(['clone', '-q', origin, daemonClone], { cwd: root });
    await git(daemonClone, 'config', 'user.email', 'agent@example.com');
    await git(daemonClone, 'config', 'user.name', 'Agent');
    await writeFile(join(daemonClone, 'a.txt'), 'base\n');
    await git(daemonClone, 'add', '.');
    await git(daemonClone, 'commit', '-q', '-m', 'base');
    await git(daemonClone, 'push', '-q', 'origin', 'main');
    await git(daemonClone, 'checkout', '-q', '-b', 'lazy/demo');
    await writeFile(join(daemonClone, 'a.txt'), 'agent work\n');
    await git(daemonClone, 'commit', '-q', '-am', 'agent work');
    await git(daemonClone, 'checkout', '-q', 'main');

    savedCwd = process.cwd();
    savedManaged = process.env.LAZY_TEST_FORCE_MANAGED;
    // The daemon chdirs to its project root; the drivers' git runs there.
    process.chdir(daemonClone);
    _resetPushState();
  });

  afterEach(async () => {
    process.chdir(savedCwd);
    if (savedManaged === undefined) delete process.env.LAZY_TEST_FORCE_MANAGED;
    else process.env.LAZY_TEST_FORCE_MANAGED = savedManaged;
    _resetPushState();
    await rm(root, { recursive: true, force: true });
  });

  async function originHas(branch: string): Promise<boolean> {
    const r = await runGit(['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { cwd: origin });
    return r.exitCode === 0;
  }

  // INVARIANT: outside managed mode the local driver pushes nothing. A solo
  // user who chose `local` did not ask lazy to write to their remote.
  test('outside managed mode: no mirror, push is a no-op', async () => {
    delete process.env.LAZY_TEST_FORCE_MANAGED;
    expect(localDriverMirrorsOrigin(localConfig)).toBe(false);
    const driver = createDriver(localConfig) as LocalDriver;
    expect(driver.originMirror).toBeNull();
    await driver.pushBranch('lazy/demo');
    expect(await originHas('lazy/demo')).toBe(false);
  });

  // INVARIANT: in managed mode the after-turn push sends the TASK branch to
  // origin — and only it: main (the target) is never pushed as a side effect.
  test('managed mode: the after-turn push lands the task branch on origin, and only it', async () => {
    process.env.LAZY_TEST_FORCE_MANAGED = '1';
    const mainBefore = await git(origin, 'rev-parse', 'main');
    await git(daemonClone, 'commit', '-q', '--allow-empty', '-m', 'local-only main commit');

    const driver = createDriver(localConfig) as LocalDriver;
    expect(driver.originMirror).not.toBeNull();
    await driver.pushBranch('lazy/demo');

    expect(await originHas('lazy/demo')).toBe(true);
    expect(await git(origin, 'rev-parse', 'lazy/demo')).toBe(await git(daemonClone, 'rev-parse', 'lazy/demo'));
    expect(await git(origin, 'rev-parse', 'main')).toBe(mainBefore);
  });

  // INVARIANT: the daemon's post-turn push queue is the mechanism — the same
  // one forge projects use — not a second one.
  test('managed mode: pushBranchAfterStateChange pushes through the mirror', async () => {
    process.env.LAZY_TEST_FORCE_MANAGED = '1';
    const savedStore = process.env.LAZY_MANAGED_STORAGE_PATH;
    process.env.LAZY_MANAGED_STORAGE_PATH = join(root, 'store');
    try {
      await writeFile(join(daemonClone, 'lazy.toml'), '[remote]\ndriver = "local"\n');
      await pushBranchAfterStateChange(daemonClone, 'lazy/demo');
      expect(await originHas('lazy/demo')).toBe(true);
    } finally {
      if (savedStore === undefined) delete process.env.LAZY_MANAGED_STORAGE_PATH;
      else process.env.LAZY_MANAGED_STORAGE_PATH = savedStore;
    }
  });

  // INVARIANT: a member's push to the task branch is SEEN by the fetch sync's
  // first step makes, so `lazy sync` merges it into the agent's branch.
  test('managed mode: fetchBranch reports a member push to the task branch', async () => {
    process.env.LAZY_TEST_FORCE_MANAGED = '1';
    const driver = createDriver(localConfig) as LocalDriver;
    await driver.pushBranch('lazy/demo');
    const worktree = join(root, 'task-wt');
    await git(daemonClone, 'worktree', 'add', '-q', worktree, 'lazy/demo');

    expect(await driver.fetchBranch('lazy/demo', worktree)).toBe(false);

    await runGit(['clone', '-q', '-b', 'lazy/demo', origin, member], { cwd: root });
    await git(member, 'config', 'user.email', 'ada@example.com');
    await git(member, 'config', 'user.name', 'Ada');
    await writeFile(join(member, 'b.txt'), 'from the mac\n');
    await git(member, 'add', '.');
    await git(member, 'commit', '-q', '-m', 'tested locally');
    await git(member, 'push', '-q', 'origin', 'lazy/demo');

    expect(await driver.fetchBranch('lazy/demo', worktree)).toBe(true);
  });
});

describe('accept target push gate', () => {
  // INVARIANT: an accept owes a target push only when the local driver mirrors
  // origin AND that remote exists — solo local projects push nothing, and a
  // managed project with no origin must not owe a step that fails forever.
  test('owed only for a mirroring driver whose remote exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lazy-accept-gate-'));
    try {
      await runGit(['init', '-q', '-b', 'main', root], { cwd: root });
      expect(await acceptPushesTargetToMirror(new LocalDriver(), root)).toBe(false);
      expect(await acceptPushesTargetToMirror(new LocalDriver(undefined, { remoteName: 'origin' }), root)).toBe(false);
      await git(root, 'remote', 'add', 'origin', join(root, 'nowhere.git'));
      expect(await acceptPushesTargetToMirror(new LocalDriver(undefined, { remoteName: 'origin' }), root)).toBe(true);
      expect(await acceptPushesTargetToMirror(new LocalDriver(), root)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // INVARIANT: a remote target that moved is recognised as a non-fast-forward
  // rejection, so accept reports it as "never overwritten" rather than a
  // generic push failure.
  test('recognises git non-fast-forward rejections', () => {
    expect(isNonFastForwardRejection(' ! [rejected]        main -> main (fetch first)')).toBe(true);
    expect(isNonFastForwardRejection(' ! [rejected] main -> main (non-fast-forward)')).toBe(true);
    expect(isNonFastForwardRejection('fatal: unable to access: Could not resolve host')).toBe(false);
  });
});

describe('pre-merge fast-forward from the mirrored origin', () => {
  let root: string;
  let origin: string;
  let clone: string;
  let other: string;

  async function commitIn(dir: string, file: string): Promise<string> {
    await writeFile(join(dir, file), `${file}\n`);
    await git(dir, 'add', file);
    await git(dir, 'commit', '-q', '-m', file);
    return git(dir, 'rev-parse', 'HEAD');
  }

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'lazy-mirror-ff-')));
    origin = join(root, 'hosted.git');
    clone = join(root, 'daemon');
    other = join(root, 'other');
    await runGit(['init', '-q', '--bare', '-b', 'main', origin], { cwd: root });
    for (const dir of [clone, other]) {
      await runGit(['clone', '-q', origin, dir], { cwd: root });
      await git(dir, 'config', 'user.email', 'a@example.com');
      await git(dir, 'config', 'user.name', 'A');
    }
    await git(clone, 'checkout', '-q', '-b', 'main');
    await commitIn(clone, 'base.txt');
    await git(clone, 'push', '-q', 'origin', 'main');
    await git(other, 'fetch', '-q', 'origin');
    await git(other, 'checkout', '-q', '-b', 'main', 'origin/main');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // INVARIANT: equal or remote-behind is a no-op; local is never moved back.
  test('up to date when origin is equal or behind', async () => {
    expect(await fastForwardTargetFromMirror('origin', 'main', clone)).toBe('up-to-date');
    const local = await commitIn(clone, 'local.txt');
    expect(await fastForwardTargetFromMirror('origin', 'main', clone)).toBe('up-to-date');
    expect(await git(clone, 'rev-parse', 'main')).toBe(local);
  });

  // INVARIANT: origin strictly ahead fast-forwards local, checked out or not.
  test('fast-forwards when origin is ahead (checked out and not)', async () => {
    let pushed = await commitIn(other, 'direct.txt');
    await git(other, 'push', '-q', 'origin', 'main');
    expect(await fastForwardTargetFromMirror('origin', 'main', clone)).toBe('fast-forwarded');
    expect(await git(clone, 'rev-parse', 'main')).toBe(pushed);
    expect(await git(clone, 'status', '--porcelain')).toBe('');

    await git(clone, 'checkout', '-q', '-b', 'elsewhere');
    pushed = await commitIn(other, 'direct2.txt');
    await git(other, 'push', '-q', 'origin', 'main');
    expect(await fastForwardTargetFromMirror('origin', 'main', clone)).toBe('fast-forwarded');
    expect(await git(clone, 'rev-parse', 'main')).toBe(pushed);
  });

  // INVARIANT: diverged is refused and nothing moves — never merged or overwritten.
  test('diverged throws and leaves local untouched', async () => {
    await commitIn(other, 'direct.txt');
    await git(other, 'push', '-q', 'origin', 'main');
    const local = await commitIn(clone, 'local.txt');
    await expect(fastForwardTargetFromMirror('origin', 'main', clone)).rejects.toBeInstanceOf(MirrorTargetDivergedError);
    expect(await git(clone, 'rev-parse', 'main')).toBe(local);
  });

  // INVARIANT: a target the install does not have yet is not an error — there
  // is nothing to bring in, and the post-merge push creates it.
  test('a target missing on origin is up to date', async () => {
    await git(clone, 'branch', 'release');
    expect(await fastForwardTargetFromMirror('origin', 'release', clone)).toBe('up-to-date');
  });

  test('diverged error counts both sides', async () => {
    await commitIn(other, 'direct.txt');
    await git(other, 'push', '-q', 'origin', 'main');
    await commitIn(clone, 'local.txt');
    await expect(fastForwardTargetFromMirror('origin', 'main', clone)).rejects.toThrow(/local has 1 commit\(s\).*origin has 1 commit\(s\)/);
  });

  // INVARIANT (AGENTS.md "The git merge is an accept's commit point"): the
  // mirror push decision and the fast-forward run in the PRE-merge band of
  // acceptTaskRun, before beginMergePhase — nothing new between the merge and
  // the accept transition.
  test('decision and fast-forward sit before the merge phase', async () => {
    const src = await readFile(join(import.meta.dir, '../../src/daemon/task-lifecycle.ts'), 'utf8');
    const fn = src.slice(src.indexOf('async function acceptTaskRun('));
    const begin = fn.indexOf('await beginMergePhase(');
    expect(begin).toBeGreaterThan(0);
    for (const call of ['acceptPushesTargetToMirror(', 'fastForwardTargetFromMirror(']) {
      const at = fn.indexOf(call);
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(begin);
      expect(fn.indexOf(call, begin)).toBe(-1);
    }
  });
});
