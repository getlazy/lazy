import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';

describe('lazy system status', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('reports ONLINE by default', async () => {
    const result = await ctx.lazy(['system', 'status']);
    expectSuccess(result);
    expectOutput(result, 'ONLINE');
    // Core state lines should be present in the readout.
    expectOutput(result, 'Driver');
    expectOutput(result, 'Storage');
    expectOutput(result, 'Daemon');
  });

  test('reports OFFLINE after `lazy system offline`', async () => {
    await ctx.lazy(['system', 'offline']);

    const result = await ctx.lazy(['system', 'status']);
    expectSuccess(result);
    expectOutput(result, 'OFFLINE');
    // The remedy must be surfaced so users know how to get back online.
    expectOutput(result, 'lazy system online');
  });

  test('reports ONLINE again after `lazy system online`', async () => {
    await ctx.lazy(['system', 'offline']);
    await ctx.lazy(['system', 'online']);

    const result = await ctx.lazy(['system', 'status']);
    expectSuccess(result);
    expectOutput(result, 'ONLINE');
  });
});
