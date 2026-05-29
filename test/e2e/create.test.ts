import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, extractTaskId } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';

describe('lazy create', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('creates a task with --goal flag', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Add authentication']);

    expectSuccess(result);
    expectOutput(result, 'Created task');
    expectOutput(result, 'Add authentication');
    expectOutput(result, 'backlog');
  });

  test('creates a task with --goal and --prompt', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Add auth', '--prompt', 'Implement OAuth2 login flow']);

    expectSuccess(result);
    expectOutput(result, 'Created task');
    expectOutput(result, 'Add auth');
    expectOutput(result, 'v1');
  });

  test('creates a task with --model flag', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Fix bug', '--model', 'claude-opus-4-6']);

    expectSuccess(result);
    expectOutput(result, 'claude-opus-4-6');
  });

  test('fails with invalid model', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Fix', '--model', 'invalid']);

    expectFailure(result);
    expectError(result, 'Invalid model');
  });

  test('fails without TTY when no flags provided', async () => {
    const result = await ctx.lazy(['create']);

    expectFailure(result);
    expectError(result, 'Interactive mode requires a TTY');
  });

  test('created task appears in list', async () => {
    await ctx.lazy(['create', '--goal', 'Test task for listing']);
    const listResult = await ctx.lazy(['list']);

    expectSuccess(listResult);
    expectOutput(listResult, 'Test task for listing');
  });

  test('created task can be shown by short ID', async () => {
    const createResult = await ctx.lazy(['create', '--goal', 'Showable task', '--prompt', 'Some prompt']);
    const taskId = extractTaskId(createResult.stdout);

    const showResult = await ctx.lazy(['show', taskId]);

    expectSuccess(showResult);
    expectOutput(showResult, 'Showable task');
    expectOutput(showResult, 'backlog');
  });

  test('creates a child task with --parent flag', async () => {
    const parentId = await createTask(ctx, 'Parent umbrella task');

    const result = await ctx.lazy(['create', '--goal', 'Child task', '--parent', parentId]);

    expectSuccess(result);
    expectOutput(result, 'Created task');
    expectOutput(result, 'Child task');
    expectOutput(result, `Parent: ${parentId}`);
  });

  test('child task shows parent in lazy show', async () => {
    const parentId = await createTask(ctx, 'Parent umbrella task');
    const childResult = await ctx.lazy(['create', '--goal', 'Child task', '--parent', parentId]);
    const childId = extractTaskId(childResult.stdout);

    const showResult = await ctx.lazy(['show', childId]);

    expectSuccess(showResult);
    expectOutput(showResult, 'Parent Task:');
    expectOutput(showResult, parentId);
    expectOutput(showResult, 'Parent umbrella task');
  });

  test('parent task shows child in lazy show', async () => {
    const parentId = await createTask(ctx, 'Parent umbrella task');
    await ctx.lazy(['create', '--goal', 'Child task', '--parent', parentId]);

    const showResult = await ctx.lazy(['show', parentId]);

    expectSuccess(showResult);
    expectOutput(showResult, 'Child Tasks (variants):');
    expectOutput(showResult, 'Child task');
  });

  test('rejects terminal-state parent', async () => {
    const parentId = await createTask(ctx, 'Will be closed');
    // Close the parent task
    await ctx.lazy(['close', parentId, '--reason', 'Done']);

    const result = await ctx.lazy(['create', '--goal', 'Child task', '--parent', parentId]);

    expectFailure(result);
    expectError(result, 'task is closed');
  });

  // INVARIANT (fix-target-adoption): when the user runs `lazy create` while
  // checked out on a non-default branch, the task target MUST NOT silently
  // adopt that branch. Top-level tasks target the repo default (origin/HEAD
  // → main) unless --parent is passed explicitly. Adopting the checked-out
  // branch produced PRs against dead release bases.
  test('does NOT adopt current branch as target when --parent is omitted', async () => {
    // Create and check out a feature branch in the test repo
    const branchResult = ctx.git('checkout', '-b', 'some-feature');
    expect(branchResult.exitCode).toBe(0);

    const result = await ctx.lazy(['create', '--goal', 'No-parent task']);
    expectSuccess(result);
    const taskId = extractTaskId(result.stdout);

    // The persisted target should NOT be 'some-feature'. We read it via show.
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    if (showResult.stdout.includes('some-feature')) {
      throw new Error(`Task adopted the current branch 'some-feature' as its target — should default to repo default. show output:\n${showResult.stdout}`);
    }
  });

  test('--parent accepts a raw branch name and persists it as target', async () => {
    const branchResult = ctx.git('checkout', '-b', 'release-x');
    expect(branchResult.exitCode).toBe(0);
    // Switch back to main so the test isn't relying on current-branch behavior
    ctx.git('checkout', 'main');

    const result = await ctx.lazy(['create', '--goal', 'Explicit branch parent', '--parent', 'release-x']);
    expectSuccess(result);
    expectOutput(result, 'Target: branch release-x');
  });

  // INVARIANT (fix-target-adoption): the explicit `--parent <branch>` flag
  // always wins, even when it disagrees with the currently checked-out branch.
  // This is the user's escape hatch from the new default-branch behavior:
  // "I really do want main, even though I'm on some-feature." Without this
  // invariant, the explicit-vs-default story collapses: the user couldn't
  // override the default in either direction.
  test('--parent main wins over the currently checked-out feature branch', async () => {
    const branchResult = ctx.git('checkout', '-b', 'some-feature');
    expect(branchResult.exitCode).toBe(0);
    // Do NOT switch back — we want to prove the explicit flag wins even while
    // checked out on the "wrong" branch.

    const result = await ctx.lazy(['create', '--goal', 'Explicit main', '--parent', 'main']);
    expectSuccess(result);
    expectOutput(result, 'Target: branch main');

    const taskId = extractTaskId(result.stdout);
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    // The persisted target must be 'main', NOT 'some-feature'.
    if (showResult.stdout.includes('some-feature')) {
      throw new Error(`Explicit --parent main was overridden by current branch 'some-feature'. show output:\n${showResult.stdout}`);
    }
  });

  test('--parent rejects a lazy/* task ref as branch', async () => {
    const branchResult = ctx.git('checkout', '-b', 'lazy/some-task');
    expect(branchResult.exitCode).toBe(0);
    ctx.git('checkout', 'main');

    const result = await ctx.lazy(['create', '--goal', 'Bad parent', '--parent', 'lazy/some-task']);
    expectFailure(result);
    expectError(result, 'not a lazy task branch');
  });

  test('rejects non-existent parent', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Child task', '--parent', 'nonexist0']);

    expectFailure(result);
    // --parent now accepts a raw branch name too, so the error mentions both
    // failure modes (not a task, not a branch).
    expectError(result, 'neither a known task nor a local git branch');
  });

  test('creates a task with --type refactor', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Refactor auth module', '--type', 'refactor']);

    expectSuccess(result);
    expectOutput(result, 'Created task');
    expectOutput(result, 'Refactor auth module');

    const taskId = extractTaskId(result.stdout);
    const showResult = await ctx.lazy(['show', taskId]);

    expectSuccess(showResult);
    expectOutput(showResult, 'Type:    refactor');
  });

  test('creates a task without --type and defaults to task', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Default type test']);

    expectSuccess(result);
    expectOutput(result, 'Created task');

    const taskId = extractTaskId(result.stdout);
    const showResult = await ctx.lazy(['show', taskId]);

    expectSuccess(showResult);
    expectOutput(showResult, 'Type:    task');
  });

  test('fails with invalid type', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Test', '--type', 'invalid-type']);

    expectFailure(result);
    expectError(result, 'Invalid type');
  });

  test('child task created with --parent branches from parent HEAD, not main', async () => {
    // INVARIANT: Child tasks created via `create --parent` must branch from
    // the parent's current HEAD at start time, not from main. This prevents
    // child tasks from missing parent's work.

    // Create and start parent task
    const parentId = await createTask(ctx, 'Parent task', 'Do parent work');
    const { MOCK_CLAUDE_SUCCESS } = await import('../helpers/fixtures');

    const startResult = await ctx.lazyMocked(['start', parentId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // Get parent's worktree and current HEAD
    const { join } = await import('path');
    const parentWorktreePath = join(ctx.root, '.lazy', 'worktrees', parentId);
    const parentHeadResult = ctx.git('-C', parentWorktreePath, 'rev-parse', 'HEAD');
    expect(parentHeadResult.exitCode).toBe(0);
    const parentHead = parentHeadResult.stdout.trim();

    // Get main HEAD for comparison
    const mainHeadResult = ctx.git('rev-parse', 'HEAD');
    expect(mainHeadResult.exitCode).toBe(0);
    const mainHead = mainHeadResult.stdout.trim();

    // Parent should be ahead of main (has at least the init commit)
    expect(parentHead).not.toBe(mainHead);

    // Create child task with --parent
    const childResult = await ctx.lazy(['create', '--goal', 'Child task', '--parent', parentId, '--prompt', 'Do child work']);
    expectSuccess(childResult);
    const childId = extractTaskId(childResult.stdout);

    // Start child task
    const startChildResult = await ctx.lazyMocked(['start', childId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startChildResult);

    // Get child's worktree and verify it branched from parent's HEAD
    const childWorktreePath = join(ctx.root, '.lazy', 'worktrees', childId);
    const mergeBaseResult = ctx.git('-C', childWorktreePath, 'merge-base', `lazy/${parentId}`, `lazy/${childId}`);
    expect(mergeBaseResult.exitCode).toBe(0);
    const mergeBase = mergeBaseResult.stdout.trim();

    // The merge base between child and parent should be the parent's HEAD
    // (i.e., child branched from parent's HEAD, not from an earlier point)
    expect(mergeBase).toBe(parentHead);
  });

  test('starting child task before parent fails with clear error', async () => {
    // Create parent task (but don't start it)
    const parentId = await createTask(ctx, 'Not yet started parent');

    // Create child task with --parent
    const childResult = await ctx.lazy(['create', '--goal', 'Child task', '--parent', parentId, '--prompt', 'Do child work']);
    expectSuccess(childResult);
    const childId = extractTaskId(childResult.stdout);

    // Try to start child task before parent is started
    const startChildResult = await ctx.lazy(['start', childId, '--yes']);
    expectFailure(startChildResult);
    expectError(startChildResult, 'Cannot start child task');
    expectError(startChildResult, 'parent task has no worktree');
    expectError(startChildResult, `lazy start ${parentId}`);
  });
});
