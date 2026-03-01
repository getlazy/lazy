import { describe, test, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { writeFileSync, readFileSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, expectOutputExcludes } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

describe('runner configuration', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('default config uses docker runner', async () => {
    const result = await ctx.lazy(['doctor']);
    // Docker runner shows Docker-specific checks
    expectOutput(result, 'Docker installed');
  });

  test('host-process runner config is recognized', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, `runner = "dangerously-host-process-without-any-isolation"\n${existingConfig}`);

    const result = await ctx.lazy(['doctor']);
    // Should show host-process mode checks instead of Docker checks
    expectOutput(result, 'Runner mode: host-process');
    expectOutputExcludes(result, 'Docker installed');
    expectOutputExcludes(result, 'Docker daemon');
  });

  test('list works with host-process runner', async () => {
    // Create a task first (before changing runner config)
    const taskId = await createTask(ctx, 'Host process test');

    // Switch to host-process runner
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, `runner = "dangerously-host-process-without-any-isolation"\n${existingConfig}`);

    // List should work — it uses the runner for crash detection only
    const result = await ctx.lazy(['list', '--all']);
    expectSuccess(result);
    expectOutput(result, 'Host process test');
  });

  test('invalid runner config fails with error', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    writeFileSync(configPath, `runner = "invalid-runner"\n`);

    // doctor always creates a runner, so it should fail with an invalid runner type
    const result = await ctx.lazy(['doctor']);
    expectFailure(result);
    expectError(result, 'Unknown runner type');
  });

  test('doctor shows claude CLI check for host-process mode', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, `runner = "dangerously-host-process-without-any-isolation"\n${existingConfig}`);

    const result = await ctx.lazy(['doctor']);
    // Should check for Claude Code CLI instead of Docker
    expectOutput(result, 'Claude Code CLI');
  });

  test('doctor skips Docker image checks in host-process mode', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, `runner = "dangerously-host-process-without-any-isolation"\n${existingConfig}`);

    const result = await ctx.lazy(['doctor']);
    expectOutputExcludes(result, 'Container image');
    expectOutputExcludes(result, 'orphaned containers');
  });

  test('runner config key is not reported as unknown by doctor', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, `runner = "docker"\n${existingConfig}`);

    const result = await ctx.lazy(['doctor']);
    expectOutput(result, 'No unknown config options');
  });

  test('show works with host-process runner', async () => {
    const taskId = await createTask(ctx, 'Show in host-process mode');

    // Switch to host-process runner
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, `runner = "dangerously-host-process-without-any-isolation"\n${existingConfig}`);

    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
    expectOutput(result, 'Show in host-process mode');
  });
});
