import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, startAndWait, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { findFullTaskId, readTaskStatus, readTurns } from '../helpers/storage';
import { protocolDir as getProtocolDir, readCommand } from '../../src/protocol';
import type { UnblockCommand } from '../../src/protocol';

/**
 * A lazy comment is FEEDBACK, never a start signal.
 *
 * The daemon used to scan blocked tasks each reconcile tick for comments newer
 * than the session's last interaction, emit a `comment` signal, and auto-unblock
 * the task with a synthetic `[system]` turn carrying "You have N new comments".
 * `lazy comment` emitted the same signal itself. Two consequences, both reported
 * from real use:
 *
 *  - It raced the human. Comment, then run `lazy unblock` a few seconds later,
 *    and unblock refuses with "task is busy" — the daemon has already claimed
 *    the task. The human's actual feedback never reaches the agent, and the
 *    task's history shows a `[system]` chunk with the comment but not the
 *    unblock message.
 *  - It contradicted every comment surface. `lazy comment`, the web UI and the
 *    MCP `lazy_comment` tool all document a comment as being DELIVERED into the
 *    target's NEXT turn prompt. None of them says it launches anything.
 *
 * Forge (PR/MR) comments are a different channel and keep their opt-in
 * auto-react — see `[daemon] auto_react_comments`.
 */
describe('a lazy comment never launches a turn', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // The bug lives in the daemon's reconcile tick (runBlockedTaskCatchup), so
    // this suite needs a real daemon ticking against a real blocked task.
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: a comment on a blocked task does not start an agent turn. The
  // human decides when the agent runs; auto-launching races their own unblock
  // and burns a turn on feedback they were still writing.
  test('commenting on a blocked task leaves it blocked, and the comment rides the next unblock', async () => {
    const taskId = await createTask(ctx, 'Comment must not auto-launch', 'Do feature work');
    await startAndWait(ctx, taskId);

    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
    const turnsBefore = readTurns(ctx.root, taskId).length;

    // Comments are only "new" relative to the last agent turn / interaction, so
    // make sure this one is strictly later.
    await Bun.sleep(1100);

    const commentResult = await ctx.lazy([
      'comment', taskId, '--message', 'REVIEW NOTE: the retry path swallows errors',
    ]);
    expectSuccess(commentResult);

    // Give the daemon several reconcile ticks (5s each) to do the wrong thing.
    await Bun.sleep(12_000);

    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');

    const turnsAfter = readTurns(ctx.root, taskId);
    expect(turnsAfter.length).toBe(turnsBefore);
    expect(turnsAfter.some(t => t.content.includes('[system]'))).toBe(false);
    expect(turnsAfter.some(t => t.content.includes('new comments on this task'))).toBe(false);

    // The human's unblock now succeeds — and carries the comment with it.
    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Fix the retry path'],
      MOCK_CLAUDE_SUCCESS,
    );
    expectSuccess(unblockResult);
    expect(unblockResult.stderr).not.toContain('busy');

    const command = readCommand(getProtocolDir(findFullTaskId(ctx.root, taskId))) as UnblockCommand;
    expect(command).not.toBeNull();
    expect(command.prompt).toContain('NOTES ADDED SINCE YOUR LAST TURN');
    expect(command.prompt).toContain('REVIEW NOTE: the retry path swallows errors');
    expect(command.prompt).toContain('Fix the retry path');
  }, 120_000);
});
