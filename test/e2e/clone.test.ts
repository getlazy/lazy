import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, extractTaskId } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

describe('lazy clone', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('clone a backlog task without parent', async () => {
    const taskId = await createTask(ctx, 'Original task goal', 'Original prompt text');

    const result = await ctx.lazy(['clone', taskId]);

    expectSuccess(result);
    expectOutput(result, 'clone of');
    expectOutput(result, 'Original task goal');
    expectOutput(result, 'backlog');
    expectOutput(result, 'Start it with');

    // Source task should still exist and be unchanged
    const srcShow = await ctx.lazy(['show', taskId]);
    expectSuccess(srcShow);
    expectOutput(srcShow, 'backlog');
    expectOutput(srcShow, 'Original task goal');

    // Cloned task should exist with same goal
    const clonedTaskId = extractNewTaskId(result.stdout);
    const clonedShow = await ctx.lazy(['show', clonedTaskId]);
    expectSuccess(clonedShow);
    expectOutput(clonedShow, 'Original task goal');
    expectOutput(clonedShow, 'backlog');
    expectOutput(clonedShow, `cloned_from: ${taskId}`);
  });

  test('clone with --parent flag', async () => {
    const parentId = await createTask(ctx, 'Parent task', 'Parent prompt');
    const taskId = await createTask(ctx, 'Task to clone', 'Clone me');

    const result = await ctx.lazy(['clone', taskId, '--parent', parentId]);

    expectSuccess(result);
    expectOutput(result, 'clone of');
    expectOutput(result, 'Parent:');

    const clonedTaskId = extractNewTaskId(result.stdout);
    const clonedShow = await ctx.lazy(['show', clonedTaskId]);
    expectSuccess(clonedShow);
    expectOutput(clonedShow, 'Parent Task:');
    expectOutput(clonedShow, parentId);
  });

  test('clone with --code flag', async () => {
    const taskId = await createTask(ctx, 'Task with code', 'Prompt');

    const result = await ctx.lazy(['clone', taskId, '--code', 'my-custom-code']);

    expectSuccess(result);
    expectOutput(result, 'clone of');
    expectOutput(result, 'my-custom-code');

    const clonedTaskId = extractNewTaskId(result.stdout);
    const clonedShow = await ctx.lazy(['show', clonedTaskId]);
    expectSuccess(clonedShow);
    expectOutput(clonedShow, 'my-custom-code');
  });

  test('clone with --model flag', async () => {
    const taskId = await createTask(ctx, 'Task to clone', 'Original prompt');

    const result = await ctx.lazy(['clone', taskId, '--model', 'claude-opus-4-6']);

    expectSuccess(result);
    expectOutput(result, 'clone of');
    expectOutput(result, 'claude-opus-4-6');

    const clonedTaskId = extractNewTaskId(result.stdout);
    const clonedShow = await ctx.lazy(['show', clonedTaskId]);
    expectSuccess(clonedShow);
    expectOutput(clonedShow, 'claude-opus-4-6');
  });

  test('clone generates -clone-N code from old task code', async () => {
    // Create task with a code
    const createResult = await ctx.lazy(['create', '--goal', 'Task with code', '--prompt', 'Prompt', '--code', 'fix-auth']);
    expectSuccess(createResult);
    const taskId = extractNewTaskId(createResult.stdout);

    const result = await ctx.lazy(['clone', taskId]);
    expectSuccess(result);

    // Cloned task should have -clone-1 code
    const clonedTaskId = extractNewTaskId(result.stdout);
    const clonedShow = await ctx.lazy(['show', clonedTaskId]);
    expectSuccess(clonedShow);
    expectOutput(clonedShow, 'fix-auth-clone-1');
  });

  test('clone increments -clone-N suffix correctly', async () => {
    // Create task with code
    const createResult = await ctx.lazy(['create', '--goal', 'Task', '--prompt', 'Prompt', '--code', 'my-task']);
    expectSuccess(createResult);
    const taskId = extractNewTaskId(createResult.stdout);

    // First clone
    const clone1 = await ctx.lazy(['clone', taskId]);
    expectSuccess(clone1);
    const clone1Id = extractNewTaskId(clone1.stdout);
    const clone1Show = await ctx.lazy(['show', clone1Id]);
    expectOutput(clone1Show, 'my-task-clone-1');

    // Clone the clone
    const clone2 = await ctx.lazy(['clone', clone1Id]);
    expectSuccess(clone2);
    const clone2Id = extractNewTaskId(clone2.stdout);
    const clone2Show = await ctx.lazy(['show', clone2Id]);
    expectOutput(clone2Show, 'my-task-clone-2');
  });

  test('fails for nonexistent task', async () => {
    const result = await ctx.lazy(['clone', 'nonexist0']);

    expectFailure(result);
    expectError(result, 'No task found matching');
  });

  test('fails for terminal parent task', async () => {
    const taskId = await createTask(ctx, 'Task to clone', 'Prompt');
    const parentId = await createTask(ctx, 'Closed parent', 'Prompt');
    await ctx.lazy(['close', parentId, '--reason', 'Done']);

    const result = await ctx.lazy(['clone', taskId, '--parent', parentId]);

    expectFailure(result);
    expectError(result, 'task is closed');
  });

  test('shows usage when no task ID provided', async () => {
    const result = await ctx.lazy(['clone']);

    expectFailure(result);
    // Should show usage or exit with error
  });

  test('cloned task carries over prompt, goal, and metadata', async () => {
    const taskId = await createTask(ctx, 'Complex task', 'Detailed prompt text');

    const result = await ctx.lazy(['clone', taskId]);
    expectSuccess(result);

    const clonedTaskId = extractNewTaskId(result.stdout);
    const clonedShow = await ctx.lazy(['show', clonedTaskId]);
    expectSuccess(clonedShow);
    expectOutput(clonedShow, 'Complex task');
    expectOutput(clonedShow, 'Detailed prompt text');
    expectOutput(clonedShow, `cloned_from: ${taskId}`);
  });

  test('cloned task is in backlog, not started', async () => {
    const taskId = await createTask(ctx, 'Task to clone', 'Prompt');

    const result = await ctx.lazy(['clone', taskId]);
    expectSuccess(result);

    const clonedTaskId = extractNewTaskId(result.stdout);
    const clonedShow = await ctx.lazy(['show', clonedTaskId]);
    expectSuccess(clonedShow);
    expectOutput(clonedShow, 'backlog');
  });

  test('clone does not affect source task', async () => {
    const taskId = await createTask(ctx, 'Source task', 'Original prompt');

    const showBefore = await ctx.lazy(['show', taskId]);
    expectSuccess(showBefore);

    const result = await ctx.lazy(['clone', taskId]);
    expectSuccess(result);

    // Source task should be unchanged
    const showAfter = await ctx.lazy(['show', taskId]);
    expectSuccess(showAfter);
    expectOutput(showAfter, 'Source task');
    expectOutput(showAfter, 'backlog');

    // Output should be identical
    expect(showBefore.stdout).toBe(showAfter.stdout);
  });

  test('clone with all flags combined', async () => {
    const parentId = await createTask(ctx, 'Parent task', 'Parent prompt');
    const createResult = await ctx.lazy(['create', '--goal', 'Source task', '--prompt', 'Source prompt', '--code', 'src-code']);
    expectSuccess(createResult);
    const taskId = extractNewTaskId(createResult.stdout);

    const result = await ctx.lazy(['clone', taskId, '--parent', parentId, '--code', 'new-code', '--model', 'claude-opus-4-6']);

    expectSuccess(result);
    expectOutput(result, 'clone of');
    expectOutput(result, 'new-code');
    expectOutput(result, 'claude-opus-4-6');
    expectOutput(result, 'Parent:');

    const clonedTaskId = extractNewTaskId(result.stdout);
    const clonedShow = await ctx.lazy(['show', clonedTaskId]);
    expectSuccess(clonedShow);
    expectOutput(clonedShow, 'Source task');
    expectOutput(clonedShow, 'new-code');
    expectOutput(clonedShow, 'claude-opus-4-6');
    expectOutput(clonedShow, 'Parent Task:');
    expectOutput(clonedShow, parentId);
  });

  test('clone with invalid --code fails', async () => {
    const taskId = await createTask(ctx, 'Task', 'Prompt');

    const result = await ctx.lazy(['clone', taskId, '--code', 'invalid code with spaces']);

    expectFailure(result);
    expectError(result, 'Invalid code');
  });

  test('clone with invalid --model fails', async () => {
    const taskId = await createTask(ctx, 'Task', 'Prompt');

    const result = await ctx.lazy(['clone', taskId, '--model', 'invalid-model']);

    expectFailure(result);
    expectError(result, 'Invalid model');
  });

  test('clone carries over task type', async () => {
    const createResult = await ctx.lazy(['create', '--goal', 'Fix bug', '--prompt', 'Debug', '--type', 'fix']);
    expectSuccess(createResult);
    const taskId = extractNewTaskId(createResult.stdout);

    const result = await ctx.lazy(['clone', taskId]);
    expectSuccess(result);

    const clonedTaskId = extractNewTaskId(result.stdout);
    const clonedShow = await ctx.lazy(['show', clonedTaskId]);
    expectSuccess(clonedShow);
    expectOutput(clonedShow, 'Type:');
    expectOutput(clonedShow, 'fix');
  });

  test('clone without flags inherits parent from source', async () => {
    const parentId = await createTask(ctx, 'Parent task', 'Parent prompt');
    const sourceId = await createTask(ctx, 'Child task', 'Child prompt');

    // Make sourceId a child of parentId
    await ctx.lazy(['edit', sourceId, '--parent', parentId]);

    const result = await ctx.lazy(['clone', sourceId]);
    expectSuccess(result);
    expectOutput(result, 'clone of');

    const clonedTaskId = extractNewTaskId(result.stdout);
    const clonedShow = await ctx.lazy(['show', clonedTaskId]);
    expectSuccess(clonedShow);
    expectOutput(clonedShow, 'Parent Task:');
    expectOutput(clonedShow, parentId);
  });

  test('clone without flags when source has no parent creates root task', async () => {
    const sourceId = await createTask(ctx, 'Root task', 'Root prompt');

    const result = await ctx.lazy(['clone', sourceId]);
    expectSuccess(result);
    expectOutput(result, 'clone of');

    const clonedTaskId = extractNewTaskId(result.stdout);
    const clonedShow = await ctx.lazy(['show', clonedTaskId]);
    expectSuccess(clonedShow);
    // Cloned task should be a root task (no parent shown)
    // The show output doesn't include "Parent Task:" line for root tasks
  });

  test('clone with --default-parent creates root task even when source has parent', async () => {
    const parentId = await createTask(ctx, 'Parent task', 'Parent prompt');
    const sourceId = await createTask(ctx, 'Child task', 'Child prompt');

    // Make sourceId a child of parentId
    await ctx.lazy(['edit', sourceId, '--parent', parentId]);

    const result = await ctx.lazy(['clone', sourceId, '--default-parent']);
    expectSuccess(result);
    expectOutput(result, 'clone of');

    const clonedTaskId = extractNewTaskId(result.stdout);
    const clonedShow = await ctx.lazy(['show', clonedTaskId]);
    expectSuccess(clonedShow);
    // Cloned task should be a root task (no parent shown)
    // The show output doesn't include "Parent Task:" line for root tasks
  });

  test('clone with --default-parent when source has no parent creates root task', async () => {
    const sourceId = await createTask(ctx, 'Root task', 'Root prompt');

    const result = await ctx.lazy(['clone', sourceId, '--default-parent']);
    expectSuccess(result);
    expectOutput(result, 'clone of');

    const clonedTaskId = extractNewTaskId(result.stdout);
    const clonedShow = await ctx.lazy(['show', clonedTaskId]);
    expectSuccess(clonedShow);
    // Cloned task should be a root task (no parent shown)
    // The show output doesn't include "Parent Task:" line for root tasks
  });

  test('clone with both --parent and --default-parent fails', async () => {
    const parentId = await createTask(ctx, 'Parent task', 'Parent prompt');
    const sourceId = await createTask(ctx, 'Source task', 'Source prompt');

    const result = await ctx.lazy(['clone', sourceId, '--parent', parentId, '--default-parent']);

    expectFailure(result);
    expectError(result, 'Cannot use both --parent and --default-parent');
  });
});

/** Extract new task ID or code from command output that contains "Created task XXXXXXXX" or "Created task code" */
function extractNewTaskId(output: string): string {
  // Try to match hex ID first (8 hex chars)
  const hexMatch = output.match(/Created task ([a-f0-9]{8})/);
  if (hexMatch) {
    return hexMatch[1];
  }

  // Try to match code with em dash (clone output: "Created task code — clone of...")
  const codeMatchWithDash = output.match(/Created task ([a-z0-9-]+) —/);
  if (codeMatchWithDash) {
    return codeMatchWithDash[1];
  }

  // Try to match code without em dash (create output: "Created task code\n")
  const codeMatch = output.match(/Created task ([a-z0-9-]+)\s/);
  if (codeMatch) {
    return codeMatch[1];
  }

  throw new Error(`Could not extract new task ID from output: ${output}`);
}
