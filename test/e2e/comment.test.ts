import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';

describe('lazy comment', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('adds a comment with --message flag', async () => {
    const taskId = await createTask(ctx, 'Task with comments');

    const result = await ctx.lazy(['comment', taskId, '--message', 'This is a test comment']);

    expectSuccess(result);
    expectOutput(result, 'Added comment to task');
  });

  test('comment appears in show output', async () => {
    const taskId = await createTask(ctx, 'Task with visible comment');
    await ctx.lazy(['comment', taskId, '--message', 'Important observation']);

    const showResult = await ctx.lazy(['show', taskId]);

    expectSuccess(showResult);
    expectOutput(showResult, 'Important observation');
  });

  test('fails with nonexistent task', async () => {
    const result = await ctx.lazy(['comment', 'nonexist0', '--message', 'some comment']);

    expectFailure(result);
    expectError(result, 'No task found matching');
  });

  test('fails without TTY when no --message provided', async () => {
    const taskId = await createTask(ctx, 'Comment without message');

    const result = await ctx.lazy(['comment', taskId]);

    expectFailure(result);
    expectError(result, 'Interactive mode requires a TTY');
  });

  // INVARIANT: Comments created via CLI (lazy comment) do NOT have source='remote'.
  // Only comments imported from PR/MR should have source='remote'. This ensures
  // locally-created comments are exported to PRs while imported ones are not.
  test('CLI-created comments have no source field (local by default)', async () => {
    const taskId = await createTask(ctx, 'Source field test');
    await ctx.lazy(['comment', taskId, '--message', 'Local observation']);

    // Read comments.json directly to verify source field
    // External storage puts tasks in ~/.lazy/<project-name>/tasks/
    const tasksDir = join(homedir(), '.lazy', basename(ctx.root), 'tasks');
    const entries = readdirSync(tasksDir);
    const fullId = entries.find(e => e.startsWith(taskId));
    expect(fullId).toBeDefined();

    const commentsPath = join(tasksDir, fullId!, 'comments.json');
    const data = JSON.parse(readFileSync(commentsPath, 'utf-8'));
    expect(data.comments).toHaveLength(1);
    // CLI comments should NOT have source='remote'
    expect(data.comments[0].source).toBeUndefined();
    expect(data.comments[0].content).toBe('Local observation');
  });

});
