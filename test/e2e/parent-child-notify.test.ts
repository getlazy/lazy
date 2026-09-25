/**
 * A task is told when a subtask is added to or removed from it.
 *
 * INVARIANT: creating a task under a parent, reparenting one in or out, and
 * closing one all leave a one-line `[Subtask added]` / `[Subtask removed]`
 * system comment on the parent *task* — the way `[Subtask accepted]` already
 * works. Nothing is posted for a top-level task (no parent task), and the
 * comment never starts a turn: the parent stays where it was.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, extractTaskId } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { taskFilePath, readTaskStatus } from '../helpers/storage';

function readComments(root: string, shortId: string): Array<{ content: string; actor?: string }> {
  try {
    const data = JSON.parse(readFileSync(taskFilePath(root, shortId, 'comments.json'), 'utf-8'));
    return data.comments ?? [];
  } catch {
    return [];
  }
}

function subtaskNotices(root: string, shortId: string): string[] {
  return readComments(root, shortId)
    .map(c => c.content)
    .filter(content => /^\[Subtask (added|removed)\]/.test(content));
}

async function createChild(
  ctx: TestContext,
  parentId: string,
  goal: string,
  prompt?: string,
): Promise<string> {
  const args = ['create', '--goal', goal, '--parent', parentId];
  if (prompt) args.push('--prompt', prompt);
  const result = await ctx.lazy(args);
  expectSuccess(result);
  return extractTaskId(result.stdout);
}

describe('parent is told when a subtask is added or removed', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: `lazy create --parent` announces the new subtask on the parent,
  // one line, naming the child and its goal, from the system actor.
  test('creating a task under a parent comments on the parent', async () => {
    const parentId = await createTask(ctx, 'Parent hub', 'Parent work');
    const childId = await createChild(ctx, parentId, 'Child of the hub');

    const notices = subtaskNotices(ctx.root, parentId);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^\[Subtask added\] \S+ — "Child of the hub"$/);
    expect(notices[0]).not.toContain('\n');
    expect(notices[0]).toContain(childId);

    const notice = readComments(ctx.root, parentId).find(c => c.content.startsWith('[Subtask'));
    expect(notice!.actor).toBe('system');

    // The comment never starts a turn: the parent is still in backlog.
    expect(readTaskStatus(ctx.root, parentId)).toBe('backlog');
  });

  // INVARIANT: a top-level task has no parent task, so nothing is written.
  test('creating a top-level task writes no subtask notice anywhere', async () => {
    const taskId = await createTask(ctx, 'Solo task', 'Solo work');
    expect(subtaskNotices(ctx.root, taskId)).toEqual([]);
  });

  // INVARIANT: a reparent announces BOTH sides — the parent that lost the
  // child and the parent that gained it.
  test('reparenting a subtask tells the old parent and the new one', async () => {
    const oldParent = await createTask(ctx, 'Old hub', 'Old work');
    const newParent = await createTask(ctx, 'New hub', 'New work');
    const childId = await createChild(ctx, oldParent, 'Moving child');

    expect(subtaskNotices(ctx.root, oldParent)).toHaveLength(1);

    // reparent runs a sync, which relaunches the task's agent — go through the
    // mocked runner even though a backlog task has nothing to merge.
    const reparent = await ctx.lazyMocked(['reparent', childId, '--parent', newParent, '--yes'], MOCK_CLAUDE_SUCCESS);
    expectSuccess(reparent);

    const oldNotices = subtaskNotices(ctx.root, oldParent);
    expect(oldNotices).toHaveLength(2);
    expect(oldNotices[1]).toMatch(/^\[Subtask removed\] \S+ — reparented to \S+$/);
    expect(oldNotices[1]).toContain(childId);

    const newNotices = subtaskNotices(ctx.root, newParent);
    expect(newNotices).toHaveLength(1);
    expect(newNotices[0]).toMatch(/^\[Subtask added\] \S+ — "Moving child"$/);
  });

  // INVARIANT: reparenting out to a bare branch still tells the old parent it
  // lost the subtask, naming where it went.
  test('reparenting a subtask out to a branch tells the old parent', async () => {
    const parentId = await createTask(ctx, 'Losing hub', 'Hub work');
    const childId = await createChild(ctx, parentId, 'Leaving child');

    const reparent = await ctx.lazyMocked(['reparent', childId, '--parent', 'main', '--yes'], MOCK_CLAUDE_SUCCESS);
    expectSuccess(reparent);

    const notices = subtaskNotices(ctx.root, parentId);
    expect(notices).toHaveLength(2);
    expect(notices[1]).toMatch(/^\[Subtask removed\] \S+ — reparented to top-level$/);
  });

  // INVARIANT: closing a subtask tells the parent, with the close reason.
  test('closing a subtask comments on the parent with the reason', async () => {
    const parentId = await createTask(ctx, 'Closing hub', 'Hub work');
    const childId = await createChild(ctx, parentId, 'Doomed child');

    const close = await ctx.lazy(['close', childId, '--reason', 'not needed after all', '--yes']);
    expectSuccess(close);

    const notices = subtaskNotices(ctx.root, parentId);
    expect(notices).toHaveLength(2);
    expect(notices[1]).toBe(`[Subtask removed] ${childId} — "not needed after all"`);

    // Still no turn started on the parent.
    expect(readTaskStatus(ctx.root, parentId)).toBe('backlog');
  });

  // INVARIANT: reject reports the reason the reviewer typed, not the generic
  // "abandoned" the tap's status backstop would write. rejectTask notifies
  // before its own status flip for exactly this reason, and a comment lands
  // either way — so only the WORDING distinguishes a working ordering from a
  // broken one.
  test('rejecting a subtask names the reviewer\'s reason, exactly once', async () => {
    const parentId = await createTask(ctx, 'Rejecting hub', 'Hub work');
    const parentStart = await ctx.lazyMocked(['start', parentId, '--yes'], MOCK_CLAUDE_SUCCESS);
    expectSuccess(parentStart);
    expectSuccess(await ctx.lazy(['wait', parentId]));

    const childId = await createChild(ctx, parentId, 'Rejected child', 'Child work');
    const childStart = await ctx.lazyMocked(['start', childId, '--yes'], MOCK_CLAUDE_SUCCESS);
    expectSuccess(childStart);
    expectSuccess(await ctx.lazy(['wait', childId]));

    const reject = await ctx.lazy(['reject', childId, '--reason', 'wrong approach', '--yes']);
    expectSuccess(reject);

    const removals = subtaskNotices(ctx.root, parentId).filter(n =>
      n.startsWith('[Subtask removed]'),
    );
    expect(removals).toEqual([`[Subtask removed] ${childId} — "rejected: wrong approach"`]);
  });

  // INVARIANT: a reopened subtask is back in the parent's live child set, so
  // the parent is told — and because the skip is last-state-wins, that also
  // restores its ability to report the child's next removal.
  test('reopening a closed subtask re-announces it, and a second close reports again', async () => {
    const parentId = await createTask(ctx, 'Reopening hub', 'Hub work');
    const childId = await createChild(ctx, parentId, 'Returning child');

    expectSuccess(await ctx.lazy(['close', childId, '--reason', 'closed too early', '--yes']));
    expectSuccess(await ctx.lazy(['reopen', childId]));
    expectSuccess(await ctx.lazy(['close', childId, '--reason', 'closed for real', '--yes']));

    expect(subtaskNotices(ctx.root, parentId)).toEqual([
      `[Subtask added] ${childId} — "Returning child"`,
      `[Subtask removed] ${childId} — "closed too early"`,
      `[Subtask added] ${childId} — "Returning child"`,
      `[Subtask removed] ${childId} — "closed for real"`,
    ]);
  });

  // INVARIANT: the notices are idempotent per state — repeating an operation
  // that is already reflected adds nothing.
  test('a no-op reparent back onto the same parent adds no second notice', async () => {
    const parentId = await createTask(ctx, 'Stable hub', 'Hub work');
    const childId = await createChild(ctx, parentId, 'Settled child');

    const reparent = await ctx.lazyMocked(['reparent', childId, '--parent', parentId, '--yes'], MOCK_CLAUDE_SUCCESS);
    expectSuccess(reparent);

    expect(subtaskNotices(ctx.root, parentId)).toHaveLength(1);
  });
});
