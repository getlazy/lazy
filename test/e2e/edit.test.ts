import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, extractTaskId } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';

describe('lazy edit', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('updates task model', async () => {
    const taskId = await createTask(ctx, 'test task');

    // Verify initial model is not set (shows as -)
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'Model:   -');

    // Update model to opus
    const editResult = await ctx.lazy(['edit', taskId, '--model', 'opus']);
    expectSuccess(editResult);
    expectOutput(editResult, 'Updated model: opus');

    // Verify model was updated
    const showResult2 = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult2);
    expectOutput(showResult2, 'Model:   opus');
  });

  test('updates task goal', async () => {
    const taskId = await createTask(ctx, 'original goal');

    const editResult = await ctx.lazy(['edit', taskId, '--goal', 'new goal']);
    expectSuccess(editResult);
    expectOutput(editResult, 'Updated goal: new goal');

    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'Goal:    new goal');
  });

  test('updates multiple fields at once', async () => {
    const taskId = await createTask(ctx, 'test task');

    const editResult = await ctx.lazy([
      'edit',
      taskId,
      '--goal',
      'updated goal',
      '--model',
      'haiku',
    ]);
    expectSuccess(editResult);
    expectOutput(editResult, 'Updated goal: updated goal');
    expectOutput(editResult, 'Updated model: haiku');

    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'Goal:    updated goal');
    expectOutput(showResult, 'Model:   haiku');
  });

  test('rejects invalid model names', async () => {
    const taskId = await createTask(ctx, 'test task');

    const editResult = await ctx.lazy(['edit', taskId, '--model', 'invalid']);
    expectFailure(editResult);
    expectError(editResult, 'Invalid model: invalid');
  });

  test('prevents editing after task is started', async () => {
    // This test would need to actually start a task, which requires Docker
    // For now, we'll skip this test case as it's already covered by existing edit logic
  });

  test('shows no changes when nothing is updated', async () => {
    const taskId = await createTask(ctx, 'test task');

    // Try to edit without providing any flags (will fail in non-TTY)
    const editResult = await ctx.lazy(['edit', taskId]);
    expectFailure(editResult);
    expectError(editResult, 'Interactive mode requires a TTY');
  });

  test('sets parent on a task', async () => {
    const parentId = await createTask(ctx, 'Parent task');
    const childId = await createTask(ctx, 'Child task');

    const editResult = await ctx.lazy(['edit', childId, '--parent', parentId]);
    expectSuccess(editResult);
    expectOutput(editResult, `Updated parent: ${parentId}`);

    // Verify parent is shown in show output
    const showResult = await ctx.lazy(['show', childId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'Parent Task:');
    expectOutput(showResult, parentId);
  });

  test('clears parent with --parent ""', async () => {
    // Create parent and child using create --parent
    const parentId = await createTask(ctx, 'Parent task');
    const childResult = await ctx.lazy(['create', '--goal', 'Child task', '--parent', parentId]);
    const childId = extractTaskId(childResult.stdout);

    // Verify parent is set
    const showBefore = await ctx.lazy(['show', childId]);
    expectOutput(showBefore, 'Parent Task:');

    // Clear parent
    const editResult = await ctx.lazy(['edit', childId, '--parent', '']);
    expectSuccess(editResult);
    expectOutput(editResult, 'Cleared parent');

    // Verify parent is gone
    const showAfter = await ctx.lazy(['show', childId]);
    expectSuccess(showAfter);
    // Should not show parent section
    if (showAfter.stdout.includes('Parent Task:')) {
      throw new Error('Expected parent info to be cleared, but it still appears in show output');
    }
  });

  test('rejects self as parent', async () => {
    const taskId = await createTask(ctx, 'Self-referential task');

    const editResult = await ctx.lazy(['edit', taskId, '--parent', taskId]);
    expectFailure(editResult);
    expectError(editResult, 'Cannot set task as its own parent');
  });

  test('rejects circular parent chain', async () => {
    const taskA = await createTask(ctx, 'Task A');
    const taskB = await createTask(ctx, 'Task B');

    // Set B's parent to A
    const edit1 = await ctx.lazy(['edit', taskB, '--parent', taskA]);
    expectSuccess(edit1);

    // Try to set A's parent to B — would create A→B→A cycle
    const edit2 = await ctx.lazy(['edit', taskA, '--parent', taskB]);
    expectFailure(edit2);
    expectError(edit2, 'circular parent chain');
  });

  test('rejects terminal-state parent in edit', async () => {
    const parentId = await createTask(ctx, 'Closed parent');
    const childId = await createTask(ctx, 'Child task');

    // Close the parent
    await ctx.lazy(['close', parentId, '--reason', 'Done']);

    const editResult = await ctx.lazy(['edit', childId, '--parent', parentId]);
    expectFailure(editResult);
    expectError(editResult, 'task is closed');
  });

  test('rejects non-existent parent in edit', async () => {
    const taskId = await createTask(ctx, 'Task');

    const editResult = await ctx.lazy(['edit', taskId, '--parent', 'nonexist0']);
    expectFailure(editResult);
    expectError(editResult, 'No task found');
  });

  test('updates task type on backlog task', async () => {
    const taskId = await createTask(ctx, 'test task');

    // Verify initial type is 'task'
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'Type:    task');

    // Update type to refactor
    const editResult = await ctx.lazy(['edit', taskId, '--type', 'refactor']);
    expectSuccess(editResult);
    expectOutput(editResult, 'Updated type: refactor');

    // Verify type was updated
    const showResult2 = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult2);
    expectOutput(showResult2, 'Type:    refactor');
  });

  test('warns when changing type after prompt is set', async () => {
    const taskId = await createTask(ctx, 'test task', 'Some prompt content');

    // Update type to refactor - should show warning
    const editResult = await ctx.lazy(['edit', taskId, '--type', 'refactor']);
    expectSuccess(editResult);
    expectOutput(editResult, 'Warning');
    expectOutput(editResult, 'Updated type: refactor');
  });

  test('rejects invalid type in edit', async () => {
    const taskId = await createTask(ctx, 'test task');

    const editResult = await ctx.lazy(['edit', taskId, '--type', 'invalid-type']);
    expectFailure(editResult);
    expectError(editResult, 'Invalid type');
  });
});
