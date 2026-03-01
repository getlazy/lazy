import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';

describe('flag validation', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('create rejects unknown flag', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Test', '--unknown']);

    expectFailure(result);
    expectError(result, 'Unknown flag: --unknown');
    expectError(result, 'lazy create --help');
  });

  test('edit validates model values', async () => {
    // Create a task first
    const createResult = await ctx.lazy(['create', '--goal', 'Test task']);
    expectSuccess(createResult);
    const taskId = createResult.stdout.match(/Created task (\w+)/)?.[1];

    // Try to edit with invalid model value
    const result = await ctx.lazy(['edit', taskId!, '--model', 'invalid-model']);

    expectFailure(result);
    expectError(result, 'Invalid model: invalid-model');
    expectError(result, 'Must be one of: sonnet, opus, haiku');
  });

  test('start rejects unknown flag', async () => {
    const result = await ctx.lazy(['start', '--goal', 'Test', '--invalid']);

    expectFailure(result);
    expectError(result, 'Unknown flag: --invalid');
    expectError(result, 'lazy start --help');
  });

  test('list rejects unknown flag', async () => {
    const result = await ctx.lazy(['list', '--unknown']);

    expectFailure(result);
    expectError(result, 'Unknown flag: --unknown');
    expectError(result, 'lazy list --help');
  });

  test('search rejects unknown flag', async () => {
    const result = await ctx.lazy(['search', 'query', '--unknown']);

    expectFailure(result);
    expectError(result, 'Unknown flag: --unknown');
    expectError(result, 'lazy search --help');
  });

  test('show rejects unknown flag', async () => {
    // Create a task first
    const createResult = await ctx.lazy(['create', '--goal', 'Test task']);
    expectSuccess(createResult);
    const taskId = createResult.stdout.match(/Created task (\w+)/)?.[1];

    const result = await ctx.lazy(['show', taskId!, '--unknown']);

    expectFailure(result);
    expectError(result, 'Unknown flag: --unknown');
    expectError(result, 'lazy show --help');
  });

  test('comment rejects unknown flag', async () => {
    // Create a task first
    const createResult = await ctx.lazy(['create', '--goal', 'Test task']);
    expectSuccess(createResult);
    const taskId = createResult.stdout.match(/Created task (\w+)/)?.[1];

    const result = await ctx.lazy(['comment', taskId!, '--message', 'Comment', '--unknown']);

    expectFailure(result);
    expectError(result, 'Unknown flag: --unknown');
    expectError(result, 'lazy comment --help');
  });

  test('accept rejects unknown flag', async () => {
    // Create a task first
    const createResult = await ctx.lazy(['create', '--goal', 'Test task']);
    expectSuccess(createResult);
    const taskId = createResult.stdout.match(/Created task (\w+)/)?.[1];

    const result = await ctx.lazy(['accept', taskId!, '--unknown']);

    expectFailure(result);
    expectError(result, 'Unknown flag: --unknown');
    expectError(result, 'lazy accept --help');
  });

  test('reject rejects unknown flag', async () => {
    // Create a task first
    const createResult = await ctx.lazy(['create', '--goal', 'Test task']);
    expectSuccess(createResult);
    const taskId = createResult.stdout.match(/Created task (\w+)/)?.[1];

    const result = await ctx.lazy(['reject', taskId!, '--reason', 'test', '--unknown']);

    expectFailure(result);
    expectError(result, 'Unknown flag: --unknown');
    expectError(result, 'lazy reject --help');
  });

  test('close rejects unknown flag', async () => {
    // Create a task first
    const createResult = await ctx.lazy(['create', '--goal', 'Test task']);
    expectSuccess(createResult);
    const taskId = createResult.stdout.match(/Created task (\w+)/)?.[1];

    const result = await ctx.lazy(['close', taskId!, '--reason', 'test', '--unknown']);

    expectFailure(result);
    expectError(result, 'Unknown flag: --unknown');
    expectError(result, 'lazy close --help');
  });

  test('status rejects unknown flag', async () => {
    // Create a task first
    const createResult = await ctx.lazy(['create', '--goal', 'Test task']);
    expectSuccess(createResult);
    const taskId = createResult.stdout.match(/Created task (\w+)/)?.[1];

    const result = await ctx.lazy(['status', taskId!, '--unknown']);

    expectFailure(result);
    expectError(result, 'Unknown flag: --unknown');
    expectError(result, 'lazy status --help');
  });

  test('shell rejects unknown flag', async () => {
    // Create a task first
    const createResult = await ctx.lazy(['create', '--goal', 'Test task']);
    expectSuccess(createResult);
    const taskId = createResult.stdout.match(/Created task (\w+)/)?.[1];

    const result = await ctx.lazy(['shell', taskId!, '--unknown']);

    expectFailure(result);
    expectError(result, 'Unknown flag: --unknown');
    expectError(result, 'lazy shell --help');
  });

  test('import-conversation rejects unknown flag', async () => {
    const result = await ctx.lazy(['import-conversation', '--unknown']);

    expectFailure(result);
    expectError(result, 'Unknown flag: --unknown');
    expectError(result, 'lazy import-conversation --help');
  });

  test('create validates model values', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Test', '--model', 'invalid-model']);

    expectFailure(result);
    expectError(result, 'Invalid model: invalid-model');
    expectError(result, 'Must be one of: sonnet, opus, haiku');
  });

  test('create accepts valid model values', async () => {
    const sonnetResult = await ctx.lazy(['create', '--goal', 'Test sonnet', '--model', 'sonnet']);
    expectSuccess(sonnetResult);
    expectOutput(sonnetResult, 'sonnet');

    const opusResult = await ctx.lazy(['create', '--goal', 'Test opus', '--model', 'opus']);
    expectSuccess(opusResult);
    expectOutput(opusResult, 'opus');

    const haikuResult = await ctx.lazy(['create', '--goal', 'Test haiku', '--model', 'haiku']);
    expectSuccess(haikuResult);
    expectOutput(haikuResult, 'haiku');
  });
});
