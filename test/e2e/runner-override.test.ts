import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { basename, join } from 'path';
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, extractTaskId } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { createRunner } from '../../src/runner';

const HOST_RUNNER = 'dangerously-host-process-without-any-isolation';

describe('per-task runner override', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // External storage resolves to $HOME/.lazy/<project>, where <project> is the
  // basename of the repo root (no origin remote configured in tests). Read the
  // on-disk JSON directly to avoid contending with the CLI's storage lock.
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
  function readSession(shortId: string): any {
    return JSON.parse(readFileSync(join(taskDirFor(shortId), 'session.json'), 'utf-8'));
  }
  function writeSession(shortId: string, session: any): void {
    writeFileSync(join(taskDirFor(shortId), 'session.json'), JSON.stringify(session, null, 2));
  }

  // --- create --runner ---

  test('create --runner host persists the host runner on the task', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Host task', '--runner', 'host']);
    expectSuccess(result);
    expectOutput(result, 'Runner:');
    const taskId = extractTaskId(result.stdout);
    expect(readTask(taskId).runner_type).toBe(HOST_RUNNER);
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

  // --- edit --runner ---

  test('edit --runner sets the runner on a backlog task', async () => {
    const taskId = await createTask(ctx, 'Edit runner task', 'Do work');
    const result = await ctx.lazy(['edit', taskId, '--runner', 'host']);
    expectSuccess(result);
    expectOutput(result, 'Updated runner');
    expect(readTask(taskId).runner_type).toBe(HOST_RUNNER);
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

// Tests that actually launch a task need a running daemon (the production
// launch path). `lazy start` via the in-process LAZY_TEST shim does not create
// a session in this harness.
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

  // INVARIANT: the runner override is changeable at ANY time, even after an
  // agent has worked on the task — unlike goal/prompt which are frozen once the
  // task has turns. It takes effect on the next turn.
  test('edit --runner is allowed after the task has been started; --goal is not', async () => {
    const taskId = await createTask(ctx, 'Started task', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    const runnerEdit = await ctx.lazy(['edit', taskId, '--runner', 'host']);
    expectSuccess(runnerEdit);
    expect(readTask(taskId).runner_type).toBe(HOST_RUNNER);

    const goalEdit = await ctx.lazy(['edit', taskId, '--goal', 'New goal']);
    expectFailure(goalEdit);
    expectError(goalEdit, 'already been started');
  });

  // INVARIANT: the session records the resolved runner it actually launched on.
  // Monitoring (reconcile/stop/close/shutdown) reads THIS, not the live global
  // config, so a per-task override is monitored on the correct runner.
  test('starting a task stamps the resolved runner onto the session', async () => {
    const taskId = await createTask(ctx, 'Stamp task', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    // Global default in tests is docker → the session records docker.
    expect(readSession(taskId).runner_type).toBe('docker');
  });

  // INVARIANT: precedence is `task.runner_type ?? config.runner.type`, and
  // monitoring resolves the runner from the SESSION's stamped type, not global.
  // createRunner(root, <override>) is exactly the resolution both launch and
  // monitoring use — proving a host-stamped session resolves to the host runner
  // even though the global config is docker.
  test('per-session runner resolution honors the override over the global default', async () => {
    const taskId = await createTask(ctx, 'Resolve task', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    // Re-stamp the session as monitoring would observe after a runner switch.
    const session = readSession(taskId);
    session.runner_type = HOST_RUNNER;
    writeSession(taskId, session);

    // Unlike every other call here, these two run createRunner IN THIS PROCESS
    // rather than in a `ctx.lazy()` subprocess — and only the subprocess gets
    // LAZY_TEST=1. createRunner resolves the (default-on) proxy's live address,
    // which needs a daemon, so without the harness bypass these two lines fail
    // on infrastructure instead of on the runner-type precedence they assert.
    // Scoped and restored so the rest of the file is unaffected.
    const priorTestFlag = process.env.LAZY_TEST;
    process.env.LAZY_TEST = '1';
    try {
      // Global config default is docker.
      const globalRunner = await createRunner(ctx.root);
      expect(globalRunner.type).toBe('docker');

      // Monitoring resolves from the session's stamped runner → host, not docker.
      const monitorRunner = await createRunner(ctx.root, readSession(taskId).runner_type);
      expect(monitorRunner.type).toBe(HOST_RUNNER);
    } finally {
      if (priorTestFlag === undefined) delete process.env.LAZY_TEST;
      else process.env.LAZY_TEST = priorTestFlag;
    }
  });
});
