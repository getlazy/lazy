import { describe, test, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { readFile } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, extractTaskId } from '../helpers/assertions';
import { createTask, disablePreAccept, startAndAccept, startAndReconcile, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { taskDirFor } from '../helpers/storage';

/**
 * Helper: create a task, start it (mocked), and accept it.
 * Returns the short task ID.
 */
async function createAndAcceptTask(
  ctx: TestContext,
  goal: string,
  code?: string,
): Promise<string> {
  const args = ['create', '--goal', goal, '--prompt', 'Do the work'];
  if (code) args.push('--code', code);
  const createResult = await ctx.lazy(args);
  const taskId = extractTaskId(createResult.stdout);

  // Start, drive the reconcile pass that moves the task out of 'working'
  // (daemonless: nothing else does), then accept and merge to main.
  await startAndAccept(ctx, taskId);

  return taskId;
}

/**
 * Helper: read task.json metadata for a task.
 */
async function getTaskMetadata(root: string, taskShortId: string): Promise<Record<string, string> | null> {
  // Storage lives at the project's external_path, not <root>/.lazy/tasks.
  const taskDir = taskDirFor(root, taskShortId);
  const taskJson = JSON.parse(await readFile(join(taskDir, 'task.json'), 'utf-8'));
  return taskJson.metadata ?? null;
}

describe('lazy revert', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    // Daemonless suite: nothing here can execute the pre-accept agent turn.
    disablePreAccept(ctx.root);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('shows usage with no arguments', async () => {
    const result = await ctx.lazy(['revert']);
    expectFailure(result);
  });

  test('fails for non-existent task', async () => {
    const result = await ctx.lazy(['revert', 'nonexist', '--reason', 'test']);
    expectFailure(result);
    expectError(result, 'No task found');
  });

  test('fails for task that is not complete', async () => {
    const taskId = await createTask(ctx, 'Incomplete task', 'Do something');
    const result = await ctx.lazy(['revert', taskId, '--reason', 'test']);
    expectFailure(result);
    expectError(result, 'not complete');
  });

  test('fails for task with no session', async () => {
    const taskId = await createTask(ctx, 'No session task');
    // Manually update task to complete status via direct file manipulation
    const taskDir = taskDirFor(ctx.root, taskId);
    const taskJsonPath = join(taskDir, 'task.json');
    const taskJson = JSON.parse(await readFile(taskJsonPath, 'utf-8'));
    taskJson.status = 'complete';
    const { writeFile: wf } = await import('fs/promises');
    await wf(taskJsonPath, JSON.stringify(taskJson, null, 2));

    const result = await ctx.lazy(['revert', taskId, '--reason', 'test']);
    expectFailure(result);
    expectError(result, 'has no session');
  });

  test('fails without --reason in non-TTY mode', async () => {
    const taskId = await createAndAcceptTask(ctx, 'Task to revert without reason');
    const result = await ctx.lazy(['revert', taskId]);
    expectFailure(result);
    expectError(result, 'Revert reason is required');
  });

  test('creates revert task with correct metadata', async () => {
    const taskId = await createAndAcceptTask(ctx, 'Task to revert', 'fix-bug');

    const result = await ctx.lazy(['revert', taskId, '--reason', 'Needs more testing']);
    expectSuccess(result);
    expectOutput(result, 'Created revert task');
    expectOutput(result, 'revert-fix-bug');
    expectOutput(result, 'Revert commit');

    // Verify the revert task exists and has correct metadata
    const listResult = await ctx.lazy(['list']);
    expectSuccess(listResult);
    expectOutput(listResult, 'revert-fix-bug');

    // Show the revert task to verify its goal
    const showResult = await ctx.lazy(['show', 'revert-fix-bug']);
    expectSuccess(showResult);
    expectOutput(showResult, 'Revert commit');
    expectOutput(showResult, 'fix-bug');
  });

  test('saves revert reason as comment on original task before creating revert task', async () => {
    const taskId = await createAndAcceptTask(ctx, 'Task for reason check', 'reason-chk');

    const result = await ctx.lazy(['revert', taskId, '--reason', 'Production issues']);
    expectSuccess(result);

    // Verify the reason was saved as a comment on the original task
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'Revert reason: Production issues');
  });

  test('revert task has correct metadata fields', async () => {
    const taskId = await createAndAcceptTask(ctx, 'Metadata check task', 'meta-chk');

    await ctx.lazy(['revert', taskId, '--reason', 'Testing metadata']);

    // Find and read the revert task metadata
    const listResult = await ctx.lazy(['show', 'revert-meta-chk']);
    expectSuccess(listResult);
    expectOutput(listResult, 'reverts_task_id');
    expectOutput(listResult, 'reverts_merge_sha');
    expectOutput(listResult, 'revert_reason');
    expectOutput(listResult, 'original_task_code');
  });

  test('revert task prompt contains git revert instruction', async () => {
    const taskId = await createAndAcceptTask(ctx, 'Prompt check task', 'prompt-chk');

    await ctx.lazy(['revert', taskId, '--reason', 'Check prompt']);

    const showResult = await ctx.lazy(['show', 'revert-prompt-chk', '--full']);
    expectSuccess(showResult);
    expectOutput(showResult, 'git revert');
    expectOutput(showResult, '--no-edit');
    expectOutput(showResult, 'Check prompt');
  });

  test('uses task short ID as code fallback when no code set', async () => {
    const taskId = await createAndAcceptTask(ctx, 'No code task');

    const result = await ctx.lazy(['revert', taskId, '--reason', 'No code test']);
    expectSuccess(result);
    expectOutput(result, `revert-${taskId}`);
  });

  test('displays accept date and merge info', async () => {
    const taskId = await createAndAcceptTask(ctx, 'Date display task', 'date-disp');

    const result = await ctx.lazy(['revert', taskId, '--reason', 'Date check']);
    expectSuccess(result);
    expectOutput(result, 'date-disp');
    expectOutput(result, 'merged into main');
    expectOutput(result, 'Merge commit:');
  });
});

describe('lazy accept revert task (continuation)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    // Daemonless suite: nothing here can execute the pre-accept agent turn.
    disablePreAccept(ctx.root);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('offers continuation task after accepting revert task', async () => {
    // 1. Create, start, accept original task
    const taskId = await createAndAcceptTask(ctx, 'Original work', 'orig-work');

    // 2. Create revert task
    const revertResult = await ctx.lazy(['revert', taskId, '--reason', 'Needs fixes']);
    expectSuccess(revertResult);

    // 3. Start the revert task and drive the reconcile pass that moves it out
    // of 'working' -- accept refuses a working task.
    await startAndReconcile(ctx, 'revert-orig-work');

    // Accept the revert task (--yes will auto-create continuation)
    const acceptResult = await ctx.lazy(['accept', 'revert-orig-work', '--yes']);
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'accepted and merged');
    expectOutput(acceptResult, 'Original work');
    expectOutput(acceptResult, 'Created continuation task');
    expectOutput(acceptResult, 'orig-work-v2');
  });

  test('continuation task has correct prompt with revert info', async () => {
    const taskId = await createAndAcceptTask(ctx, 'Cont prompt task', 'cont-test');

    await ctx.lazy(['revert', taskId, '--reason', 'Fix the approach']);

    await startAndReconcile(ctx, 'revert-cont-test');
    await ctx.lazy(['accept', 'revert-cont-test', '--yes']);

    // Show the continuation task
    const showResult = await ctx.lazy(['show', 'cont-test-v2', '--full']);
    expectSuccess(showResult);
    expectOutput(showResult, 'continuing task cont-test');
    expectOutput(showResult, 'Fix the approach');
    expectOutput(showResult, 'git revert');
    expectOutput(showResult, 'lazy show cont-test');
  });

  test('continuation task increments version if v2 exists', async () => {
    const taskId = await createAndAcceptTask(ctx, 'Version test', 'ver-test');

    // Create a task with the v2 code to simulate it already existing
    await ctx.lazy(['create', '--goal', 'Existing v2', '--code', 'ver-test-v2']);

    // Create and accept the revert
    await ctx.lazy(['revert', taskId, '--reason', 'V2 exists test']);
    await startAndReconcile(ctx, 'revert-ver-test');
    const acceptResult = await ctx.lazy(['accept', 'revert-ver-test', '--yes']);
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'ver-test-v3');
  });
});
