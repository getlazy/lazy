import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { writeFile, readFile } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';

describe('LAZY_CONFIG environment variable', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('uses default lazy.toml when LAZY_CONFIG is not set', async () => {
    // Modify default lazy.toml to have a distinctive value
    const defaultConfigPath = join(ctx.root, 'lazy.toml');
    const existingConfig = await readFile(defaultConfigPath, 'utf-8');
    const modifiedConfig = existingConfig.replace(
      'shortid_length = 8',
      'shortid_length = 10',
    );
    await writeFile(defaultConfigPath, modifiedConfig, 'utf-8');

    // Create a task and verify it works (config is loaded successfully)
    const result = await ctx.lazy(['create', '--goal', 'Test task', '--prompt', 'Test prompt']);
    expectSuccess(result);

    // Extract task ID from output - should be 10 chars (reflecting the modified config)
    const taskIdMatch = result.stdout.match(/[a-f0-9]{10}/);
    expect(taskIdMatch).toBeTruthy();
    expect(taskIdMatch![0].length).toBe(10);
  });

  test('reads from custom config when LAZY_CONFIG is set', async () => {
    // Create a custom config file with distinctive settings
    const customConfigPath = join(ctx.root, 'custom.toml');
    const defaultConfigPath = join(ctx.root, 'lazy.toml');
    const defaultConfig = await readFile(defaultConfigPath, 'utf-8');

    // Custom config: shortid_length = 6
    const customConfig = defaultConfig.replace(
      'shortid_length = 8',
      'shortid_length = 6',
    );
    await writeFile(customConfigPath, customConfig, 'utf-8');

    // Create a task with LAZY_CONFIG pointing to custom.toml
    const result = await ctx.lazy(
      ['create', '--goal', 'Custom config task', '--prompt', 'Test task with custom config'],
      { env: { LAZY_CONFIG: 'custom.toml' } },
    );
    expectSuccess(result);

    // Extract task ID from output (should be 6 chars)
    const taskIdMatch = result.stdout.match(/[a-f0-9]{6}/);
    expect(taskIdMatch).toBeTruthy();
    const taskId = taskIdMatch![0];
    expect(taskId.length).toBe(6);

    // Verify we can show the task using the custom config
    const showResult = await ctx.lazy(['show', taskId], {
      env: { LAZY_CONFIG: 'custom.toml' },
    });
    expectSuccess(showResult);
    expect(showResult.stdout).toContain('Custom config task');
  });

  test('falls back to lazy.toml if custom config does not exist', async () => {
    // Try to use a non-existent config file
    // Should fall back to lazy.toml (or defaults if lazy.toml also doesn't exist)
    const result = await ctx.lazy(['list'], {
      env: { LAZY_CONFIG: 'nonexistent.toml' },
    });
    expectSuccess(result);
  });

  test('works with relative path in LAZY_CONFIG', async () => {
    // Create a custom config in a subdirectory
    const customConfigPath = join(ctx.root, 'config', 'custom.toml');
    const defaultConfigPath = join(ctx.root, 'lazy.toml');
    const defaultConfig = await readFile(defaultConfigPath, 'utf-8');

    // Ensure config directory exists
    await Bun.write(customConfigPath, defaultConfig);

    // Use relative path in LAZY_CONFIG
    const result = await ctx.lazy(['list'], {
      env: { LAZY_CONFIG: 'config/custom.toml' },
    });
    expectSuccess(result);
  });
});
