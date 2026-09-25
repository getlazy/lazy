import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectOutput } from '../helpers/assertions';
import { setTaskStatus, setTaskMetadata, readSystemMessagesFile } from '../helpers/storage';

/**
 * When `lazy doctor` finds ERROR-level checks it files ONE inbox alert so
 * people who never run doctor still see the findings. Dedup: an identical
 * still-open message is reused.
 */
describe('lazy doctor inbox alert', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('a run with a forced error files one alert visible in lazy messages', async () => {
    const create = await ctx.lazy(['create', '--goal', 'Wedged for doctor alert']);
    const taskId = create.stdout.match(/([0-9a-f]{8})/)![1];
    setTaskStatus(ctx.root, taskId, 'merging');
    setTaskMetadata(ctx.root, taskId, 'accept_in_flight_from', 'blocked');

    await ctx.lazy(['doctor']);

    const messages = await ctx.lazy(['messages']);
    expectOutput(messages, 'lazy doctor found issues');

    const stored = readSystemMessagesFile(ctx.root);
    const alerts = stored.filter(m => m.source === 'doctor' && m.title === 'lazy doctor found issues');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.kind).toBe('alert');
    expect(alerts[0]!.body).toContain("merging");
  });

  test('re-running doctor does not stack an identical alert', async () => {
    const create = await ctx.lazy(['create', '--goal', 'Wedged for doctor dedup']);
    const taskId = create.stdout.match(/([0-9a-f]{8})/)![1];
    setTaskStatus(ctx.root, taskId, 'merging');
    setTaskMetadata(ctx.root, taskId, 'accept_in_flight_from', 'blocked');

    await ctx.lazy(['doctor']);
    await ctx.lazy(['doctor']);

    const stored = readSystemMessagesFile(ctx.root);
    const alerts = stored.filter(m => m.source === 'doctor' && m.title === 'lazy doctor found issues');
    expect(alerts).toHaveLength(1);
  });
});
