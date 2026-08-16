import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/**
 * End-to-end coverage for the deleted-file resurrection guard.
 *
 * INVARIANT: an accept that would silently put back a file the target branch
 * deliberately deleted is refused until a human names each file. This is the
 * defect class documented in docs/spikes/v012-release-resurrection-audit.md,
 * where a release merge re-added the dead SSE module and it survived eight
 * releases unnoticed. The guard lives in the daemon accept path, so these tests
 * exercise the real CLI → daemon → merge route rather than the pure function
 * (which test/unit/resurrection-guard.test.ts covers).
 */
describe('lazy accept — deleted-file resurrection guard', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // `start` + `accept` need a real daemon: start launches the supervisor
    // asynchronously and the daemon reconciler is what moves the task out of
    // 'working'. Same rationale as test/e2e/accept-reason.test.ts.
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** Start a task and wait for it to settle, returning its short id. */
  async function startedTask(goal: string): Promise<string> {
    const taskId = await createTask(ctx, goal, 'Some work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    }));
    const waitResult = await ctx.lazy(['wait', taskId]);
    if (waitResult.exitCode !== 0) {
      throw new Error(`wait failed for ${taskId}: ${waitResult.stderr}\n${waitResult.stdout}`);
    }
    return taskId;
  }

  function commitInWorktree(taskId: string, file: string, content: string, message: string): void {
    const worktree = join(ctx.root, '.lazy', 'worktrees', taskId);
    writeFileSync(join(worktree, file), content);
    expect(ctx.git('-C', worktree, 'add', file).exitCode).toBe(0);
    expect(ctx.git('-C', worktree, 'commit', '-m', message).exitCode).toBe(0);
  }

  /**
   * Put a deletion of `dead.ts` into the target branch's history BEFORE the task
   * branches, so the task's merge base has no version of the file. That is the
   * shape that makes a re-add land as a silent one-sided add — a branch that
   * merely predates the deletion has the file at its merge base and git resolves
   * it correctly on its own (see the "ordinary stale branch" unit test).
   */
  function deleteFileOnTarget(): void {
    writeFileSync(join(ctx.root, 'dead.ts'), 'export const dead = 1;\n');
    expect(ctx.git('-C', ctx.root, 'add', 'dead.ts').exitCode).toBe(0);
    expect(ctx.git('-C', ctx.root, 'commit', '-m', 'Add dead.ts').exitCode).toBe(0);
    expect(ctx.git('-C', ctx.root, 'rm', '-q', 'dead.ts').exitCode).toBe(0);
    expect(ctx.git('-C', ctx.root, 'commit', '-m', 'Remove dead module').exitCode).toBe(0);
  }

  test('refuses an accept that would re-add a file the target deleted', async () => {
    deleteFileOnTarget();
    const taskId = await startedTask('Resurrect a deleted file');
    commitInWorktree(taskId, 'dead.ts', 'export const dead = 1;\n', 'Re-add dead.ts');

    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectFailure(result);

    // The refusal must be actionable on its own: what file, who deleted it,
    // and the exact command that resolves it.
    const output = result.stdout + result.stderr;
    expect(output).toContain('dead.ts');
    expect(output).toContain('Remove dead module');
    expect(output).toContain('--approve-file dead.ts');

    // And it must have refused BEFORE merging: the file is still absent on the
    // target branch.
    const onTarget = ctx.git('-C', ctx.root, 'ls-files', 'dead.ts');
    expect(onTarget.stdout.trim()).toBe('');
  });

  test('--approve-file lets the re-add through', async () => {
    deleteFileOnTarget();
    const taskId = await startedTask('Deliberately restore a deleted file');
    commitInWorktree(taskId, 'dead.ts', 'export const dead = 1;\n', 'Restore dead.ts on purpose');

    const result = await ctx.lazy(['accept', taskId, '--yes', '--approve-file', 'dead.ts']);
    expectSuccess(result);

    // The approval was honoured — the file really did land on the target.
    const onTarget = ctx.git('-C', ctx.root, 'ls-files', 'dead.ts');
    expect(onTarget.stdout.trim()).toBe('dead.ts');
  });

  // INVARIANT: the guard must be invisible on ordinary work. A gate that fires
  // on normal accepts trains everyone to approve without reading, which is worse
  // than no gate at all.
  test('an ordinary accept that adds new files is unaffected', async () => {
    const taskId = await startedTask('Ordinary work');
    commitInWorktree(taskId, 'feature.ts', 'export const f = 1;\n', 'Add feature');

    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(result);
    expect(ctx.git('-C', ctx.root, 'ls-files', 'feature.ts').stdout.trim()).toBe('feature.ts');
  });

  // INVARIANT: a branch that simply predates a deletion on the target is NOT a
  // resurrection — the file exists at its merge base, so git deletes it during
  // the merge without help. Blocking this would fire the guard on routine work.
  test('a branch that predates the deletion accepts cleanly and stays deleted', async () => {
    writeFileSync(join(ctx.root, 'doomed.ts'), 'export const d = 1;\n');
    expect(ctx.git('-C', ctx.root, 'add', 'doomed.ts').exitCode).toBe(0);
    expect(ctx.git('-C', ctx.root, 'commit', '-m', 'Add doomed.ts').exitCode).toBe(0);

    const taskId = await startedTask('Work that predates the deletion');
    commitInWorktree(taskId, 'unrelated.ts', 'export const u = 1;\n', 'Unrelated work');

    expect(ctx.git('-C', ctx.root, 'rm', '-q', 'doomed.ts').exitCode).toBe(0);
    expect(ctx.git('-C', ctx.root, 'commit', '-m', 'Delete doomed.ts').exitCode).toBe(0);

    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(result);
    expect(ctx.git('-C', ctx.root, 'ls-files', 'doomed.ts').stdout.trim()).toBe('');
  });
});
