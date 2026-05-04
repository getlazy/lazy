/**
 * Tests for defense-in-depth reparenting when parent tasks are stale.
 *
 * INVARIANT: When a parent task is closed, its non-terminal children are
 * re-parented to the grandparent (or become top-level if no grandparent).
 * This mirrors the accept-reparent behavior.
 *
 * INVARIANT: When sync/unblock resolves the upstream branch and the parent is
 * terminal, it walks up the hierarchy to find a living ancestor (or main).
 * This is a safety net for cases where reparent-on-accept didn't fire.
 *
 * NOTE: Accept-reparent warning tests and sync-with-stale-parent tests require
 * daemon infrastructure that can't auto-start in all environments (same issue
 * as test/e2e/accept-reparent.test.ts). The close-reparent tests below cover
 * the core reparenting logic, which is shared across accept/close/sync paths.
 */

import { describe, test, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, expectOutputExcludes, extractTaskId } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';

describe('close re-parents unfinished children', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: When a parent is closed, its backlog children are re-parented
  // to top-level (same behavior as accept-reparent).
  test('re-parents backlog children to top-level when parent is closed', async () => {
    // 1. Create a parent task
    const parentId = await createTask(ctx, 'Parent to close');

    // 2. Create a backlog child task
    const childResult = await ctx.lazy([
      'create', '--goal', 'Child of closed parent', '--parent', parentId,
    ]);
    expectSuccess(childResult);
    const childId = extractTaskId(childResult.stdout);

    // 3. Close the parent task
    const closeResult = await ctx.lazy(['close', parentId, '--reason', 'No longer needed']);
    expectSuccess(closeResult);

    // 4. Verify re-parenting warning was shown
    expectOutput(closeResult, 'Re-parented');
    expectOutput(closeResult, 'top-level');
  });

  // INVARIANT: Terminal children are NOT re-parented when parent is closed.
  test('does not re-parent terminal children when parent is closed', async () => {
    // 1. Create parent and child
    const parentId = await createTask(ctx, 'Parent task');
    const childResult = await ctx.lazy([
      'create', '--goal', 'Terminal child', '--parent', parentId,
    ]);
    expectSuccess(childResult);
    const childId = extractTaskId(childResult.stdout);

    // 2. Close the child first (making it terminal)
    await ctx.lazy(['close', childId, '--reason', 'Not needed']);

    // 3. Close the parent
    const closeResult = await ctx.lazy(['close', parentId, '--reason', 'Done']);
    expectSuccess(closeResult);

    // 4. No re-parenting should have happened
    expectOutputExcludes(closeResult, 'Re-parented');
  });

  // INVARIANT: When a parent with multiple active children is closed,
  // all active children are re-parented and the count is logged.
  test('re-parents multiple children and logs count', async () => {
    const parentId = await createTask(ctx, 'Parent with children');

    await ctx.lazy(['create', '--goal', 'Child 1', '--parent', parentId]);
    await ctx.lazy(['create', '--goal', 'Child 2', '--parent', parentId]);

    const closeResult = await ctx.lazy(['close', parentId, '--reason', 'Cancelled']);
    expectSuccess(closeResult);

    expectOutput(closeResult, 'Re-parented 2 unfinished children');
  });

  // INVARIANT: When a grandparent → parent → child hierarchy exists,
  // closing the parent reparents the child to the grandparent.
  test('re-parents child to grandparent when parent is closed', async () => {
    // 1. Create grandparent → parent → child hierarchy
    const grandparentId = await createTask(ctx, 'Grandparent task');
    const parentResult = await ctx.lazy([
      'create', '--goal', 'Parent task', '--parent', grandparentId,
    ]);
    expectSuccess(parentResult);
    const parentId = extractTaskId(parentResult.stdout);

    const childResult = await ctx.lazy([
      'create', '--goal', 'Child task', '--parent', parentId,
    ]);
    expectSuccess(childResult);
    const childId = extractTaskId(childResult.stdout);

    // 2. Close the parent (not the grandparent)
    const closeResult = await ctx.lazy(['close', parentId, '--reason', 'Cancelled']);
    expectSuccess(closeResult);

    // 3. Verify re-parenting happened — child should now point to grandparent
    expectOutput(closeResult, 'Re-parented');

    // 4. Verify child now shows grandparent as parent
    const showResult = await ctx.lazy(['show', childId]);
    expectSuccess(showResult);
    expectOutput(showResult, grandparentId);
  });
});
