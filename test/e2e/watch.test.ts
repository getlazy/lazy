import { describe, test, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';

describe('lazy watch', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('shows error when no tasks are running', async () => {
    const result = await ctx.lazy(['watch']);
    // No working tasks — should show a message
    expectOutput(result, 'No tasks are currently running');
  });

  test('shows error when task is not in working status', async () => {
    const taskId = await createTask(ctx, 'Test task for watch');
    const result = await ctx.lazy(['watch', taskId]);
    expectFailure(result);
    expectError(result, 'not currently running');
  });

  test('shows error when task not found', async () => {
    const result = await ctx.lazy(['watch', 'nonexist']);
    expectFailure(result);
    // Should fail because task doesn't exist
  });

  test('shows help with --help flag', async () => {
    const result = await ctx.lazy(['watch', '--help']);
    expectOutput(result, 'lazy watch');
    expectOutput(result, 'real-time');
  });

  // The proxy-traffic layer is what makes watch agent-agnostic: every agent's
  // API calls ride lazy's proxy, so this is the one stream that works for
  // Cursor (whose wire format lazy deliberately does not parse) as well as
  // Claude. These pin the surface; the rendering and the subscription are
  // covered in test/unit/proxy-activity-renderer.test.ts and
  // test/unit/daemon-proxy-watch.test.ts.
  test('help documents the traffic flags', async () => {
    const result = await ctx.lazy(['watch', '--help']);
    expectOutput(result, '--traffic');
    expectOutput(result, '--no-traffic');
    expectOutput(result, 'net>');
  });

  test('--traffic and --no-traffic together are refused', async () => {
    const result = await ctx.lazy(['watch', '--traffic', '--no-traffic']);
    expectFailure(result);
    expectError(result, 'contradict');
  });

  // Rather than sitting blank, a traffic stream that cannot reach the daemon
  // says so and exits — "is it quiet or is it broken?" is the exact ambiguity
  // this feature exists to remove.
  test('--traffic says why it has nothing to show instead of hanging', async () => {
    const result = await ctx.lazy(['watch', '--traffic']);
    expectOutput(result, 'proxy traffic');
    expectOutput(result, 'unavailable');
  });

  // Unlike the full watch, --traffic does NOT require the task to be working:
  // a task's last requests are worth seeing right after it stops.
  test('--traffic accepts a task that is not running', async () => {
    const taskId = await createTask(ctx, 'Test task for traffic watch');
    const result = await ctx.lazy(['watch', taskId, '--traffic']);
    expectOutput(result, 'proxy traffic');
  });

  test('help text does not require tmux', async () => {
    const result = await ctx.lazy(['watch', '--help']);
    // INVARIANT: lazy watch no longer depends on tmux
    if (result.stdout.includes('tmux must be installed')) {
      throw new Error('Watch help text should not require tmux');
    }
  });
});
