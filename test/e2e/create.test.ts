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
    const result = await ctx.lazy(['create', '--goal', 'Fix bug', '--model', 'opus']);

    expectSuccess(result);
    expectOutput(result, 'opus');
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

  test('rejects non-existent parent', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Child task', '--parent', 'nonexist0']);

    expectFailure(result);
    expectError(result, 'No task found');
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
