import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, expectOutputExcludes } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS, disablePreAccept } from '../helpers/fixtures';
import { runReconcile } from '../helpers/reconcile';

/** Extract child task ID from "Created variant task <id>" output */
function extractVariantTaskId(output: string): string {
  const match = output.match(/Created variant task ([a-f0-9]{8})/);
  if (!match) {
    throw new Error(`Could not extract variant task ID from output: ${output}`);
  }
  return match[1];
}

/** Helper: create a parent task and start it so it has a session + worktree */
async function createAndStartParent(
  ctx: TestContext,
  goal: string = 'Parent task',
  prompt: string = 'Initial prompt',
): Promise<string> {
  const parentId = await createTask(ctx, goal, prompt);
  const startResult = await ctx.lazyMocked(['start', parentId, '--yes'], MOCK_CLAUDE_SUCCESS, {
    env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
  });
  expectSuccess(startResult);
  return parentId;
}

describe('lazy branch', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    // Daemonless suite: the pre-accept turn has no runner to launch against, and
    // this file asserts on branch/accept routing rather than on that turn.
    disablePreAccept(ctx.root);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // ── Basic branch creation ───────────────────────────────────────────

  test('branches from parent task with --goal and --prompt flags', async () => {
    const parentId = await createAndStartParent(ctx);

    const result = await ctx.lazyMocked(
      ['branch', parentId, '--goal', 'Variant approach', '--prompt', 'Try a different way', '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );

    expectSuccess(result);
    expectOutput(result, 'Created variant task');
    expectOutput(result, 'Variant approach');
    expectOutput(result, `Parent:      ${parentId}`);
  });

  test('uses default goal when only --prompt is provided', async () => {
    const parentId = await createAndStartParent(ctx, 'Build feature X');

    const result = await ctx.lazyMocked(
      ['branch', parentId, '--prompt', 'Alternative approach', '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );

    expectSuccess(result);
    expectOutput(result, 'Created variant task');
    // Default goal is "parent goal (variant)"
    expectOutput(result, 'Build feature X (variant)');
  });

  test('uses parent prompt when only --goal is provided', async () => {
    const parentId = await createAndStartParent(ctx);

    const result = await ctx.lazyMocked(
      ['branch', parentId, '--goal', 'Different goal', '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );

    expectSuccess(result);
    expectOutput(result, 'Created variant task');
    expectOutput(result, 'Different goal');
  });

  test('child task has its own worktree', async () => {
    const parentId = await createAndStartParent(ctx);

    const result = await ctx.lazyMocked(
      ['branch', parentId, '--goal', 'Child task', '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );

    expectSuccess(result);
    const childId = extractVariantTaskId(result.stdout);

    // Child worktree should exist
    const childWorktreePath = join(ctx.root, '.lazy', 'worktrees', childId);
    expect(existsSync(childWorktreePath)).toBe(true);
  });

  test('child task worktree is based on parent HEAD', async () => {
    const parentId = await createAndStartParent(ctx);

    // Get parent's current HEAD
    const parentWorktreePath = join(ctx.root, '.lazy', 'worktrees', parentId);
    const parentHead = ctx.git('-C', parentWorktreePath, 'rev-parse', 'HEAD');
    expect(parentHead.exitCode).toBe(0);

    const result = await ctx.lazyMocked(
      ['branch', parentId, '--goal', 'Child from parent HEAD', '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );

    expectSuccess(result);
    // The branch-from SHA should appear in the output
    expectOutput(result, `Branch from: ${parentHead.stdout.trim().substring(0, 8)}`);
  });

  // ── Branch with optional flags ──────────────────────────────────────

  test('branch with --model flag sets child model', async () => {
    const parentId = await createAndStartParent(ctx);

    const result = await ctx.lazyMocked(
      ['branch', parentId, '--goal', 'Use haiku', '--model', 'claude-haiku-4-5-20251001', '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );

    expectSuccess(result);
    // `branch` echoes the model string it was given verbatim — it does not
    // shorten or alias it. (Commit 5649fcc2 switched the flag value from
    // "haiku" to the full id without updating this assertion.)
    expectOutput(result, 'Model:       claude-haiku-4-5-20251001');
  });

  test('branch with --code flag sets child code', async () => {
    const parentId = await createAndStartParent(ctx);

    const result = await ctx.lazyMocked(
      ['branch', parentId, '--goal', 'Redis variant', '--code', 'try-redis', '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );

    expectSuccess(result);
    expectOutput(result, 'Code:        try-redis');
  });

  // ── Error cases ─────────────────────────────────────────────────────

  test('fails without TTY when no flags provided', async () => {
    const parentId = await createAndStartParent(ctx);

    // Try to branch without flags (requires TTY)
    const result = await ctx.lazy(['branch', parentId]);

    expectFailure(result);
    expectError(result, 'This command requires an interactive terminal');
  });

  test('fails when parent has no session', async () => {
    const parentId = await createTask(ctx, 'Not started yet');

    const result = await ctx.lazy(['branch', parentId, '--goal', 'Child']);

    expectFailure(result);
    expectError(result, 'has no session');
  });

  test('fails when no task ID provided', async () => {
    const result = await ctx.lazy(['branch']);

    expectFailure(result);
    // Should show usage
    expectOutput(result, 'Usage: lazy branch');
  });

  test('fails when parent task does not exist', async () => {
    const result = await ctx.lazy(['branch', 'deadbeef', '--goal', 'Child']);

    expectFailure(result);
    expectError(result, 'No task found matching');
  });

  // ── Show displays parent relationship ───────────────────────────────

  test('show displays parent task info for child', async () => {
    const parentId = await createAndStartParent(ctx, 'Parent goal text');

    const branchResult = await ctx.lazyMocked(
      ['branch', parentId, '--goal', 'Child goal text', '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(branchResult);
    const childId = extractVariantTaskId(branchResult.stdout);

    // Show child task
    const showResult = await ctx.lazy(['show', childId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'Parent Task:');
    expectOutput(showResult, parentId);
    expectOutput(showResult, 'Parent goal text');
    expectOutput(showResult, 'Branched from:');
  });

  test('show displays child tasks for parent', async () => {
    const parentId = await createAndStartParent(ctx, 'Parent for children');

    const branchResult = await ctx.lazyMocked(
      ['branch', parentId, '--goal', 'Child variant', '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(branchResult);

    // Show parent task - should list child
    const showResult = await ctx.lazy(['show', parentId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'Child Tasks (variants):');
    expectOutput(showResult, 'Child variant');
  });

  // ── List shows hierarchy ────────────────────────────────────────────

  test('list shows parent-child relationship in tree view', async () => {
    const parentId = await createAndStartParent(ctx, 'Tree parent');

    const branchResult = await ctx.lazyMocked(
      ['branch', parentId, '--goal', 'Tree child', '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(branchResult);

    // List should show tree structure with both tasks
    const listResult = await ctx.lazy(['list']);
    expectSuccess(listResult);
    expectOutput(listResult, 'Tree parent');
    expectOutput(listResult, 'Tree child');
  });

  test('list --flat shows parent column for child tasks', async () => {
    const parentId = await createAndStartParent(ctx, 'Flat parent');

    const branchResult = await ctx.lazyMocked(
      ['branch', parentId, '--goal', 'Flat child', '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(branchResult);

    // Flat list should show parent ID for child
    const listResult = await ctx.lazy(['list', '--flat']);
    expectSuccess(listResult);
    expectOutput(listResult, 'PARENT');
    expectOutput(listResult, parentId);
  });

  // ── Accept child task merges into parent ─────────────────────────────

  test('accept child succeeds while the parent worktree still exists', async () => {
    // This used to be a known limitation: the squash merge ran
    // `git checkout lazy/<parentId>` in the root repo, which git refuses while
    // the parent's worktree has that branch checked out. Accept now merges into
    // the parent branch WITHOUT checking it out, so a live parent worktree is no
    // longer in the way — that is what this pins.
    const parentId = await createAndStartParent(ctx, 'Merge parent');

    const branchResult = await ctx.lazyMocked(
      ['branch', parentId, '--goal', 'Merge child', '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(branchResult);
    const childId = extractVariantTaskId(branchResult.stdout);

    // Make a commit in the child worktree
    const childWorktreePath = join(ctx.root, '.lazy', 'worktrees', childId);
    writeFileSync(join(childWorktreePath, 'child-file.txt'), 'child content\n');
    const gitAdd = ctx.git('-C', childWorktreePath, 'add', 'child-file.txt');
    expect(gitAdd.exitCode).toBe(0);
    const gitCommit = ctx.git('-C', childWorktreePath, 'commit', '-m', 'Child work');
    expect(gitCommit.exitCode).toBe(0);

    // `branch --yes` STARTS the child, so it sits in `working` until something
    // reconciles it. This suite is daemonless, so drive one reconcile pass by
    // hand — otherwise accept refuses at the status gate ("still working") and
    // never reaches the merge this test is about.
    await runReconcile(ctx.root, ctx.protocolBase);

    const acceptResult = await ctx.lazy(['accept', childId, '--yes']);
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'accepted and merged');

    // The parent's checked-out worktree is untouched and still on its branch.
    const parentWorktreePath = join(ctx.root, '.lazy', 'worktrees', parentId);
    expect(existsSync(parentWorktreePath)).toBe(true);
    const parentBranch = ctx.git('-C', parentWorktreePath, 'rev-parse', '--abbrev-ref', 'HEAD');
    expect(parentBranch.stdout.trim()).toBe(`lazy/${parentId}`);
  });

  test('accept child merges into the parent branch, not main', async () => {
    // INVARIANT: a variant merges back into the branch it was cut from. Asserted
    // on git state rather than on console text, which is presentation.
    const parentId = await createAndStartParent(ctx, 'Target parent');

    const branchResult = await ctx.lazyMocked(
      ['branch', parentId, '--goal', 'Target child', '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(branchResult);
    const childId = extractVariantTaskId(branchResult.stdout);

    // Make a commit in the child worktree
    const childWorktreePath = join(ctx.root, '.lazy', 'worktrees', childId);
    writeFileSync(join(childWorktreePath, 'child-file.txt'), 'child content\n');
    ctx.git('-C', childWorktreePath, 'add', 'child-file.txt');
    ctx.git('-C', childWorktreePath, 'commit', '-m', 'Child work');

    // Daemonless suite: reconcile the started child out of `working` so accept
    // gets past the status gate (see the sibling test above).
    await runReconcile(ctx.root, ctx.protocolBase);

    const acceptResult = await ctx.lazy(['accept', childId, '--yes']);
    expectSuccess(acceptResult);

    // The child's file is on the parent's branch...
    const onParent = ctx.git('-C', ctx.root, 'show', `lazy/${parentId}:child-file.txt`);
    expect(onParent.exitCode).toBe(0);
    expect(onParent.stdout).toContain('child content');

    // ...and NOT on main.
    const onMain = ctx.git('-C', ctx.root, 'show', 'main:child-file.txt');
    expect(onMain.exitCode).not.toBe(0);
  });

  // ── Reject child task ───────────────────────────────────────────────

  test('reject child task cleans up worktree', async () => {
    const parentId = await createAndStartParent(ctx, 'Reject parent');

    const branchResult = await ctx.lazyMocked(
      ['branch', parentId, '--goal', 'Reject child', '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(branchResult);
    const childId = extractVariantTaskId(branchResult.stdout);

    // Reject child
    const rejectResult = await ctx.lazy(['reject', childId, '--reason', 'Wrong approach', '--yes']);
    expectSuccess(rejectResult);
    expectOutput(rejectResult, 'rejected');

    // Child worktree should be cleaned up
    const childWorktreePath = join(ctx.root, '.lazy', 'worktrees', childId);
    expect(existsSync(childWorktreePath)).toBe(false);
  });

  test('reject child does not affect parent branch', async () => {
    const parentId = await createAndStartParent(ctx, 'Safe parent');

    // Make a commit in parent worktree first
    const parentWorktreePath = join(ctx.root, '.lazy', 'worktrees', parentId);
    writeFileSync(join(parentWorktreePath, 'parent-file.txt'), 'parent content\n');
    ctx.git('-C', parentWorktreePath, 'add', 'parent-file.txt');
    ctx.git('-C', parentWorktreePath, 'commit', '-m', 'Parent work');

    // Branch
    const branchResult = await ctx.lazyMocked(
      ['branch', parentId, '--goal', 'Expendable child', '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(branchResult);
    const childId = extractVariantTaskId(branchResult.stdout);

    // Make a commit in child that we'll reject
    const childWorktreePath = join(ctx.root, '.lazy', 'worktrees', childId);
    writeFileSync(join(childWorktreePath, 'bad-file.txt'), 'bad content\n');
    ctx.git('-C', childWorktreePath, 'add', 'bad-file.txt');
    ctx.git('-C', childWorktreePath, 'commit', '-m', 'Bad work');

    // Reject child
    await ctx.lazy(['reject', childId, '--reason', 'Not needed', '--yes']);

    // Parent worktree should still be intact with its file
    expect(existsSync(join(parentWorktreePath, 'parent-file.txt'))).toBe(true);
    // Parent should NOT have the child's bad file
    expect(existsSync(join(parentWorktreePath, 'bad-file.txt'))).toBe(false);
  });

  // ── Multiple children from same parent ──────────────────────────────

  test('multiple children can branch from same parent', async () => {
    const parentId = await createAndStartParent(ctx, 'Multi-child parent');

    // Create first child
    const branch1 = await ctx.lazyMocked(
      ['branch', parentId, '--goal', 'First child', '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(branch1);
    const child1Id = extractVariantTaskId(branch1.stdout);

    // Create second child
    const branch2 = await ctx.lazyMocked(
      ['branch', parentId, '--goal', 'Second child', '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(branch2);
    const child2Id = extractVariantTaskId(branch2.stdout);

    // Both children should exist
    expect(child1Id).not.toBe(child2Id);

    // Show parent should list both children
    const showResult = await ctx.lazy(['show', parentId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'Child Tasks (variants):');
    expectOutput(showResult, 'First child');
    expectOutput(showResult, 'Second child');
  });
});
