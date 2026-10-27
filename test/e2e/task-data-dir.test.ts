/**
 * The task data directory ($LAZY_TASK_DATA) across a task's lifetime, against
 * the fake container runtime (test/helpers/fake-docker.ts): the runtime is the
 * only fake — the runner, the reuse/recreate decision, storage and the
 * terminal teardown are real. No real engine runs in the agent container, so
 * a real Docker/microVM run is still owed (see docs/task-data-dir.md).
 *
 * INVARIANT: the data volume is touched by exactly one thing — the task's
 * terminal teardown. An explicitly requested recreate, a daemon restart (which stops
 * only the agent) and a container stop never remove it; a launch after any of
 * them mounts the SAME volume.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { installFakeDocker, type FakeDocker } from '../helpers/fake-docker';
import { DockerRunner } from '../../src/runner/docker-runner';
import { FileStorage } from '../../src/storage';
import { reuseOrStartTaskRun } from '../../src/runner/start-or-recreate';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';
import { buildSupervisorDockerArgs } from '../../src/capture/claude';
import { taskDataVolumeName } from '../../src/runner/task-data';

let root: string;
let storage: FileStorage;
let docker: FakeDocker;
let previousPath: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'task-data-dir-'));
  storage = new FileStorage(root, { basePath: join(root, 'store') });
  await storage.initialize();
  docker = await installFakeDocker(join(root, 'runtime'));
  // cleanupTaskContainer builds its runner by type; the fake answers as `docker`.
  previousPath = process.env.PATH;
  process.env.PATH = `${docker.binDir}:${process.env.PATH}`;
}, 120_000);

afterEach(async () => {
  restoreMockedModules();
  process.env.PATH = previousPath;
  await storage.close();
  await rm(root, { recursive: true, force: true });
}, 120_000);

/** The launch argv for this task, as launchSupervisorAsync builds it. */
function launchArgs(taskUuid: string): string[] {
  return buildSupervisorDockerArgs({
    binary: 'docker', containerName: 'lazy-keep-data', imageName: 'img', repoRoot: root,
    sandbox: { worktreePath: join(root, 'wt'), sandboxPath: join(root, 'wt', '.lazy-task-sandbox') } as never,
    protocolDir: join(root, 'proto'), agentBinaryPath: '/bin/lazy-agent', authEnvVars: [], taskEnvArgs: [],
    customMountArgs: [], gitMountArgs: [], publishArgs: [], runArgs: [], wrapperScript: 'true',
    taskData: { volume: taskDataVolumeName(taskUuid), readOnly: false },
  });
}

const volumeCalls = async () => (await docker.invocations()).filter((c) => c.startsWith('volume rm'));

describe('the data volume across recreate, daemon restart and task end', () => {
  test('reuses an old environment and preserves data until terminal teardown', async () => {
    const runner = new DockerRunner('docker');
    const task = await storage.createTask('Keep the database');
    const session = await storage.createSession(task.id, 'claude-code', 'lazy/keep', 'base');
    const name = 'lazy-keep-data';
    await storage.updateSessionContainerName(session.id, name, 'claude-code');
    expect(launchArgs(task.id)).toContain(`type=volume,src=${taskDataVolumeName(task.id)},dst=/lazy/data`);
    const runnerPath = resolve(import.meta.dir, '../../src/runner/index.ts');
    const real = await import(runnerPath);
    await mockModule(runnerPath, () => ({ ...real, createRunner: async () => runner }));
    const { taskDataView } = await import('../../src/daemon/task-data-view');
    const { checkOldTaskEnvironments } = await import('../../src/doctor/sweep');
    const { taskPageHtml } = await import('../../src/server/task-page');

    // INVARIANT: an upgrade preserves the old environment until a person restarts it.
    await docker.seedContainer(name, { state: 'running' });
    await writeFile(join(docker.stateDir, `old-layout-${name}`), '1');
    expect(await reuseOrStartTaskRun(runner, storage, (await storage.getSessionByTaskId(task.id))!, name, false, 'claude-code')).toBe('reused');
    expect(await runner.lacksCurrentLayout(name)).toBe(true);
    const oldView = await taskDataView(root, task, await storage.getSessionByTaskId(task.id));
    expect(oldView.restartAvailable).toBe(true);
    expect(oldView.notice).toContain("A restart loses anything installed outside the worktree");
    const doctor = await checkOldTaskEnvironments(storage, root);
    expect(doctor.warning).toContain(oldView.notice!);
    expect(doctor.warning).toContain(task.id.substring(0, 8));
    const page = taskPageHtml({
      task, session: null, turns: [], commits: [], comments: [], journal: [], raisedItems: [],
      children: [], promptVersions: [], tab: 'services', taskData: oldView,
    });
    expect(page).toContain('Restart environment');
    expect(page).toContain('/container/start?restart=true');
    expect(page).toContain("This environment was created before lazy");

    expect((await docker.invocations()).some((c) => c.startsWith('rm '))).toBe(false);
    // Explicit restart through the daemon and real launcher is covered by
    // task-data-restart.test.ts; this test owns reuse and terminal teardown.
    // A daemon restart stops the agent, never the container or its data.
    await runner.stopAgentInRun(name).catch(() => undefined);
    await runner.stopRun(name);
    expect(await volumeCalls()).toEqual([]);

    // Task end: the terminal teardown removes the container, then the volume.
    // Its runner is the real DockerRunner over the fake runtime; createRunner
    // itself needs a live daemon's proxy, which this suite does not start.
    const { cleanupTaskContainer } = await import('../../src/task/cleanup');
    await cleanupTaskContainer(storage, { ...(await storage.getSessionByTaskId(task.id))!, runner_type: 'docker' }, 'keep', root);
    expect(await volumeCalls()).toEqual([`volume rm ${taskDataVolumeName(task.id)}`]);
  }, 60_000);
});

describe('an environment kept across an upgrade', () => {
  async function setup(goal: string, name: string) {
    const runner = new DockerRunner('docker');
    const task = await storage.createTask(goal);
    const session = await storage.createSession(task.id, 'claude-code', 'lazy/keep', 'base');
    await storage.updateSessionContainerName(session.id, name, 'claude-code');
    const runnerPath = resolve(import.meta.dir, '../../src/runner/index.ts');
    const real = await import(runnerPath);
    await mockModule(runnerPath, () => ({ ...real, createRunner: async () => runner }));
    const { taskDataView } = await import('../../src/daemon/task-data-view');
    const { OUTDATED_IMAGE_ENVIRONMENT_NOTICE } = await import('../../src/runner/task-data');
    await docker.seedContainer(name, { state: 'running' });
    await writeFile(join(docker.stateDir, `image-of-${name}`), 'sha256:old\n');
    const view = async () => taskDataView(root, (await storage.getTask(task.id))!, await storage.getSessionByTaskId(task.id));
    return { runner, task, view, OUTDATED_IMAGE_ENVIRONMENT_NOTICE };
  }

  // INVARIANT: a container still on an older image than the task's next
  // launch would use offers the same restart as an old-layout one — a full
  // `lazy upgrade` keeps running containers, so this notice is how a person
  // learns a restart would bring the new image. The comparison is against the
  // image the next launch RESOLVES (a new version tag, a changed Dockerfile's
  // new name), never only the container's own tag.
  test('offers a restart once the project image is a newer build, under a new tag', async () => {
    const { resolveImageName } = await import('../../src/capture/claude');
    const { view, OUTDATED_IMAGE_ENVIRONMENT_NOTICE } = await setup('Keep my tools', 'lazy-keep-image');
    const expected = await resolveImageName(root);
    await docker.seedImage(expected, { id: 'sha256:old' });
    expect((await view()).restartAvailable).toBe(false);

    await docker.seedImage(expected, { id: 'sha256:new' });
    const behind = await view();
    expect(behind.restartAvailable).toBe(true);
    expect(behind.notice).toBe(OUTDATED_IMAGE_ENVIRONMENT_NOTICE);
    const { checkOldTaskEnvironments } = await import('../../src/doctor/sweep');
    expect((await checkOldTaskEnvironments(storage, root)).warning).toContain(OUTDATED_IMAGE_ENVIRONMENT_NOTICE);
    expect((await docker.invocations()).some((c) => c.startsWith('rm '))).toBe(false);
  }, 60_000);

  test('compares a pinned task against its pin', async () => {
    const { CUSTOM_IMAGE_META_KEY } = await import('../../src/docker/worktree-image');
    const { task, view } = await setup('Keep my pinned tools', 'lazy-keep-pin');
    await storage.updateTaskMetadata(task.id, CUSTOM_IMAGE_META_KEY, 'lazy-custom-abc:9.9');
    await docker.seedImage('lazy-custom-abc:9.9', { id: 'sha256:new' });
    expect((await view()).restartAvailable).toBe(true);
    await docker.seedImage('lazy-custom-abc:9.9', { id: 'sha256:old' });
    expect((await view()).restartAvailable).toBe(false);
  }, 60_000);
});
