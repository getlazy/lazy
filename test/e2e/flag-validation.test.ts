import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
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

  test('edit accepts any model string', async () => {
    // Create a task first
    const createResult = await ctx.lazy(['create', '--goal', 'Test task']);
    expectSuccess(createResult);
    const taskId = createResult.stdout.match(/Created task (\w+)/)?.[1];

    // Any non-empty model string is now accepted (raw model IDs)
    const result = await ctx.lazy(['edit', taskId!, '--model', 'any-model-id']);

    expectSuccess(result);
    expectOutput(result, 'Updated model: any-model-id');
  });

  test('start rejects unknown flag', async () => {
    // `start` takes a task id positionally and has no --goal, so passing --goal
    // here made parseFlags reject *that* flag first and the assertion below
    // never exercised --invalid. Use a positional id instead.
    const result = await ctx.lazy(['start', 'zzzzzzzz', '--invalid']);

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

  // REGRESSION: `-f` and `-m` are the documented spellings in `lazy unblock --help`,
  // but parseFlags only registers `--<name>` unless an alias is declared — so `-f`
  // used to be rejected as an unknown flag. Both must parse. The task has no session,
  // so the commands still fail — just not at flag parsing.
  test('unblock accepts the documented -f and -m short flags', async () => {
    const createResult = await ctx.lazy(['create', '--goal', 'Test task']);
    expectSuccess(createResult);
    const taskId = createResult.stdout.match(/Created task (\w+)/)?.[1];

    await Bun.write(join(ctx.root, 'feedback.md'), 'some feedback');

    const fileResult = await ctx.lazy(['unblock', taskId!, '-f', 'feedback.md']);
    expect(fileResult.stderr).not.toContain('Unknown flag');
    expect(fileResult.stdout).not.toContain('Unknown flag');

    const messageResult = await ctx.lazy(['unblock', taskId!, '-m', 'some feedback']);
    expect(messageResult.stderr).not.toContain('Unknown flag');
    expect(messageResult.stdout).not.toContain('Unknown flag');
  });

  // INVARIANT: Model names are raw model IDs — any non-empty string is accepted.
  // No alias resolution or validation against a fixed list.
  test('create accepts raw model IDs', async () => {
    const sonnetResult = await ctx.lazy(['create', '--goal', 'Test sonnet', '--model', 'claude-sonnet-4-5-20250929']);
    expectSuccess(sonnetResult);
    expectOutput(sonnetResult, 'claude-sonnet-4-5-20250929');

    const opusResult = await ctx.lazy(['create', '--goal', 'Test opus', '--model', 'claude-opus-4-6']);
    expectSuccess(opusResult);
    expectOutput(opusResult, 'claude-opus-4-6');

    const ollamaResult = await ctx.lazy(['create', '--goal', 'Test ollama', '--model', 'qwen3.5:35b-a3b-coding-nvfp4']);
    expectSuccess(ollamaResult);
    expectOutput(ollamaResult, 'qwen3.5:35b-a3b-coding-nvfp4');
  });
});
