/**
 * Tests for accept refusing when parent task has an active worktree.
 *
 * INVARIANT: Accepting a child task merges into the parent's branch.
 * If the parent has an active worktree (working, interrupted, pairing, or
 * merging status), merging into it would corrupt the agent's state or
 * conflict with ongoing work. Accept must refuse.
 */

import { describe, test, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/** Find the full task UUID from a short (8-char) prefix. */
function findFullTaskId(root: string, shortId: string): string {
  const tasksDir = join(root, '.lazy', 'tasks');
  const dirs = readdirSync(tasksDir);
  const match = dirs.find(d => d.startsWith(shortId));
  if (!match) throw new Error(`Task directory not found for ${shortId}`);
  return match;
}

/** Read task.json for direct manipulation in tests. */
function readTaskJson(root: string, shortId: string): any {
  const fullId = findFullTaskId(root, shortId);
  const taskPath = join(root, '.lazy', 'tasks', fullId, 'task.json');
  return JSON.parse(readFileSync(taskPath, 'utf-8'));
}

/** Write task.json for direct manipulation in tests. */
function writeTaskJson(root: string, shortId: string, data: any): void {
  const fullId = findFullTaskId(root, shortId);
  const taskPath = join(root, '.lazy', 'tasks', fullId, 'task.json');
  writeFileSync(taskPath, JSON.stringify(data, null, 2));
}

/** Extract child task ID from "Created variant task <id>" output */
function extractVariantTaskId(output: string): string {
  const match = output.match(/Created variant task ([a-f0-9]{8})/);
  if (!match) {
    throw new Error(`Could not extract variant task ID from output: ${output}`);
  }
  return match[1];
}

/** Helper: create parent + child tasks, add a commit to child, set parent status */
async function setupParentChild(ctx: TestContext, parentStatus?: string) {
  const parentId = await createTask(ctx, 'Parent task', 'Do parent work');
  const parentStartResult = await ctx.lazyMocked(
    ['start', parentId, '--yes'],
    MOCK_CLAUDE_SUCCESS,
    { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
  );
  expectSuccess(parentStartResult);

  const branchResult = await ctx.lazyMocked(
    ['branch', parentId, '--goal', 'Child task', '--prompt', 'Do child work', '--yes'],
    MOCK_CLAUDE_SUCCESS,
    { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
  );
  expectSuccess(branchResult);
  const childId = extractVariantTaskId(branchResult.stdout);

  const childWorktree = join(ctx.root, '.lazy', 'worktrees', childId);
  writeFileSync(join(childWorktree, 'child-work.txt'), 'child content\n');
  ctx.git('-C', childWorktree, 'add', 'child-work.txt');
  ctx.git('-C', childWorktree, 'commit', '-m', 'Child work commit');

  if (parentStatus) {
    const parentJson = readTaskJson(ctx.root, parentId);
    parentJson.status = parentStatus;
    writeTaskJson(ctx.root, parentId, parentJson);
  }

  return { parentId, childId };
}

describe('accept with working parent', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: Accepting a child task when the parent is working would merge
  // into the agent's active worktree, corrupting its state. Must refuse.
  test('refuses accept when parent task is working', async () => {
    const { childId } = await setupParentChild(ctx, 'working');

    const acceptResult = await ctx.lazy(['accept', childId, '--reason', 'LGTM']);
    expectFailure(acceptResult);
    expectError(acceptResult, 'currently working');
    expectError(acceptResult, 'surprise the agent or human');
    expectError(acceptResult, 'Wait for the parent task to become blocked');
  });

  // INVARIANT: Accepting a child task when the parent is pairing would surprise
  // the human interactively working in the worktree. Must refuse.
  test('refuses accept when parent task is pairing', async () => {
    const { childId } = await setupParentChild(ctx, 'pairing');

    const acceptResult = await ctx.lazy(['accept', childId, '--reason', 'LGTM']);
    expectFailure(acceptResult);
    expectError(acceptResult, 'currently pairing');
    expectError(acceptResult, 'surprise the agent or human');
  });

  // INVARIANT: Accepting when parent is interrupted shows a different hint:
  // the user can unblock the parent to resume it.
  test('refuses accept when parent is interrupted and suggests unblock', async () => {
    const { parentId, childId } = await setupParentChild(ctx, 'interrupted');

    const acceptResult = await ctx.lazy(['accept', childId, '--reason', 'LGTM']);
    expectFailure(acceptResult);
    expectError(acceptResult, 'currently interrupted');
    expectError(acceptResult, 'lazy resume');
  });

  test('accept succeeds when parent is blocked (not working)', async () => {
    // 1. Create and start a parent task (ends in blocked state after mock)
    const parentId = await createTask(ctx, 'Parent task', 'Do parent work');
    const parentStartResult = await ctx.lazyMocked(
      ['start', parentId, '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(parentStartResult);

    // 2. Create a child task
    const branchResult = await ctx.lazyMocked(
      ['branch', parentId, '--goal', 'Child task', '--prompt', 'Do child work', '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(branchResult);
    const childId = extractVariantTaskId(branchResult.stdout);

    // 3. Add a commit to the child worktree
    const childWorktree = join(ctx.root, '.lazy', 'worktrees', childId);
    writeFileSync(join(childWorktree, 'child-work.txt'), 'child content\n');
    ctx.git('-C', childWorktree, 'add', 'child-work.txt');
    ctx.git('-C', childWorktree, 'commit', '-m', 'Child work commit');

    // 4. Remove parent worktree so the local driver's squash merge can
    //    check out the parent branch. (The test is about verifying accept
    //    works normally when parent is blocked — no guard should fire.)
    const parentWorktree = join(ctx.root, '.lazy', 'worktrees', parentId);
    ctx.git('worktree', 'remove', '--force', parentWorktree);

    // 5. Parent is in 'blocked' state (default after mock completes) — accept should work
    const acceptResult = await ctx.lazy(['accept', childId, '--reason', 'LGTM']);
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'Merged into parent task');
  });
});
