import { describe, test, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

describe('lazy start --follow', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('start --follow completes without crashing', async () => {
    const taskId = await createTask(ctx, 'Follow test', 'Do the work');

    const result = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );

    // --follow should complete successfully (mock container exits immediately)
    expectSuccess(result);
    expectOutput(result, 'Started task');
    expectOutput(result, taskId);
  });

  // `lazy start` no longer creates tasks: inline `--goal`/`--prompt` were removed
  // in favor of `lazy create` + `lazy start <id>` (see startUsage(), which points
  // at `lazy create`). The removal must stay LOUD — a silently-ignored `--goal`
  // would start some other task while the human believes a new one was created.
  test('start rejects the removed inline --goal flag with an actionable error', async () => {
    const result = await ctx.lazyMocked(
      ['start', '--goal', 'Inline follow test', '--prompt', 'Do the work', '--follow'],
      MOCK_CLAUDE_SUCCESS,
    );

    expectFailure(result);
    expectError(result, 'Unknown flag: --goal');
    expectError(result, 'lazy start --help');
  });
});
