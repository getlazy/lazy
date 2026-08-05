import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, extractTaskId } from '../helpers/assertions';
import { createTask, disablePreAccept, startAndAccept, startAndReconcile, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/** Extract new task ID from rework output that contains "Created rework task XXXXXXXX" */
function extractReworkTaskId(output: string): string {
  const match = output.match(/Created rework task ([a-z0-9-]+)/);
  if (!match) {
    throw new Error(`Could not extract rework task ID from output: ${output}`);
  }
  return match[1];
}

describe('lazy rework', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    // Daemonless suite: nothing here can execute the pre-accept agent turn, and
    // these tests assert on rework, not on pre-accept.
    disablePreAccept(ctx.root);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: rework only works on accepted (complete) tasks.
  // This is the core distinction from reopen (rejected/closed) and redo (stale/working).
  test('rework an accepted task with --prompt', async () => {
    const taskId = await createTask(ctx, 'Original auth feature', 'Implement OAuth login');

    // Start and accept the task
    await startAndAccept(ctx, taskId);

    // Verify task is complete
    const showBefore = await ctx.lazy(['show', taskId]);
    expectOutput(showBefore, 'complete');

    // Rework it
    const result = await ctx.lazy(['rework', taskId, '--prompt', 'Fix token expiry edge case']);

    expectSuccess(result);
    expectOutput(result, 'Created rework task');
    expectOutput(result, 'Rework: Original auth feature');
    expectOutput(result, 'lazy start');

    // New task should exist in backlog
    const newTaskId = extractReworkTaskId(result.stdout);
    const newShow = await ctx.lazy(['show', newTaskId]);
    expectSuccess(newShow);
    expectOutput(newShow, 'Rework: Original auth feature');
    expectOutput(newShow, 'backlog');
    expectOutput(newShow, 'rework_of');
  });

  // INVARIANT: rework inherits the original task's model unless overridden.
  test('rework inherits model from original task', async () => {
    const createResult = await ctx.lazy(['create', '--goal', 'Task with model', '--prompt', 'Do work', '--model', 'claude-opus-4-6']);
    expectSuccess(createResult);
    const taskId = extractTaskId(createResult.stdout);

    // Start and accept
    await startAndAccept(ctx, taskId);

    // Rework without --model
    const result = await ctx.lazy(['rework', taskId, '--prompt', 'Fix something']);
    expectSuccess(result);
    expectOutput(result, 'claude-opus-4-6');
  });

  // INVARIANT: --model overrides the inherited model.
  test('rework with --model override', async () => {
    const taskId = await createTask(ctx, 'Task to rework with model', 'Do work');

    await startAndAccept(ctx, taskId);

    const result = await ctx.lazy(['rework', taskId, '--prompt', 'Fix it', '--model', 'claude-haiku-4-5-20251001']);
    expectSuccess(result);
    expectOutput(result, 'claude-haiku-4-5-20251001');
  });

  // INVARIANT: --goal overrides the default "Rework: <original goal>".
  test('rework with --goal override', async () => {
    const taskId = await createTask(ctx, 'Original goal here', 'Do work');

    await startAndAccept(ctx, taskId);

    const result = await ctx.lazy(['rework', taskId, '--prompt', 'Fix it', '--goal', 'Custom rework goal']);
    expectSuccess(result);
    expectOutput(result, 'Custom rework goal');
  });

  // INVARIANT: rework generates code as rework-<original-code>.
  test('rework generates code from original task code', async () => {
    const createResult = await ctx.lazy(['create', '--goal', 'Coded task', '--prompt', 'Work', '--code', 'fix-auth']);
    expectSuccess(createResult);
    // Use the code directly since displayId returns code when set
    const taskId = 'fix-auth';

    await startAndAccept(ctx, taskId);

    const result = await ctx.lazy(['rework', taskId, '--prompt', 'Fix edge case']);
    expectSuccess(result);

    const newTaskId = extractReworkTaskId(result.stdout);
    const newShow = await ctx.lazy(['show', newTaskId]);
    expectSuccess(newShow);
    expectOutput(newShow, 'rework-fix-auth');
  });

  // INVARIANT: --code overrides the generated code.
  test('rework with --code override', async () => {
    const taskId = await createTask(ctx, 'Task to rework', 'Work');

    await startAndAccept(ctx, taskId);

    const result = await ctx.lazy(['rework', taskId, '--prompt', 'Fix it', '--code', 'custom-rework']);
    expectSuccess(result);

    const newTaskId = extractReworkTaskId(result.stdout);
    const newShow = await ctx.lazy(['show', newTaskId]);
    expectSuccess(newShow);
    expectOutput(newShow, 'custom-rework');
  });

  // INVARIANT: rework refuses non-complete tasks and provides guidance.
  test('fails for backlog task', async () => {
    const taskId = await createTask(ctx, 'Backlog task');

    const result = await ctx.lazy(['rework', taskId, '--prompt', 'Fix it']);
    expectFailure(result);
    expectError(result, 'not complete');
    expectError(result, 'lazy create');
  });

  // INVARIANT: rework refuses blocked tasks and suggests unblock.
  test('fails for blocked task', async () => {
    const taskId = await createTask(ctx, 'Blocked task', 'Work');

    // Drive the reconcile pass: post-v0.11 only a reconcile moves a started
    // task working -> blocked, and this test is about the blocked state.
    await startAndReconcile(ctx, taskId);

    const result = await ctx.lazy(['rework', taskId, '--prompt', 'Fix it']);
    expectFailure(result);
    expectError(result, 'not complete');
    expectError(result, 'lazy unblock');
  });

  // INVARIANT: rework refuses closed tasks and suggests reopen.
  test('fails for closed task', async () => {
    const taskId = await createTask(ctx, 'Closed task');
    await ctx.lazy(['close', taskId, '--reason', 'Done']);

    const result = await ctx.lazy(['rework', taskId, '--prompt', 'Fix it']);
    expectFailure(result);
    expectError(result, 'not complete');
    expectError(result, 'lazy reopen');
  });

  test('fails for nonexistent task', async () => {
    const result = await ctx.lazy(['rework', 'nonexist0', '--prompt', 'Fix it']);
    expectFailure(result);
    expectError(result, 'No task found matching');
  });

  test('shows usage when no task ID provided', async () => {
    const result = await ctx.lazy(['rework']);
    expectFailure(result);
  });

  // INVARIANT: rework task type is set to 'rework'.
  test('rework task has type rework', async () => {
    const taskId = await createTask(ctx, 'Task for type check', 'Work');

    await startAndAccept(ctx, taskId);

    const result = await ctx.lazy(['rework', taskId, '--prompt', 'Fix it']);
    expectSuccess(result);

    const newTaskId = extractReworkTaskId(result.stdout);
    const newShow = await ctx.lazy(['show', newTaskId]);
    expectSuccess(newShow);
    expectOutput(newShow, 'rework');
  });

  // INVARIANT: multiple reworks of the same task are allowed.
  test('multiple reworks of same task are allowed', async () => {
    const taskId = await createTask(ctx, 'Task to rework twice', 'Work');

    await startAndAccept(ctx, taskId);

    const result1 = await ctx.lazy(['rework', taskId, '--prompt', 'First rework']);
    expectSuccess(result1);

    const result2 = await ctx.lazy(['rework', taskId, '--prompt', 'Second rework']);
    expectSuccess(result2);

    // Both should have created separate tasks
    const newId1 = extractReworkTaskId(result1.stdout);
    const newId2 = extractReworkTaskId(result2.stdout);
    expect(newId1).not.toBe(newId2);
  });

  // INVARIANT: piped stdin is accepted as the rework prompt.
  test('accepts prompt from piped stdin', async () => {
    const taskId = await createTask(ctx, 'Task for stdin test', 'Work');

    await startAndAccept(ctx, taskId);

    const result = await ctx.lazy(['rework', taskId], {
      input: 'Fix the race condition in auth',
    });
    expectSuccess(result);
    expectOutput(result, 'Created rework task');
  });

  test('rework prompt includes original task context', async () => {
    const taskId = await createTask(ctx, 'Context test task', 'Implement the feature');

    await startAndAccept(ctx, taskId);

    const result = await ctx.lazy(['rework', taskId, '--prompt', 'Fix edge case']);
    expectSuccess(result);

    // The new task's prompt should contain the original task context
    const newTaskId = extractReworkTaskId(result.stdout);
    const newShow = await ctx.lazy(['show', newTaskId]);
    expectSuccess(newShow);
    // The prompt template mentions "previously accepted work"
    expectOutput(newShow, 'previously accepted work');
    expectOutput(newShow, 'Context test task');
  });

  // INVARIANT: --parent sets a parent on the rework task (consistent with lazy create).
  // This lets users place rework tasks in the right hierarchy.
  test('rework with --parent sets parent on new task', async () => {
    // Create a potential parent task (non-terminal)
    const parentResult = await ctx.lazy(['create', '--goal', 'Release parent', '--code', 'release-v1']);
    expectSuccess(parentResult);

    // Create and accept a task to rework (no parent on original)
    const taskId = await createTask(ctx, 'Task to rework', 'Work');
    await startAndAccept(ctx, taskId);

    // Rework with --parent
    const result = await ctx.lazy(['rework', taskId, '--prompt', 'Fix it', '--parent', 'release-v1']);
    expectSuccess(result);
    expectOutput(result, 'Parent:');
    expectOutput(result, 'release-v1');

    // Verify parent is set on the new task
    const newTaskId = extractReworkTaskId(result.stdout);
    const newShow = await ctx.lazy(['show', newTaskId]);
    expectSuccess(newShow);
    expectOutput(newShow, 'release-v1');
  });

  // INVARIANT: --parent rejects terminal parent tasks (consistent with lazy create).
  // Terminal tasks cannot receive new child tasks.
  test('rework fails when --parent points to terminal task', async () => {
    // Create and close a potential parent (`lazy abandon` was removed; `close`
    // is the no-session terminal transition that replaced it).
    const parentResult = await ctx.lazy(['create', '--goal', 'Closed parent', '--code', 'closed-par']);
    expectSuccess(parentResult);
    const parentId = extractTaskId(parentResult.stdout);
    const closeResult = await ctx.lazy(['close', parentId, '--reason', 'Done']);
    expectSuccess(closeResult);

    // Create and accept a task to rework
    const taskId = await createTask(ctx, 'Task to rework', 'Work');
    await startAndAccept(ctx, taskId);

    // Rework with --parent pointing to abandoned task
    const result = await ctx.lazy(['rework', taskId, '--prompt', 'Fix it', '--parent', 'closed-par']);
    expectFailure(result);
    expectError(result, 'Cannot use task');
    expectError(result, 'closed');
  });

  // INVARIANT: rework without --parent on a parentless task creates a parentless rework.
  test('rework without parent creates parentless task', async () => {
    const taskId = await createTask(ctx, 'Standalone task', 'Work');
    await startAndAccept(ctx, taskId);

    const result = await ctx.lazy(['rework', taskId, '--prompt', 'Fix it']);
    expectSuccess(result);

    // Output should NOT contain a Parent: line
    expect(result.stdout).not.toContain('Parent:');
  });
});
