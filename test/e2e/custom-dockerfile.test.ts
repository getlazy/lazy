import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { writeFile, readFile, mkdir } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';

describe('custom Dockerfile support', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('default behavior unchanged when no docker.dockerfile is set', async () => {
    // Default lazy.toml has dockerfile = ""
    const taskId = await createTask(ctx, 'Default Dockerfile task');
    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
  });

  test('config accepts docker.dockerfile setting', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = await readFile(configPath, 'utf-8');

    // Create a custom Dockerfile
    const dockerDir = join(ctx.root, 'docker');
    await mkdir(dockerDir, { recursive: true });
    await writeFile(
      join(dockerDir, 'lazy-agent.Dockerfile'),
      'FROM ruby:3.2\nRUN apt-get update && apt-get install -y git\n',
    );

    // Set docker.dockerfile in config
    const newConfig = existingConfig.replace(
      'dockerfile = ""',
      'dockerfile = "docker/lazy-agent.Dockerfile"',
    );
    await writeFile(configPath, newConfig, 'utf-8');

    // Non-Docker commands should still work with custom config
    const taskId = await createTask(ctx, 'Custom Dockerfile task');
    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
  });

  test('config template includes docker section', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const content = await readFile(configPath, 'utf-8');

    // Verify the default template has the docker section
    expect(content).toContain('[docker]');
    expect(content).toContain('dockerfile');
  });
});
