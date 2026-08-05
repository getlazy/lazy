import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, extractTaskId } from '../helpers/assertions';

describe('lazy refactor', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('creates a refactor task with --goal flag', async () => {
    const result = await ctx.lazy(['refactor', '--goal', 'Extract storage interface']);

    expectSuccess(result);
    expectOutput(result, 'Created task');
    expectOutput(result, 'Extract storage interface');
    expectOutput(result, 'refactor');
  });

  test('sets task type to refactor automatically', async () => {
    const result = await ctx.lazy(['refactor', '--goal', 'Refactor auth module']);
    expectSuccess(result);

    const taskId = extractTaskId(result.stdout);
    const showResult = await ctx.lazy(['show', taskId]);

    expectSuccess(showResult);
    expectOutput(showResult, 'Type:    refactor');
  });

  // INVARIANT: Refactor tasks always include refactoring constraints in the prompt.
  // These constraints enforce no-behavior-change discipline and incremental commits.
  test('includes refactor constraints in prompt', async () => {
    const result = await ctx.lazy(['refactor', '--goal', 'Refactor auth module']);
    expectSuccess(result);

    const taskId = extractTaskId(result.stdout);
    const showResult = await ctx.lazy(['show', taskId]);

    expectSuccess(showResult);
    expectOutput(showResult, 'Refactoring Task Constraints');
  });

  // INVARIANT: User prompt is preserved alongside constraints, not replaced by them.
  test('combines user prompt with refactor constraints', async () => {
    const result = await ctx.lazy([
      'refactor', '--goal', 'Refactor storage',
      '--prompt', 'Focus on reducing cyclomatic complexity',
    ]);
    expectSuccess(result);

    const taskId = extractTaskId(result.stdout);
    const showResult = await ctx.lazy(['show', taskId]);

    expectSuccess(showResult);
    expectOutput(showResult, 'Focus on reducing cyclomatic complexity');
    expectOutput(showResult, 'Refactoring Task Constraints');
  });

  test('creates a task with --code flag', async () => {
    const result = await ctx.lazy([
      'refactor', '--goal', 'Refactor auth', '--code', 'refactor-auth',
    ]);

    expectSuccess(result);
    expectOutput(result, 'refactor-auth');
  });

  test('creates a task with --model flag', async () => {
    const result = await ctx.lazy(['refactor', '--goal', 'Refactor auth', '--model', 'claude-opus-4-6']);

    expectSuccess(result);
    expectOutput(result, 'claude-opus-4-6');
  });

  // RETARGETED: there is no model allowlist any more. Ollama support (5649fcc2)
  // removed it deliberately so arbitrary local model ids work, leaving only the
  // empty-value check. Asserting 'Invalid model' for an unknown name would
  // assert the absence of that feature.
  test('accepts an arbitrary model id but rejects an empty one', async () => {
    const ok = await ctx.lazy(['refactor', '--goal', 'Refactor', '--model', 'my-local-model']);
    expectSuccess(ok);
    expectOutput(ok, 'my-local-model');

    const empty = await ctx.lazy(['refactor', '--goal', 'Refactor', '--model', ' ']);
    expectFailure(empty);
    expectError(empty, 'Model name cannot be empty');
  });

  test('fails with invalid code', async () => {
    const result = await ctx.lazy(['refactor', '--goal', 'Refactor', '--code', 'X']);

    expectFailure(result);
    expectError(result, 'Invalid code');
  });

  test('fails without TTY when no flags provided', async () => {
    const result = await ctx.lazy(['refactor']);

    expectFailure(result);
    expectError(result, 'Interactive mode requires a TTY');
  });

  test('refactor task appears in list', async () => {
    await ctx.lazy(['refactor', '--goal', 'Refactor for listing']);
    const listResult = await ctx.lazy(['list']);

    expectSuccess(listResult);
    expectOutput(listResult, 'Refactor for listing');
  });

  test('accepts piped stdin as prompt', async () => {
    const result = await ctx.lazy(
      ['refactor', '--goal', 'Refactor from stdin'],
      { input: 'Extra refactoring instructions from stdin' },
    );

    expectSuccess(result);
    expectOutput(result, 'Created task');

    const taskId = extractTaskId(result.stdout);
    const showResult = await ctx.lazy(['show', taskId]);

    expectSuccess(showResult);
    expectOutput(showResult, 'Extra refactoring instructions from stdin');
    expectOutput(showResult, 'Refactoring Task Constraints');
  });
});
