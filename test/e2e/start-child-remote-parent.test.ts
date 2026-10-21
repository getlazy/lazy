/**
 * E2E: a child task starts on a machine where its parent has no local
 * worktree, no local branch and no session — only a branch on the remote.
 *
 * That is the distributed case (a VM clone, a colleague's machine, a Teams
 * project): the parent ran somewhere else and pushed its branch. Start used to
 * refuse with "parent task has no worktree. Start the parent first", advice
 * the user cannot follow when the parent already ran elsewhere. Start now
 * restores the parent's branch (local worktree, then local branch, then the
 * remote) and cuts the child from it through the same resolution as before.
 *
 * Daemonless, like start-target-branch.test.ts: the behaviour lives in
 * launchTask's validation, which runs in-process under LAZY_TEST.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectError, extractTaskId } from '../helpers/assertions';
import { MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { readTaskJson, readSessionJson, worktreePathFor } from '../helpers/storage';

describe('lazy start (child of a parent that exists only on the remote)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    const bare = mkdtempSync(join(tmpdir(), 'lazy-e2e-bare-'));
    Bun.spawnSync(['git', 'init', '--bare', bare]);
    expect(ctx.git('remote', 'add', 'origin', bare).exitCode).toBe(0);
    expect(ctx.git('push', 'origin', 'main').exitCode).toBe(0);
    ctx.git('remote', 'set-head', 'origin', 'main');
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function createParentAndChild(): Promise<{ parentId: string; childId: string; parentBranch: string }> {
    const parent = await ctx.lazy(['create', '--goal', 'Parent', '--prompt', 'Parent work']);
    expectSuccess(parent);
    const parentId = extractTaskId(parent.stdout);
    const child = await ctx.lazy(['create', '--goal', 'Child', '--prompt', 'Child work', '--parent', parentId]);
    expectSuccess(child);
    const childId = extractTaskId(child.stdout);
    // An unstarted parent's branch is named from its short id (no task_ref yet).
    const parentBranch = `lazy/${readTaskJson(ctx.root, parentId).metadata?.task_ref ?? parentId}`;
    return { parentId, childId, parentBranch };
  }

  // INVARIANT: a child whose parent ran elsewhere starts from the parent's
  // branch on the remote. Refusing with "start the parent first" stranded every
  // child in distributed setups, where the parent's worktree is on another machine.
  test('starts the child from the parent branch fetched from the remote', async () => {
    const { childId, parentBranch } = await createParentAndChild();

    // The parent's work exists ONLY on origin: push it, then remove it locally.
    expect(ctx.git('checkout', '-b', parentBranch).exitCode).toBe(0);
    writeFileSync(join(ctx.root, 'parent-marker.txt'), 'parent\n');
    ctx.git('add', 'parent-marker.txt');
    ctx.git('commit', '-m', 'Parent work done elsewhere');
    const parentSha = ctx.git('rev-parse', 'HEAD').stdout.trim();
    expect(ctx.git('push', 'origin', parentBranch).exitCode).toBe(0);
    expect(ctx.git('checkout', 'main').exitCode).toBe(0);
    expect(ctx.git('branch', '-D', parentBranch).exitCode).toBe(0);

    const result = await ctx.lazyMocked(['start', childId, '--yes'], MOCK_CLAUDE_SUCCESS);
    expectSuccess(result);

    const worktree = worktreePathFor(ctx.root, childId);
    expect(ctx.git('-C', worktree, 'merge-base', '--is-ancestor', parentSha, 'HEAD').exitCode).toBe(0);
    expect(ctx.git('-C', worktree, 'cat-file', '-e', 'HEAD:parent-marker.txt').exitCode).toBe(0);
  });

  // INVARIANT: a parent that RAN elsewhere (shared store: its session is
  // recorded, but its worktree and branch are on another machine) is restored
  // from the remote under its recorded branch, and the child starts from it.
  test('starts the child when the parent has a session but only a remote branch', async () => {
    const { parentId, childId } = await createParentAndChild();
    expectSuccess(await ctx.lazyMocked(['start', parentId, '--yes'], MOCK_CLAUDE_SUCCESS));
    const session = readSessionJson(ctx.root, parentId);
    expect(session?.git_branch).toBeTruthy();
    const branch = session!.git_branch as string;
    const parentWorktree = worktreePathFor(ctx.root, parentId);
    const parentSha = ctx.git('-C', parentWorktree, 'rev-parse', 'HEAD').stdout.trim();

    expect(ctx.git('push', 'origin', branch).exitCode).toBe(0);
    expect(ctx.git('worktree', 'remove', '--force', parentWorktree).exitCode).toBe(0);
    expect(ctx.git('branch', '-D', branch).exitCode).toBe(0);

    const result = await ctx.lazyMocked(['start', childId, '--yes'], MOCK_CLAUDE_SUCCESS);
    expectSuccess(result);
    const worktree = worktreePathFor(ctx.root, childId);
    expect(ctx.git('-C', worktree, 'merge-base', '--is-ancestor', parentSha, 'HEAD').exitCode).toBe(0);
  });

  // INVARIANT: when the parent's branch exists nowhere (never started, never
  // pushed), start refuses and names the branch — it never silently cuts the
  // child from the default branch.
  test('refuses clearly when the parent branch exists nowhere', async () => {
    const { childId, parentBranch } = await createParentAndChild();

    const result = await ctx.lazyMocked(['start', childId, '--yes'], MOCK_CLAUDE_SUCCESS);
    expectFailure(result);
    expectError(result, parentBranch);
    expectError(result, 'lazy start');
  });
});
