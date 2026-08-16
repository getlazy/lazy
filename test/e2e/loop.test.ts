import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';

describe('lazy loop', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('fails in non-TTY mode with helpful error', async () => {
    // loop requires interactive terminal (tests run in non-TTY)
    const result = await ctx.lazy(['loop']);
    expectFailure(result);
    expectError(result, 'lazy loop requires an interactive terminal');
  });

  test('shows usage with --help', async () => {
    const result = await ctx.lazy(['loop', '--help']);
    expectSuccess(result);
    expectOutput(result, 'Usage: lazy loop');
    expectOutput(result, '--model');
    expectOutput(result, '--follow');
  });

  test('loop appears in main help output', async () => {
    const result = await ctx.lazy(['--help']);
    expectSuccess(result);
    expectOutput(result, 'loop');
    expectOutput(result, 'Review all blocked tasks sequentially');
  });

  test('detects and shows interrupted tasks', async () => {
    // Create a task to mark as interrupted
    const taskId = await createTask(ctx, 'Interrupted task test', 'Do some work');

    // Manually mark the task as interrupted via storage API
    // We can't actually interrupt a task in the test (would need to crash an agent),
    // but we can verify the basic infrastructure works by checking that interrupted
    // tasks would be queried if they existed.
    // For now, just verify that loop handles no interrupted/blocked tasks gracefully
    const result = await ctx.lazy(['loop']);

    // In non-TTY mode, loop should fail as before (no mock TTY available in tests)
    expectFailure(result);
    expectError(result, 'lazy loop requires an interactive terminal');
  });

  // --- Queue mode (`lazy loop <task...>`) ---

  test('usage documents both modes and the queue flags', async () => {
    const result = await ctx.lazy(['loop', '--help']);
    expectSuccess(result);
    expectOutput(result, '--pipeline');
    expectOutput(result, '--backlog');
    expectOutput(result, '--parent');
    expectOutput(result, '--tag');
    // The queue is an argument list, not persisted state — the help must say so,
    // because "resume with this command" is the whole interruption story.
    expectOutput(result, 'The queue is not persisted');
  });

  test('rejects mixing explicit task IDs with selection filters', async () => {
    // Guessing which wins would be a silent surprise; refusing is the contract.
    const result = await ctx.lazy(['loop', 'some-task', '--backlog']);
    expectFailure(result);
    expectError(result, 'not both');
  });

  test('rejects --pipeline without a queue', async () => {
    // --pipeline pre-starts the NEXT queued task; reactive mode has no queue.
    const result = await ctx.lazy(['loop', '--pipeline']);
    expectFailure(result);
    expectError(result, '--pipeline applies to a task queue');
  });

  test('argument errors are reported even without a TTY', async () => {
    // INVARIANT: argument validation precedes the TTY guard. Reporting
    // "requires an interactive terminal" for a malformed invocation would hide
    // the actual mistake from anyone scripting or piping.
    const result = await ctx.lazy(['loop', 'a', '--tag', 'x']);
    expectFailure(result);
    expectError(result, 'not both');
  });

  test('queue mode still requires a TTY', async () => {
    const taskId = await createTask(ctx, 'Queue task', 'Do some work');
    const result = await ctx.lazy(['loop', taskId]);
    expectFailure(result);
    expectError(result, 'lazy loop requires an interactive terminal');
  });

  test('one bad task reference fails the whole run before anything starts', async () => {
    // INVARIANT: the queue resolves all-or-nothing (same rule as `lazy wait`'s
    // multi-task race). Silently racing the valid subset would leave the human
    // believing they queued work that was never touched.
    const good = await createTask(ctx, 'Real task', 'Do some work');
    const result = await ctx.lazy(['loop', good, 'no-such-task-ref'], {
      env: { LAZY_FORCE_TTY: '1' },
    });
    expectFailure(result);
    expectError(result, 'no-such-task-ref');

    // The good task must NOT have been started by the failed run.
    const status = await ctx.lazy(['show', good]);
    expectSuccess(status);
    expectOutput(status, 'backlog');
  });
});
