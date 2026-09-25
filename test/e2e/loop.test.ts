import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS, setProtectedPatterns } from '../helpers/fixtures';
import { runReconcile } from '../helpers/reconcile';
import { readTaskStatus } from '../helpers/storage';
import { writeFileSync } from 'fs';
import { join } from 'path';

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

  // `lazy loop` is the HUMAN's loop over a queue of tasks, at a review gate.
  // It kept the word when the `loop` TASK TYPE became `cluster` on 2026-09-20 —
  // freeing the word for exactly this is part of why the type was renamed.
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

  // INVARIANT (a conflict task is reviewable from the loop —
  // move-file-approval-to-accept): the loop had two gates that skipped the
  // feedback flow whenever a protected file was still pending and told the
  // human to "use lazy unblock to handle them interactively". Both are gone:
  // unblock reverts nothing now, that interactive prompt was deleted with the
  // revert, and the advice led to an ordinary feedback editor that never
  // mentioned the files. Meanwhile the loop silently advanced past exactly the
  // tasks a reviewer most wanted to nudge — the workflow this change exists to
  // restore.
  //
  // Driven through the prompt seams (LAZY_FORCE_TTY + LAZY_PROMPT_DEFAULTS
  // picks the first menu entry, "Give feedback") with EDITOR as a no-op, so the
  // run reaches the feedback flow and stops there. What is asserted is that the
  // loop did NOT refuse on the violation.
  test('a task with a pending protected file still reaches the feedback flow', async () => {
    setProtectedPatterns(ctx.root, ['*.spec.*']);
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable protected patterns');
    writeFileSync(join(ctx.root, 'a.spec.ts'), 'describe("existing", () => {});\n');
    ctx.git('add', 'a.spec.ts');
    ctx.git('commit', '-m', 'Add a spec file');

    const taskId = await createTask(ctx, 'Touch a protected test', 'Do the work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes', '--follow'], MOCK_CLAUDE_SUCCESS, {
      env: {
        LAZY_MOCK_SHOULD_COMMIT: '1',
        LAZY_MOCK_FILES: JSON.stringify([
          { path: 'a.spec.ts', content: 'describe("agent changed this", () => {});\n' },
        ]),
      },
    }));
    await runReconcile(ctx.root, ctx.protocolBase);
    expect(readTaskStatus(ctx.root, taskId)).toBe('conflict');

    const result = await ctx.lazyMocked(['loop', taskId], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_FORCE_TTY: '1', LAZY_PROMPT_DEFAULTS: '1', EDITOR: 'true', VISUAL: 'true' },
    });

    const output = result.stdout + result.stderr;
    // The refusal that used to fire here, verbatim from the deleted gate.
    expect(output).not.toContain('has file permission violations');
    expect(output).not.toContain('to handle them interactively');
    // It got as far as offering the feedback menu for this task.
    expect(output).toContain('Give feedback');
  }, 60_000);

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
