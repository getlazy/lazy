import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { writeFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, expectOutputExcludes } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

// ── Helpers ──────────────────────────────────────────────────────────────

function findFullTaskId(root: string, shortId: string): string {
  const tasksDir = join(root, '.lazy', 'tasks');
  const entries = readdirSync(tasksDir);
  const match = entries.find((e: string) => e.startsWith(shortId));
  if (!match) {
    throw new Error(`Could not find full task ID for short ID: ${shortId}`);
  }
  return match;
}

function setTaskStatus(root: string, fullTaskId: string, status: string): void {
  const taskPath = join(root, '.lazy', 'tasks', fullTaskId, 'task.json');
  const task = JSON.parse(readFileSync(taskPath, 'utf-8'));
  task.status = status;
  writeFileSync(taskPath, JSON.stringify(task, null, 2));
}

function setContainerName(root: string, fullTaskId: string, containerName: string): void {
  const sessionPath = join(root, '.lazy', 'tasks', fullTaskId, 'session.json');
  const session = JSON.parse(readFileSync(sessionPath, 'utf-8'));
  session.container_name = containerName;
  writeFileSync(sessionPath, JSON.stringify(session, null, 2));
}

/**
 * Start a task and reconcile to get it into blocked state (with session).
 */
async function startAndReconcile(ctx: TestContext, taskId: string): Promise<void> {
  const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
    env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
  });
  expectSuccess(startResult);

  // Reconcile to process the mock response (transitions working → blocked)
  await ctx.lazyMocked(['list'], MOCK_CLAUDE_SUCCESS);
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('lazy list: crashed container indicators', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('shows [CRASHED] indicator for interrupted task with dead container', async () => {
    const taskId = await createTask(ctx, 'Crash indicator test', 'Do the work');
    const fullId = findFullTaskId(ctx.root, taskId);

    await startAndReconcile(ctx, taskId);

    // Set task to interrupted and set a known container name
    const containerName = `lazy-${taskId}`;
    setTaskStatus(ctx.root, fullId, 'interrupted');
    setContainerName(ctx.root, fullId, containerName);

    // Run list with mocked crashed container
    const result = await ctx.lazyMocked(['list'], MOCK_CLAUDE_SUCCESS, {
      env: {
        LAZY_MOCK_CRASHED_CONTAINERS: containerName,
      },
    });

    expectSuccess(result);
    expectOutput(result, '[CRASHED]');
    expectOutput(result, 'crashed containers');
    expectOutput(result, 'lazy doctor');
  });

  test('shows [CRASHED] indicator in flat list mode', async () => {
    const taskId = await createTask(ctx, 'Flat crash test', 'Do the work');
    const fullId = findFullTaskId(ctx.root, taskId);

    await startAndReconcile(ctx, taskId);

    const containerName = `lazy-${taskId}`;
    setTaskStatus(ctx.root, fullId, 'interrupted');
    setContainerName(ctx.root, fullId, containerName);

    // The flat list doesn't show the [CRASHED] tag on individual rows since
    // it doesn't use printTaskTree, but the footnote should still appear
    const result = await ctx.lazyMocked(['list', '--flat'], MOCK_CLAUDE_SUCCESS, {
      env: {
        LAZY_MOCK_CRASHED_CONTAINERS: containerName,
      },
    });

    expectSuccess(result);
    expectOutput(result, 'crashed containers');
    expectOutput(result, 'lazy doctor');
  });

  test('does not show crash indicator when no containers are crashed', async () => {
    const taskId = await createTask(ctx, 'Normal task test', 'Do the work');

    await startAndReconcile(ctx, taskId);

    // List without any crashed containers mock
    const result = await ctx.lazyMocked(['list'], MOCK_CLAUDE_SUCCESS);

    expectSuccess(result);
    expectOutputExcludes(result, '[CRASHED]');
    expectOutputExcludes(result, 'crashed containers');
  });

  test('does not show crash indicator for tasks without sessions', async () => {
    // Just create a task without starting it
    await createTask(ctx, 'Unstarted task', 'Do the work');

    const result = await ctx.lazyMocked(['list'], MOCK_CLAUDE_SUCCESS);

    expectSuccess(result);
    expectOutputExcludes(result, '[CRASHED]');
    expectOutputExcludes(result, 'crashed containers');
  });

  test('shows count of multiple crashed tasks', async () => {
    const taskId1 = await createTask(ctx, 'Crashed task 1', 'Do work 1');
    const taskId2 = await createTask(ctx, 'Crashed task 2', 'Do work 2');
    const fullId1 = findFullTaskId(ctx.root, taskId1);
    const fullId2 = findFullTaskId(ctx.root, taskId2);

    await startAndReconcile(ctx, taskId1);
    await startAndReconcile(ctx, taskId2);

    const cn1 = `lazy-${taskId1}`;
    const cn2 = `lazy-${taskId2}`;
    setTaskStatus(ctx.root, fullId1, 'interrupted');
    setContainerName(ctx.root, fullId1, cn1);
    setTaskStatus(ctx.root, fullId2, 'interrupted');
    setContainerName(ctx.root, fullId2, cn2);

    const result = await ctx.lazyMocked(['list'], MOCK_CLAUDE_SUCCESS, {
      env: {
        LAZY_MOCK_CRASHED_CONTAINERS: `${cn1},${cn2}`,
      },
    });

    expectSuccess(result);
    expectOutput(result, '2 task(s) have crashed containers');
  });
});

describe('lazy doctor: --no-resume flag', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('--no-resume flag is accepted', async () => {
    const result = await ctx.lazy(['doctor', '--no-resume']);
    // Doctor should run (may have failures due to Docker not being installed,
    // but it should NOT error about unknown flags)
    const hasUnknownFlag = result.stderr.includes('Unknown flag');
    expect(hasUnknownFlag).toBe(false);
  });

  test('help text mentions --no-resume', async () => {
    const result = await ctx.lazy(['doctor', '--help']);
    expectSuccess(result);
    expectOutput(result, '--no-resume');
    expectOutput(result, 'Crashed task containers');
  });
});
