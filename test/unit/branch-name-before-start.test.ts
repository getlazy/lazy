/**
 * A task's branch name is fixed when it is CREATED, not when it starts.
 *
 * Background: the ref (and so the branch `lazy/<ref>`) used to be assigned at
 * start, so before start every branch lookup answered `lazy/<shortId>` — a
 * branch a coded task never has. A child reparented under an unstarted cluster
 * then fetched that phantom branch, failed "after 3 attempts", and was told to
 * check its network.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage/file-storage';
import { getBranchName, shortId, taskRef } from '../../src/task/identity';
import { pinUnstartedTaskRefs } from '../../src/task/pin-unstarted-refs';
import { unstartedParentOf } from '../../src/task/unstarted-parent';
import { taskTarget } from '../../src/task-target';
import { resolveUpstreamMergeRef } from '../../src/remote/upstream-ref';
import { RemoteBranchMissingError, isRemoteRefMissing } from '../../src/remote/branch-missing';
import { runGit, type GitResult } from '../../src/utils/git';

let root: string;
let storage: FileStorage;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lazy-ref-at-create-'));
  const base = join(root, 'store');
  await writeFile(join(root, 'lazy.toml'), `[storage]\nbackend = "external"\nexternal_path = "${base}"\n`);
  storage = new FileStorage(root, { basePath: base });
  await storage.initialize();
});

afterEach(async () => {
  await storage.close();
  await rm(root, { recursive: true, force: true });
});

describe('the ref is assigned at create', () => {
  // INVARIANT: a new task's ref is stored at creation, so its branch name
  // before start is the branch it starts on. A ref first assigned at start made
  // children chase `lazy/<shortId>`, a branch that never exists.
  test('a coded task is named after its code from the start', async () => {
    const t = await storage.createTask('Hub', undefined, undefined, 'landing-hub');
    expect(t.metadata?.task_ref).toBe('landing-hub');
    expect(getBranchName((await storage.getTask(t.id))!)).toBe('lazy/landing-hub');
  });

  test('an uncoded task pins its short id', async () => {
    const t = await storage.createTask('No code');
    expect(t.metadata?.task_ref).toBe(shortId(t.id));
  });

  test('the existing disambiguation still applies (a finished task holding the code)', async () => {
    const first = await storage.createTask('Old', undefined, undefined, 'dup');
    await storage.updateTaskStatus(first.id, 'abandoned');
    const second = await storage.createTask('New', undefined, undefined, 'dup');
    expect(taskRef(second)).not.toBe('dup');
    expect(taskRef(second).startsWith('dup-')).toBe(true);
  });

  test('a caller-supplied ref (linked tasks) wins', async () => {
    const t = await storage.createTask('Linked', undefined, undefined, 'linked', undefined, undefined, undefined,
      { metadata: { task_ref: 'abcd1234' } } as never);
    expect(t.metadata?.task_ref).toBe('abcd1234');
  });
});

describe('a code edited before start moves the ref with it', () => {
  // INVARIANT: before start nothing is cut from the ref, so it follows the code;
  // after start (a session exists) the ref is frozen and a rename is cosmetic.
  test('unstarted: the ref follows the new code', async () => {
    const t = await storage.createTask('Hub', undefined, undefined, 'old-code');
    await storage.updateTaskCode(t.id, 'new-code');
    expect(taskRef((await storage.getTask(t.id))!)).toBe('new-code');
    expect((await (storage as any).ensureIndex()).refOf.get(t.id)).toBe('new-code');
  });

  test('started: the ref stays', async () => {
    const t = await storage.createTask('Hub', undefined, undefined, 'old-code');
    await storage.createSession(t.id, 'claude-code', 'lazy/old-code', 'abc');
    await storage.updateTaskCode(t.id, 'new-code');
    expect(taskRef((await storage.getTask(t.id))!)).toBe('old-code');
  });

  test('cleared code falls back to the short id', async () => {
    const t = await storage.createTask('Hub', undefined, undefined, 'some-code');
    await storage.updateTaskCode(t.id, null);
    expect(taskRef((await storage.getTask(t.id))!)).toBe(shortId(t.id));
  });
});

describe('unstarted tasks from before the rule are given their ref', () => {
  test('pins backlog tasks with no ref, leaves started ones', async () => {
    const unstarted = await storage.createTask('Old hub', undefined, undefined, 'old-hub');
    const started = await storage.createTask('Old started', undefined, undefined, 'old-started');
    // Simulate pre-rule data: no ref stored.
    await storage.updateTaskMetadata(unstarted.id, 'task_ref', '');
    await storage.updateTaskMetadata(started.id, 'task_ref', '');
    await storage.createSession(started.id, 'claude-code', `lazy/${shortId(started.id)}`, 'abc');

    expect(await pinUnstartedTaskRefs(storage)).toBe(1);
    expect(taskRef((await storage.getTask(unstarted.id))!)).toBe('old-hub');
    expect((await storage.getTask(started.id))!.metadata?.task_ref).toBe(''); // untouched
    expect(await pinUnstartedTaskRefs(storage)).toBe(0);
  });
});

describe('a parent with no branch yet', () => {
  // INVARIANT: a parent that has not started is "nothing to merge yet", told
  // apart from a fetch failure BEFORE any fetch.
  test('unstarted parent without a branch is reported; once its branch exists it is not', async () => {
    await runGit(['init', '-q', '-b', 'main'], { cwd: root });
    await runGit(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root });
    const parent = await storage.createTask('Cluster', undefined, undefined, 'cluster-c', 'cluster');
    const child = await storage.createTask('Child', undefined, undefined, 'child-t');
    await storage.updateTaskTarget(child.id, taskTarget(parent.id));
    const fresh = (await storage.getTask(child.id))!;

    expect((await unstartedParentOf(storage, fresh, root))?.id).toBe(parent.id);

    await runGit(['branch', 'lazy/cluster-c'], { cwd: root });
    expect(await unstartedParentOf(storage, fresh, root)).toBeNull();
  });

  test('a top-level task has no unstarted parent', async () => {
    const t = await storage.createTask('Top');
    expect(await unstartedParentOf(storage, t, root)).toBeNull();
  });
});

describe('a branch missing on origin is not a network failure', () => {
  const ok = (stdout = ''): GitResult => ({ stdout, stderr: '', exitCode: 0 });
  const fail = (stderr: string): GitResult => ({ stdout: '', stderr, exitCode: 1 });
  const missingDriver = {
    needsSync: true,
    resolveUpstreamRef: async (branch: string): Promise<string> => { throw new RemoteBranchMissingError(branch, 'origin'); },
    isTargetBranchProtected: async () => false,
  };

  test("git's wording is recognised", () => {
    expect(isRemoteRefMissing("fatal: couldn't find remote ref lazy/ac596f2b")).toBe(true);
    expect(isRemoteRefMissing('fatal: unable to access: Could not resolve host')).toBe(false);
  });

  // INVARIANT: the message says the branch does not exist — never "check your
  // network connection" or --offline-override.
  test('the error names the missing branch, not the network', () => {
    const err = new RemoteBranchMissingError('lazy/x', 'origin');
    expect(err.message).toBe('Branch lazy/x does not exist on origin.');
    expect(err.message).not.toMatch(/network|offline-override/);
  });

  test('a task branch only present locally resolves to the local branch', async () => {
    const res = await resolveUpstreamMergeRef(missingDriver, 'lazy/parent', '/x', {
      git: async (args) => args[0] === 'rev-parse' ? ok('abc') : fail('unexpected'),
    });
    expect(res.ref).toBe('lazy/parent');
    expect(res.warnings.join(' ')).toContain('does not exist on origin');
  });

  test('a task branch present nowhere propagates the missing-branch error', async () => {
    await expect(resolveUpstreamMergeRef(missingDriver, 'lazy/parent', '/x', {
      git: async () => fail('no such ref'),
    })).rejects.toBeInstanceOf(RemoteBranchMissingError);
  });

  test('a named branch missing on origin is never swapped for a local one', async () => {
    await expect(resolveUpstreamMergeRef(missingDriver, 'release', '/x', {
      git: async () => ok('abc'),
    })).rejects.toBeInstanceOf(RemoteBranchMissingError);
  });
});
