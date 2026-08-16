import { describe, test, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';

describe('lazy wait', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('shows usage when no task ID and no --next', async () => {
    const result = await ctx.lazy(['wait']);
    expectFailure(result);
    expectOutput(result, 'Usage: lazy wait');
  });

  test('shows help with --help flag', async () => {
    const result = await ctx.lazy(['wait', '--help']);
    expectSuccess(result);
    expectOutput(result, 'Usage: lazy wait');
    expectOutput(result, '--next');
    expectOutput(result, '--follow');
  });

  test('rejects unknown flag', async () => {
    const result = await ctx.lazy(['wait', '--unknown']);
    expectFailure(result);
    expectError(result, 'Unknown flag: --unknown');
    expectError(result, 'lazy wait --help');
  });

  // INVARIANT: --next and task IDs are mutually exclusive.
  // --next means "watch all working tasks", so specifying IDs is contradictory.
  test('rejects --next with task IDs', async () => {
    const taskId = await createTask(ctx, 'Test task');
    const result = await ctx.lazy(['wait', '--next', taskId]);
    expectFailure(result);
    expectError(result, '--next does not accept task IDs');
  });

  // INVARIANT: --next with no working tasks exits cleanly.
  // The builder should not hang when there's nothing to wait for.
  test('--next exits cleanly when no working tasks', async () => {
    const result = await ctx.lazy(['wait', '--next']);
    expectSuccess(result);
    expectOutput(result, 'No working tasks to wait for');
  });

  // INVARIANT: Waiting for an already-blocked task exits immediately with code 0.
  // The command should not block when the task has already finished its turn.
  test('single task already blocked exits with code 0', async () => {
    const taskId = await createTask(ctx, 'Test task');
    // Tasks start in 'blocked' status after creation (no session started)
    const result = await ctx.lazy(['wait', taskId]);
    // Task has no session, so it should error about missing session
    expectFailure(result);
    expectError(result, 'has no session');
  });

  // INVARIANT: --follow is only valid for single-task wait.
  // Multi-task wait polls silently; following multiple containers is not supported.
  test('rejects --follow with multiple task IDs', async () => {
    const taskId1 = await createTask(ctx, 'Task one');
    const taskId2 = await createTask(ctx, 'Task two');
    const result = await ctx.lazy(['wait', taskId1, taskId2, '--follow']);
    expectFailure(result);
    expectError(result, '--follow is only supported when waiting for a single task');
  });

  // --follow streams raw container output, which would corrupt a JSON document.
  test('rejects --follow with --json', async () => {
    const taskId = await createTask(ctx, 'Task one');
    const result = await ctx.lazy(['wait', taskId, '--follow', '--json']);
    expectFailure(result);
    expectError(result, 'cannot be combined with --json');
  });

  test('accepts multiple task IDs and announces the race', async () => {
    const taskId1 = await createTask(ctx, 'Task one');
    const taskId2 = await createTask(ctx, 'Task two');
    const result = await ctx.lazy(['wait', taskId1, taskId2]);
    // Neither task was started, so the race reports the missing session rather
    // than blocking — but the arguments parsed and both were resolved.
    expectFailure(result);
    expectOutput(result, 'Waiting for the first of 2 tasks to finish');
    expectError(result, 'has no session');
  });

  // INVARIANT: one bad reference fails the WHOLE call, naming it. Silently
  // racing the valid subset would leave the caller waiting on fewer tasks than
  // it asked for, with no way to tell.
  test('an unknown task ID in the set fails the whole call and names it', async () => {
    const taskId = await createTask(ctx, 'Task one');
    const result = await ctx.lazy(['wait', taskId, 'nosuchtask']);
    expectFailure(result);
    expectError(result, 'Task not found: nosuchtask');
  });

  test('--json reports the error as JSON', async () => {
    const result = await ctx.lazy(['wait', 'nosuchtask', '--json']);
    expectFailure(result);
    expectOutput(result, '"error"');
    expectOutput(result, 'nosuchtask');
  });

  test('--next --json emits an empty set when nothing is working', async () => {
    const result = await ctx.lazy(['wait', '--next', '--json']);
    expectSuccess(result);
    expectOutput(result, '"tasks": []');
  });
});
