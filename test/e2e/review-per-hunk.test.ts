import { describe, test, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectFailure, expectError, expectOutput } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';

describe('lazy browse -i (interactive)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('refuses to run without a TTY', async () => {
    const taskId = await createTask(ctx, 'Interactive TTY guard');
    const result = await ctx.lazy(['browse', '-i', taskId]);
    expectFailure(result);
    expectError(result, 'requires an interactive terminal');
  });

  test('usage text advertises -i flag', async () => {
    const helpResult = await ctx.lazy(['browse', '--help']);
    expectOutput(helpResult, '-i');
    expectOutput(helpResult, 'interactive');
  });
});
