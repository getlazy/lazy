import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, expectFailure } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/**
 * A worktree left mid-merge must be visible from every surface that reports on
 * the task, and must not be mistaken for ordinary uncommitted work.
 *
 * The live incident (fix-sync-silent-conflict): a sync conflicted, left `UU
 * CHANGELOG.md` and MERGE_HEAD behind, and put the task back to `blocked`.
 * `lazy wait` said "blocked" — a settled-looking answer — and `lazy show` said
 * nothing at all. The strand only surfaced when `accept` refused with "Task has
 * uncommitted changes. Commit or stash changes", which is both a misdiagnosis
 * and bad advice: stashing a conflicted merge fails and committing one records
 * conflict markers.
 *
 * These tests drive the real CLI against a real half-merged worktree.
 */
describe('mid-merge worktree visibility', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // `start` launches the supervisor asynchronously and the daemon reconciler
    // is what moves the task out of 'working'; accept refuses on a 'working'
    // task. Same reasoning as the accept-gates / accept-reason suites.
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /**
   * Leave the task's worktree in a genuinely conflicted merge: MERGE_HEAD
   * present and one unmerged path on disk. Built with real git rather than by
   * writing marker files, because the surfaces under test read git's index.
   */
  function leaveConflictedMerge(worktreePath: string): void {
    const branch = ctx.git('-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();

    writeFileSync(join(worktreePath, 'conflicted.txt'), 'base\n');
    expect(ctx.git('-C', worktreePath, 'add', 'conflicted.txt').exitCode).toBe(0);
    expect(ctx.git('-C', worktreePath, 'commit', '-m', 'base for conflict').exitCode).toBe(0);
    const baseSha = ctx.git('-C', worktreePath, 'rev-parse', 'HEAD').stdout.trim();

    writeFileSync(join(worktreePath, 'conflicted.txt'), 'task side\n');
    expect(ctx.git('-C', worktreePath, 'add', 'conflicted.txt').exitCode).toBe(0);
    expect(ctx.git('-C', worktreePath, 'commit', '-m', 'task side').exitCode).toBe(0);

    expect(ctx.git('-C', worktreePath, 'checkout', '-b', 'sideline', baseSha).exitCode).toBe(0);
    writeFileSync(join(worktreePath, 'conflicted.txt'), 'upstream side\n');
    expect(ctx.git('-C', worktreePath, 'add', 'conflicted.txt').exitCode).toBe(0);
    expect(ctx.git('-C', worktreePath, 'commit', '-m', 'upstream side').exitCode).toBe(0);
    expect(ctx.git('-C', worktreePath, 'checkout', branch).exitCode).toBe(0);

    // Conflicts, by construction — the merge is deliberately left in place.
    expect(ctx.git('-C', worktreePath, 'merge', 'sideline').exitCode).not.toBe(0);
    expect(
      ctx.git('-C', worktreePath, 'rev-parse', '--verify', 'MERGE_HEAD').exitCode,
    ).toBe(0);
  }

  async function startedTaskWithStrandedMerge(goal: string): Promise<string> {
    const taskId = await createTask(ctx, goal, 'Some work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));

    const waitResult = await ctx.lazy(['wait', taskId]);
    if (waitResult.exitCode !== 0) {
      throw new Error(`wait failed for ${taskId}: ${waitResult.stderr}\n${waitResult.stdout}`);
    }

    leaveConflictedMerge(join(ctx.root, '.lazy', 'worktrees', taskId));
    return taskId;
  }

  // INVARIANT (fix-sync-silent-conflict): the status surfaces tell the truth
  // about a mid-merge worktree. `blocked` on its own is a lie when files on disk
  // are still conflicted, so show and wait must both say so.
  test('show and wait report a half-merged worktree instead of a bare status', async () => {
    const taskId = await startedTaskWithStrandedMerge('stranded merge visibility');

    const show = await ctx.lazy(['show', taskId]);
    expectSuccess(show);
    expectOutput(show, 'unresolved merge');
    expectOutput(show, 'conflicted.txt');
    expectOutput(show, `lazy sync ${taskId}`);

    // The task is already blocked, so wait returns immediately — with the merge
    // state attached, not just "Task X is now blocked".
    const wait = await ctx.lazy(['wait', taskId]);
    expectOutput(wait, 'blocked');
    expectOutput(wait, 'unresolved merge');
    expectOutput(wait, `lazy sync ${taskId}`);
  });

  // INVARIANT (fix-sync-silent-conflict): accept distinguishes a mid-merge
  // worktree from ordinary uncommitted changes. "Commit or stash" is actively
  // wrong advice for a conflicted merge.
  test('accept refuses with the merge diagnosis, not "commit or stash"', async () => {
    const taskId = await startedTaskWithStrandedMerge('stranded merge accept guard');

    const accept = await ctx.lazy(['accept', taskId, '--yes']);
    expectFailure(accept);

    const output = `${accept.stdout}${accept.stderr}`;
    expect(output).toContain('unresolved merge');
    expect(output).toContain(`lazy sync ${taskId}`);
    expect(output).not.toContain('Commit or stash');
  });
});
