/**
 * E2E tests for `lazy start` honoring a top-level task's STORED branch target.
 *
 * `lazy create --parent release-x` persists { kind: 'branch', branch: 'release-x' }
 * on a top-level task. `lazy start` used to ignore it entirely: it resolved the
 * repo default branch, branched the worktree from there, and then overwrote the
 * stored target with the default — no warning. The user's explicit instruction
 * was silently discarded, which is exactly the silent-wrongness CLAUDE.md's
 * "principle of least surprise" forbids.
 *
 * These run WITHOUT a daemon so `lazy start` executes launchTask() in-process
 * (queryStartTask → handleStartTask fallback under LAZY_TEST), the same reason
 * start-offline.test.ts does. The behavior under test lives entirely in
 * launchTask's top-level branch-resolution path.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { writeFileSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectError, extractTaskId } from '../helpers/assertions';
import { MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { readTaskJson, worktreePathFor } from '../helpers/storage';

describe('lazy start (stored branch target)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /**
   * Create `release-x` with a commit that exists ONLY on it, then return to
   * main. The distinguishing file is how we tell which branch the worktree was
   * actually based on — a merge-base assertion alone can't, since release-x
   * descends from main.
   */
  function makeReleaseBranch(name = 'release-x'): string {
    expect(ctx.git('checkout', '-b', name).exitCode).toBe(0);
    writeFileSync(join(ctx.root, 'release-marker.txt'), `${name}\n`);
    ctx.git('add', 'release-marker.txt');
    ctx.git('commit', '-m', `Release-only commit on ${name}`);
    const sha = ctx.git('rev-parse', 'HEAD').stdout.trim();
    expect(ctx.git('checkout', 'main').exitCode).toBe(0);
    return sha;
  }

  async function createWithParent(parent: string): Promise<string> {
    const result = await ctx.lazy([
      'create', '--goal', 'Targeted task', '--prompt', 'Do the work', '--parent', parent,
    ]);
    expectSuccess(result);
    return extractTaskId(result.stdout);
  }

  // INVARIANT: an explicit `--parent <branch>` on a top-level task is the user's
  // instruction about where the work is based and where it integrates. `start`
  // must branch the worktree from THAT branch, not from the repo default.
  test('branches the worktree from the stored target branch, not the repo default', async () => {
    const releaseSha = makeReleaseBranch();
    const taskId = await createWithParent('release-x');

    const result = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
    expectSuccess(result);

    const worktree = worktreePathFor(ctx.root, taskId);

    // The release-only commit must be an ancestor of the worktree branch.
    const contains = ctx.git('-C', worktree, 'merge-base', '--is-ancestor', releaseSha, 'HEAD');
    expect(contains.exitCode).toBe(0);

    // And its file must be present — proof we branched from release-x, not main.
    const marker = ctx.git('-C', worktree, 'cat-file', '-e', 'HEAD:release-marker.txt');
    expect(marker.exitCode).toBe(0);
  });

  // INVARIANT: start must not overwrite a stored branch target with the branch it
  // resolved. The write at publish time is a "fill the empty slot" write, never a
  // clobber — otherwise accept (which reads targetBranchOf) would later merge
  // into the wrong branch even though the worktree was based correctly.
  test('preserves the stored branch target across start', async () => {
    makeReleaseBranch();
    const taskId = await createWithParent('release-x');

    expect(readTaskJson(ctx.root, taskId).target).toEqual({ kind: 'branch', branch: 'release-x' });

    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));

    expect(readTaskJson(ctx.root, taskId).target).toEqual({ kind: 'branch', branch: 'release-x' });
  });

  // INVARIANT: an unresolvable stored target fails LOUDLY. Falling back to the
  // repo default would silently base the task on the wrong branch — the very bug
  // this suite exists for. The message must name the branch and give a way out.
  test('fails actionably when the stored target branch no longer resolves', async () => {
    makeReleaseBranch();
    const taskId = await createWithParent('release-x');

    // Branch deleted after creation (renamed, pruned, or never pushed).
    expect(ctx.git('branch', '-D', 'release-x').exitCode).toBe(0);

    const result = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
    expectFailure(result);
    expectError(result, 'release-x');
    expectError(result, 'lazy reparent');

    // The task must NOT have been quietly retargeted to the default.
    expect(readTaskJson(ctx.root, taskId).target).toEqual({ kind: 'branch', branch: 'release-x' });
  });

  // INVARIANT: --force-local with a stored target means "that branch's LOCAL
  // ref", never the repo's current HEAD. Reaching for HEAD here would resurrect
  // the silent-discard bug through the fallback path. With the branch gone,
  // there is no local ref either, so it must still fail loudly.
  test('--force-local does not silently fall back to the default branch', async () => {
    makeReleaseBranch();
    const taskId = await createWithParent('release-x');
    expect(ctx.git('branch', '-D', 'release-x').exitCode).toBe(0);

    const result = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--force-local'],
      MOCK_CLAUDE_SUCCESS,
    );
    expectFailure(result);
    expectError(result, 'release-x');
  });

  // INVARIANT (pre-existing, guarded here): with NO stored target, start still
  // resolves the repo's configured integration branch and records it — the
  // empty-slot write must keep working after the no-clobber change.
  test('with no stored target, still resolves and records the repo default', async () => {
    makeReleaseBranch();
    // Deliberately leave the repo checked out on a non-default branch: start must
    // ignore it and use the configured integration branch.
    expect(ctx.git('checkout', 'release-x').exitCode).toBe(0);

    const cr = await ctx.lazy(['create', '--goal', 'Untargeted', '--prompt', 'Do the work']);
    expectSuccess(cr);
    const taskId = extractTaskId(cr.stdout);

    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));

    expect(readTaskJson(ctx.root, taskId).target).toEqual({ kind: 'branch', branch: 'main' });

    // Worktree is based on main, so the release-only file must be absent.
    const worktree = worktreePathFor(ctx.root, taskId);
    expect(ctx.git('-C', worktree, 'cat-file', '-e', 'HEAD:release-marker.txt').exitCode).not.toBe(0);
  });
});
