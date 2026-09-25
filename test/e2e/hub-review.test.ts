/**
 * A release hub's review / `lazy diff` shows accepted children plus the hub's
 * own direct changes — not the union of every child's files against main.
 *
 * Reproduces fix-hub-review-renders-whole-release: the review Changes block
 * used to render `main...lazy/<hub>` (every accepted squash), which on
 * release-v022 was 1,843 files / 12.4 MB in one synchronous response.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, disablePreAccept, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { expectSuccess, extractTaskId } from '../helpers/assertions';
import { findFullTaskId, worktreePathFor } from '../helpers/storage';
import { seedFinal } from '../helpers/final';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';

async function waitFor(ctx: TestContext, taskId: string): Promise<void> {
  const result = await ctx.lazy(['wait', taskId]);
  if (result.exitCode !== 0) {
    throw new Error(`wait failed for ${taskId}: ${result.stderr}\n${result.stdout}`);
  }
}

async function startBlocked(
  ctx: TestContext,
  goal: string,
  prompt: string,
): Promise<string> {
  const id = await createTask(ctx, goal, prompt);
  expectSuccess(await ctx.lazyMocked(['start', id, '--yes'], MOCK_CLAUDE_SUCCESS, {
    env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
  }));
  await waitFor(ctx, id);
  return id;
}

async function addCommit(ctx: TestContext, taskId: string, file: string, body: string, message: string) {
  const worktree = worktreePathFor(ctx.root, taskId);
  writeFileSync(join(worktree, file), body);
  ctx.git('-C', worktree, 'add', file);
  ctx.git('-C', worktree, 'commit', '-m', message);
}

describe('hub review shows direct changes, not the whole branch', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;

  beforeEach(async () => {
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    disablePreAccept(ctx.root);
    const health = await checkDaemonHealth(ctx.root);
    expect(health.webPort).toBeGreaterThan(0);
    ({ base, fetch } = await signInToDashboard(ctx));
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('Changes links to grouped Subtasks; accepted-child files drop out of the hub diff', async () => {
    const hubId = await startBlocked(ctx, 'Release hub', 'Hub work');

    const childA = await ctx.lazy(['create', '--goal', 'Hub child A', '--prompt', 'Add child-a', '--parent', hubId]);
    expectSuccess(childA);
    const childAId = extractTaskId(childA.stdout);
    expectSuccess(await ctx.lazyMocked(['start', childAId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    }));
    await waitFor(ctx, childAId);
    await addCommit(ctx, childAId, 'hub-child-a.txt', 'from child A\n', 'Add hub-child-a.txt');
    // Fixture setup, not the subject (see test/helpers/final.ts).
    await seedFinal(ctx, childAId);
    expectSuccess(await ctx.lazy(['accept', childAId, '--yes']));

    const childB = await ctx.lazy(['create', '--goal', 'Hub child B', '--prompt', 'Add child-b', '--parent', hubId]);
    expectSuccess(childB);
    const childBId = extractTaskId(childB.stdout);
    expectSuccess(await ctx.lazyMocked(['start', childBId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    }));
    await waitFor(ctx, childBId);
    await addCommit(ctx, childBId, 'hub-child-b.txt', 'from child B\n', 'Add hub-child-b.txt');
    // Fixture setup, not the subject (see test/helpers/final.ts).
    await seedFinal(ctx, childBId);
    expectSuccess(await ctx.lazy(['accept', childBId, '--yes']));

    const live = await ctx.lazy(['create', '--goal', 'Hub child still going', '--prompt', 'In progress', '--parent', hubId]);
    expectSuccess(live);
    const liveId = extractTaskId(live.stdout);
    expectSuccess(await ctx.lazyMocked(['start', liveId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    }));
    await waitFor(ctx, liveId);

    // The hub's own commit after the children landed — this is the review unit.
    await addCommit(ctx, hubId, 'hub-direct.txt', 'hub only\n', 'Add hub-direct.txt');

    const hubFull = findFullTaskId(ctx.root, hubId);
    const childAFull = findFullTaskId(ctx.root, childAId);
    const childBFull = findFullTaskId(ctx.root, childBId);
    const liveFull = findFullTaskId(ctx.root, liveId);

    const scoped = await ctx.lazy(['diff', hubId, '--full']);
    expectSuccess(scoped);
    expect(scoped.stdout).toContain('hub-direct.txt');
    expect(scoped.stdout).not.toContain('hub-child-a.txt');
    expect(scoped.stdout).not.toContain('hub-child-b.txt');

    const whole = await ctx.lazy(['diff', hubId, '--full', '--full-branch']);
    expectSuccess(whole);
    expect(whole.stdout).toContain('hub-direct.txt');
    expect(whole.stdout).toContain('hub-child-a.txt');
    expect(whole.stdout).toContain('hub-child-b.txt');

    const stat = await ctx.lazy(['diff', hubId]);
    expectSuccess(stat);
    expect(stat.stdout).toContain('Direct changes only');
    expect(stat.stdout).toContain('--full-branch');

    const html = await (await fetch(`${base}/tasks/${hubId}/changes`)).text();
    expect(html).toContain('rv-hub-children');
    expect(html).toContain(`href="/tasks/${hubFull}/subtasks"`);
    expect(html).toContain('grouped by status');
    expect(html).not.toContain('Accepted subtasks');
    expect(html).toContain('data-file="hub-direct.txt"');
    expect(html).not.toContain('data-file="hub-child-a.txt"');
    expect(html).not.toContain('data-file="hub-child-b.txt"');

    const subtasks = await (await fetch(`${base}/tasks/${hubId}/subtasks`)).text();
    expect(subtasks).toContain('Hub child A');
    expect(subtasks).toContain('Hub child B');
    expect(subtasks).toContain(`href="/tasks/${childAFull}"`);
    expect(subtasks).toContain(`href="/tasks/${childBFull}"`);
    expect(subtasks).toContain('Hub child still going');
    expect(subtasks).toContain(`href="/tasks/${liveFull}"`);
    expect(subtasks).toContain('Needs you');
    expect(subtasks).toContain('Done');
  }, 120_000);

  test('a task with no accepted children has no hub list and keeps its files', async () => {
    const taskId = await startBlocked(ctx, 'Ordinary leaf', 'Do work');
    const html = await (await fetch(`${base}/tasks/${taskId}/changes`)).text();
    expect(html).toContain('data-file="agent-output-');
    expect(html).not.toContain('Accepted subtasks');
    expect(html).not.toContain('rv-hub-children');
  }, 60_000);
});
