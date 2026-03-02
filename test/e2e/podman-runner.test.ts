import { describe, test, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { writeFileSync, readFileSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, expectOutputExcludes } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';

/** Replace the [runner] section's type value in a lazy.toml config string. */
function setRunnerType(config: string, type: string): string {
  return config.replace(/^type\s*=\s*"[^"]*"/m, `type = "${type}"`);
}

describe('podman runner configuration', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: [runner] type = "podman" is a valid config value.
  // Podman is a supported container runtime alongside Docker.
  test('podman runner config is recognized by doctor', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, setRunnerType(existingConfig, 'podman'));

    const result = await ctx.lazy(['doctor']);
    // Should show Podman-specific checks instead of Docker checks
    expectOutput(result, 'Podman installed');
    expectOutputExcludes(result, 'Docker installed');
    expectOutputExcludes(result, 'Docker daemon');
  });

  // INVARIANT: Podman runner does not show Docker-specific checks.
  // Users who chose Podman shouldn't see Docker health checks.
  test('doctor skips Docker checks in podman mode', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, setRunnerType(existingConfig, 'podman'));

    const result = await ctx.lazy(['doctor']);
    expectOutputExcludes(result, 'Docker installed');
    expectOutputExcludes(result, 'Docker daemon running');
  });

  // INVARIANT: [runner] type = "podman" is not reported as an unknown config value.
  test('podman runner config key is not reported as unknown by doctor', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, setRunnerType(existingConfig, 'podman'));

    const result = await ctx.lazy(['doctor']);
    expectOutput(result, 'No unknown config options');
  });

  // INVARIANT: Commands that don't invoke the container runtime work with podman config.
  test('list works with podman runner', async () => {
    const taskId = await createTask(ctx, 'Podman runner test');

    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, setRunnerType(existingConfig, 'podman'));

    const result = await ctx.lazy(['list', '--all']);
    expectSuccess(result);
    expectOutput(result, 'Podman runner test');
  });

  // INVARIANT: show works with podman runner config.
  test('show works with podman runner', async () => {
    const taskId = await createTask(ctx, 'Show in podman mode');

    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, setRunnerType(existingConfig, 'podman'));

    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
    expectOutput(result, 'Show in podman mode');
  });
});
