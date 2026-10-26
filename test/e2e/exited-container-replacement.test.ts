/** The runtime is the only fake: launch teardown, inspect parsing and storage
 * are real. Real Docker death/relaunch coverage is in the companion suite.
 * Tests set their own one-minute timeout; setup and cleanup allow two minutes.
 * No command-line --timeout override is needed.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { installFakeDocker } from '../helpers/fake-docker';
import { hardwareTestEnv } from '../helpers/hardware-env';
import { DockerRunner } from '../../src/runner/docker-runner';
import { FileStorage } from '../../src/storage';
import { removeTaskRun } from '../../src/runner/session-launch';
import { recordContainerBeforeLaunch, environmentReplacedPrefix, clearEnvironmentReplaced, LAST_ENVIRONMENT_REPLACED_KEY } from '../../src/task/environment-replaced';

import { writeCommand, type UnblockCommand } from '../../src/protocol';
import { refreshEnvironmentReplacedCommand } from '../../src/daemon/environment-replaced-command';
import { reuseOrStartTaskRun } from '../../src/runner/start-or-recreate';

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

// INVARIANT: observing a stopped environment never implies lost files. Both
// work launches and Run services preserve the evidence before trying a start.
describe('a stopped environment can be kept', () => {
  for (const outcome of ['started', 'unstartable', 'missing'] as const) {
    test(outcome + ': exit evidence and loss notices stay distinct', async () => {
      const docker = await installFakeDocker(join(root, 'runtime'));
      const runner = new DockerRunner(join(docker.binDir, 'docker'));
      const task = await storage.createTask('Keep tools after an external stop');
      await storage.createSession(task.id, 'claude-code', 'lazy/test', 'base');
      const name = 'lazy-kept-exit';
      const containerId = 'same-container';
      await storage.updateSessionContainerName((await storage.getSessionByTaskId(task.id))!.id, name, 'claude-code');
      if (outcome !== 'missing') {
        await docker.seedContainer(name, { state: 'running', id: containerId });
        await writeFile(join(docker.stateDir, 'kept-' + name), '1');
        await docker.crash(name, 137, 'Killed externally');
      }
      if (outcome === 'unstartable') await writeFile(join(docker.stateDir, 'fail-start'), '1');
      const session = (await storage.getSessionByTaskId(task.id))!;
      await recordContainerBeforeLaunch(storage, task.id, null, runner, name);
      await recordContainerBeforeLaunch(storage, task.id, null, runner, name);
      expect(await storage.getTaskJournal(task.id)).toHaveLength(1);
      if (outcome !== 'missing') {
        expect(await environmentReplacedPrefix(storage, task.id)).toBe('');
        expect(await storage.getTaskMetadata(task.id, LAST_ENVIRONMENT_REPLACED_KEY)).toBeFalsy();
        expect((await storage.getTaskJournal(task.id))[0].content).toContain('code 137');
      }
      let envNotice = await environmentReplacedPrefix(storage, task.id);
      const command = { type: 'unblock', task_id: task.id, command_id: 'replacement-turn', prompt: envNotice + 'Keep this feedback' } as UnblockCommand;
      const protoDir = join(root, 'protocol');
      writeCommand(protoDir, command);
      const kept = await reuseOrStartTaskRun(runner, storage, session, name, false, 'claude-code');
      if (outcome === 'started') {
        expect(kept).toBe('started');
        expect(await runner.isRunning(name)).toBe(true);
        expect(await environmentReplacedPrefix(storage, task.id)).toBe('');
        expect(await storage.getTaskMetadata(task.id, LAST_ENVIRONMENT_REPLACED_KEY)).toBeFalsy();
        expect(await docker.containers()).toContain(name);
        expect(await runner.runExists(name)).toBe(true);
        expect(await readFile(join(docker.stateDir, 'containers.tsv'), 'utf8')).toContain(containerId);
      } else {
        expect(kept).toBeNull();
        await removeTaskRun(runner, storage, session, name);
        envNotice = await refreshEnvironmentReplacedCommand(storage, protoDir, command, envNotice);
        const dispatched = JSON.parse(await readFile(join(protoDir, 'command.json'), 'utf8'));
        expect(dispatched.prompt).toContain(outcome === 'missing' ? 'disappeared' : 'code 137');
        expect(dispatched.prompt).toEndWith('Keep this feedback');
        expect(dispatched.prompt.split('Your environment was replaced')).toHaveLength(2);
        expect(dispatched.command_id).toBe('replacement-turn');
        expect(await environmentReplacedPrefix(storage, task.id)).toContain(outcome === 'missing' ? 'disappeared' : 'code 137');
        expect(await storage.getTaskMetadata(task.id, LAST_ENVIRONMENT_REPLACED_KEY)).toBeTruthy();
      }
    }, 60_000);
  }
});

// INVARIANT: the task owns its services environment even before it has a
// session. Replacement history and pending notices cannot depend on a turn.
describe('services containers created before the first session', () => {
  for (const starts of [true, false]) {
    test(starts ? 'keeps the environment without a loss notice' : 'records loss before replacing an unstartable environment', async () => {
      const docker = await installFakeDocker(join(root, 'runtime'));
      const runner = new DockerRunner(join(docker.binDir, 'docker'));
      const task = await storage.createTask('Run services before starting work');
      const name = 'lazy-services-only';
      expect(await storage.getSessionByTaskId(task.id)).toBeNull();
      await docker.seedContainer(name, { state: 'running', id: 'services-container' });
      await writeFile(join(docker.stateDir, 'kept-' + name), '1');
      await docker.crash(name, 137, 'Killed externally');
      if (!starts) await writeFile(join(docker.stateDir, 'fail-start'), '1');
      await recordContainerBeforeLaunch(storage, task.id, null, runner, name);
      const kept = await reuseOrStartTaskRun(runner, storage, null, name, false, 'claude-code');
      if (starts) {
        expect(kept).toBe('started');
        expect(await environmentReplacedPrefix(storage, task.id)).toBe('');
        expect(await storage.getTaskJournal(task.id)).toHaveLength(1);
      } else {
        expect(kept).toBeNull();
        await removeTaskRun(runner, storage, null, name, task.id);
        expect(await environmentReplacedPrefix(storage, task.id)).toContain('code 137');
        expect(await storage.getTaskMetadata(task.id, LAST_ENVIRONMENT_REPLACED_KEY)).toContain('code 137');
        expect(await storage.getTaskMetadata(task.id, 'observed_environment_exit')).toBeFalsy();
        expect((await storage.getTaskJournal(task.id))[1].content).toContain('Container replaced');
        expect(await docker.containers()).not.toContain(name);
      }
    }, 60_000);
  }
});
