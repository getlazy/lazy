import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';

describe('lazy system offline / online', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('system offline enables offline mode', async () => {
    const result = await ctx.lazy(['system', 'offline']);
    expectSuccess(result);
    expectOutput(result, 'Offline mode enabled');

    // Verify marker file was created in project's .lazy/
    const markerPath = join(ctx.root, '.lazy', 'offline.json');
    expect(existsSync(markerPath)).toBe(true);
    const state = JSON.parse(readFileSync(markerPath, 'utf-8'));
    expect(state.enabled).toBe(true);
  });

  test('system offline is idempotent', async () => {
    await ctx.lazy(['system', 'offline']);

    const result = await ctx.lazy(['system', 'offline']);
    expectSuccess(result);
    expectOutput(result, 'Already in offline mode');
  });

  test('system online disables offline mode', async () => {
    await ctx.lazy(['system', 'offline']);

    const result = await ctx.lazy(['system', 'online']);
    expectSuccess(result);
    expectOutput(result, 'Online mode restored');

    // Verify marker file was removed
    const markerPath = join(ctx.root, '.lazy', 'offline.json');
    expect(existsSync(markerPath)).toBe(false);
  });

  test('system online is idempotent when already online', async () => {
    const result = await ctx.lazy(['system', 'online']);
    expectSuccess(result);
    expectOutput(result, 'Already online');
  });

  test('system offline records configured driver', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    writeFileSync(configPath, '[remote]\ndriver = "github"\n');

    const result = await ctx.lazy(['system', 'offline']);
    expectSuccess(result);
    expectOutput(result, 'Remote driver "github" operations will be skipped');

    const markerPath = join(ctx.root, '.lazy', 'offline.json');
    const state = JSON.parse(readFileSync(markerPath, 'utf-8'));
    expect(state.configured_driver).toBe('github');
  });

  test('system online mentions configured driver when restoring', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    writeFileSync(configPath, '[remote]\ndriver = "github"\n');
    await ctx.lazy(['system', 'offline']);

    const result = await ctx.lazy(['system', 'online']);
    expectSuccess(result);
    expectOutput(result, 'Remote driver "github" operations will resume');
  });

  test('system offline shows help', async () => {
    const result = await ctx.lazy(['system', 'offline', '--help']);
    expectSuccess(result);
    expectOutput(result, 'Enable offline mode');
  });

  test('system online shows help', async () => {
    const result = await ctx.lazy(['system', 'online', '--help']);
    expectSuccess(result);
    expectOutput(result, 'Disable offline mode');
  });

  // INVARIANT: Submit should be blocked when offline because it requires
  // creating a remote PR — there's no meaningful local fallback for submit.
  test('submit is blocked when offline', async () => {
    const taskId = await createTask(ctx, 'Test task', 'Do something');
    await ctx.lazy(['system', 'offline']);

    const result = await ctx.lazy(['submit', taskId]);
    expectFailure(result);
    expectError(result, 'offline');
  });

  // --- config integration tests ---

  test('config set offline on enables offline mode', async () => {
    const result = await ctx.lazy(['config', 'set', 'offline', 'on']);
    expectSuccess(result);
    expectOutput(result, 'Offline mode enabled');

    const markerPath = join(ctx.root, '.lazy', 'offline.json');
    expect(existsSync(markerPath)).toBe(true);
  });

  test('config set offline off disables offline mode', async () => {
    await ctx.lazy(['config', 'set', 'offline', 'on']);

    const result = await ctx.lazy(['config', 'set', 'offline', 'off']);
    expectSuccess(result);
    expectOutput(result, 'Online mode restored');

    const markerPath = join(ctx.root, '.lazy', 'offline.json');
    expect(existsSync(markerPath)).toBe(false);
  });

  test('config get offline shows status', async () => {
    const onlineResult = await ctx.lazy(['config', 'get', 'offline']);
    expectSuccess(onlineResult);
    expectOutput(onlineResult, 'off');

    await ctx.lazy(['config', 'set', 'offline', 'on']);

    const offlineResult = await ctx.lazy(['config', 'get', 'offline']);
    expectSuccess(offlineResult);
    expectOutput(offlineResult, 'ENABLED');
  });

  test('system offline mentions daemon tick delay', async () => {
    const result = await ctx.lazy(['system', 'offline']);
    expectSuccess(result);
    expectOutput(result, 'next tick');
  });
});
