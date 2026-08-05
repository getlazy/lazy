/**
 * Tests for accept refusing when parent task has an active worktree.
 *
 * INVARIANT: Accepting a child task merges into the parent's branch.
 * If the parent has an active worktree (working, interrupted, pairing, or
 * merging status), merging into it would corrupt the agent's state or
 * conflict with ongoing work. Accept must refuse.
 *
 * The one exemption: the parent's OWN agent accepting one of its subtasks over
 * MCP, and only while the parent is `working` or `pairing`
 * (ACTIVE_PARENT_EXEMPT_STATUSES in src/daemon/task-lifecycle.ts). Both statuses
 * describe a worktree with exactly one actor in it, and that actor is the one
 * blocked inside this very accept call, so nothing else is touching the
 * worktree. `merging` and `interrupted` are exempt for nobody — no caller,
 * agent or otherwise, may merge into a parent in those states. The exemption is
 * an identity match on the merge destination and does not weaken anything
 * asserted here — every caller in this file is the CLI, which never sets it.
 * See test/e2e/mcp-agent-accept.test.ts.
 */

import { describe, test, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/**
 * Resolve the tasks directory for the test project. Test projects init with
 * external storage (external_path in lazy.toml), so tasks live outside the repo
 * — reading root/.lazy/tasks finds nothing. Fall back to the in-repo layout only
 * when no external_path is configured. Mirrors tasksDirFor() in
 * auto-react-budget.test.ts / reconcile.test.ts.
 */
function tasksDirFor(root: string): string {
  const toml = readFileSync(join(root, 'lazy.toml'), 'utf-8');
  const m = toml.match(/^external_path\s*=\s*"(.+)"/m);
  if (m && m[1]) return join(m[1], 'tasks');
  return join(root, '.lazy', 'tasks');
}

/** Find the full task UUID from a short (8-char) prefix. */
function findFullTaskId(root: string, shortId: string): string {
  const tasksDir = tasksDirFor(root);
  const dirs = readdirSync(tasksDir);
  const match = dirs.find(d => d.startsWith(shortId));
  if (!match) throw new Error(`Task directory not found for ${shortId}`);
  return match;
}

/** Read task.json for direct manipulation in tests. */
function readTaskJson(root: string, shortId: string): any {
  const fullId = findFullTaskId(root, shortId);
  const taskPath = join(tasksDirFor(root), fullId, 'task.json');
  return JSON.parse(readFileSync(taskPath, 'utf-8'));
}

/** Write task.json for direct manipulation in tests. */
function writeTaskJson(root: string, shortId: string, data: any): void {
  const fullId = findFullTaskId(root, shortId);
  const taskPath = join(tasksDirFor(root), fullId, 'task.json');
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

/**
 * Wait for the reconciler to move a task out of 'working'. The explicit `wait`
 * is mandatory because `start`/`branch` launch the supervisor asynchronously
 * under the daemon; without it accept refuses ("Task X is still working").
 */
async function waitForTask(ctx: TestContext, taskId: string): Promise<void> {
  const waitResult = await ctx.lazy(['wait', taskId]);
  if (waitResult.exitCode !== 0) {
    throw new Error(`wait failed for ${taskId}: ${waitResult.stderr}\n${waitResult.stdout}`);
  }
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
  await waitForTask(ctx, parentId);

  const branchResult = await ctx.lazyMocked(
    ['branch', parentId, '--goal', 'Child task', '--prompt', 'Do child work', '--yes'],
    MOCK_CLAUDE_SUCCESS,
    { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
  );
  expectSuccess(branchResult);
  const childId = extractVariantTaskId(branchResult.stdout);
  await waitForTask(ctx, childId);

  const childWorktree = join(ctx.root, '.lazy', 'worktrees', childId);
  writeFileSync(join(childWorktree, 'child-work.txt'), 'child content\n');
  ctx.git('-C', childWorktree, 'add', 'child-work.txt');
  ctx.git('-C', childWorktree, 'commit', '-m', 'Child work commit');

  // Set the parent status LAST, right before the accept under test, to minimize
  // the window in which the daemon reconciler could sweep an artificially-set
  // 'working'/'pairing'/'interrupted' parent (whose supervisor already exited).
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
    // INVARIANT: `start`/`branch`/`accept` need a real daemon. Daemonless, the
    // task stays 'working' and accept refuses ("Task X is still working").
    // Mirrors accept-reason / accept-gates.
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: Accepting a child task when the parent is working would merge
  // into the agent's active worktree, corrupting its state. Must refuse.
  // The refusal message is now a single unified form for every active status:
  // "Parent task X is currently <status>. Wait for it to become blocked."
  test('refuses accept when parent task is working', async () => {
    const { childId } = await setupParentChild(ctx, 'working');

    const acceptResult = await ctx.lazy(['accept', childId, '--reason', 'LGTM']);
    expectFailure(acceptResult);
    expectError(acceptResult, 'currently working');
    expectError(acceptResult, 'Wait for it to become blocked');
  }, 15000);

  // INVARIANT: Accepting a child task when the parent is pairing would surprise
  // the human interactively working in the worktree. Must refuse.
  test('refuses accept when parent task is pairing', async () => {
    const { childId } = await setupParentChild(ctx, 'pairing');

    const acceptResult = await ctx.lazy(['accept', childId, '--reason', 'LGTM']);
    expectFailure(acceptResult);
    expectError(acceptResult, 'currently pairing');
    expectError(acceptResult, 'Wait for it to become blocked');
  }, 15000);

  // INVARIANT: Accepting when the parent is interrupted also refuses — the
  // parent still has an active worktree. Same unified refusal message.
  test('refuses accept when parent is interrupted', async () => {
    const { childId } = await setupParentChild(ctx, 'interrupted');

    const acceptResult = await ctx.lazy(['accept', childId, '--reason', 'LGTM']);
    expectFailure(acceptResult);
    expectError(acceptResult, 'currently interrupted');
    expectError(acceptResult, 'Wait for it to become blocked');
  }, 15000);

  test('accept succeeds when parent is blocked (not working)', async () => {
    // 1. Create and start a parent task (ends in blocked state after mock)
    const parentId = await createTask(ctx, 'Parent task', 'Do parent work');
    const parentStartResult = await ctx.lazyMocked(
      ['start', parentId, '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(parentStartResult);
    await waitForTask(ctx, parentId);

    // 2. Create a child task
    const branchResult = await ctx.lazyMocked(
      ['branch', parentId, '--goal', 'Child task', '--prompt', 'Do child work', '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(branchResult);
    const childId = extractVariantTaskId(branchResult.stdout);
    await waitForTask(ctx, childId);

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

    // 5. Parent is in 'blocked' state (default after mock completes) — accept
    //    should work (no working-parent guard fires). The success message is
    //    now the unified "accepted and merged." (it no longer names the parent).
    const acceptResult = await ctx.lazy(['accept', childId, '--reason', 'LGTM']);
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'accepted and merged');
  }, 15000);
});
