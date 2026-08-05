import { describe, test, beforeEach, afterEach } from 'bun:test';
import { readFile, writeFile } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, expectOutputExcludes } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';
// taskFilePath is the ONE place that knows tasks live at lazy.toml's
// external_path; the per-test <root>/.lazy/tasks lookups this suite open-coded
// died with ENOENT once storage moved out of the repo.
import { taskFilePath } from '../helpers/storage';

describe('task metadata', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('show displays metadata when present', async () => {
    const taskId = await createTask(ctx, 'Metadata test task');

    // Find the task directory and update task.json with metadata
    const taskJsonPath = taskFilePath(ctx.root, taskId, 'task.json');
    const taskJson = JSON.parse(await readFile(taskJsonPath, 'utf-8'));
    taskJson.metadata = { pr_url: 'https://github.com/org/repo/pull/42', jira_key: 'PROJ-123' };
    await writeFile(taskJsonPath, JSON.stringify(taskJson, null, 2), 'utf-8');

    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
    expectOutput(result, 'Metadata:');
    expectOutput(result, 'pr_url: https://github.com/org/repo/pull/42');
    expectOutput(result, 'jira_key: PROJ-123');
  });

  test('show does not display metadata section when null', async () => {
    const taskId = await createTask(ctx, 'No metadata task');

    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
    expectOutputExcludes(result, 'Metadata:');
  });

  test('show does not display metadata section when empty object', async () => {
    const taskId = await createTask(ctx, 'Empty metadata task');

    // Set metadata to empty object
    const taskJsonPath = taskFilePath(ctx.root, taskId, 'task.json');
    const taskJson = JSON.parse(await readFile(taskJsonPath, 'utf-8'));
    taskJson.metadata = {};
    await writeFile(taskJsonPath, JSON.stringify(taskJson, null, 2), 'utf-8');

    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
    expectOutputExcludes(result, 'Metadata:');
  });

  test('legacy tasks without metadata field migrate to null', async () => {
    const taskId = await createTask(ctx, 'Legacy task');

    // Remove metadata field from task.json to simulate legacy task
    const taskJsonPath = taskFilePath(ctx.root, taskId, 'task.json');
    const taskJson = JSON.parse(await readFile(taskJsonPath, 'utf-8'));
    delete taskJson.metadata;
    await writeFile(taskJsonPath, JSON.stringify(taskJson, null, 2), 'utf-8');

    // Reading the task should work fine (migration sets metadata to null)
    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
    expectOutputExcludes(result, 'Metadata:');

    // Verify the migration persisted: metadata should now be null in the file
    const updatedJson = JSON.parse(await readFile(taskJsonPath, 'utf-8'));
    if (updatedJson.metadata !== null) {
      throw new Error(`Expected metadata to be null after migration, got: ${JSON.stringify(updatedJson.metadata)}`);
    }
  });
});
