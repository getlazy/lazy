import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';

describe('stdin piping', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  describe('lazy comment', () => {
    test('reads comment from piped stdin', async () => {
      const taskId = await createTask(ctx, 'Task for stdin comment');

      const result = await ctx.lazy(['comment', taskId], {
        input: 'This comment came from stdin\n',
      });

      expectSuccess(result);
      expectOutput(result, 'Added comment to task');

      // Verify the comment is stored
      const showResult = await ctx.lazy(['show', taskId]);
      expectSuccess(showResult);
      expectOutput(showResult, 'This comment came from stdin');
    });

    test('reads multi-line comment from piped stdin', async () => {
      const taskId = await createTask(ctx, 'Task for multi-line comment');

      const result = await ctx.lazy(['comment', taskId], {
        input: 'Line 1\nLine 2\nLine 3\n',
      });

      expectSuccess(result);
      expectOutput(result, 'Added comment to task');
    });

    test('--message flag takes priority over piped stdin', async () => {
      const taskId = await createTask(ctx, 'Task for flag priority');

      const result = await ctx.lazy(
        ['comment', taskId, '--message', 'From flag'],
        { input: 'From stdin\n' },
      );

      expectSuccess(result);
      expectOutput(result, 'Added comment to task');

      // Verify the flag content was used, not stdin
      const showResult = await ctx.lazy(['show', taskId]);
      expectSuccess(showResult);
      expectOutput(showResult, 'From flag');
    });

    test('rejects empty piped stdin (treated as no input)', async () => {
      const taskId = await createTask(ctx, 'Task for empty stdin');

      const result = await ctx.lazy(['comment', taskId], {
        input: '   \n\n  \n',
      });

      // Empty/whitespace stdin is treated as no input, falls through to TTY check
      expectFailure(result);
      expectError(result, 'Interactive mode requires a TTY');
    });
  });

  describe('lazy create', () => {
    test('reads prompt from piped stdin when --goal is provided', async () => {
      const result = await ctx.lazy(
        ['create', '--goal', 'Stdin prompt task'],
        { input: 'This is the prompt from stdin\n' },
      );

      expectSuccess(result);
      expectOutput(result, 'Created task');
      expectOutput(result, 'Stdin prompt task');
      expectOutput(result, 'Prompt:');
    });

    test('--prompt flag takes priority over piped stdin', async () => {
      const result = await ctx.lazy(
        ['create', '--goal', 'Flag priority task', '--prompt', 'From flag'],
        { input: 'From stdin\n' },
      );

      expectSuccess(result);
      expectOutput(result, 'Created task');
    });

    test('creates task without prompt when stdin is empty', async () => {
      const result = await ctx.lazy(
        ['create', '--goal', 'No prompt task'],
        { input: '  \n' },
      );

      expectSuccess(result);
      expectOutput(result, 'Created task');
      expectOutput(result, 'No prompt task');
    });
  });

  describe('lazy abandon', () => {
    test('reads reason from piped stdin', async () => {
      const taskId = await createTask(ctx, 'Task to abandon via stdin');

      const result = await ctx.lazy(['abandon', taskId], {
        input: 'Abandoning because of stdin reason\n',
      });

      expectSuccess(result);
      expectOutput(result, 'abandoned');
      expectOutput(result, 'Abandoning because of stdin reason');
    });

    test('--reason flag takes priority over piped stdin', async () => {
      const taskId = await createTask(ctx, 'Task to abandon with flag');

      const result = await ctx.lazy(
        ['abandon', taskId, '--reason', 'Flag reason'],
        { input: 'Stdin reason\n' },
      );

      expectSuccess(result);
      expectOutput(result, 'abandoned');
      expectOutput(result, 'Flag reason');
    });
  });

  describe('lazy edit', () => {
    test('reads prompt from piped stdin', async () => {
      const taskId = await createTask(ctx, 'Task to edit via stdin');

      const result = await ctx.lazy(['edit', taskId], {
        input: 'New prompt from stdin\n',
      });

      expectSuccess(result);
      expectOutput(result, 'Updated prompt');
    });

    test('reads prompt from piped stdin with --goal flag', async () => {
      const taskId = await createTask(ctx, 'Task to edit goal and prompt');

      const result = await ctx.lazy(
        ['edit', taskId, '--goal', 'Updated goal'],
        { input: 'New prompt from stdin with goal\n' },
      );

      expectSuccess(result);
      expectOutput(result, 'Updated goal');
      expectOutput(result, 'Updated prompt');
    });

    test('--prompt flag takes priority over piped stdin', async () => {
      const taskId = await createTask(ctx, 'Task for edit flag priority');

      const result = await ctx.lazy(
        ['edit', taskId, '--prompt', 'From flag'],
        { input: 'From stdin\n' },
      );

      expectSuccess(result);
      expectOutput(result, 'Updated prompt');
    });
  });

  describe('process exit behavior', () => {
    test('piped stdin command exits promptly without hanging', async () => {
      const taskId = await createTask(ctx, 'Task for exit test');

      // Time the command — it should exit within a few seconds, not hang
      const start = Date.now();
      const result = await ctx.lazy(
        ['comment', taskId, '--message', 'quick exit test'],
        { input: 'piped input\n' },
      );
      const elapsed = Date.now() - start;

      expectSuccess(result);
      // If the process hangs, it would hit the 30s test timeout.
      // A healthy exit should complete well under 10 seconds even on slow CI.
      expect(elapsed).toBeLessThan(10_000);
    });

    test('list command with piped stdin exits promptly', async () => {
      const start = Date.now();
      const result = await ctx.lazy(['list'], { input: 'unused input\n' });
      const elapsed = Date.now() - start;

      expectSuccess(result);
      expect(elapsed).toBeLessThan(10_000);
    });

    test('create command with piped stdin exits promptly', async () => {
      const start = Date.now();
      const result = await ctx.lazy(
        ['create', '--goal', 'Exit timing test'],
        { input: 'prompt from stdin\n' },
      );
      const elapsed = Date.now() - start;

      expectSuccess(result);
      expect(elapsed).toBeLessThan(10_000);
    });
  });
});
