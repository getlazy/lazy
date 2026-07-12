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

  // --- auto-expiry (temporary offline) ---

  // INVARIANT: `lazy system offline` is temporary and auto-recovers at local
  // midnight. The output must always tell the user when it resumes — no silent
  // indefinite offline.
  test('system offline always displays when it auto-resumes', async () => {
    const result = await ctx.lazy(['system', 'offline']);
    expectSuccess(result);
    expectOutput(result, 'auto-resumes');
    expectOutput(result, 'local'); // "(00:00 local)" countdown anchor
    expectOutput(result, 'auto-recovers at local midnight');

    // The on-disk state must carry an expiry so it cannot strand the user.
    const state = JSON.parse(readFileSync(join(ctx.root, '.lazy', 'offline.json'), 'utf-8'));
    expect(typeof state.expires_at).toBe('string');
    expect(new Date(state.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  // INVARIANT: an expired temporary offline reports as ONLINE again with no
  // manual `lazy system online`. We simulate the passage of time by writing a
  // past expiry directly, then assert status reads as online.
  test('expired offline auto-recovers — status shows ONLINE', async () => {
    const markerPath = join(ctx.root, '.lazy', 'offline.json');
    writeFileSync(markerPath, JSON.stringify({
      enabled: true,
      enabled_at: new Date(Date.now() - 86_400_000).toISOString(),
      expires_at: new Date(Date.now() - 1000).toISOString(),
    }));

    const result = await ctx.lazy(['system', 'status']);
    expectSuccess(result);
    expectOutput(result, 'ONLINE');
    // Stale file should be cleaned up by the read.
    expect(existsSync(markerPath)).toBe(false);
  });

  test('system status shows the offline expiry countdown', async () => {
    await ctx.lazy(['system', 'offline']);
    const result = await ctx.lazy(['system', 'status']);
    expectSuccess(result);
    expectOutput(result, 'OFFLINE');
    expectOutput(result, 'auto-resumes');
  });

  test('system offline tells the user how to stay offline permanently', async () => {
    const result = await ctx.lazy(['system', 'offline']);
    expectSuccess(result);
    expectOutput(result, 'offline = true');
    expectOutput(result, 'lazy.toml');
  });

  // --- permanent offline (config flag) ---

  // INVARIANT: permanent offline lives in lazy.toml and is NOT subject to the
  // midnight auto-expiry. The temporary command must not write a redundant
  // offline.json, and must explain how to leave permanent offline.
  test('permanent config offline is honored without an offline.json file', async () => {
    writeFileSync(join(ctx.root, 'lazy.toml'), '[remote]\ndriver = "github"\noffline = true\n');

    const status = await ctx.lazy(['system', 'status']);
    expectSuccess(status);
    expectOutput(status, 'OFFLINE');
    expectOutput(status, 'does not auto-resume');

    // No temporary file was created — permanent offline comes from config alone.
    expect(existsSync(join(ctx.root, '.lazy', 'offline.json'))).toBe(false);
  });

  test('system offline is a no-op when permanent offline is configured', async () => {
    writeFileSync(join(ctx.root, 'lazy.toml'), '[remote]\noffline = true\n');

    const result = await ctx.lazy(['system', 'offline']);
    expectSuccess(result);
    expectOutput(result, 'permanently');
    // Must not create a temporary file when permanent is already in effect.
    expect(existsSync(join(ctx.root, '.lazy', 'offline.json'))).toBe(false);
  });

  // INVARIANT: `lazy system online` must NOT silently rewrite lazy.toml. With
  // permanent offline set, it tells the user to remove the flag and stays offline.
  test('system online does not clear permanent (config) offline', async () => {
    writeFileSync(join(ctx.root, 'lazy.toml'), '[remote]\noffline = true\n');

    const result = await ctx.lazy(['system', 'online']);
    expectSuccess(result);
    expectOutput(result, 'Still offline');
    expectOutput(result, 'lazy.toml');

    // lazy.toml is untouched — the flag is still there.
    expect(readFileSync(join(ctx.root, 'lazy.toml'), 'utf-8')).toContain('offline = true');

    // And status still reports offline.
    const status = await ctx.lazy(['system', 'status']);
    expectOutput(status, 'OFFLINE');
  });

  test('config get offline reports permanent offline', async () => {
    writeFileSync(join(ctx.root, 'lazy.toml'), '[remote]\noffline = true\n');
    const result = await ctx.lazy(['config', 'get', 'offline']);
    expectSuccess(result);
    expectOutput(result, 'ENABLED');
    expectOutput(result, 'does not auto-resume');
  });
});
