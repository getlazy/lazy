import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { basename, join } from 'path';
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, extractTaskId } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { createRunner } from '../../src/runner';

describe('per-task runner override', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function tasksDir(): string {
    const home = process.env.HOME!;
    return join(home, '.lazy', basename(ctx.root), 'tasks');
  }
  function taskDirFor(shortId: string): string {
    const dir = readdirSync(tasksDir()).find(d => d.startsWith(shortId));
    if (!dir) throw new Error(`No task dir for ${shortId} in ${tasksDir()}`);
    return join(tasksDir(), dir);
  }
  function readTask(shortId: string): any {
    return JSON.parse(readFileSync(join(taskDirFor(shortId), 'task.json'), 'utf-8'));
  }

  test('create --runner host is rejected with docker guidance', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Host task', '--runner', 'host']);
    expectFailure(result);
    expectError(result, 'Host-process runner is no longer supported');
  });

  test('create --runner container maps to docker', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Container task', '--runner', 'container']);
    expectSuccess(result);
    const taskId = extractTaskId(result.stdout);
    expect(readTask(taskId).runner_type).toBe('docker');
  });

  test('create without --runner leaves runner_type null (inherits global)', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Default task']);
    expectSuccess(result);
    const taskId = extractTaskId(result.stdout);
    expect(readTask(taskId).runner_type).toBeNull();
  });

  test('create --runner with an invalid value fails', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Bad', '--runner', 'vm']);
    expectFailure(result);
    expectError(result, 'Invalid runner');
  });

  test('edit --runner host is rejected on a backlog task', async () => {
    const taskId = await createTask(ctx, 'Edit runner task', 'Do work');
    const result = await ctx.lazy(['edit', taskId, '--runner', 'host']);
    expectFailure(result);
    expectError(result, 'Host-process runner is no longer supported');
  });

  test('edit --runner "" clears the override back to inherit', async () => {
    const taskId = await createTask(ctx, 'Clear runner task', 'Do work');
    await ctx.lazy(['edit', taskId, '--runner', 'podman']);
    expect(readTask(taskId).runner_type).toBe('podman');

    const result = await ctx.lazy(['edit', taskId, '--runner', '']);
    expectSuccess(result);
    expectOutput(result, 'Cleared runner');
    expect(readTask(taskId).runner_type).toBeNull();
  });

  test('edit --runner with an invalid value fails', async () => {
    const taskId = await createTask(ctx, 'Bad edit', 'Do work');
    const result = await ctx.lazy(['edit', taskId, '--runner', 'nope']);
    expectFailure(result);
    expectError(result, 'Invalid runner');
  });

});

describe('per-task runner override (daemon-backed)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function tasksDir(): string {
    return join(process.env.HOME!, '.lazy', basename(ctx.root), 'tasks');
  }
  function taskDirFor(shortId: string): string {
    const dir = readdirSync(tasksDir()).find(d => d.startsWith(shortId));
    if (!dir) throw new Error(`No task dir for ${shortId} in ${tasksDir()}`);
    return join(tasksDir(), dir);
  }
  function readTask(shortId: string): any {
    return JSON.parse(readFileSync(join(taskDirFor(shortId), 'task.json'), 'utf-8'));
  }
  function readSession(shortId: string): any {
    return JSON.parse(readFileSync(join(taskDirFor(shortId), 'session.json'), 'utf-8'));
  }
  function writeSession(shortId: string, session: any): void {
    writeFileSync(join(taskDirFor(shortId), 'session.json'), JSON.stringify(session, null, 2));
  }

  test('edit --runner podman is allowed after the task has been started; --goal is not', async () => {
    const taskId = await createTask(ctx, 'Started task', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    const runnerEdit = await ctx.lazy(['edit', taskId, '--runner', 'podman']);
    expectSuccess(runnerEdit);
    expect(readTask(taskId).runner_type).toBe('podman');

    const goalEdit = await ctx.lazy(['edit', taskId, '--goal', 'New goal']);
    expectFailure(goalEdit);
    expectError(goalEdit, 'already been started');
  });

  test('starting a task stamps the resolved runner onto the session', async () => {
    const taskId = await createTask(ctx, 'Stamp task', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    expect(readSession(taskId).runner_type).toBe('docker');
  });

  test('per-session runner resolution honors the override over the global default', async () => {
    const taskId = await createTask(ctx, 'Resolve task', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    const session = readSession(taskId);
    session.runner_type = 'podman';
    writeSession(taskId, session);

    const priorTestFlag = process.env.LAZY_TEST;
    process.env.LAZY_TEST = '1';
    try {
      const globalRunner = await createRunner(ctx.root);
      expect(globalRunner.type).toBe('docker');

      const monitorRunner = await createRunner(ctx.root, readSession(taskId).runner_type);
      expect(monitorRunner.type).toBe('podman');
    } finally {
      if (priorTestFlag === undefined) delete process.env.LAZY_TEST;
      else process.env.LAZY_TEST = priorTestFlag;
    }
  });
});
