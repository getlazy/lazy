/**
 * Accepting a child task informs its parent with a comment.
 *
 * INVARIANT: when a subtask is accepted into a parent *task* (not a bare
 * branch / default), lazy drops a `[Subtask accepted]` comment on the parent
 * that includes the accept-tag SHA. It does NOT auto-unblock the parent —
 * local comments never start a turn (fix-comment-auto-launch). Top-level
 * accepts into a branch leave no parent comment.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { seedFinal } from '../helpers/final';
import { taskFilePath } from '../helpers/storage';

function readComments(root: string, shortId: string): Array<{ content: string; actor?: string }> {
  try {
    const data = JSON.parse(readFileSync(taskFilePath(root, shortId, 'comments.json'), 'utf-8'));
    return data.comments ?? [];
  } catch {
    return [];
  }
}

async function waitForTask(ctx: TestContext, taskId: string): Promise<void> {
  const waitResult = await ctx.lazy(['wait', taskId]);
  if (waitResult.exitCode !== 0) {
    throw new Error(`wait failed for ${taskId}: ${waitResult.stderr}\n${waitResult.stdout}`);
  }
}

async function addWorktreeCommit(ctx: TestContext, taskId: string, fileName: string): Promise<void> {
  const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
  writeFileSync(join(worktreePath, fileName), `${fileName} content\n`);
  expect(ctx.git('-C', worktreePath, 'add', fileName).exitCode).toBe(0);
  expect(ctx.git('-C', worktreePath, 'commit', '-m', `Add ${fileName}`).exitCode).toBe(0);
  // Fixture setup, not the subject (see test/helpers/final.ts): every accept
  // in this suite commits through this helper first.
  await seedFinal(ctx, taskId);
}

describe('accept notifies parent task', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: accepting a child leaves a [Subtask accepted] comment on the
  // parent with the merge SHA, and does not change the parent's status.
  test('accepting a child comments on the parent with the accept-tag SHA', async () => {
    const parentId = await createTask(ctx, 'Parent for notify', 'Parent work');
    const parentStart = await ctx.lazyMocked(
      ['start', parentId, '--yes'],
      MOCK_CLAUDE_SUCCESS,
    );
    expectSuccess(parentStart);
    await waitForTask(ctx, parentId);

    // Child via branch so it stacks under the parent task.
    const branchResult = await ctx.lazyMocked(
      ['branch', parentId, '--goal', 'Child for notify', '--prompt', 'Child work', '--yes'],
      MOCK_CLAUDE_SUCCESS,
    );
    expectSuccess(branchResult);
    const childMatch = branchResult.stdout.match(/Created variant task ([a-f0-9]{8})/);
    expect(childMatch).toBeTruthy();
    const childId = childMatch![1];
    await waitForTask(ctx, childId);
    await addWorktreeCommit(ctx, childId, 'child-feature.txt');

    const acceptResult = await ctx.lazy(['accept', childId, '--reason', 'LGTM']);
    expectSuccess(acceptResult);

    const parentComments = readComments(ctx.root, parentId);
    const notify = parentComments.find(c => c.content.includes('[Subtask accepted]'));
    expect(notify).toBeTruthy();
    expect(notify!.content).toMatch(/merge [a-f0-9]{40}/);
    expect(notify!.actor).toBe('system');

    // Parent stays blocked — comment never auto-unblocks.
    const showParent = await ctx.lazy(['show', parentId]);
    expectSuccess(showParent);
    expectOutput(showParent, 'blocked');
  });

  // INVARIANT: top-level accept (no parent task) does not invent a parent comment.
  test('accepting a top-level task does not create a parent notify comment', async () => {
    const taskId = await createTask(ctx, 'Top-level accept', 'Solo work');
    const start = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
    expectSuccess(start);
    await waitForTask(ctx, taskId);
    await addWorktreeCommit(ctx, taskId, 'solo.txt');

    const acceptResult = await ctx.lazy(['accept', taskId, '--reason', 'LGTM']);
    expectSuccess(acceptResult);

    // The accepted task itself gets [Accepted], never [Subtask accepted].
    const comments = readComments(ctx.root, taskId);
    expect(comments.some(c => c.content.startsWith('[Accepted]'))).toBe(true);
    expect(comments.some(c => c.content.includes('[Subtask accepted]'))).toBe(false);
  });

  // INVARIANT: lazy wait reports head_sha for a settled task (branch tip when
  // blocked; accept-tag SHA when complete — same value the parent comment uses).
  test('lazy wait --json reports head_sha matching the accept-tag after accept', async () => {
    const parentId = await createTask(ctx, 'Parent for wait sha', 'Parent work');
    const parentStart = await ctx.lazyMocked(
      ['start', parentId, '--yes'],
      MOCK_CLAUDE_SUCCESS,
    );
    expectSuccess(parentStart);
    await waitForTask(ctx, parentId);

    const branchResult = await ctx.lazyMocked(
      ['branch', parentId, '--goal', 'Child for wait sha', '--prompt', 'Child work', '--yes'],
      MOCK_CLAUDE_SUCCESS,
    );
    expectSuccess(branchResult);
    const childMatch = branchResult.stdout.match(/Created variant task ([a-f0-9]{8})/);
    expect(childMatch).toBeTruthy();
    const childId = childMatch![1];
    await waitForTask(ctx, childId);
    await addWorktreeCommit(ctx, childId, 'wait-sha.txt');

    // Wait while blocked — should still expose a branch tip head_sha.
    const waitBlocked = await ctx.lazy(['wait', childId, '--json']);
    expectSuccess(waitBlocked);
    const blockedPayload = JSON.parse(waitBlocked.stdout);
    expect(typeof blockedPayload.head_sha).toBe('string');
    expect(blockedPayload.head_sha).toMatch(/^[a-f0-9]{40}$/);

    const acceptResult = await ctx.lazy(['accept', childId, '--reason', 'LGTM']);
    expectSuccess(acceptResult);

    // Wait again after complete — head_sha is the accept-tag commit.
    const waitComplete = await ctx.lazy(['wait', childId, '--json']);
    // complete is not a blocked status — wait exits 1, but still prints JSON.
    const completePayload = JSON.parse(waitComplete.stdout);
    expect(completePayload.status).toBe('complete');
    expect(completePayload.head_sha).toMatch(/^[a-f0-9]{40}$/);

    const parentComments = readComments(ctx.root, parentId);
    const notify = parentComments.find(c => c.content.includes('[Subtask accepted]'));
    expect(notify).toBeTruthy();
    expect(notify!.content).toContain(`merge ${completePayload.head_sha}`);
  });
});
