/**
 * Run services on a task whose environment is down AND whose checkout is gone,
 * end to end through the REAL bring-up: runStartServices → ensureTaskContainer
 * → the worktree restore (a slow, LFS-like smudge filter, as in
 * worktree-restore-lfs.test.ts) → a container launch. Only the container
 * runner and the in-container exec are stand-ins; everything that decides what
 * the phases say is real.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, realpath, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { runStartServices } from '../../src/daemon/serve-run';
import { ensureTaskContainer, type EnsureTaskContainerDeps } from '../../src/daemon/task-container';
import type { ProgressEvent, ProgressPhaseEvent } from '../../src/daemon/progress';
import type { Runner } from '../../src/runner/types';
import type { Storage } from '../../src/storage';
import type { Task } from '../../src/types';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';

const dirs: string[] = [];
let restoreBase: (() => void) | undefined;

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (await proc.exited !== 0) throw new Error(`git ${args.join(' ')}: ${await new Response(proc.stderr).text()}`);
}

afterEach(async () => {
  restoreBase?.();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('Run services with the environment down and the task files missing', () => {
  // INVARIANT: the restore's OWN progress lines reach serve.run's "Restore
  // task files" phase, and the phases run restore → environment → services.
  // A restore that takes minutes must never be a silent wait in Teams.
  test('restores the files with progress, starts the environment, then the services', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'lazy-serve-restore-')));
    dirs.push(root);
    restoreBase = pinDaemonBaseDir(join(root, 'daemon-state'));
    await git(root, 'init', '-q', '-b', 'main');
    await mkdir(join(root, 'datasets'));
    for (let i = 0; i < 4; i++) await writeFile(join(root, 'datasets', `f${i}.sqlite`), `payload ${i}\n`);
    await writeFile(join(root, '.gitattributes'), 'datasets/*.sqlite filter=slowlfs\n');
    await writeFile(join(root, 'lazy.toml'), '[remote]\noffline = true\n');
    await git(root, 'add', '-A');
    await git(root, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init');
    await git(root, 'branch', 'lazy/slow');
    await git(root, 'config', 'filter.slowlfs.smudge', 'sleep 1; cat');
    await git(root, 'config', 'filter.slowlfs.clean', 'cat');
    await mkdir(join(root, '.lazy'), { recursive: true });

    const task = { id: 'abcdef1234567890', code: 'slow', status: 'blocked', agent_id: 'claude-code', metadata: { task_ref: 'slow' } } as unknown as Task;
    const storage = {
      resolveTask: async () => ({ task }),
      getSessionByTaskId: async () => null,
      // A replacement launch retires the removed environment's exit fingerprints.
      updateTaskMetadata: async () => {},
    } as unknown as Storage;
    let running = false;
    const launched: string[] = [];
    const runner = {
      type: 'docker',
      usesSandbox: () => true,
      runNameForTask: () => 'lazy-slow',
      isRunning: async () => running,
      async stopRun() { running = false; return true; },
      async removeRun() {},
      async launchSupervisor() { launched.push('launch'); running = true; },
    } as unknown as Runner;
    const deps: EnsureTaskContainerDeps = {
      getStorage: async () => storage,
      createRunner: async () => runner,
      setupSandbox: async (worktreePath) => ({ worktreePath, sandboxPath: join(worktreePath, '.lazy-task-sandbox') }) as never,
    };

    const events: ProgressEvent[] = [];
    const result = await runStartServices(root, { taskId: 'slow' }, {
      getStorage: async () => storage,
      resolveCmd: async () => 'bin/dev',
      progress: (e) => events.push(e),
      ensureContainer: (projectRoot, params) => ensureTaskContainer(projectRoot, params, deps),
      exec: async () => ({ exitCode: 0, stdout: 'running\nListening\n', stderr: '' }),
    });

    expect(result.containerStarted).toBe(true);
    expect(launched).toEqual(['launch']);
    expect(await readFile(join(root, '.lazy', 'worktrees', 'slow', 'datasets', 'f3.sqlite'), 'utf8')).toBe('payload 3\n');
    const phases = events.filter((e): e is ProgressPhaseEvent => e.kind === 'phase');
    const order = phases.map(e => `${e.id}:${e.state}`).filter((s, i, a) => !(s.endsWith(':progress') && a[i - 1] === s));
    expect(order[0]).toBe('restore-files:start');
    expect(order).toContain('restore-files:progress');
    expect(order.slice(-5)).toEqual(['restore-files:done', 'environment:start', 'environment:done', 'services:start', 'services:done']);
    expect(phases[0]!.detail).toBe('Restoring task files…');
    // The restore's own words: git's checkout progress, parsed by the restore.
    expect(phases.some(e => e.id === 'restore-files' && e.state === 'progress' && /^Checking out files: \d+\/\d+ \(\d+%\)$/.test(e.detail ?? ''))).toBe(true);
  }, 60_000);
});
