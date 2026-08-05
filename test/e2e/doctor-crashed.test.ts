import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, expectOutputExcludes } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
// Test projects init with EXTERNAL storage, so task state does NOT live at
// `<root>/.lazy/tasks`. These helpers read `external_path` out of the project's
// lazy.toml — the local copies this file used to carry hardcoded the in-repo
// layout and died with ENOENT on `<root>/.lazy/tasks` once the backend changed.
import { setTaskStatus, readSessionJson, writeSessionJson } from '../helpers/storage';

// ── Helpers ──────────────────────────────────────────────────────────────

function setContainerName(root: string, shortId: string, containerName: string): void {
  const session = readSessionJson(root, shortId);
  if (!session) throw new Error(`Task ${shortId} has no session.json — was it started?`);
  session.container_name = containerName;
  writeSessionJson(root, shortId, session);
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
    await startAndReconcile(ctx, taskId);

    // Set task to interrupted and set a known container name
    const containerName = `lazy-${taskId}`;
    setTaskStatus(ctx.root, taskId, 'interrupted');
    setContainerName(ctx.root, taskId, containerName);

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
    await startAndReconcile(ctx, taskId);

    const containerName = `lazy-${taskId}`;
    setTaskStatus(ctx.root, taskId, 'interrupted');
    setContainerName(ctx.root, taskId, containerName);

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

    await startAndReconcile(ctx, taskId1);
    await startAndReconcile(ctx, taskId2);

    const cn1 = `lazy-${taskId1}`;
    const cn2 = `lazy-${taskId2}`;
    setTaskStatus(ctx.root, taskId1, 'interrupted');
    setContainerName(ctx.root, taskId1, cn1);
    setTaskStatus(ctx.root, taskId2, 'interrupted');
    setContainerName(ctx.root, taskId2, cn2);

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
