/**
 * INVARIANT: lazy's daemon-side git that WRITES in a task worktree (lazy_commit,
 * sync's merges, accept's squash merge, recording a session's commits) only
 * runs while the worktree's HEAD is `ref: refs/heads/<the task's own branch>`,
 * read from the HEAD file, never through git. `<gitdir>/HEAD` stays writable
 * in a task container (git rewrites it on checkout), so a task can point it at
 * a sibling's, its parent's or main's branch — and the daemon's next commit
 * there would move a branch the task does not own. A detached HEAD is refused
 * too. Repair (rewriting HEAD back) happens only in doctor and the sweep.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, readFile, rm, writeFile, mkdtemp, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  assertTaskWorktreeHead,
  checkTaskWorktreeHead,
  describeHeadMismatch,
  repairRedirectedTaskHeads,
  repairTaskWorktreeHead,
  scanTaskWorktreeHeads,
  TaskHeadBranchError,
  HeadRepairUnsafeError,
} from '../../src/git/worktree-pointers';
import { squashMergeBranchIntoTarget } from '../../src/git/operations';
import { recordSessionCommits } from '../../src/task/session-commits';
import { createCommitHandler } from '../../src/mcp/tools';
import { createInternalGitHandler } from '../../src/mcp/internal-git';
import { taskWorktreeBranches } from '../../src/task/worktree-branches';
import type { Storage } from '../../src/storage';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
function git(args: string[], cwd: string) {
  const r = Bun.spawnSync(['git', ...args], { cwd, env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

let base: string;
let repo: string;
let worktree: string;
let headFile: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'head-guard-')));
  repo = join(base, 'repo');
  await mkdir(repo);
  git(['init', '-q', '-b', 'main'], repo);
  await writeFile(join(repo, 'f.txt'), 'hello\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  worktree = join(repo, '.lazy', 'worktrees', 'my-task');
  git(['worktree', 'add', '-q', '-b', 'lazy/my-task', worktree], repo);
  git(['branch', 'lazy/sibling'], repo);
  headFile = join(repo, '.git', 'worktrees', 'my-task', 'HEAD');
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('describeHeadMismatch', () => {
  test('own branch passes; another branch, a detached sha and junk do not', () => {
    expect(describeHeadMismatch('ref: refs/heads/lazy/x\n', 'lazy/x')).toBeNull();
    expect(describeHeadMismatch('ref: refs/heads/main\n', 'lazy/x')).toBe('points at branch main');
    expect(describeHeadMismatch('a'.repeat(40) + '\n', 'lazy/x')).toContain('detached');
    expect(describeHeadMismatch('ref: refs/tags/v1\n', 'lazy/x')).toBe('points at refs/tags/v1');
    expect(describeHeadMismatch('whatever', 'lazy/x')).toBe('is not a branch reference');
  });
});

describe('task worktree HEAD check', () => {
  test('passes on the task branch', async () => {
    expect(await checkTaskWorktreeHead(repo, worktree, 'lazy/my-task')).toBeNull();
    await assertTaskWorktreeHead(worktree, 'lazy/my-task');
  });

  test('refuses a HEAD redirected to another branch, naming task and branch', async () => {
    await writeFile(headFile, 'ref: refs/heads/main\n');
    const err = await assertTaskWorktreeHead(worktree, 'lazy/my-task').catch((e) => e);
    expect(err).toBeInstanceOf(TaskHeadBranchError);
    expect(err.message).toContain('my-task');
    expect(err.message).toContain('points at branch main');
  });

  test('refuses a detached HEAD', async () => {
    await writeFile(headFile, git(['rev-parse', 'HEAD'], repo) + '\n');
    await expect(assertTaskWorktreeHead(worktree, 'lazy/my-task')).rejects.toBeInstanceOf(TaskHeadBranchError);
  });

  test('a path outside any task worktree is not judged', async () => {
    await assertTaskWorktreeHead(repo, 'something-else');
  });

  test('repair rewrites HEAD only, keeping uncommitted edits', async () => {
    await writeFile(join(worktree, 'f.txt'), 'edited\n');
    await writeFile(headFile, 'ref: refs/heads/lazy/sibling\n');
    expect(await repairTaskWorktreeHead(repo, worktree, 'lazy/my-task')).toBe(true);
    expect(await readFile(headFile, 'utf-8')).toBe('ref: refs/heads/lazy/my-task\n');
    expect(await readFile(join(worktree, 'f.txt'), 'utf-8')).toBe('edited\n');
    expect(await repairTaskWorktreeHead(repo, worktree, 'lazy/my-task')).toBe(false);
  });

  // INVARIANT: repair rewrites HEAD alone only when the index still holds the
  // task branch's tree. After a real `git checkout other` the index and files
  // are the other branch's; pointing HEAD back under them would make the next
  // lazy_commit revert the task's work, so the repair refuses and says how.
  test('a real checkout of another branch is left alone, with the remedy', async () => {
    await writeFile(join(worktree, 'mine.txt'), 'task work\n');
    git(['add', '.'], worktree);
    git(['commit', '-q', '-m', 'task work'], worktree);
    git(['checkout', '-q', 'lazy/sibling'], worktree);
    // Doctor surfaces name the manual remedy up front, not the repair flag.
    const scan = await scanTaskWorktreeHeads(repo, new Map([['my-task', 'lazy/my-task']]));
    expect(scan.map((r) => r.manual)).toEqual([true]);
    const err = await repairTaskWorktreeHead(repo, worktree, 'lazy/my-task').catch((e) => e);
    expect(err).toBeInstanceOf(HeadRepairUnsafeError);
    expect(err.message).toContain('a real checkout moved it');
    expect(err.message).toContain('git checkout lazy/my-task');
    expect(await readFile(headFile, 'utf-8')).toBe('ref: refs/heads/lazy/sibling\n');
    const results = await repairRedirectedTaskHeads(repo, new Map([['my-task', 'lazy/my-task']]));
    expect(results[0]!.error).toContain('index does not hold');
    expect(await readFile(headFile, 'utf-8')).toBe('ref: refs/heads/lazy/sibling\n');
  });

  test('when the index cannot be compared, the refusal says so and claims no cause', async () => {
    await writeFile(headFile, 'ref: refs/heads/lazy/sibling\n');
    git(['branch', '-D', 'lazy/my-task'], repo); // the task branch is gone
    const err = await repairTaskWorktreeHead(repo, worktree, 'lazy/my-task').catch((e) => e);
    expect(err).toBeInstanceOf(HeadRepairUnsafeError);
    expect(err.message).toContain('could not compare its index with lazy/my-task');
    expect(err.message).not.toContain('a real checkout moved it');
    expect(await readFile(headFile, 'utf-8')).toBe('ref: refs/heads/lazy/sibling\n');
  });

  test('a file-written HEAD over a task-branch index is repaired', async () => {
    await writeFile(join(worktree, 'mine.txt'), 'task work\n');
    git(['add', '.'], worktree);
    git(['commit', '-q', '-m', 'task work'], worktree);
    await writeFile(headFile, 'ref: refs/heads/lazy/sibling\n');
    expect(await repairTaskWorktreeHead(repo, worktree, 'lazy/my-task')).toBe(true);
    expect(await checkTaskWorktreeHead(repo, worktree, 'lazy/my-task')).toBeNull();
  });

  test('the sweep scan finds and repairs only judged worktrees', async () => {
    await writeFile(headFile, 'ref: refs/heads/main\n');
    expect(await scanTaskWorktreeHeads(repo, new Map())).toEqual([]);
    const branches = new Map([['my-task', 'lazy/my-task']]);
    expect((await scanTaskWorktreeHeads(repo, branches)).map((r) => r.name)).toEqual(['my-task']);
    const results = await repairRedirectedTaskHeads(repo, branches);
    expect(results.length).toBe(1);
    expect(results[0]!.error).toBeUndefined();
    expect(await checkTaskWorktreeHead(repo, worktree, 'lazy/my-task')).toBeNull();
  });
});

describe('writing paths refuse a redirected HEAD', () => {
  const storageFor = (branch: string) => ({
    getSessionByTaskId: async () => ({ id: 's', git_branch: branch }),
    getTask: async () => null,
    close: async () => {},
  }) as unknown as Storage;

  test('lazy_commit refuses and moves no branch', async () => {
    await writeFile(headFile, 'ref: refs/heads/lazy/sibling\n');
    await writeFile(join(worktree, 'new.txt'), 'x\n');
    const siblingBefore = git(['rev-parse', 'lazy/sibling'], repo);
    const handler = createCommitHandler({ taskId: 't1', worktreePath: worktree, storage: storageFor('lazy/my-task') });
    await expect(handler({ message: 'm' })).rejects.toThrow(/lazy\/sibling/);
    expect(git(['rev-parse', 'lazy/sibling'], repo)).toBe(siblingBefore);
  });

  test('lazy_commit still commits on the task branch', async () => {
    await writeFile(join(worktree, 'new.txt'), 'x\n');
    const handler = createCommitHandler({ taskId: 't1', worktreePath: worktree, storage: storageFor('lazy/my-task') });
    const res = (await handler({ message: 'm' })) as { committed: boolean };
    expect(res.committed).toBe(true);
    expect(git(['log', '-1', '--format=%s', 'lazy/my-task'], repo)).toBe('m');
  });

  test("accept's squash merge into a task worktree refuses a redirected HEAD", async () => {
    git(['branch', 'lazy/child', 'main'], repo);
    await writeFile(headFile, 'ref: refs/heads/main\n');
    const mainBefore = git(['rev-parse', 'main'], repo);
    await expect(squashMergeBranchIntoTarget('lazy/child', 'lazy/my-task', 'msg', worktree)).rejects.toThrow();
    expect(git(['rev-parse', 'main'], repo)).toBe(mainBefore);
  });

  test('the supervisor git channel refuses merge and merge_commit on a redirected HEAD', async () => {
    await writeFile(headFile, 'ref: refs/heads/main\n');
    const mainBefore = git(['rev-parse', 'main'], repo);
    const handler = createInternalGitHandler({ taskId: 't1', worktreePath: worktree, storage: storageFor('lazy/my-task') });
    await expect(handler({ op: 'merge', target: 'main', message: 'm' })).rejects.toThrow(/points at branch main/);
    await expect(handler({ op: 'merge_commit' })).rejects.toThrow(/points at branch main/);
    expect(git(['rev-parse', 'main'], repo)).toBe(mainBefore);
  });

  test('an accept into a branch two worktrees claim refuses, without stashing either', async () => {
    // A sibling points its HEAD at this task's branch.
    const sib = join(repo, '.lazy', 'worktrees', 'sib');
    git(['worktree', 'add', '-q', sib, 'lazy/sibling'], repo);
    await writeFile(join(repo, '.git', 'worktrees', 'sib', 'HEAD'), 'ref: refs/heads/lazy/my-task\n');
    await writeFile(join(sib, 'dirty.txt'), 'uncommitted\n');
    git(['branch', 'lazy/child', 'main'], repo);
    const before = git(['rev-parse', 'lazy/my-task'], repo);
    await expect(squashMergeBranchIntoTarget('lazy/child', 'lazy/my-task', 'msg', repo)).rejects.toThrow(/2 worktrees have HEAD on it/);
    expect(git(['rev-parse', 'lazy/my-task'], repo)).toBe(before);
    expect(await readFile(join(sib, 'dirty.txt'), 'utf-8')).toBe('uncommitted\n');
  });

  test('the automatic repair leaves a detached HEAD alone; doctor-style repair fixes it', async () => {
    await writeFile(headFile, git(['rev-parse', 'HEAD'], repo) + '\n');
    const branches = new Map([['my-task', 'lazy/my-task']]);
    expect(await repairRedirectedTaskHeads(repo, branches, { skipDetached: true })).toEqual([]);
    expect(await checkTaskWorktreeHead(repo, worktree, 'lazy/my-task')).toContain('detached');
    expect((await repairRedirectedTaskHeads(repo, branches))[0]!.error).toBeUndefined();
  });

  test('the automatic repair skips working and pairing tasks', async () => {
    const task = (status: string, ref: string) => ({ id: ref, status, metadata: { task_ref: ref } });
    const storage = {
      listTasksWithOptions: async () => [task('working', 'a'), task('pairing', 'b'), task('blocked', 'c')],
      getSessionByTaskId: async (id: string) => ({ git_branch: `lazy/${id}`, ended_at: null }),
    } as unknown as Storage;
    expect([...(await taskWorktreeBranches(storage, { excludeLive: true })).keys()]).toEqual(['c']);
    expect([...(await taskWorktreeBranches(storage)).keys()]).toEqual(['a', 'b', 'c']);
  });

  test('session-commit recording refuses to read another branch as this task', async () => {
    const start = git(['rev-parse', 'HEAD'], repo);
    await writeFile(join(repo, 'g.txt'), 'g\n');
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', 'main work'], repo);
    await writeFile(headFile, 'ref: refs/heads/main\n');
    let recorded = 0;
    const storage = { getSessionCommits: async () => [], createCommit: async () => { recorded++; } } as unknown as Storage;
    const scan = await recordSessionCommits(storage, { id: 's', git_start_sha: start, git_branch: 'lazy/my-task' }, worktree, 'my-task');
    expect(scan.base).toBeNull();
    expect(recorded).toBe(0);
  });
});
