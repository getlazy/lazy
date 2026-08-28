import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectOutputExcludes, expectError, extractTaskId } from '../helpers/assertions';
import { createTask, disablePreAccept, startAndAccept, startAndReconcile, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { readTaskJson, writeTaskJson } from '../helpers/storage';

describe('lazy redo', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    // Daemonless suite: nothing here can execute the pre-accept agent turn.
    disablePreAccept(ctx.root);
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

    // Start the task (creates session + worktree) and drive the reconcile pass
    // that moves it out of 'working' -- redo cannot close a working task.
    await startAndReconcile(ctx, taskId);

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

    // Start, reconcile, and accept the task.
    await startAndAccept(ctx, taskId);

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

  // INVARIANT: redo is a fresh start — do NOT inherit the old image pin.
  test('redo does not inherit custom_image metadata; warns when old task was pinned', async () => {
    const { IMAGE_TAG } = await import('../../src/capture/image-tag');
    const taskId = await createTask(ctx, 'Pinned redo source', 'Prompt');
    const imageRef = `lazy-custom-redoinherit:${IMAGE_TAG}`;
    const hash = 'd'.repeat(64);

    const data = readTaskJson(ctx.root, taskId);
    data.metadata = {
      ...(data.metadata ?? {}),
      custom_image: imageRef,
      custom_image_hash: hash,
    };
    writeTaskJson(ctx.root, taskId, data);

    const result = await ctx.lazy(['redo', taskId, '--no-start']);
    expectSuccess(result);
    expectOutput(result, `custom container image pin (${imageRef})`);
    expectOutputExcludes(result, 'inherited from previous attempt');

    const newTaskId = extractNewTaskId(result.stdout);
    const redone = readTaskJson(ctx.root, newTaskId);
    expect(redone.metadata?.custom_image).toBeUndefined();
    expect(redone.metadata?.custom_image_hash).toBeUndefined();
  });
});

/** Extract new task ID from redo output that contains "Created task XXXXXXXX" */
function extractNewTaskId(output: string): string {
  // A task created with --code is addressed and printed by that code, not by
  // its hex short id.
  const match = output.match(/Created task ([a-z0-9][a-z0-9.-]*)/);
  if (!match) {
    throw new Error(`Could not extract new task ID from output: ${output}`);
  }
  return match[1];
}
