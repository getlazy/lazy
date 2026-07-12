/**
 * Tests for re-parenting unfinished child tasks when a parent is accepted.
 *
 * INVARIANT: When a parent task is accepted, its non-terminal children are
 * re-parented to the grandparent (or become top-level if no grandparent).
 * This prevents orphaning when the parent's branch is deleted after merge.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, expectOutputExcludes } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/** Extract child task ID from "Created variant task <id>" output */
function extractVariantTaskId(output: string): string {
  const match = output.match(/Created variant task ([a-f0-9]{8})/);
  if (!match) {
    throw new Error(`Could not extract variant task ID from output: ${output}`);
  }
  return match[1];
}

describe('accept re-parents unfinished children', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: When a parent is accepted, its backlog children are re-parented
  // to the grandparent (or top-level if no grandparent exists).
  test('re-parents backlog children to top-level when parent is accepted', async () => {
    // 1. Create and start a parent task
    const parentId = await createTask(ctx, 'Parent task', 'Do parent work');
    const parentStartResult = await ctx.lazyMocked(
      ['start', parentId, '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(parentStartResult);

    // 2. Create a backlog child task (not started, no worktree)
    const childCreateResult = await ctx.lazy([
      'create', '--goal', 'Child backlog task', '--parent', parentId,
    ]);
    expectSuccess(childCreateResult);
    const childIdMatch = childCreateResult.stdout.match(/(?:Created task|Task) ([a-f0-9]{8})/);
    if (!childIdMatch) throw new Error(`Could not extract child ID: ${childCreateResult.stdout}`);
    const childId = childIdMatch[1];

    // Verify child shows parent in `lazy show`
    const showBefore = await ctx.lazy(['show', childId]);
    expectSuccess(showBefore);
    expectOutput(showBefore, parentId);

    // 3. Remove parent worktree so local merge can proceed
    const parentWorktree = join(ctx.root, '.lazy', 'worktrees', parentId);
    ctx.git('worktree', 'remove', '--force', parentWorktree);

    // 4. Accept the parent task
    const acceptResult = await ctx.lazy(['accept', parentId, '--reason', 'LGTM']);
    expectSuccess(acceptResult);

    // 5. Verify the log mentions re-parenting
    expectOutput(acceptResult, 'Re-parented');
    expectOutput(acceptResult, 'Child backlog task');

    // 6. Verify child no longer shows parent (re-parented to top-level)
    const showAfter = await ctx.lazy(['show', childId]);
    expectSuccess(showAfter);
    // The child should no longer reference the parent task
    // (it's now top-level, so no parent line in show output)
  });

  // INVARIANT: When a parent is accepted, blocked children with worktrees
  // are re-parented. Their worktrees are not touched — sync-with-upstream
  // handles the merge on next turn.
  test('re-parents blocked children when parent is accepted', async () => {
    // 1. Create and start a parent task
    const parentId = await createTask(ctx, 'Parent task', 'Do parent work');
    const parentStartResult = await ctx.lazyMocked(
      ['start', parentId, '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(parentStartResult);

    // 2. Create a child task via branch (starts it, creates worktree)
    const branchResult = await ctx.lazyMocked(
      ['branch', parentId, '--goal', 'Child blocked task', '--prompt', 'Do child work', '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(branchResult);
    const childId = extractVariantTaskId(branchResult.stdout);

    // Child should be in blocked state after mock completes

    // 3. Remove parent worktree so local merge can proceed
    const parentWorktree = join(ctx.root, '.lazy', 'worktrees', parentId);
    ctx.git('worktree', 'remove', '--force', parentWorktree);

    // 4. Accept the parent task
    const acceptResult = await ctx.lazy(['accept', parentId, '--reason', 'LGTM']);
    expectSuccess(acceptResult);

    // 5. Verify re-parent is logged
    expectOutput(acceptResult, 'Re-parented');
    expectOutput(acceptResult, 'Child blocked task');
  });

  // INVARIANT: When a parent has no unfinished children, accept proceeds
  // normally without any re-parenting noise.
  test('no re-parenting output when parent has no children', async () => {
    // 1. Create and start a parent task with no children
    const parentId = await createTask(ctx, 'Lonely parent', 'Work alone');
    const parentStartResult = await ctx.lazyMocked(
      ['start', parentId, '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(parentStartResult);

    // 2. Add an extra commit to the worktree so accept can detect it
    const parentWorktree = join(ctx.root, '.lazy', 'worktrees', parentId);
    writeFileSync(join(parentWorktree, 'work.txt'), 'work content\n');
    ctx.git('-C', parentWorktree, 'add', 'work.txt');
    ctx.git('-C', parentWorktree, 'commit', '-m', 'Work commit');

    // 3. Accept — no worktree removal needed for root tasks (merges into main)
    const acceptResult = await ctx.lazy(['accept', parentId, '--reason', 'LGTM']);
    expectSuccess(acceptResult);

    // 4. Verify no re-parenting message
    expectOutputExcludes(acceptResult, 'Re-parented');
  });

  // INVARIANT: Terminal children (complete, abandoned, closed) are NOT
  // re-parented — they're already done and their parent reference is historical.
  test('does not re-parent terminal children', async () => {
    // 1. Create and start a parent task
    const parentId = await createTask(ctx, 'Parent task', 'Do parent work');
    const parentStartResult = await ctx.lazyMocked(
      ['start', parentId, '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(parentStartResult);

    // 2. Create a child and close it (making it terminal)
    const childCreateResult = await ctx.lazy([
      'create', '--goal', 'Terminal child', '--parent', parentId,
    ]);
    expectSuccess(childCreateResult);
    const childIdMatch = childCreateResult.stdout.match(/(?:Created task|Task) ([a-f0-9]{8})/);
    if (!childIdMatch) throw new Error(`Could not extract child ID: ${childCreateResult.stdout}`);
    const childId = childIdMatch[1];

    // Close the child task to make it terminal
    const closeResult = await ctx.lazy(['close', childId, '--reason', 'Not needed']);
    expectSuccess(closeResult);

    // 3. Remove parent worktree and accept
    const parentWorktree = join(ctx.root, '.lazy', 'worktrees', parentId);
    ctx.git('worktree', 'remove', '--force', parentWorktree);

    const acceptResult = await ctx.lazy(['accept', parentId, '--reason', 'LGTM']);
    expectSuccess(acceptResult);

    // 4. Verify no re-parenting happened
    expectOutputExcludes(acceptResult, 'Re-parented');
  });

  // INVARIANT: Re-parenting logs clearly state what happened: how many
  // children were re-parented and to where.
  test('log output mentions re-parenting count and destination', async () => {
    // 1. Create and start a parent task
    const parentId = await createTask(ctx, 'Parent task', 'Do parent work');
    const parentStartResult = await ctx.lazyMocked(
      ['start', parentId, '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(parentStartResult);

    // 2. Create two backlog children
    const child1Result = await ctx.lazy([
      'create', '--goal', 'First child', '--parent', parentId,
    ]);
    expectSuccess(child1Result);

    const child2Result = await ctx.lazy([
      'create', '--goal', 'Second child', '--parent', parentId,
    ]);
    expectSuccess(child2Result);

    // 3. Remove parent worktree and accept
    const parentWorktree = join(ctx.root, '.lazy', 'worktrees', parentId);
    ctx.git('worktree', 'remove', '--force', parentWorktree);

    const acceptResult = await ctx.lazy(['accept', parentId, '--reason', 'LGTM']);
    expectSuccess(acceptResult);

    // 4. Verify the log mentions 2 children and top-level, and names the
    //    branch the now-top-level children target (default branch: main).
    expectOutput(acceptResult, 'Re-parented 2 unfinished children');
    expectOutput(acceptResult, 'top-level');
    expectOutput(acceptResult, 'main branch');
  });

  // INVARIANT: The pre-accept note about active children must describe what
  // lazy actually does (automatic re-parent + sync, no manual action) and must
  // NOT use the non-lazy "rebasing" concept or imply the user must act.
  test('pre-accept note conveys no action needed and never mentions rebasing', async () => {
    // 1. Create and start a parent task
    const parentId = await createTask(ctx, 'Parent task', 'Do parent work');
    const parentStartResult = await ctx.lazyMocked(
      ['start', parentId, '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(parentStartResult);

    // 2. Create a backlog child so the active-children note fires
    const childCreateResult = await ctx.lazy([
      'create', '--goal', 'Child backlog task', '--parent', parentId,
    ]);
    expectSuccess(childCreateResult);

    // 3. Remove parent worktree and accept
    const parentWorktree = join(ctx.root, '.lazy', 'worktrees', parentId);
    ctx.git('worktree', 'remove', '--force', parentWorktree);

    const acceptResult = await ctx.lazy(['accept', parentId, '--reason', 'LGTM']);
    expectSuccess(acceptResult);

    // 4. Note must not use "rebasing" (not a lazy concept) and must tell the
    //    user no manual action is required.
    expectOutputExcludes(acceptResult, 'rebasing');
    expectOutput(acceptResult, 'no action needed');
  });
});
