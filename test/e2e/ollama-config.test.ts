import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { writeFile, readFile } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectError } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';

describe('ollama config section', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('works with ollama disabled (default)', async () => {
    // Default config should work without [ollama] section
    const taskId = await createTask(ctx, 'No ollama config task');
    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
  });

  test('works with ollama section disabled explicitly', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = await readFile(configPath, 'utf-8');

    const newConfig = existingConfig + `
[ollama]
enabled = false
`;
    await writeFile(configPath, newConfig, 'utf-8');

    const taskId = await createTask(ctx, 'Ollama disabled task');
    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
  });

  test('works with full ollama config', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = await readFile(configPath, 'utf-8');

    const newConfig = existingConfig + `
[ollama]
enabled = true
model = "qwen3.5:35b-a3b-coding-nvfp4"
endpoint = "http://host.docker.internal:11434"
`;
    await writeFile(configPath, newConfig, 'utf-8');

    // Config should parse correctly — commands that don't need auth still work
    const taskId = await createTask(ctx, 'Ollama enabled task');
    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
  });

  // INVARIANT: Ollama enabled without a model is a configuration error.
  // The user must specify which model to use — there's no sensible default.
  test('fails when ollama enabled without model', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = await readFile(configPath, 'utf-8');

    const newConfig = existingConfig + `
[ollama]
enabled = true
`;
    await writeFile(configPath, newConfig, 'utf-8');

    // Should fail because model is required when enabled
    const result = await ctx.lazy(['create', '--goal', 'test task']);
    expectFailure(result);
    expectError(result, 'no model is configured');
  });

  test('ollama config uses default endpoint when not specified', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = await readFile(configPath, 'utf-8');

    const newConfig = existingConfig + `
[ollama]
enabled = true
model = "qwen3-coder"
`;
    await writeFile(configPath, newConfig, 'utf-8');

    // Should work — endpoint defaults to http://host.docker.internal:11434
    const taskId = await createTask(ctx, 'Ollama default endpoint task');
    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
  });
});
