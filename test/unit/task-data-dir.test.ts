/**
 * The per-task persistent data directory ($LAZY_TASK_DATA, src/runner/task-data.ts).
 *
 * INVARIANT: every task container — the turns' container and a member's —
 * mounts ONE named volume per task at /lazy/data, named by the task's UUID, so
 * a recreated container, a restarted daemon or a new image finds the same data
 * and no other project's task of the same code ever shares it. Removing or
 * recreating the CONTAINER never removes the volume; only a terminal teardown
 * (or a person's finished-task cleanup) does. Lazy never chowns its contents:
 * the only ownership change is the top directory of a freshly created,
 * root-owned volume.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSupervisorDockerArgs, buildSupervisorWrapperScript } from '../../src/capture/claude';
import { DockerRunner } from '../../src/runner/docker-runner';
import { reuseOrStartTaskRun } from '../../src/runner/start-or-recreate';
import { TASK_DATA_MOUNT, claimTaskDataDirShell, taskDataMountArgs, taskDataVolumeName } from '../../src/runner/task-data';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';
import type { Storage } from '../../src/storage';

const UUID = '0b6f6a52-2d0e-4c55-9a43-1f1e0f8f6a01';

function supervisorArgs(taskData?: { volume: string; readOnly: boolean }): string[] {
  return buildSupervisorDockerArgs({
    binary: 'docker', containerName: 'lazy-t1', imageName: 'img', repoRoot: '/r',
    sandbox: { worktreePath: '/r/.lazy/worktrees/t1', sandboxPath: '/r/.lazy/worktrees/t1/.lazy-task-sandbox' } as never,
    protocolDir: '/p/t1', agentBinaryPath: '/bin/lazy-agent', authEnvVars: [], taskEnvArgs: ['-e', 'LAZY_TASK_DATA=/elsewhere'],
    customMountArgs: [], gitMountArgs: [], publishArgs: [], runArgs: [], wrapperScript: 'true',
    ...(taskData ? { taskData } : {}),
  });
}

describe('mount', () => {
  test('one volume per task, named by its UUID — never by its code, which another project may share', () => {
    expect(taskDataVolumeName(UUID)).toBe(`lazy-data-${UUID}`);
    expect(taskDataVolumeName(UUID)).not.toContain('lazy-t1');
  });

  test('the turns container mounts it at /lazy/data, labelled, announced last-wins over the task env', () => {
    const args = supervisorArgs({ volume: taskDataVolumeName(UUID), readOnly: false });
    expect(args).toContain(`type=volume,src=lazy-data-${UUID},dst=/lazy/data`);
    expect(args).toContain('lazy.task-data=1');
    const envs = args.flatMap((a, i) => (args[i - 1] === '-e' ? [a] : [])).filter((e) => e.startsWith('LAZY_TASK_DATA='));
    expect(envs.at(-1)).toBe(`LAZY_TASK_DATA=${TASK_DATA_MOUNT}`);
  });

  test('a side run (review) mounts it read-only', () => {
    expect(supervisorArgs({ volume: 'v', readOnly: true })).toContain('type=volume,src=v,dst=/lazy/data,readonly');
  });

  test('never a bind mount of a host path: the engine owns it, not the worktree', () => {
    expect(taskDataMountArgs('v')[1]).toStartWith('type=volume,');
  });
});

describe('claim of a fresh volume', () => {
  const asRoot = process.getuid?.() === 0;
  test.skipIf(asRoot)('touches nothing when the directory is not root-owned', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lzd-data-'));
    try {
      const log = join(dir, 'sudo.log');
      await writeFile(join(dir, 'sudo'), `#!/bin/sh\necho "$@" >> "${log}"\n`);
      await chmod(join(dir, 'sudo'), 0o755);
      const script = claimTaskDataDirShell().replaceAll(TASK_DATA_MOUNT, dir);
      const p = Bun.spawn(['sh', '-c', script], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
      expect(await p.exited).toBe(0);
      expect(await readFile(log, 'utf8').catch(() => '')).toBe('');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('is never recursive, and runs in the PID-1 wrapper before any turn', () => {
    expect(claimTaskDataDirShell()).not.toContain('-R');
    expect(claimTaskDataDirShell()).not.toContain('find');
    const w = buildSupervisorWrapperScript('/p', '/w', ['/w']);
    expect(w.indexOf(claimTaskDataDirShell())).toBeGreaterThan(-1);
    expect(w.indexOf(claimTaskDataDirShell())).toBeLessThan(w.indexOf('lazy-agent --one-shot'));
  });
});

describe('lifetime', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    restoreMockedModules();
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  /** A fake engine that logs every argv; `inspect` answers with `label`, or fails when null. */
  async function fakeEngine(label: string | null = null): Promise<{ bin: string; calls: () => Promise<string[]> }> {
    const dir = await mkdtemp(join(tmpdir(), 'lzd-engine-'));
    dirs.push(dir);
    const log = join(dir, 'calls.log');
    const inspect = label === null ? 'echo "Error: No such object" >&2; exit 1' : `echo "${label}"; exit 0`;
    await writeFile(join(dir, 'docker'), `#!/bin/sh\necho "$*" >> "${log}"\ncase "$1" in inspect) ${inspect};; ps) exit 0;; esac\nexit 0\n`);
    await chmod(join(dir, 'docker'), 0o755);
    return { bin: join(dir, 'docker'), calls: async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean) };
  }

  test('recreating (removing) the container keeps the data volume', async () => {
    const engine = await fakeEngine();
    await new DockerRunner(engine.bin).removeRun('lazy-t1');
    const calls = await engine.calls();
    expect(calls).toContain('rm -f lazy-t1');
    expect(calls.some((c) => c.startsWith('volume'))).toBe(false);
  });

  // INVARIANT: upgrading never recreates a kept environment for its layout.
  // Installed packages and running services belong to the person until they restart it.
  test('a kept container without the layout label is reused, just like a labelled one', async () => {
    const storage = { updateSessionContainerName: async () => {} } as never;
    const session = { id: 's', container_name: 'lazy-t1', container_agent_id: 'claude-code' };
    const old = new DockerRunner((await fakeEngine('<no value>')).bin);
    const reuse = { isRunning: async () => true };
    expect(await reuseOrStartTaskRun({ ...reuse, lacksCurrentLayout: (n) => old.lacksCurrentLayout(n) }, storage, session, 'lazy-t1', false, 'claude-code')).toBe('reused');
    const current = new DockerRunner((await fakeEngine('1')).bin);
    expect(await reuseOrStartTaskRun({ ...reuse, lacksCurrentLayout: (n) => current.lacksCurrentLayout(n) }, storage, session, 'lazy-t1', false, 'claude-code')).toBe('reused');
  });

  test('a stopped old environment is started again with its state intact', async () => {
    let started = false;
    const runner = {
      isRunning: async () => false,
      startStoppedRun: async () => { started = true; return true; },
      lacksCurrentLayout: async () => true,
    };
    expect(await reuseOrStartTaskRun(runner, { updateSessionContainerName: async () => {} } as never,
      null, 'lazy-old', false, 'claude-code')).toBe('started');
    expect(started).toBe(true);
  });

  test('the terminal teardown removes the container first, then the task volume by UUID', async () => {
    const engine = await fakeEngine();
    const runner = new DockerRunner(engine.bin);
    const runnerPath = resolve(import.meta.dir, '../../src/runner/index.ts');
    const real = await import(runnerPath);
    await mockModule(runnerPath, () => ({ ...real, createRunner: async () => runner }));
    const { cleanupTaskContainer } = await import('../../src/task/cleanup');
    const storage = { updateSessionContainerName: async () => {} } as unknown as Storage;
    await cleanupTaskContainer(storage, { id: 's', task_id: UUID, container_name: 'lazy-t1' }, 't1', '/nonexistent');
    const calls = await engine.calls();
    expect(calls.indexOf('rm -f lazy-t1')).toBeGreaterThan(-1);
    expect(calls.indexOf('rm -f lazy-t1')).toBeLessThan(calls.indexOf(`volume rm lazy-data-${UUID}`));
  });
});
