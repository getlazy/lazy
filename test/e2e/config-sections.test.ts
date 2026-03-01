import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { writeFile, readFile } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';

describe('config remote and docker sections', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('works with default config (no remote/docker sections)', async () => {
    // Default lazy.toml should not have remote/docker but commands still work
    const taskId = await createTask(ctx, 'Default config task');
    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
  });

  test('works with remote and docker config sections in lazy.toml', async () => {
    // Write a lazy.toml with the new sections
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = await readFile(configPath, 'utf-8');

    const newConfig = existingConfig + `
[remote]
driver = "github"
github_auto_push = false

[docker]
dockerfile = "Dockerfile.custom"
`;
    await writeFile(configPath, newConfig, 'utf-8');

    // Commands should still work with the new config sections
    const taskId = await createTask(ctx, 'Custom config task');
    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
  });

  test('works with partial remote config', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = await readFile(configPath, 'utf-8');

    const newConfig = existingConfig + `
[remote]
driver = "github"
`;
    await writeFile(configPath, newConfig, 'utf-8');

    const taskId = await createTask(ctx, 'Partial remote config task');
    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
  });
});
