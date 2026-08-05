/**
 * E2E tests for `lazy daemon config` — the runtime concurrency-cap surface.
 *
 * Two groups:
 *  - Output + validation (no daemon): each invocation falls back to the handler
 *    in-process, so we can assert on rendering and argument validation.
 *  - Ephemeral persistence (withDaemon): the override lives in the daemon
 *    process, so `set` in one CLI call is visible to `get` in the next, and a
 *    lazy.toml value change is NOT written (override is ephemeral).
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput } from '../helpers/assertions';
import { join } from 'path';
import { readFileSync } from 'fs';

describe('lazy daemon config (output + validation)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('get shows both caps with the default limit of 8', async () => {
    const result = await ctx.lazy(['daemon', 'config', 'get']);
    expectSuccess(result);
    expectOutput(result, 'Concurrency limits');
    expectOutput(result, 'Agents:');
    expectOutput(result, 'Builders:');
    // Default cap is 8 for both; agent running count is 0 with no working tasks.
    expectOutput(result, '0/8 running');
    expectOutput(result, 'max_concurrent_agents');
  });

  test('set rejects a non-integer value', async () => {
    const result = await ctx.lazy(['daemon', 'config', 'set', 'max_concurrent_agents', 'banana']);
    expectFailure(result);
  });

  test('set rejects a zero / negative value', async () => {
    const zero = await ctx.lazy(['daemon', 'config', 'set', 'agents', '0']);
    expectFailure(zero);
  });

  test('set rejects an unknown key', async () => {
    const result = await ctx.lazy(['daemon', 'config', 'set', 'max_concurrent_gremlins', '4']);
    expectFailure(result);
  });

  test('set accepts a valid value and states the override is ephemeral', async () => {
    const result = await ctx.lazy(['daemon', 'config', 'set', 'max_concurrent_agents', '12']);
    expectSuccess(result);
    expectOutput(result, 'ephemeral override');
    expectOutput(result, 'lazy.toml'); // points at the permanent home
  });

  test('the alias "builders" maps to max_concurrent_builders', async () => {
    const result = await ctx.lazy(['daemon', 'config', 'set', 'builders', '3']);
    expectSuccess(result);
    expectOutput(result, 'max_concurrent_builders = 3');
  });
});

describe('lazy daemon config (ephemeral persistence, withDaemon)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('an override set in one call is visible to the next, and never touches lazy.toml', async () => {
    const before = readFileSync(join(ctx.root, 'lazy.toml'), 'utf-8');

    const set = await ctx.lazy(['daemon', 'config', 'set', 'max_concurrent_agents', '5']);
    expectSuccess(set);

    // A subsequent call (new CLI process) sees the override held in the daemon.
    const get = await ctx.lazy(['daemon', 'config', 'get']);
    expectSuccess(get);
    expectOutput(get, 'override');
    expectOutput(get, '0/5 (override; configured 8)');

    // The override is ephemeral — lazy.toml is untouched.
    const after = readFileSync(join(ctx.root, 'lazy.toml'), 'utf-8');
    expect(after).toBe(before);

    // Reset clears it, reverting to the configured default of 8.
    const reset = await ctx.lazy(['daemon', 'config', 'reset', 'agents']);
    expectSuccess(reset);
    const getAfter = await ctx.lazy(['daemon', 'config', 'get']);
    expectOutput(getAfter, '0/8');
  });
});
