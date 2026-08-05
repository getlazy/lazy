import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { existsSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectError } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

describe('lazy shell', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // `start` needs daemon-backed storage to create a session + worktree.
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** Create a task and start it so it has a session and a worktree. */
  async function startedTask(goal: string): Promise<string> {
    const taskId = await createTask(ctx, goal, 'Do the work');
    const result = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
    expectSuccess(result);
    return taskId;
  }

  test('runs a command in the worktree and exits with its exit code', async () => {
    const taskId = await startedTask('Shell exec test');
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);

    // Run a deterministic command that produces an observable effect in the
    // worktree (creates a marker file in cwd). argv is passed through.
    const result = await ctx.lazy(['shell', taskId, '--', 'touch', 'RAN_HERE.txt']);

    expectSuccess(result);
    expect(existsSync(join(worktreePath, 'RAN_HERE.txt'))).toBe(true);
  });

  test('sets LAZY_TASK and runs with cwd at the worktree', async () => {
    const taskId = await startedTask('Shell env test');
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);

    // The command sees LAZY_TASK and cwd = the worktree.
    const result = await ctx.lazy(['shell', taskId, '--', 'sh', '-c', 'echo "$LAZY_TASK at $(pwd)"']);

    expectSuccess(result);
    expect(result.stdout).toContain(taskId);
    expect(result.stdout).toContain(worktreePath);
  });

  test('propagates a non-zero exit code from a failing command', async () => {
    const taskId = await startedTask('Shell exit code test');

    const result = await ctx.lazy(['shell', taskId, '--', 'sh', '-c', 'exit 7']);

    expect(result.exitCode).toBe(7);
  });

  test('errors when no command is given after --', async () => {
    const taskId = await startedTask('Shell empty command test');

    const result = await ctx.lazy(['shell', taskId, '--']);

    expectFailure(result);
    expectError(result, "No command given after '--'");
  });

  test('errors when the task has no session (no -- path)', async () => {
    // Created but never started → no session.
    const taskId = await createTask(ctx, 'Shell no-session test', 'Do the work');

    const result = await ctx.lazy(['shell', taskId]);

    expectFailure(result);
    expectError(result, 'has no session');
  });

  test('errors when the task has no session before running a -- command', async () => {
    // The same pre-flight checks must run before executing a one-off command.
    const taskId = await createTask(ctx, 'Shell no-session exec test', 'Do the work');

    const result = await ctx.lazy(['shell', taskId, '--', 'touch', 'SHOULD_NOT_EXIST.txt']);

    expectFailure(result);
    expectError(result, 'has no session');
  });

  test('errors when the task cannot be resolved', async () => {
    const result = await ctx.lazy(['shell', 'nonexistent', '--', 'git', 'status']);

    expectFailure(result);
  });
});
