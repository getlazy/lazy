/** The runtime is the only fake: launch teardown, inspect parsing and storage
 * are real. Real Docker death/relaunch coverage is in the companion suite.
 * Tests set their own one-minute timeout; setup and cleanup allow two minutes.
 * No command-line --timeout override is needed.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { installFakeDocker } from '../helpers/fake-docker';
import { hardwareTestEnv } from '../helpers/hardware-env';
import { DockerRunner } from '../../src/runner/docker-runner';
import { FileStorage } from '../../src/storage';
import { removeTaskRun } from '../../src/runner/session-launch';
import { environmentReplacedPrefix, clearEnvironmentReplaced, LAST_ENVIRONMENT_REPLACED_KEY } from '../../src/task/environment-replaced';

let root: string;
let storage: FileStorage;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'exited-container-relaunch-'));
  storage = new FileStorage(root, { basePath: join(root, 'store') });
  await storage.initialize();
}, 120_000);
afterEach(async () => { await storage.close(); await rm(root, { recursive: true, force: true }); }, 120_000);

describe('launch after a runtime killed the container', () => {
  // INVARIANT: exit deduplication belongs to one environment. A replacement
  // that disappears before any live probe still needs its own durable notice.
  test('a replacement disappearing immediately records a fresh loss', async () => {
    const docker = await installFakeDocker(join(root, 'runtime'));
    const runner = new DockerRunner(join(docker.binDir, 'docker'));
    const task = await storage.createTask('Explain every lost environment');
    const session = await storage.createSession(task.id, 'claude-code', 'lazy/test', 'base');
    const name = 'lazy-repeated-loss';
    await storage.updateSessionContainerName(session.id, name, 'claude-code');
    await docker.seedContainer(name, { state: 'running', id: 'first-container' });
    await docker.crash(name, 137, 'Killed externally');
    await removeTaskRun(runner, storage, (await storage.getSessionByTaskId(task.id))!, name);
    expect(await storage.getTaskJournal(task.id)).toHaveLength(1);
    await clearEnvironmentReplaced(storage, task.id);

    await docker.seedContainer(name, { state: 'running', id: 'replacement-container' });
    await storage.updateSessionContainerName(session.id, name, 'claude-code');
    // No live probe: it vanishes before the daemon sees the new environment.
    await runner.removeRun(name);
    await removeTaskRun(runner, storage, (await storage.getSessionByTaskId(task.id))!, name);
    expect(await storage.getTaskJournal(task.id)).toHaveLength(2);
    expect(await environmentReplacedPrefix(storage, task.id)).toContain('previous environment disappeared');
    expect(await storage.getTaskMetadata(task.id, LAST_ENVIRONMENT_REPLACED_KEY)).toContain('previous environment disappeared');
  }, 60_000);

  // INVARIANT: removal is the final chance to capture runtime evidence. Every
  // launch teardown shares this path, including a services-only launch in Teams.
  test('exit evidence reaches the task journal and the next work prompt before the old environment is removed', async () => {
    const docker = await installFakeDocker(join(root, 'runtime'));
    const runner = new DockerRunner(join(docker.binDir, 'docker'));
    const task = await storage.createTask('Keep the explanation');
    const session = await storage.createSession(task.id, 'claude-code', 'lazy/test', 'base');
    const name = 'lazy-lifetime-test';
    await storage.updateSessionContainerName(session.id, name, 'claude-code');
    await docker.seedContainer(name, { state: 'running', id: 'old-container' });
    // The external runtime kills it, rather than a turn-launch recreate predicate.
    await docker.crash(name, 137, 'Killed externally');
    const previous = (await storage.getSessionByTaskId(task.id))!;
    await removeTaskRun(runner, storage, previous, name);
    expect(await docker.containers()).not.toContain(name);
    const prefix = await environmentReplacedPrefix(storage, task.id);
    expect(prefix).toContain('code 137');
    expect(prefix).toContain('2026-09-27T12:00:00Z');
    const journal = await storage.getTaskJournal(task.id);
    expect(journal).toHaveLength(1);
    expect(journal[0].content).toContain('code 137');
    // The next launch starts fresh, and passing its notice to work does not
    // erase the persistent fact Teams displays.
    const start = Bun.spawn([join(docker.binDir, 'docker'), 'run', '-d', '--name', name, 'image', 'sh', '-c', 'true'], { env: hardwareTestEnv(), stdout: 'ignore', stderr: 'pipe' });
    expect(await start.exited).toBe(0);
    expect(await runner.isRunning(name)).toBe(true);
    await clearEnvironmentReplaced(storage, task.id);
    expect(await storage.getTaskMetadata(task.id, LAST_ENVIRONMENT_REPLACED_KEY)).toContain('code 137');
  }, 60_000);
});
