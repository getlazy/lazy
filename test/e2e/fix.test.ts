import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, extractTaskId } from '../helpers/assertions';

describe('lazy fix', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('creates a fix task with --goal flag', async () => {
    const result = await ctx.lazy(['fix', '--goal', 'Fix token refresh hanging']);

    expectSuccess(result);
    expectOutput(result, 'Created task');
    expectOutput(result, 'Fix token refresh hanging');
    expectOutput(result, 'fix');
  });

  test('sets task type to fix automatically', async () => {
    const result = await ctx.lazy(['fix', '--goal', 'Fix null pointer in session cleanup']);
    expectSuccess(result);

    const taskId = extractTaskId(result.stdout);
    const showResult = await ctx.lazy(['show', taskId]);

    expectSuccess(showResult);
    expectOutput(showResult, 'Type:    fix');
  });

  // INVARIANT: Fix tasks always include debugging constraints in the prompt.
  // These constraints enforce experimental debugging methodology: reproduce, instrument, prove.
  test('includes fix constraints in prompt', async () => {
    const result = await ctx.lazy(['fix', '--goal', 'Fix race condition in worker pool']);
    expectSuccess(result);

    const taskId = extractTaskId(result.stdout);
    const showResult = await ctx.lazy(['show', taskId]);

    expectSuccess(showResult);
    expectOutput(showResult, 'Fix Task: Experimental Debugging Methodology');
    expectOutput(showResult, 'Reproduce First');
    expectOutput(showResult, 'Instrument, Don\'t Assume');
  });

  // INVARIANT: User prompt is preserved alongside constraints, not replaced by them.
  test('combines user prompt with fix constraints', async () => {
    const result = await ctx.lazy([
      'fix', '--goal', 'Fix timeout in API calls',
      '--prompt', 'Error: ETIMEDOUT after 30s on production',
    ]);
    expectSuccess(result);

    const taskId = extractTaskId(result.stdout);
    const showResult = await ctx.lazy(['show', taskId]);

    expectSuccess(showResult);
    expectOutput(showResult, 'Error: ETIMEDOUT after 30s on production');
    expectOutput(showResult, 'Fix Task: Experimental Debugging Methodology');
  });

  test('creates a task with --code flag', async () => {
    const result = await ctx.lazy([
      'fix', '--goal', 'Fix memory leak', '--code', 'fix-memory-leak',
    ]);

    expectSuccess(result);
    expectOutput(result, 'fix-memory-leak');
  });

  test('creates a task with --model flag', async () => {
    const result = await ctx.lazy(['fix', '--goal', 'Fix bug', '--model', 'claude-opus-4-6']);

    expectSuccess(result);
    expectOutput(result, 'claude-opus-4-6');
  });

  test('fails with invalid model', async () => {
    const result = await ctx.lazy(['fix', '--goal', 'Fix bug', '--model', 'invalid']);

    expectFailure(result);
    expectError(result, 'Invalid model');
  });

  test('fails with invalid code', async () => {
    const result = await ctx.lazy(['fix', '--goal', 'Fix bug', '--code', 'X']);

    expectFailure(result);
    expectError(result, 'Invalid code');
  });

  test('fails without TTY when no flags provided', async () => {
    const result = await ctx.lazy(['fix']);

    expectFailure(result);
    expectError(result, 'Interactive mode requires a TTY');
  });

  test('fix task appears in list', async () => {
    await ctx.lazy(['fix', '--goal', 'Fix for listing']);
    const listResult = await ctx.lazy(['list']);

    expectSuccess(listResult);
    expectOutput(listResult, 'Fix for listing');
  });

  test('accepts piped stdin as prompt', async () => {
    const result = await ctx.lazy(
      ['fix', '--goal', 'Fix from stdin'],
      { input: 'Reproduction steps: 1. Start app 2. Click logout 3. Crash' },
    );

    expectSuccess(result);
    expectOutput(result, 'Created task');

    const taskId = extractTaskId(result.stdout);
    const showResult = await ctx.lazy(['show', taskId]);

    expectSuccess(showResult);
    expectOutput(showResult, 'Reproduction steps: 1. Start app 2. Click logout 3. Crash');
    expectOutput(showResult, 'Fix Task: Experimental Debugging Methodology');
  });

  test('creates child fix task with --parent flag', async () => {
    const parentResult = await ctx.lazy(['create', '--goal', 'Parent task']);
    expectSuccess(parentResult);
    const parentId = extractTaskId(parentResult.stdout);

    const childResult = await ctx.lazy([
      'fix', '--goal', 'Fix child bug', '--parent', parentId,
    ]);
    expectSuccess(childResult);
    expectOutput(childResult, 'Parent:');

    const childId = extractTaskId(childResult.stdout);
    const showResult = await ctx.lazy(['show', childId]);
    expectSuccess(showResult);
    expectOutput(showResult, `Parent: ${parentId}`);
  });

  test('fails when parent task is in terminal status', async () => {
    const parentResult = await ctx.lazy(['create', '--goal', 'Terminal parent']);
    expectSuccess(parentResult);
    const parentId = extractTaskId(parentResult.stdout);

    // Close the parent task to put it in terminal status
    await ctx.lazy(['close', parentId]);

    const childResult = await ctx.lazy([
      'fix', '--goal', 'Fix with closed parent', '--parent', parentId,
    ]);
    expectFailure(childResult);
    expectError(childResult, 'task is closed');
  });
});
