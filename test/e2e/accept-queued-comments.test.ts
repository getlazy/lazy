import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, expectFailure, expectError } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { seedFinal } from '../helpers/final';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard } from '../helpers/dashboard-session';
import { findFullTaskId } from '../helpers/storage';

/** Same fixture as accept-reason.test.ts: a parked task with a commit to merge. */
async function createStartedTaskWithCommit(ctx: TestContext, goal: string): Promise<string> {
  const taskId = await createTask(ctx, goal, 'Some work');
  expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
    env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
  }));
  const waited = await ctx.lazy(['wait', taskId]);
  if (waited.exitCode !== 0) throw new Error(`wait failed for ${taskId}: ${waited.stderr}`);
  const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
  writeFileSync(join(worktreePath, 'feature.txt'), 'feature content\n');
  expect(ctx.git('-C', worktreePath, 'add', 'feature.txt').exitCode).toBe(0);
  expect(ctx.git('-C', worktreePath, 'commit', '-m', 'Add feature').exitCode).toBe(0);
  await seedFinal(ctx, taskId);
  return taskId;
}

describe('accept refuses while human feedback is undelivered', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: a comment a human queued that no prompt has carried REFUSES
  // accept — merging would end the task with that feedback never read
  // (CLAUDE.md, "Never Lose Human Feedback"). The human's way past it is an
  // explicit override, never a silent merge.
  test('a queued lazy comment refuses accept; --allow-queued-comments merges', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Queued comment gate');
    expectSuccess(await ctx.lazy(['comment', taskId, '-m', 'also handle the empty case']));

    const refused = await ctx.lazy(['accept', taskId, '--yes']);
    expectFailure(refused);
    expectError(refused, 'not been delivered');
    expectError(refused, '--allow-queued-comments');

    const accepted = await ctx.lazy(['accept', taskId, '--yes', '--allow-queued-comments']);
    expectSuccess(accepted);
    expectOutput(accepted, 'accepted');
  }, 120_000);

  test('Current review counts the queued task comment and names the gate', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Queued comment page');
    expectSuccess(await ctx.lazy(['comment', taskId, '-m', 'also handle the empty case']));
    const health = await checkDaemonHealth(ctx.root);
    expect(health.webPort).toBeGreaterThan(0);
    const { base, fetch } = await signInToDashboard(ctx);
    const fullId = findFullTaskId(ctx.root, taskId)!;

    const page = await (await fetch(`${base}/tasks/${fullId}/review`)).text();
    expect(page).toContain('1 comment queued');
    expect(page).toContain('also handle the empty case');
    expect(page).toContain('1 queued comment has not reached the agent');
    expect(page).toContain('name="allow_queued_comments"');
    expect(page).not.toContain('Nothing is blocking accept from this tab');
  }, 120_000);
});
