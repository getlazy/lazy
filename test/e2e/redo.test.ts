import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, extractTaskId } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

describe('lazy redo', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('redo a backlog task with --no-start', async () => {
    const taskId = await createTask(ctx, 'Original task goal', 'Original prompt text');

    const result = await ctx.lazy(['redo', taskId, '--no-start']);

    expectSuccess(result);
    expectOutput(result, 'Closing task');
    expectOutput(result, 'redo of');
    expectOutput(result, 'Original task goal');
    expectOutput(result, 'backlog');

    // Old task should be abandoned
    const oldShow = await ctx.lazy(['show', taskId]);
    expectSuccess(oldShow);
    expectOutput(oldShow, 'abandoned');

    // New task should exist with same goal
    const newTaskId = extractTaskId(result.stdout.split('redo of')[0].split('\n').pop()!);
    const newShow = await ctx.lazy(['show', newTaskId]);
    expectSuccess(newShow);
    expectOutput(newShow, 'Original task goal');
    expectOutput(newShow, 'backlog');
  });

  test('redo with --prompt override and --no-start', async () => {
    const taskId = await createTask(ctx, 'Task to redo with new prompt', 'Old prompt');

    const result = await ctx.lazy(['redo', taskId, '--no-start', '--prompt', 'Updated requirements']);

    expectSuccess(result);
    expectOutput(result, 'Closing task');
    expectOutput(result, 'redo of');

    // Extract new task ID from "Created task XXXXXXXX" line
    const newTaskId = extractNewTaskId(result.stdout);

    // New task should have the updated prompt
    const newShow = await ctx.lazy(['show', newTaskId]);
    expectSuccess(newShow);
    expectOutput(newShow, 'Updated requirements');
  });

  test('redo a started task with --no-start', async () => {
    const taskId = await createTask(ctx, 'Started task to redo', 'Do some work');

    // Start the task (creates session + worktree)
    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // Redo the task
    const result = await ctx.lazy(['redo', taskId, '--no-start']);

    expectSuccess(result);
    expectOutput(result, 'Closing task');
    expectOutput(result, 'redo of');

    // Old task should be abandoned
    const oldShow = await ctx.lazy(['show', taskId]);
    expectSuccess(oldShow);
    expectOutput(oldShow, 'abandoned');
  });

  test('redo and start immediately', async () => {
    const taskId = await createTask(ctx, 'Task to redo and start', 'Work on feature');

    // Redo and start (needs mocked Claude for the start part)
    const result = await ctx.lazyMocked(['redo', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    expectSuccess(result);
    expectOutput(result, 'Closing task');
    expectOutput(result, 'redo of');
    expectOutput(result, 'Started task');
  });

  test('fails for nonexistent task', async () => {
    const result = await ctx.lazy(['redo', 'nonexist0']);

    expectFailure(result);
    expectError(result, 'No task found matching');
  });

  test('fails for already-closed task', async () => {
    const taskId = await createTask(ctx, 'Already closed task');
    await ctx.lazy(['close', taskId, '--reason', 'Done']);

    const result = await ctx.lazy(['redo', taskId]);

    expectFailure(result);
    expectError(result, 'already closed');
  });

  test('fails for completed task', async () => {
    const taskId = await createTask(ctx, 'Completed task', 'Implement feature');

    // Start and accept the task
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    await ctx.lazy(['accept', taskId]);

    const result = await ctx.lazy(['redo', taskId]);

    expectFailure(result);
    expectError(result, 'already complete');
  });

  test('redo with --model override and --no-start', async () => {
    const taskId = await createTask(ctx, 'Task to redo with model', 'Do work');

    const result = await ctx.lazy(['redo', taskId, '--no-start', '--model', 'claude-opus-4-6']);

    expectSuccess(result);
    expectOutput(result, 'redo of');
    expectOutput(result, 'claude-opus-4-6');
  });

  test('shows usage when no task ID provided', async () => {
    const result = await ctx.lazy(['redo']);

    expectFailure(result);
    // Should show usage or exit with error
  });

  test('close reason includes new task ID', async () => {
    const taskId = await createTask(ctx, 'Task with close reason check', 'Prompt');

    const result = await ctx.lazy(['redo', taskId, '--no-start']);
    expectSuccess(result);

    // Old task's close reason should mention the new task ID
    const newTaskId = extractNewTaskId(result.stdout);
    const oldShow = await ctx.lazy(['show', taskId]);
    expectSuccess(oldShow);
    expectOutput(oldShow, `Redone as ${newTaskId}`);
  });

  test('redo generates -redo-N code from old task code', async () => {
    // Create task with a code
    const createResult = await ctx.lazy(['create', '--goal', 'Task with code', '--prompt', 'Prompt', '--code', 'fix-auth']);
    expectSuccess(createResult);
    const taskId = extractNewTaskId(createResult.stdout);

    const result = await ctx.lazy(['redo', taskId, '--no-start']);
    expectSuccess(result);

    // New task should have -redo-1 code
    const newTaskId = extractNewTaskId(result.stdout);
    const newShow = await ctx.lazy(['show', newTaskId]);
    expectSuccess(newShow);
    expectOutput(newShow, 'fix-auth-redo-1');
  });
});

/** Extract new task ID from redo output that contains "Created task XXXXXXXX" */
function extractNewTaskId(output: string): string {
  const match = output.match(/Created task ([a-f0-9]{8})/);
  if (!match) {
    throw new Error(`Could not extract new task ID from output: ${output}`);
  }
  return match[1];
}
