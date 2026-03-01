import { describe, test, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';

describe('lazy completion', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('--zsh outputs valid zsh completion script', async () => {
    const result = await ctx.lazy(['completion', '--zsh']);
    expectSuccess(result);
    expectOutput(result, 'compdef _lazy lazy');
    expectOutput(result, '_lazy()');
    expectOutput(result, 'compadd');
  });

  test('--bash outputs valid bash completion script', async () => {
    const result = await ctx.lazy(['completion', '--bash']);
    expectSuccess(result);
    expectOutput(result, 'complete -F _lazy_completions lazy');
    expectOutput(result, '_lazy_completions()');
    expectOutput(result, 'COMPREPLY');
  });

  test('fails without --bash or --zsh', async () => {
    const result = await ctx.lazy(['completion']);
    expectFailure(result);
    expectError(result, 'Specify a shell');
  });

  test('fails with both --bash and --zsh', async () => {
    const result = await ctx.lazy(['completion', '--bash', '--zsh']);
    expectFailure(result);
    expectError(result, 'Specify only one shell');
  });

  test('--help shows usage', async () => {
    const result = await ctx.lazy(['completion', '--help']);
    expectSuccess(result);
    expectOutput(result, 'lazy completion --bash | --zsh');
    expectOutput(result, 'eval');
  });

  test('zsh script includes all expected commands', async () => {
    const result = await ctx.lazy(['completion', '--zsh']);
    expectSuccess(result);
    // Check a representative set of commands are in the completion list
    expectOutput(result, 'start');
    expectOutput(result, 'show');
    expectOutput(result, 'accept');
    expectOutput(result, 'reject');
    expectOutput(result, 'diff');
    expectOutput(result, 'list');
    expectOutput(result, 'completion');
  });

  test('bash script includes task ID completion via active --ids-only', async () => {
    const result = await ctx.lazy(['completion', '--bash']);
    expectSuccess(result);
    expectOutput(result, 'active --ids-only');
  });

  test('zsh script includes task ID completion via active --ids-only', async () => {
    const result = await ctx.lazy(['completion', '--zsh']);
    expectSuccess(result);
    expectOutput(result, 'active --ids-only');
  });

  test('zsh script includes flag completion for commands', async () => {
    const result = await ctx.lazy(['completion', '--zsh']);
    expectSuccess(result);
    expectOutput(result, '--goal');
    expectOutput(result, '--model');
    expectOutput(result, '--follow');
  });
});

describe('lazy active --ids-only', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('outputs nothing when no active tasks exist', async () => {
    // Create a task but don't start it — it has no session
    await createTask(ctx, 'Unstarted task');

    const result = await ctx.lazy(['active', '--ids-only']);
    expectSuccess(result);
    if (result.stdout.trim().length > 0) {
      throw new Error(`Expected empty output, got: ${result.stdout}`);
    }
  });
});

describe('lazy list --ids-only', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('outputs nothing when no tasks exist', async () => {
    const result = await ctx.lazy(['list', '--ids-only']);
    expectSuccess(result);
    // Should be empty or just whitespace
    if (result.stdout.trim().length > 0) {
      throw new Error(`Expected empty output, got: ${result.stdout}`);
    }
  });

  test('outputs task IDs one per line', async () => {
    const id1 = await createTask(ctx, 'First task');
    const id2 = await createTask(ctx, 'Second task');

    const result = await ctx.lazy(['list', '--ids-only']);
    expectSuccess(result);

    const lines = result.stdout.trim().split('\n');
    if (lines.length !== 2) {
      throw new Error(`Expected 2 lines, got ${lines.length}: ${result.stdout}`);
    }
    expectOutput(result, id1);
    expectOutput(result, id2);
  });

  test('--all --ids-only includes terminal tasks', async () => {
    const id = await createTask(ctx, 'Task to close');
    await ctx.lazy(['close', id, '--reason', 'testing']);

    // Without --all, should not appear (task is now terminal)
    const result1 = await ctx.lazy(['list', '--ids-only']);
    expectSuccess(result1);

    // With --all, should appear
    const result2 = await ctx.lazy(['list', '--all', '--ids-only']);
    expectSuccess(result2);
    expectOutput(result2, id);
  });
});
