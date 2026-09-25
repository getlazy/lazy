/**
 * Unit tests for resolveTaskDiffBase — "which ref is a task's diff rendered
 * against?" — over REAL git repositories.
 *
 * Reproduces fix-fleet-task-diff-base: a fleet-provisioned project is a fresh
 * `git clone` whose lazy.toml says `driver = "github"`. The task launcher
 * resolves the integration branch through resolveUpstreamMergeRef, which fetches
 * and returns `origin/<default>`, and cuts the task branch from there. The diff
 * used the raw LOCAL default branch instead — and in such a clone that branch is
 * frozen at clone time forever (nothing pulls it; accepts into a protected
 * default land on the forge). `main...HEAD` therefore had its merge base at the
 * clone commit and attributed every upstream commit since provisioning to the
 * task. On a hosted-git project cloned at its seed commit, that is the whole
 * repository.
 *
 * INVARIANT: the diff base and the branch point resolve through the SAME
 * function (src/remote/upstream-ref.ts, per CLAUDE.md). A test here that goes
 * red means a diff surface has grown a second opinion again.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { realpath } from 'fs/promises';
import {
  classifyHubChildren,
  gitDiffPaths,
  resolveTaskDiffBase,
  resolveTaskDirectDiff,
} from '../../src/task-diff-base';
import { acceptTagName } from '../../src/git/operations';
import { DEFAULT_CONFIG } from '../../src/config/loader';
import type { ResolvedConfig } from '../../src/config/types';
import type { Session, Task } from '../../src/types';
import type { Storage } from '../../src/storage/interface';
import { runGit } from '../../src/utils/git';
import * as gitUtil from '../../src/utils/git';

/** Number of files the "release history" adds on top of the seed commit. */
const UPSTREAM_FILES = 40;

async function git(args: string[], cwd: string): Promise<string> {
  const result = await runGit(args, { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  }
  return result.stdout;
}

/** Files a three-dot diff from `fromRef` to HEAD reports as changed. */
async function changedFiles(fromRef: string, cwd: string): Promise<string[]> {
  const out = await git(['diff', '--name-only', `${fromRef}...HEAD`], cwd);
  return out.split('\n').map(l => l.trim()).filter(Boolean);
}

function configWithDriver(driver: 'github' | 'local'): ResolvedConfig {
  return { ...DEFAULT_CONFIG, remote: { ...DEFAULT_CONFIG.remote, driver } };
}

/** A top-level task whose branch slot is the unresolved sentinel — exactly what
 *  a Slack `/lazy create` produces (createTask stores no branch target). */
function topLevelTask(): Task {
  return {
    id: 'task-1',
    goal: 'a task',
    target: { kind: 'branch', branch: '' },
  } as unknown as Task;
}

const noSession = { upstream_merge_sha: undefined } as unknown as Session;
const noStorage = {} as unknown as Storage;

describe('resolveTaskDiffBase (real git)', () => {
  let root: string;
  let origin: string;
  /** The "fleet clone" — the project root the daemon operates on. */
  let clone: string;
  let worktree: string;

  beforeEach(async () => {
    // realpath: git resolves symlinks, and macOS puts tmpdir() under /private.
    root = await realpath(await mkdtemp(join(tmpdir(), 'lazy-diff-base-')));
    origin = join(root, 'origin.git');
    clone = join(root, 'clone');
    worktree = join(root, 'task-worktree');

    // --- Seed the "hosted git" repo with one commit, as Teams provisioning does
    await git(['init', '--bare', '--initial-branch=main', origin], root);
    const seed = join(root, 'seed');
    await mkdir(seed);
    await git(['init', '--initial-branch=main'], seed);
    await git(['config', 'user.email', 't@example.com'], seed);
    await git(['config', 'user.name', 'Test'], seed);
    await writeFile(join(seed, 'README.md'), '# seed\n');
    await git(['add', '.'], seed);
    await git(['commit', '-m', 'Initial commit'], seed);
    await git(['remote', 'add', 'origin', origin], seed);
    await git(['push', 'origin', 'main'], seed);

    // --- Fleet provisioning: plain clone. Local main == the seed commit.
    await git(['clone', origin, clone], root);
    await git(['config', 'user.email', 't@example.com'], clone);
    await git(['config', 'user.name', 'Test'], clone);

    // --- Upstream moves on (a release lands) while the clone's local main sits
    for (let i = 0; i < UPSTREAM_FILES; i++) {
      await writeFile(join(seed, `upstream-${i}.txt`), `file ${i}\n`);
    }
    await git(['add', '.'], seed);
    await git(['commit', '-m', 'Release history'], seed);
    await git(['push', 'origin', 'main'], seed);

    // --- The task launcher fetches and cuts the branch from origin/main
    await git(['fetch', 'origin', 'main'], clone);
    await git(['branch', 'lazy/task-1', 'origin/main'], clone);
    await git(['worktree', 'add', worktree, 'lazy/task-1'], clone);
    await writeFile(join(worktree, 'task-work.txt'), 'the only change\n');
    await git(['add', '.'], worktree);
    await git(['commit', '-m', 'Task work'], worktree);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('the raw local default branch is the 90k-file diff (the bug being fixed)', async () => {
    // What handleDiff used to do. Local main is frozen at the seed commit, so
    // the merge base is the seed and the whole release is blamed on the task.
    expect(await changedFiles('main', worktree)).toHaveLength(UPSTREAM_FILES + 1);
  });

  test('resolves to the branch point, so the diff is only the task work', async () => {
    const base = await resolveTaskDiffBase({
      task: topLevelTask(),
      session: noSession,
      storage: noStorage,
      projectRoot: clone,
      worktreePath: worktree,
      config: configWithDriver('github'),
    });

    expect(base.ref).toBe('origin/main');
    expect(base.twoDot).toBe(false);
    expect(base.parentBranch).toBe('main');

    expect(await changedFiles(base.ref, worktree)).toEqual(['task-work.txt']);
  });

  test('no remote configured: the local branch is still the base', async () => {
    // INVARIANT: this fix must not turn a LocalDriver project into one that
    // diffs against a remote-tracking ref it never uses.
    const base = await resolveTaskDiffBase({
      task: topLevelTask(),
      session: noSession,
      storage: noStorage,
      projectRoot: clone,
      worktreePath: worktree,
      config: configWithDriver('local'),
    });

    expect(base.ref).toBe('main');
  });

  test('an explicit integration target is honoured over the repo default', async () => {
    await git(['branch', 'release-v1', 'origin/main'], clone);
    const task = {
      ...topLevelTask(),
      target: { kind: 'branch', branch: 'release-v1' },
    } as unknown as Task;

    const base = await resolveTaskDiffBase({
      task,
      session: noSession,
      storage: noStorage,
      projectRoot: clone,
      worktreePath: worktree,
      config: configWithDriver('local'),
    });

    expect(base.ref).toBe('release-v1');
  });

  test('falls back to the sync merge point when no branch ref resolves', async () => {
    // Worktree recovered from a remote branch after the parent branch was
    // deleted: neither `main` nor `origin/main` is reachable from here.
    const detached = join(root, 'bare-worktree');
    await git(['clone', '--no-checkout', origin, detached], root);
    await git(['checkout', '--detach', 'origin/main'], detached);
    await git(['branch', '-D', 'main'], detached).catch(() => {});
    await git(['remote', 'remove', 'origin'], detached);
    await git(['update-ref', '-d', 'refs/remotes/origin/main'], detached);
    await git(['update-ref', '-d', 'refs/remotes/origin/HEAD'], detached).catch(() => {});

    const sha = (await git(['rev-parse', 'HEAD'], detached)).trim();
    const base = await resolveTaskDiffBase({
      task: { ...topLevelTask(), target: { kind: 'branch', branch: 'gone-branch' } } as unknown as Task,
      session: { upstream_merge_sha: sha } as unknown as Session,
      storage: noStorage,
      projectRoot: detached,
      worktreePath: detached,
      config: configWithDriver('local'),
    });

    expect(base.ref).toBe(sha);
    expect(base.twoDot).toBe(true);
  });
});

describe('classifyHubChildren', () => {
  const child = (status: Task['status'], id: string): Task =>
    ({ id, goal: id, status } as unknown as Task);

  test('splits complete vs live and drops backlog/abandoned', () => {
    const { accepted, inProgress } = classifyHubChildren([
      child('complete', 'done'),
      child('blocked', 'need-you'),
      child('working', 'busy'),
      child('backlog', 'later'),
      child('abandoned', 'closed'),
    ]);
    expect(accepted.map(c => c.id)).toEqual(['done']);
    expect(inProgress.map(c => c.id)).toEqual(['need-you', 'busy']);
  });
});

describe('resolveTaskDirectDiff (real git)', () => {
  let root: string;
  let worktree: string;
  const childId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  async function writeAndCommit(path: string, body: string, message: string, cwd: string) {
    await writeFile(join(cwd, path), body);
    await git(['add', path], cwd);
    await git(['commit', '-m', message], cwd);
  }

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'lazy-direct-diff-')));
    await git(['init', '-b', 'main'], root);
    await git(['config', 'user.email', 'test@test.com'], root);
    await git(['config', 'user.name', 'Test'], root);
    await writeAndCommit('seed.txt', 'seed\n', 'seed', root);
    await git(['checkout', '-b', 'lazy/hub'], root);
    await writeAndCommit('hub-own.txt', 'hub first\n', 'hub own commit', root);
    // Simulate an accepted child's squash on first-parent, tagged the way
    // createAcceptTag writes it (lazy-accept-<uuid> pointing at the squash).
    await writeAndCommit('child-only.txt', 'from child\n', `Accept task ${childId.substring(0, 8)}: child work`, root);
    const squash = (await git(['rev-parse', 'HEAD'], root)).trim();
    await git(['tag', '-a', '-m', `Accepted task ${childId}`, acceptTagName(childId), squash], root);
    await writeAndCommit('hub-direct.txt', 'hub later\n', 'hub direct commit', root);
    worktree = root;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function hubTask(): Task {
    return {
      id: 'hub-task-id',
      goal: 'hub',
      target: { kind: 'branch', branch: '' },
    } as unknown as Task;
  }

  function storageWith(children: Task[]): Storage {
    return { getChildTasks: async () => children } as unknown as Storage;
  }

  const acceptedChild = {
    id: childId,
    code: 'child-a',
    goal: 'child work',
    status: 'complete',
  } as unknown as Task;

  test('a leaf task (no accepted children) is unrestricted', async () => {
    const plan = await resolveTaskDirectDiff({
      task: hubTask(),
      session: { upstream_merge_sha: undefined } as unknown as Session,
      storage: storageWith([]),
      projectRoot: root,
      worktreePath: worktree,
      config: configWithDriver('local'),
    });
    expect(plan.scopedToDirect).toBe(false);
    expect(gitDiffPaths(plan)).toEqual({ paths: undefined, empty: false });
    const files = await changedFiles('main', worktree);
    expect(files).toContain('hub-own.txt');
    expect(files).toContain('child-only.txt');
    expect(files).toContain('hub-direct.txt');
  });

  test('accepted-child squash paths drop out of the direct set', async () => {
    const plan = await resolveTaskDirectDiff({
      task: hubTask(),
      session: { upstream_merge_sha: undefined } as unknown as Session,
      storage: storageWith([acceptedChild]),
      projectRoot: root,
      worktreePath: worktree,
      config: configWithDriver('local'),
    });
    expect(plan.scopedToDirect).toBe(true);
    expect(plan.paths).toContain('hub-own.txt');
    expect(plan.paths).toContain('hub-direct.txt');
    expect(plan.paths).not.toContain('child-only.txt');
    expect(gitDiffPaths(plan).empty).toBe(false);
  });

  // INVARIANT (final-turn §4.2): attribution is the MIRROR of the exclusion —
  // whatever a child's accept contributed and the direct set dropped is what
  // the parent's wrap-up owes. It must ride the same tag map + first-parent
  // walk (zero extra git calls — the invocation-count test below keeps that
  // honest) and be present exactly when the plan is scoped to direct paths.
  test('each accepted child reports its attributed paths', async () => {
    const plan = await resolveTaskDirectDiff({
      task: hubTask(),
      session: { upstream_merge_sha: undefined } as unknown as Session,
      storage: storageWith([acceptedChild]),
      projectRoot: root,
      worktreePath: worktree,
      config: configWithDriver('local'),
    });
    expect(plan.scopedToDirect).toBe(true);
    expect(plan.childAttribution).toEqual([{ childId, paths: ['child-only.txt'], attributed: true }]);
  });

  test('childAttribution is absent when the plan is not scoped to direct paths', async () => {
    const leaf = await resolveTaskDirectDiff({
      task: hubTask(),
      session: { upstream_merge_sha: undefined } as unknown as Session,
      storage: storageWith([]),
      projectRoot: root,
      worktreePath: worktree,
      config: configWithDriver('local'),
    });
    expect(leaf.childAttribution).toBeUndefined();

    const full = await resolveTaskDirectDiff({
      task: hubTask(),
      session: { upstream_merge_sha: undefined } as unknown as Session,
      storage: storageWith([acceptedChild]),
      projectRoot: root,
      worktreePath: worktree,
      config: configWithDriver('local'),
      fullBranch: true,
    });
    expect(full.childAttribution).toBeUndefined();
  });

  test('a child excluded via subject needle is still attributed', async () => {
    await git(['tag', '-d', acceptTagName(childId)], root);
    const plan = await resolveTaskDirectDiff({
      task: hubTask(),
      session: { upstream_merge_sha: undefined } as unknown as Session,
      storage: storageWith([acceptedChild]),
      projectRoot: root,
      worktreePath: worktree,
      config: configWithDriver('local'),
    });
    expect(plan.scopedToDirect).toBe(true);
    expect(plan.paths).not.toContain('child-only.txt');
    expect(plan.childAttribution).toEqual([{ childId, paths: ['child-only.txt'], attributed: true }]);
  });

  test('a child with neither tag nor subject match is unattributed and stays in the direct set', async () => {
    await git(['tag', '-d', acceptTagName(childId)], root);
    // Rewrite the child's squash so no needle matches: soft-reset to before it
    // and re-commit the same changes under an unrelated subject.
    await git(['reset', '--soft', 'HEAD~2'], root);
    await git(['commit', '-m', 'unrelated work'], root);
    const plan = await resolveTaskDirectDiff({
      task: hubTask(),
      session: { upstream_merge_sha: undefined } as unknown as Session,
      storage: storageWith([acceptedChild]),
      projectRoot: root,
      worktreePath: worktree,
      config: configWithDriver('local'),
    });
    expect(plan.scopedToDirect).toBe(true);
    expect(plan.childAttribution).toEqual([{ childId, paths: [], attributed: false }]);
    // Not excluded, not attributed — the file is inside the direct set, so the
    // parent's scan still sees it. Show twice, never hide.
    expect(plan.paths).toContain('child-only.txt');
  });

  test('a tag pointing outside the walked range is unattributed and unexcluded', async () => {
    // The seed commit is the walk's merge-base (exclusive), so the tag is not
    // on the first-parent line. Attribution fails — and so does the exclusion,
    // which skips its subject fallback the moment a tag is found.
    const seedSha = (await git(['rev-parse', 'main'], root)).trim();
    await git(['tag', '-f', '-a', '-m', 're-pointed', acceptTagName(childId), seedSha], root);
    const plan = await resolveTaskDirectDiff({
      task: hubTask(),
      session: { upstream_merge_sha: undefined } as unknown as Session,
      storage: storageWith([acceptedChild]),
      projectRoot: root,
      worktreePath: worktree,
      config: configWithDriver('local'),
    });
    expect(plan.childAttribution).toEqual([{ childId, paths: [], attributed: false }]);
    expect(plan.paths).toContain('child-only.txt');
  });

  test('fullBranch restores the whole-branch path set', async () => {
    const plan = await resolveTaskDirectDiff({
      task: hubTask(),
      session: { upstream_merge_sha: undefined } as unknown as Session,
      storage: storageWith([acceptedChild]),
      projectRoot: root,
      worktreePath: worktree,
      config: configWithDriver('local'),
      fullBranch: true,
    });
    expect(plan.scopedToDirect).toBe(false);
    expect(plan.paths).toBeUndefined();
    const files = await changedFiles('main', worktree);
    expect(files).toContain('child-only.txt');
  });

  test('missing accept tag still excludes via Accept task subject', async () => {
    await git(['tag', '-d', acceptTagName(childId)], root);
    const plan = await resolveTaskDirectDiff({
      task: hubTask(),
      session: { upstream_merge_sha: undefined } as unknown as Session,
      storage: storageWith([acceptedChild]),
      projectRoot: root,
      worktreePath: worktree,
      config: configWithDriver('local'),
    });
    expect(plan.scopedToDirect).toBe(true);
    expect(plan.paths).not.toContain('child-only.txt');
    expect(plan.paths).toContain('hub-direct.txt');
  });

  // INVARIANT: review-page cost must not grow with accepted children. A
  // per-child rev-parse / --grep / diff-tree loop is what made release-v022
  // spawn 600+ gits on every render. One for-each-ref + one first-parent log
  // cover every child; 1 vs 50 accepted children must issue the same calls.
  test('git invocation count does not grow with accepted children', async () => {
    const extraChildren: Task[] = Array.from({ length: 49 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      code: `child-extra-${i + 1}`,
      goal: `extra ${i + 1}`,
      status: 'complete',
    } as unknown as Task));

    const callsOf = async (children: Task[]): Promise<string[][]> => {
      const calls: string[][] = [];
      // Capture the real export before spyOn replaces it — calling `runGit`
      // after the spy is installed would recurse through the wrapper.
      const realRunGit = gitUtil.runGit;
      const spy = spyOn(gitUtil, 'runGit').mockImplementation(async (args, opts) => {
        calls.push([...args]);
        return realRunGit(args, opts);
      });
      try {
        await resolveTaskDirectDiff({
          task: hubTask(),
          session: { upstream_merge_sha: undefined } as unknown as Session,
          storage: storageWith(children),
          projectRoot: root,
          worktreePath: worktree,
          config: configWithDriver('local'),
        });
      } finally {
        spy.mockRestore();
      }
      return calls;
    };

    const one = await callsOf([acceptedChild]);
    const fifty = await callsOf([acceptedChild, ...extraChildren]);
    expect(fifty).toEqual(one);

    const firstArg = (args: string[]) => args[0];
    expect(one.filter((a) => firstArg(a) === 'for-each-ref')).toHaveLength(1);
    expect(one.filter((a) => firstArg(a) === 'log' && a.includes('--first-parent'))).toHaveLength(1);
    expect(one.some((a) => a.some((x) => x.startsWith('--grep=')))).toBe(false);
    expect(one.some((a) => firstArg(a) === 'diff-tree')).toBe(false);
    expect(one.some((a) => a.some((x) => x.includes('refs/tags/lazy-accept-') && firstArg(a) === 'rev-parse'))).toBe(false);
  });
});
