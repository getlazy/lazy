import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';
import { successScenario } from '../helpers/fake-claude';

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

  test('accepts -m as a short alias for --message', async () => {
    const taskId = await createTask(ctx, 'Task with -m comment');

    const result = await ctx.lazy(['comment', taskId, '-m', 'Short-flag comment']);

    expectSuccess(result);
    expectOutput(result, 'Added comment to task');

    const showResult = await ctx.lazy(['show', taskId]);
    expectOutput(showResult, 'Short-flag comment');
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

describe('lazy comment --edit', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function commentIdFrom(output: string): string {
    const m = output.match(/Comment ID: (\S+)/);
    if (!m) throw new Error(`no comment id in: ${output}`);
    return m[1];
  }

  // INVARIANT: a comment the agent has not been shown yet can be edited; the
  // next prompt carries the edited text.
  test('edits a comment the agent has not seen yet', async () => {
    const taskId = await createTask(ctx, 'Task with an editable comment');
    const added = await ctx.lazy(['comment', taskId, '-m', 'Typo in thsi comment']);
    expectSuccess(added);
    const commentId = commentIdFrom(added.stdout);

    const edited = await ctx.lazy(['comment', taskId, '--edit', commentId, '-m', 'Typo fixed in this comment']);
    expectSuccess(edited);
    expectOutput(edited, 'Edited comment');

    const show = await ctx.lazy(['show', taskId]);
    expectOutput(show, 'Typo fixed in this comment');
    expect(show.stdout).not.toContain('Typo in thsi comment');
  });

});

describe('lazy comment --edit on a delivered comment', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // A real delivery needs a real prompt: daemon + fake agent binary.
    ctx = await setupTestLazy({ fakeClaude: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: once delivered to the agent a comment cannot be edited, and the
  // refusal says why — the agent may have acted on what it read.
  test('refuses, explaining why, and leaves the comment untouched', async () => {
    const taskId = await createTask(ctx, 'Task whose comment was delivered', 'Do the work');
    const added = await ctx.lazy(['comment', taskId, '-m', 'Original guidance']);
    const commentId = added.stdout.match(/Comment ID: (\S+)/)![1];
    await ctx.setClaudeScenario({ sequence: [successScenario({ result: 'Done.', sessionId: 'fake-sess-edit' })] });
    // The first prompt carries queued comments.
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const edited = await ctx.lazy(['comment', taskId, '--edit', commentId, '-m', 'Rewritten guidance']);
    expectFailure(edited);
    expectError(edited, 'already been delivered to the agent');
    expectError(edited, 'Add a new comment');

    const show = await ctx.lazy(['show', taskId]);
    expectOutput(show, 'Original guidance');
    expect(show.stdout).not.toContain('Rewritten guidance');
  });
});
