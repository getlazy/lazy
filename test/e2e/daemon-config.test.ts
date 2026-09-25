/**
 * E2E tests for `lazy daemon config` — the runtime builder-cap surface.
 *
 * Agent tasks are uncapped (remove-reaper-cap-sweep): the old
 * `max_concurrent_agents` key is gone and its spelling is rejected with a
 * pointer to the removal, so a stale script fails loudly rather than silently
 * "configuring" nothing.
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
import { expectSuccess, expectFailure, expectOutput, expectOutputExcludes, expectError } from '../helpers/assertions';
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

  test('get shows the builder cap with the default limit of 8, and no agent cap', async () => {
    const result = await ctx.lazy(['daemon', 'config', 'get']);
    expectSuccess(result);
    expectOutput(result, 'Concurrency limits');
    expectOutput(result, 'Builders:');
    expectOutput(result, '0/8 running');
    expectOutput(result, 'max_concurrent_builders');
    // INVARIANT (remove-reaper-cap-sweep): agent tasks are uncapped — there is
    // no agent cap to display, and the output says so.
    expectOutputExcludes(result, 'max_concurrent_agents');
    expectOutputExcludes(result, 'Agents:');
    expectOutput(result, 'uncapped');
  });

  test('set rejects a non-integer value', async () => {
    const result = await ctx.lazy(['daemon', 'config', 'set', 'builders', 'banana']);
    expectFailure(result);
  });

  test('set rejects a zero / negative value', async () => {
    const zero = await ctx.lazy(['daemon', 'config', 'set', 'builders', '0']);
    expectFailure(zero);
  });

  test('set rejects an unknown key', async () => {
    const result = await ctx.lazy(['daemon', 'config', 'set', 'max_concurrent_gremlins', '4']);
    expectFailure(result);
  });

  // INVARIANT (remove-reaper-cap-sweep): the agent cap is REMOVED, not renamed.
  // The old spelling must fail loudly with a message that says why, so a stale
  // script or muscle memory gets an actionable error instead of a silent no-op.
  test('set rejects the removed max_concurrent_agents key with a removal message', async () => {
    const result = await ctx.lazy(['daemon', 'config', 'set', 'max_concurrent_agents', '12']);
    expectFailure(result);
    expectError(result, 'removed');
    const alias = await ctx.lazy(['daemon', 'config', 'set', 'agents', '12']);
    expectFailure(alias);
    expectError(alias, 'removed');
  });

  test('set accepts a valid value and states the override is ephemeral', async () => {
    const result = await ctx.lazy(['daemon', 'config', 'set', 'max_concurrent_builders', '12']);
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

    const set = await ctx.lazy(['daemon', 'config', 'set', 'builders', '5']);
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
    const reset = await ctx.lazy(['daemon', 'config', 'reset', 'builders']);
    expectSuccess(reset);
    const getAfter = await ctx.lazy(['daemon', 'config', 'get']);
    expectOutput(getAfter, '0/8');
  });
});
