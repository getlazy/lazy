import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureTaskContainer, type EnsureTaskContainerDeps } from '../../src/daemon/task-container';
import { probeContainerGitPointers } from '../../src/git/container-pointers';
import { validateWorktreeGitPointers } from '../../src/git/worktree-pointers';
import { buildTaskGitMounts } from '../../src/capture/git-mounts';
import type { SandboxConfig } from '../../src/capture/claude';
import type { Runner } from '../../src/runner/types';
import type { Storage } from '../../src/storage';
import {
  ENVIRONMENT_REPLACED_KEY,
  REASON_CHECKOUT_MISSING,
  REASON_RESTART_REQUESTED,
  REASON_TASK_ENV_CHANGED,
  environmentReplacedJournalLine,
} from '../../src/task/environment-replaced';
import type { Task } from '../../src/types';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { pathExists } from '../../src/utils/fs';
import { ensureTaskWorktree } from '../../src/daemon/task-worktree';
import { recordTaskEnvLaunched, setTaskEnv } from '../../src/daemon/task-env';

let root: string;
let worktree: string;
let restoreDaemonBase: () => void;
let task: Task;
let runner: Runner;
let deps: EnsureTaskContainerDeps;
let mountedFiles: Map<string, string>;
let calls: string[];
let messages: string[];
let probeFailure: number | null | Error | undefined;
let containerRunning: boolean;
/** What the fake storage was told: task metadata and journal entries. */
let metadata: Map<string, string>;
let journal: string[];

function git(argv: string[], cwd: string) {
  const result = Bun.spawnSync(['git', ...argv], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'container-recovery-')));
  restoreDaemonBase = pinDaemonBaseDir(join(root, 'daemon-state'));
  git(['init', '-q', '-b', 'main'], root);
  await writeFile(join(root, 'tracked.txt'), 'original\n');
  git(['add', '.'], root);
  git(['commit', '-q', '-m', 'initial'], root);
  worktree = join(root, '.lazy', 'worktrees', 'recover-task');
  git(['worktree', 'add', '-q', '-b', 'lazy/recover-task', worktree], root);
  await writeFile(join(worktree, 'tracked.txt'), 'uncommitted edit\n');
  await writeFile(join(worktree, 'untracked.txt'), 'uncommitted new file\n');
  task = { id: 'recovery-task-id', code: 'recovery', agent_id: 'claude-code', status: 'blocked', metadata: { task_ref: 'recover-task' } } as unknown as Task;
  mountedFiles = new Map();
  const layout = await validateWorktreeGitPointers(root, worktree);
  const mountedDir = join(root, 'mounted-view');
  await mkdir(mountedDir);
  for (const pointer of layout.pointerFiles) {
    const mountedPath = join(mountedDir, pointer.name);
    await writeFile(mountedPath, pointer.content);
    mountedFiles.set(pointer.target, mountedPath);
  }
  calls = [];
  messages = [];
  probeFailure = undefined;
  containerRunning = true;
  runner = {
    type: 'docker',
    usesSandbox: () => true,
    runNameForTask: () => 'lazy-recovery',
    isRunning: async () => containerRunning,
    async execInRun(_name: string, argv: string[]) {
      calls.push('probe');
      if (probeFailure instanceof Error) throw probeFailure;
      if (probeFailure !== undefined) return probeFailure;
      const command = argv.map(argument => mountedFiles.get(argument) ?? argument);
      return Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe' }).exitCode;
    },
    async stopRun() { calls.push('stop'); containerRunning = false; return true; },
    async removeRun() { calls.push('remove'); },
    async launchSupervisor(sandbox: SandboxConfig) {
      calls.push('launch');
      containerRunning = true;
      mountedFiles.delete(worktree);
      const mounts = await buildTaskGitMounts(root, sandbox.worktreePath);
      for (const target of mounts.pointerTargets) {
        const mount = mounts.args.find(argument => argument.endsWith(`:${target}:ro`));
        if (!mount) throw new Error(`Missing read-only pointer mount for ${target}`);
        mountedFiles.set(target, mount.slice(0, -`:${target}:ro`.length));
      }
    },
  } as unknown as Runner;
  metadata = new Map();
  journal = [];
  const storage = {
    resolveTask: async () => ({ task }),
    getSessionByTaskId: async () => null,
    getTaskMetadata: async (_id: string, key: string) => metadata.get(key) ?? null,
    updateTaskMetadata: async (_id: string, key: string, value: string) => { metadata.set(key, value); },
    appendJournalEntry: async (_id: string, content: string) => { journal.push(content); },
  } as unknown as Storage;
  deps = {
    getStorage: async () => storage,
    createRunner: async () => runner,
    setupSandbox: async () => {
      calls.push('prepare');
      return { worktreePath: worktree, sandboxPath: join(worktree, '.lazy-task-sandbox') };
    },
  };
});

afterEach(async () => {
  restoreDaemonBase?.();
  if (root) await rm(root, { recursive: true, force: true });
});

function ensure(restart = false) {
  return ensureTaskContainer(root, { taskId: task.id, restart, notify: message => messages.push(message) }, deps);
}

describe('task container pointer recovery', () => {
  test('recreates a container with fresh mounts after restoring its deleted checkout, without an agent turn', async () => {
    await writeFile(join(root, 'lazy.toml'), '[remote]\noffline = true\n');
    await rm(worktree, { recursive: true });
    expect((await ensure()).alreadyRunning).toBe(false);
    expect(await readFile(join(worktree, 'tracked.txt'), 'utf8')).toBe('original\n');
    expect(task.status).toBe('blocked');
    expect(calls).toEqual(['stop', 'prepare', 'remove', 'launch']);
    expect(messages).toEqual(['Recreating container: its task checkout is missing.', 'Restoring task files…']);
    expect(await probeContainerGitPointers(root, worktree, runner, 'lazy-recovery')).toEqual({ kind: 'healthy' });
  });

  test('a deleted checkout cannot cause an active turn to be stopped or its files replaced', async () => {
    task.status = 'working';
    await rm(worktree, { recursive: true });
    await expect(ensure()).rejects.toMatchObject({ status: 409 });
    expect(await pathExists(worktree)).toBe(false);
    expect(calls).toEqual([]);
    expect(messages).toEqual([]);
  });

  // INVARIANT: `neverLaunch` keeps a running container and otherwise refuses —
  // work for a turn that already ended must not bring up a container nobody asked for.
  test('neverLaunch keeps a running container, and refuses rather than launching or restoring', async () => {
    expect((await ensureTaskContainer(root, { taskId: task.id, neverLaunch: true }, deps)).alreadyRunning).toBe(true);
    containerRunning = false;
    calls.length = 0;
    // INVARIANT: the refusal is worded for a turn that already ended, never as "stop the task first".
    const refused = await ensureTaskContainer(root, { taskId: task.id, neverLaunch: true }, deps).catch((e: Error) => e);
    expect(refused).toMatchObject({ status: 409 });
    expect((refused as Error).message).toContain('not asked for');
    expect((refused as Error).message).not.toContain('lazy stop');
    containerRunning = true;
    await rm(worktree, { recursive: true });
    await expect(ensureTaskContainer(root, { taskId: task.id, neverLaunch: true }, deps)).rejects.toMatchObject({ status: 409 });
    expect(await pathExists(worktree)).toBe(false);
    expect(calls).toEqual([]);
  });

  test('a failed stop leaves the checkout missing so a retry still replaces the stale container', async () => {
    await rm(worktree, { recursive: true });
    const stop = runner.stopRun;
    runner.stopRun = async () => false;
    await expect(ensure()).rejects.toMatchObject({ status: 503 });
    expect(await pathExists(worktree)).toBe(false);
    expect(calls).toEqual([]);
    runner.stopRun = stop;
    expect((await ensure()).alreadyRunning).toBe(false);
    expect(calls).toEqual(['stop', 'prepare', 'remove', 'launch']);
  });

  // INVARIANT: a replacement is recorded on the task only once the old
  // container really stopped. A refused stop (503) replaced nothing, so it
  // leaves no "Container replaced" journal entry and no next-turn notice; the
  // retry that does replace it records the reason once.
  test('a failed stop records no replacement; the successful retry records it once', async () => {
    await writeFile(join(root, 'lazy.toml'), '[remote]\noffline = true\n');
    await rm(worktree, { recursive: true });
    const stop = runner.stopRun;
    runner.stopRun = async () => false;
    await expect(ensure()).rejects.toMatchObject({ status: 503 });
    expect(journal).toEqual([]);
    expect(metadata.get(ENVIRONMENT_REPLACED_KEY)).toBeUndefined();
    runner.stopRun = stop;
    await ensure();
    expect(journal).toEqual([environmentReplacedJournalLine(REASON_CHECKOUT_MISSING)]);
  });

  // INVARIANT: the restore narrates through `restoreProgress` and the launch is
  // announced through `onLaunching` after the files are back, so a caller
  // (Start services) can show them as separate phases in the order they run.
  test('restore and launch are reported through their own hooks, in order', async () => {
    containerRunning = false;
    await writeFile(join(root, 'lazy.toml'), '[remote]\noffline = true\n');
    await rm(worktree, { recursive: true });
    const order: string[] = [];
    const prepare = deps.setupSandbox!;
    deps.setupSandbox = async (...args) => { order.push('prepare'); return prepare(...args); };
    await ensureTaskContainer(root, {
      taskId: task.id,
      notify: m => order.push(`notify:${m}`),
      restoreProgress: m => order.push(`restore:${m}`),
      onLaunching: () => order.push('launching'),
    }, deps);
    expect(order).toEqual(['restore:Restoring task files…', 'launching', 'prepare']);
  });

  test('a healthy running container announces no launch', async () => {
    let launching = false;
    expect((await ensureTaskContainer(root, { taskId: task.id, onLaunching: () => { launching = true; } }, deps)).alreadyRunning).toBe(true);
    expect(launching).toBe(false);
  });
  test('a stopped environment launches fresh mounts after recovering missing files', async () => {
    containerRunning = false;
    await rm(worktree, { recursive: true });
    expect((await ensure()).alreadyRunning).toBe(false);
    expect(calls).toEqual(['prepare', 'remove', 'launch']);
  });

  test.skipIf(process.platform !== 'linux')('recreates a stale directory mount even when a diff already restored the host checkout', async () => {
    const staleMount = join(root, 'stale-mounted-checkout');
    await rename(worktree, staleMount);
    await ensureTaskWorktree(root, task, 'lazy/recover-task');
    mountedFiles.set(worktree, staleMount);
    expect(await probeContainerGitPointers(root, worktree, runner, 'lazy-recovery')).toEqual({ kind: 'broken' });
    calls.length = 0;
    expect((await ensure()).alreadyRunning).toBe(false);
    expect(calls).toEqual(['probe', 'stop', 'prepare', 'remove', 'launch']);
    expect(await readFile(join(worktree, 'tracked.txt'), 'utf8')).toBe('original\n');
    expect(await probeContainerGitPointers(root, worktree, runner, 'lazy-recovery')).toEqual({ kind: 'healthy' });
  });

  test.each(['blocked', 'working'] as const)('healthy mounted pointers reuse a %s container', async status => {
    task.status = status;
    expect((await ensure()).alreadyRunning).toBe(true);
    expect(calls).toEqual(['probe']);
    expect(messages).toEqual([]);
  });

  test.each([0, 1, 2])('a missing mounted pointer %i recreates a paused container and preserves worktree files', async pointerIndex => {
    const layout = await validateWorktreeGitPointers(root, worktree);
    const originals = await Promise.all(layout.pointerFiles.map(pointer => readFile(pointer.target, 'utf8')));
    await rm(mountedFiles.get(layout.pointerFiles[pointerIndex]!.target)!);
    expect((await ensure()).alreadyRunning).toBe(false);
    expect(calls).toEqual(['probe', 'stop', 'prepare', 'remove', 'launch']);
    expect(messages).toEqual(['Recreating container: mounted git pointers or checkout do not match the validated host environment.']);
    expect(await readFile(join(worktree, 'tracked.txt'), 'utf8')).toBe('uncommitted edit\n');
    expect(await readFile(join(worktree, 'untracked.txt'), 'utf8')).toBe('uncommitted new file\n');
    expect(await Promise.all(layout.pointerFiles.map(pointer => readFile(pointer.target, 'utf8')))).toEqual(originals);
    expect(await probeContainerGitPointers(root, worktree, runner, 'lazy-recovery')).toEqual({ kind: 'healthy' });
  });

  test('a confirmed mismatch cannot stop an active turn', async () => {
    task.status = 'working';
    await writeFile(mountedFiles.get(join(worktree, '.git'))!, 'wrong pointer\n');
    await expect(ensure()).rejects.toMatchObject({ status: 409 });
    expect(calls).toEqual(['probe']);
    expect(messages).toEqual([]);
  });

  test('an explicit restart cannot stop an active turn', async () => {
    task.status = 'working';
    await expect(ensure(true)).rejects.toMatchObject({ status: 409 });
    expect(calls).toEqual(['probe']);
  });

  test('host tampering refuses before probing or changing the container', async () => {
    await writeFile(join(worktree, '.git'), 'gitdir: /untrusted\n');
    await expect(ensure()).rejects.toThrow();
    expect(calls).toEqual([]);
    expect(messages).toEqual([]);
  });

  test.each([1, 43, 126, 127, 137, null])('diagnostic exit %s leaves the container untouched', async exitCode => {
    probeFailure = exitCode;
    await expect(ensure()).rejects.toMatchObject({ status: 503 });
    expect(calls).toEqual(['probe']);
    expect(messages).toEqual([]);
  });

  test('a diagnostic exception leaves the container untouched even on explicit restart', async () => {
    probeFailure = new Error('Runtime unavailable');
    await expect(ensure(true)).rejects.toThrow('Runtime unavailable');
    expect(calls).toEqual(['probe']);
    expect(messages).toEqual([]);
  });
});

describe('task container and a changed per-task environment', () => {
  // INVARIANT: Run services / Start container must see the task's CURRENT env. Env is fixed
  // when a container is created, so a running container made before the env changed (a Teams
  // selection push, `lazy env set`) is replaced; reusing it served services stale variables.
  test('a paused container created before the env changed is recreated', async () => {
    await recordTaskEnvLaunched(root, task.id, 'lazy-recovery', {});
    await setTaskEnv(root, task.id, { FEATURE_FLAG: 'on' });
    expect((await ensure()).alreadyRunning).toBe(false);
    expect(calls).toEqual(['probe', 'stop', 'prepare', 'remove', 'launch']);
    expect(messages).toEqual(["Recreating container: the task's environment variables changed since it was created."]);
  });

  // INVARIANT: a container Run services / Start container replaces is named on
  // the TASK — a journal entry for the person, the one-shot line for the agent's
  // next work turn — because whatever was built or installed in it is gone.
  test('a replaced container is named on the task with its reason; a reused one is not', async () => {
    await recordTaskEnvLaunched(root, task.id, 'lazy-recovery', {});
    await setTaskEnv(root, task.id, { FEATURE_FLAG: 'on' });
    await ensure();
    expect(journal).toEqual([environmentReplacedJournalLine(REASON_TASK_ENV_CHANGED)]);
    expect(metadata.get(ENVIRONMENT_REPLACED_KEY)).toBe(REASON_TASK_ENV_CHANGED);

    // What the real launch records (this suite's runner is a fake).
    await recordTaskEnvLaunched(root, task.id, 'lazy-recovery', { FEATURE_FLAG: 'on' });
    await ensure();
    expect(journal).toHaveLength(1);
    await ensure(true);
    expect(journal[1]).toBe(environmentReplacedJournalLine(REASON_RESTART_REQUESTED));
  });

  // INVARIANT: replacing a container would kill a running turn, so a working task keeps it;
  // that turn's own next launch recreates it.
  test('a working task keeps its container', async () => {
    task.status = 'working';
    await recordTaskEnvLaunched(root, task.id, 'lazy-recovery', {});
    await setTaskEnv(root, task.id, { FEATURE_FLAG: 'on' });
    expect((await ensure()).alreadyRunning).toBe(true);
    expect(calls).toEqual(['probe']);
  });

  test('an unchanged env reuses the container', async () => {
    await setTaskEnv(root, task.id, { FEATURE_FLAG: 'on' });
    await recordTaskEnvLaunched(root, task.id, 'lazy-recovery', { FEATURE_FLAG: 'on' });
    expect((await ensure()).alreadyRunning).toBe(true);
  });
});

// INVARIANT: an external stop is evidence of an exit, not lost files.
// Run services must report replacement only when it cannot keep the environment.
describe('Run services after an external stop', () => {
  for (const starts of [true, false]) {
    test(starts ? 'starts in place without a loss notice' : 'an unstartable container still records replacement', async () => {
      containerRunning = false;
      const storage = await deps.getStorage!();
      storage.getSessionByTaskId = async () => ({ id: 'session', task_id: task.id, container_name: 'lazy-recovery', container_agent_id: 'claude-code', runner_type: 'docker' }) as any;
      storage.updateSessionContainerName = async () => {};
      runner.getRunInfo = async () => ({ running: false, exitCode: 137, oomKilled: true, finishedAt: '2026-10-23T10:00:00Z' });
      runner.startStoppedRun = async () => { calls.push('start'); containerRunning = starts; return starts; };
      const result = await ensure();
      expect(result.alreadyRunning).toBe(false);
      expect(journal[0]).toContain('Container stopped');
      expect(journal[0]).toContain('code 137');
      expect(journal[0]).toContain('OOM-killed');
      if (starts) {
        expect(calls).not.toContain('remove');
        expect(calls).not.toContain('launch');
        expect(metadata.get(ENVIRONMENT_REPLACED_KEY)).toBeFalsy();
        expect(metadata.get('last_environment_replaced')).toBeFalsy();
        expect(journal).toHaveLength(1);
      } else {
        expect(calls).toContain('remove');
        expect(calls).toContain('launch');
        expect(metadata.get(ENVIRONMENT_REPLACED_KEY)).toContain('code 137');
        expect(journal[1]).toContain('Container replaced');
      }
    });
  }
  test('a genuinely missing recorded container still produces a loss notice', async () => {
    containerRunning = false;
    const storage = await deps.getStorage!();
    storage.getSessionByTaskId = async () => ({ id: 'session', task_id: task.id, container_name: 'lazy-recovery', container_agent_id: 'claude-code', runner_type: 'docker' }) as any;
    storage.updateSessionContainerName = async () => {};
    runner.getRunInfo = async () => null;
    runner.startStoppedRun = async () => false;
    await ensure();
    expect(calls).toContain('launch');
    expect(metadata.get(ENVIRONMENT_REPLACED_KEY)).toContain('disappeared');
    expect(journal).toHaveLength(1);
    expect(journal[0]).toContain('Container replaced');
  });

  // INVARIANT: Run services can create a container before the first turn.
  // That environment's loss is still recorded even though there is no session.
  for (const starts of [true, false]) {
    test('services before the first session: ' + (starts ? 'keeps the stopped environment' : 'reports its replacement'), async () => {
      containerRunning = false;
      runner.getRunInfo = async () => ({ running: false, exitCode: 137, oomKilled: true, finishedAt: '2026-10-23T10:00:00Z' });
      runner.startStoppedRun = async () => { containerRunning = starts; return starts; };
      expect(await (await deps.getStorage!()).getSessionByTaskId(task.id)).toBeNull();
      await ensure();
      expect(journal[0]).toContain('Container stopped');
      if (starts) {
        expect(calls).not.toContain('remove');
        expect(metadata.get(ENVIRONMENT_REPLACED_KEY)).toBeFalsy();
        expect(journal).toHaveLength(1);
      } else {
        expect(calls).toContain('remove');
        expect(calls).toContain('launch');
        expect(metadata.get(ENVIRONMENT_REPLACED_KEY)).toContain('code 137');
        expect(metadata.get('last_environment_replaced')).toContain('code 137');
        expect(metadata.get('observed_environment_exit')).toBeFalsy();
        expect(journal[1]).toContain('Container replaced');
      }
    });
  }

});
