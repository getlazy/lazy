/** Layout notices and data reads follow the task's engine, including a smolvm relay. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { SmolvmRunner } from '../../src/runner/smolvm-runner';
import { taskDataView } from '../../src/daemon/task-data-view';
import { taskDataVolumeName } from '../../src/runner/task-data';
import type { Task } from '../../src/types';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';

let root: string;
const task = {
  id: '11111111-1111-1111-1111-111111111111', code: 'old-services',
  status: 'blocked', runner_type: 'smolvm',
} as Task;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'task-data-view-'));
});

afterEach(async () => {
  restoreMockedModules();
  await rm(root, { recursive: true, force: true });
});

// INVARIANT: a task's data and layout are read from its own engine. A host
// Docker client is a different engine and must never substitute for the VM relay.
test('smolvm shows the old-layout notice and measures data through its relay client', async () => {
  const binary = join(root, 'vm-docker');
  const old = join(root, 'old');
  const log = join(root, 'calls');
  await writeFile(old, '1');
  await writeFile(binary, `#!/bin/sh
echo "$*" >> "${log}"
case "$1" in
  inspect) if [ -f "${old}" ]; then echo '<no value>'; else echo 1; fi ;;
  volume) echo '${taskDataVolumeName(task.id)}' ;;
  exec) printf '42\\t/lazy/data\\n' ;;
  *) echo "Unexpected VM engine call: $*" >&2; exit 1 ;;
esac
`);
  await chmod(binary, 0o755);
  const runner = new SmolvmRunner(root, binary,
    {} as ConstructorParameters<typeof SmolvmRunner>[2], async () => {
      throw new Error('Reading a layout must not start a VM');
    });
  const runnerPath = resolve(import.meta.dir, '../../src/runner/index.ts');
  const real = await import(runnerPath);
  const overrides: unknown[] = [];
  await mockModule(runnerPath, () => ({ ...real, createRunner: async (_root: string, type: unknown) => {
    overrides.push(type);
    return runner;
  } }));

  const before = await taskDataView(root, task, null);
  expect(before.supported).toBe(true);
  expect(before.restartAvailable).toBe(true);
  expect(before.notice).toContain('Restart the environment to get both.');
  expect(before.bytes).toBeNull();
  expect(before.exists).toBe(true);
  expect(overrides).toEqual(['smolvm']);

  // The new-layout branch must measure through that same relay, not host Docker.
  await rm(old);
  const after = await taskDataView(root, task, null);
  expect(after.restartAvailable).toBe(false);
  expect(after.notice).toBeNull();
  expect(after.bytes).toBe(42 * 1024);
  expect(await readFile(log, 'utf8')).toContain('exec lazy-11111111 du -sk /lazy/data');
});

// INVARIANT: Services may create an environment before any agent session.
// Doctor must inspect it too, without inventing a session or starting a container.
test('doctor lists old Services environments with no session and skips absent ones', async () => {
  const { FileStorage } = await import('../../src/storage');
  const { taskRef } = await import('../../src/task/identity');
  const storage = new FileStorage(root, { basePath: join(root, 'store') });
  await storage.initialize();
  try {
    const old = await storage.createTask('Services before the first turn');
    await storage.updateTaskRunnerType(old.id, 'smolvm');
    const absent = await storage.createTask('No environment yet');
    await storage.updateTaskRunnerType(absent.id, 'smolvm');
    const binary = join(root, 'vm-docker');
    await writeFile(binary, `#!/bin/sh
case "$*" in
  *lazy-${taskRef(old)}) echo '<no value>' ;;
  *lazy-${taskRef(absent)}) echo 'Error: No such container' >&2; exit 1 ;;
  *) echo "Unexpected engine call: $*" >&2; exit 1 ;;
esac
`);
    await chmod(binary, 0o755);
    const runner = new SmolvmRunner(root, binary,
      {} as ConstructorParameters<typeof SmolvmRunner>[2], async () => {
        throw new Error('Doctor must not start a VM');
      });
    const runnerPath = resolve(import.meta.dir, '../../src/runner/index.ts');
    const real = await import(runnerPath);
    const overrides: unknown[] = [];
    await mockModule(runnerPath, () => ({ ...real, createRunner: async (_root: string, type: unknown) => {
      overrides.push(type);
      return runner;
    } }));
    const { checkOldTaskEnvironments } = await import('../../src/doctor/sweep');
    const report = await checkOldTaskEnvironments(storage, root);
    expect(report.warning).toContain(old.id.slice(0, 8));
    expect(report.warning).not.toContain(absent.id.slice(0, 8));
    expect(report.warning).toContain('Restart the environment to get both.');
    expect(overrides).toEqual(['smolvm', 'smolvm']);
    expect(await storage.getSessionByTaskId(old.id)).toBeNull();
  } finally {
    await storage.close();
  }
});
