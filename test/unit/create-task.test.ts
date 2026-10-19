/**
 * Daemon createTask: the one writer behind the web New-task form.
 *
 * INVARIANT: every field is validated before any write, so a bad effort or
 * code cannot leave a half-created task. INVARIANT: a blank code is derived
 * from the goal via deriveCode (the suggestion the form advertises), and an
 * explicit code is validated with validateCode — neither rule is reimplemented
 * in the web layer.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDaemonStorage, getOrCreateStorage, closeAllStorage } from '../../src/daemon/rpc-handlers';
import { createTask } from '../../src/daemon/create-task';
import { RpcError } from '../../src/daemon/rpc-error';
import { currentPromptOf } from '../../src/task-prompt';
import { parentTaskIdOf } from '../../src/task-target';
import { resolveBranchParent } from '../../src/task/branch-parent';
import { resetBranchPrefix, setBranchPrefix } from '../../src/git/branch-prefix';
import { runGit } from '../../src/utils/git';

describe('daemon createTask', () => {
  let root: string;
  let prevLazyConfig: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-createtask-'));
    const store = join(root, 'store');
    await mkdir(store, { recursive: true });
    const configPath = join(root, 'lazy.toml');
    await writeFile(
      configPath,
      `[storage]\nbackend = "external"\nexternal_path = "${store}"\n`,
    );
    prevLazyConfig = process.env.LAZY_CONFIG;
    process.env.LAZY_CONFIG = configPath;
    initDaemonStorage(root);
  });

  afterEach(async () => {
    await closeAllStorage();
    if (prevLazyConfig === undefined) delete process.env.LAZY_CONFIG;
    else process.env.LAZY_CONFIG = prevLazyConfig;
    await rm(root, { recursive: true, force: true });
  });

  test('creates a backlog task and derives a code from the goal', async () => {
    const storage = await getOrCreateStorage();
    const result = await createTask(storage, root, {
      goal: 'Add authentication',
      prompt: 'Implement OAuth2',
      type: 'feature',
      effort: 'high',
      actor: 'human',
    });

    expect(result.derivedCode).toBe(true);
    expect(result.displayId).toBe('add-authentication');
    const task = await storage.getTask(result.taskId);
    expect(task?.status).toBe('backlog');
    expect(task?.goal).toBe('Add authentication');
    expect(task?.code).toBe('add-authentication');
    expect(task?.type).toBe('feature');
    expect(task?.metadata?.effort).toBe('high');
    expect(currentPromptOf(task!)).toBe('Implement OAuth2');
    expect(parentTaskIdOf(task!)).toBeNull();
  });

  test('keeps an explicit code and inherits the parent agent', async () => {
    const storage = await getOrCreateStorage();
    const parent = await storage.createTask(
      'Parent',
      undefined,
      undefined,
      'parent-task',
      'task',
      'cursor',
    );
    await storage.updateTaskModel(parent.id, 'parent-model');

    const result = await createTask(storage, root, {
      goal: 'Child work',
      code: 'child-work',
      parent: parent.code ?? parent.id,
      actor: 'human',
    });

    const child = await storage.getTask(result.taskId);
    expect(result.derivedCode).toBe(false);
    expect(child?.code).toBe('child-work');
    expect(child?.agent_id).toBe('cursor');
    expect(child?.model).toBe('parent-model');
    expect(parentTaskIdOf(child!)).toBe(parent.id);
  });

  test('an explicit model overrides the inherited model', async () => {
    const storage = await getOrCreateStorage();
    const parent = await storage.createTask('Parent', undefined, undefined, 'parent-explicit-model', 'task', 'cursor');
    await storage.updateTaskModel(parent.id, 'old-model');
    const result = await createTask(storage, root, {
      goal: 'Explicit model child', parent: parent.id, model: 'new-model',
    });
    expect((await storage.getTask(result.taskId))?.model).toBe('new-model');
  });

  test('switching agents does not copy the parent model', async () => {
    const storage = await getOrCreateStorage();
    const parent = await storage.createTask('Parent', undefined, undefined, 'parent-other-agent', 'task', 'cursor');
    await storage.updateTaskModel(parent.id, 'cursor-model');
    const result = await createTask(storage, root, {
      goal: 'Other agent child', parent: parent.id, agent: 'claude-code',
    });
    expect((await storage.getTask(result.taskId))?.model).toBeNull();
  });

  test('refuses an empty goal without writing a task', async () => {
    const storage = await getOrCreateStorage();
    await expect(createTask(storage, root, { goal: '   ' }))
      .rejects.toMatchObject({ status: 400 });
    expect((await storage.listTasks()).length).toBe(0);
  });

  test('refuses an invalid code before writing', async () => {
    const storage = await getOrCreateStorage();
    await expect(createTask(storage, root, { goal: 'Do it', code: 'Has.Dots' }))
      .rejects.toBeInstanceOf(RpcError);
    expect((await storage.listTasks()).length).toBe(0);
  });

  test('refuses a terminal parent', async () => {
    const storage = await getOrCreateStorage();
    const parent = await storage.createTask('Done parent', undefined, undefined, 'done-parent');
    await storage.updateTaskStatus(parent.id, 'abandoned');

    await expect(createTask(storage, root, {
      goal: 'Orphan child',
      parent: 'done-parent',
    })).rejects.toMatchObject({ status: 400 });
    expect((await storage.listTasks()).map((t) => t.code)).toEqual(['done-parent']);
  });

  test('refuses a parent that looks like a git option', async () => {
    const storage = await getOrCreateStorage();
    let dash: unknown;
    try {
      await createTask(storage, root, {
        goal: 'Do not parse this as git',
        parent: '--output=/tmp/pwned',
      });
    } catch (err) {
      dash = err;
    }
    expect(dash).toBeInstanceOf(RpcError);
    expect((dash as RpcError).status).toBe(400);
    expect((dash as RpcError).message).toContain("cannot start with '-'");

    let help: unknown;
    try {
      await createTask(storage, root, { goal: 'Dash help', parent: '-h' });
    } catch (err) {
      help = err;
    }
    expect(help).toBeInstanceOf(RpcError);
    expect((help as RpcError).status).toBe(400);
    expect((await storage.listTasks()).length).toBe(0);
  });

  test('a taken code is a 400; any other storage failure is not', async () => {
    const storage = await getOrCreateStorage();
    await createTask(storage, root, { goal: 'First', code: 'taken-code' });

    let taken: unknown;
    try {
      await createTask(storage, root, { goal: 'Second', code: 'taken-code' });
    } catch (err) {
      taken = err;
    }
    expect(taken).toBeInstanceOf(RpcError);
    expect((taken as RpcError).status).toBe(400);
    expect((taken as RpcError).message).toContain('already exists');

    const original = storage.createTask.bind(storage);
    storage.createTask = async () => {
      throw new Error('ENOSPC: no space left on device');
    };
    try {
      let wrote: unknown;
      try {
        await createTask(storage, root, { goal: 'Write me' });
      } catch (err) {
        wrote = err;
      }
      expect(wrote).toBeInstanceOf(Error);
      expect(wrote).not.toBeInstanceOf(RpcError);
      expect((wrote as Error).message).toContain('failed to create task: ENOSPC');
    } finally {
      storage.createTask = original;
    }
  });

  async function gitInit(dir: string): Promise<void> {
    for (const args of [
      ['init', '-q', '-b', 'main', dir],
      ['-C', dir, 'config', 'user.email', 't@example.com'],
      ['-C', dir, 'config', 'user.name', 'T'],
      ['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'init'],
    ]) {
      const r = await runGit(args, { cwd: tmpdir() });
      if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    }
  }

  // INVARIANT: a create is ONE write — the prompt, a branch target, model,
  // settings and tags land with the row, never as follow-up writes. Follow-ups
  // left a promptless backlog task behind when one was refused (a clone bound
  // to Lazy Teams pointing a task at a branch, 2026-10-09).
  test('writes the prompt, branch target, model, effort and tags with the row', async () => {
    await gitInit(root);
    await runGit(['-C', root, 'branch', 'release/base'], { cwd: tmpdir() });
    const storage = await getOrCreateStorage();
    const updates: string[] = [];
    for (const method of ['updateTaskPrompt', 'updateTaskTarget', 'updateTaskModel', 'updateTaskMetadata', 'addTaskTag'] as const) {
      const original = (storage as any)[method].bind(storage);
      (storage as any)[method] = async (...args: unknown[]) => { updates.push(method); return original(...args); };
    }

    const result = await createTask(storage, root, {
      goal: 'On a branch', prompt: 'Do it.', parent: 'release/base', model: 'm-1', effort: 'high',
      tags: ['Launch', 'launch'], deriveCode: false,
    });

    expect(updates).toEqual([]);
    expect(result.derivedCode).toBe(false);
    const task = (await storage.getTask(result.taskId))!;
    expect(task.code).toBeNull();
    expect(task.target).toEqual({ kind: 'branch', branch: 'release/base' });
    expect(currentPromptOf(task)).toBe('Do it.');
    expect((await storage.getPromptHistory(task.id)).map((v) => v.version)).toEqual([1]);
    expect(task.model).toBe('m-1');
    expect(task.metadata?.effort).toBe('high');
    expect(task.tags).toEqual(['launch']);
  });

  // INVARIANT: a refused create leaves NOTHING behind — no half-made task.
  test('a parent that is neither a task nor a branch is refused with no task created', async () => {
    await gitInit(root);
    const storage = await getOrCreateStorage();
    await expect(createTask(storage, root, { goal: 'Nowhere', prompt: 'x', parent: 'no/such-branch' }))
      .rejects.toBeInstanceOf(RpcError);
    expect(await storage.listTasks()).toEqual([]);
  });

  // INVARIANT: a parent shaped like a full task id is a TASK parent or a
  // refusal — never a branch. Lazy Teams decides from that shape which bar a
  // bound clone's create must pass (a branch parent also needs "Move under
  // another task"'s); a fall-through to the branch lookup would let a branch
  // pushed under an id-shaped name dodge that bar.
  test('an id-shaped parent that names no task is refused, even when a branch has that name', async () => {
    await gitInit(root);
    const idShaped = '0b5d3c1e-2f4a-4b6c-8d9e-0f1a2b3c4d5e';
    await runGit(['-C', root, 'branch', idShaped], { cwd: tmpdir() });
    await runGit(['-C', root, 'branch', idShaped.toUpperCase()], { cwd: tmpdir() });
    const storage = await getOrCreateStorage();
    for (const parent of [idShaped, idShaped.toUpperCase()]) {
      const err = await createTask(storage, root, { goal: 'Sneaky', prompt: 'x', parent }).catch((e) => e);
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).status).toBe(404);
    }
    expect(await storage.listTasks()).toEqual([]);
  });

  // INVARIANT: a branch parent must exist under EXACTLY its name, and no PATH
  // PART of it may differ from an existing branch's only by letter case. A
  // case-insensitive filesystem (the daemon clone on a macOS host) folds case
  // per path part: `Main` aliases `main` (and fetched over a packed `main`
  // moves it), `MAIN/x` makes a folder that blocks every later update of
  // `main`, `Release/2.0` lands inside `release/`, and `LAZY/x` lands among
  // the task branches. Each is refused before anything is fetched.
  test('a branch name that differs from an existing branch only by case is refused and never fetched', async () => {
    const side = await mkdtemp(join(tmpdir(), 'lazy-createtask-case-'));
    try {
      const origin = join(side, 'origin.git');
      expect((await runGit(['init', '-q', '--bare', '-b', 'main', origin], { cwd: side })).exitCode).toBe(0);
      await gitInit(root);
      await runGit(['-C', root, 'remote', 'add', 'origin', origin], { cwd: tmpdir() });
      await runGit(['-C', root, 'commit', '-q', '--allow-empty', '-m', 'pushed'], { cwd: tmpdir() });
      // Put the names on origin so a refusal is the only thing standing between
      // each of them and a fetch. On a case-insensitive disk (default macOS)
      // several cannot coexist in one repository — `Main` and `MAIN/x` are a
      // file and a folder of the same name there — so only the first name per
      // case-folded top folder is pushed. Every refusal below happens before
      // origin is asked anything, so the assertions hold on both kinds of disk.
      const caseOnly = ['Main', 'MAIN/x', 'Release/2.0', 'LAZY/x', 'Lazy', 'WIP/x', 'team', 'Team', 'TEAM/lazy'];
      const ignoreCase = (await runGit(['-C', origin, 'config', '--bool', 'core.ignorecase'], { cwd: tmpdir() })).stdout.trim() === 'true';
      const pushedTops = new Set<string>();
      for (const name of caseOnly) {
        const top = name.split('/')[0]!.toLowerCase();
        if (ignoreCase && pushedTops.has(top)) continue;
        pushedTops.add(top);
        expect((await runGit(['-C', root, 'push', '-q', 'origin', `HEAD:refs/heads/${name}`], { cwd: tmpdir() })).exitCode).toBe(0);
      }
      await runGit(['-C', root, 'reset', '-q', '--hard', 'HEAD~1'], { cwd: tmpdir() });
      await runGit(['-C', root, 'pack-refs', '--all'], { cwd: tmpdir() });
      // A LOOSE `release/1.0`, created after the pack: `Release/2.0` must not
      // be written into its folder.
      await runGit(['-C', root, 'branch', 'release/1.0'], { cwd: tmpdir() });
      const mainBefore = (await runGit(['-C', root, 'rev-parse', 'refs/heads/main'], { cwd: tmpdir() })).stdout.trim();

      expect(await resolveBranchParent(root, 'Main', { LAZY_MANAGED: '1' })).toEqual({ ok: false, reason: 'case-collision' });
      expect(await resolveBranchParent(root, 'MAIN', {})).toEqual({ ok: false, reason: 'case-collision' });
      expect(await resolveBranchParent(root, 'MAIN/x', { LAZY_MANAGED: '1' })).toEqual({ ok: false, reason: 'case-collision' });
      expect(await resolveBranchParent(root, 'Release/2.0', { LAZY_MANAGED: '1' })).toEqual({ ok: false, reason: 'case-collision' });
      // The task-branch namespace ignores case — the built-in `lazy` and the
      // configured prefix alike, as a folder or as a branch of that name.
      expect(await resolveBranchParent(root, 'LAZY/x', { LAZY_MANAGED: '1' })).toEqual({ ok: false, reason: 'task-branch' });
      expect(await resolveBranchParent(root, 'Lazy', { LAZY_MANAGED: '1' })).toEqual({ ok: false, reason: 'task-branch' });
      setBranchPrefix('wip');
      try {
        expect(await resolveBranchParent(root, 'WIP/x', { LAZY_MANAGED: '1' })).toEqual({ ok: false, reason: 'task-branch' });
      } finally {
        resetBranchPrefix();
      }
      // A multi-part prefix: an ANCESTOR folder of it is refused too, in any
      // case. A branch `team` would make every later `team/lazy/<x>` task
      // branch fail ("refs/heads/team exists") and wedge the project. A
      // sibling under the same folder is not the namespace.
      setBranchPrefix('team/lazy');
      try {
        for (const name of ['team', 'Team', 'TEAM/lazy', 'team/Lazy/x']) {
          expect(await resolveBranchParent(root, name, { LAZY_MANAGED: '1' })).toEqual({ ok: false, reason: 'task-branch' });
        }
        expect(await resolveBranchParent(root, 'team/other', { LAZY_MANAGED: '1' })).toEqual({ ok: false, reason: 'not-found' });
      } finally {
        resetBranchPrefix();
      }
      expect(await resolveBranchParent(root, 'main', { LAZY_MANAGED: '1' })).toEqual({ ok: true, fetched: false });
      expect(await resolveBranchParent(root, 'release/1.0', { LAZY_MANAGED: '1' })).toEqual({ ok: true, fetched: false });
      const refs = (await runGit(['-C', root, 'for-each-ref', '--format=%(refname)', 'refs/heads/'], { cwd: tmpdir() })).stdout.trim();
      expect(refs).toBe('refs/heads/main\nrefs/heads/release/1.0');
      expect((await runGit(['-C', root, 'rev-parse', 'refs/heads/main'], { cwd: tmpdir() })).stdout.trim()).toBe(mainBefore);

      const storage = await getOrCreateStorage();
      await expect(createTask(storage, root, { goal: 'Alias', prompt: 'x', parent: 'Main' }))
        .rejects.toThrow(/differs only in letter case/);
      expect(await storage.listTasks()).toEqual([]);
    } finally {
      await rm(side, { recursive: true, force: true });
    }
  });

  // INVARIANT: in managed mode (Lazy Teams) a branch a member pushed to the
  // team's repository exists on the daemon clone's origin only; it is a valid
  // parent and is fetched into a local branch for the task to be cut from.
  // Outside managed mode nothing is fetched into a person's own repository.
  test('a branch only on origin is a parent in managed mode, and only there', async () => {
    const side = await mkdtemp(join(tmpdir(), 'lazy-createtask-origin-'));
    try {
      const origin = join(side, 'origin.git');
      expect((await runGit(['init', '-q', '--bare', '-b', 'main', origin], { cwd: side })).exitCode).toBe(0);
      await gitInit(root);
      await runGit(['-C', root, 'remote', 'add', 'origin', origin], { cwd: tmpdir() });
      await runGit(['-C', root, 'push', '-q', 'origin', 'main:main', 'main:pushed/base'], { cwd: tmpdir() });

      expect(await resolveBranchParent(root, 'pushed/base', {})).toEqual({ ok: false, reason: 'not-found' });
      // A revision is not a branch: only refs/heads/<name> counts.
      expect((await resolveBranchParent(root, 'HEAD', {})).ok).toBe(false);
      expect((await resolveBranchParent(root, 'main~0', {})).ok).toBe(false);
      const sha = (await runGit(['-C', root, 'rev-parse', 'HEAD'], { cwd: tmpdir() })).stdout.trim();
      expect((await resolveBranchParent(root, sha, {})).ok).toBe(false);
      expect(await resolveBranchParent(root, 'main', {})).toEqual({ ok: true, fetched: false });
      expect(await resolveBranchParent(root, 'pushed/missing', { LAZY_MANAGED: '1' })).toEqual({ ok: false, reason: 'not-found' });
      expect(await resolveBranchParent(root, 'lazy/someone', { LAZY_MANAGED: '1' })).toEqual({ ok: false, reason: 'task-branch' });
      // INVARIANT: the managed fetch writes ONLY `refs/heads/<name>`. git's
      // opportunistic remote-tracking update would otherwise force-move
      // `refs/remotes/origin/<name>`, which the letter-case guard does not
      // check and which the upstream-ref resolution prefers. The push above
      // made that tracking ref, so drop it first: a fetch that writes it again
      // would show here.
      await runGit(['-C', root, 'update-ref', '-d', 'refs/remotes/origin/pushed/base'], { cwd: tmpdir() });
      const remoteRefs = async () => (await runGit(
        ['-C', root, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes/'], { cwd: tmpdir() },
      )).stdout;
      const remotesBefore = await remoteRefs();
      expect(await resolveBranchParent(root, 'pushed/base', { LAZY_MANAGED: '1' })).toEqual({ ok: true, fetched: true });
      expect((await runGit(['-C', root, 'rev-parse', '--verify', '--quiet', 'refs/heads/pushed/base'], { cwd: tmpdir() })).exitCode).toBe(0);
      expect(await remoteRefs()).toBe(remotesBefore);
    } finally {
      await rm(side, { recursive: true, force: true });
    }
  });
});
