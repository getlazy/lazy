import { describe, test, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { writeFileSync, readFileSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, expectOutputExcludes } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';

describe('docker runner flags', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: Existing configs with runner = "docker" (flat string) must keep
  // working after the migration to [runner] section format.
  test('backward compat: runner = "docker" (string form) still works', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, `runner = "docker"\n${existingConfig}`);

    const taskId = await createTask(ctx, 'Backward compat test');
    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
    expectOutput(result, 'Backward compat test');
  });

  // INVARIANT: The new [runner] section format is recognized and parsed correctly.
  test('[runner] section with type works', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, existingConfig + `
[runner]
type = "docker"
`);

    const taskId = await createTask(ctx, 'Runner section test');
    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
    expectOutput(result, 'Runner section test');
  });

  test('[runner] section with docker_agent_no_network works', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, existingConfig + `
[runner]
type = "docker"
docker_agent_no_network = true
`);

    const taskId = await createTask(ctx, 'Docker flags test');
    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
    expectOutput(result, 'Docker flags test');
  });

  test('doctor shows docker_agent_no_network when enabled', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, existingConfig + `
[runner]
type = "docker"
docker_agent_no_network = true
`);

    const result = await ctx.lazy(['doctor']);
    expectOutput(result, 'docker_agent_no_network enabled');
  });

  // INVARIANT: [runner] section keys are not flagged as unknown by doctor.
  test('[runner] section keys not reported as unknown', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, existingConfig + `
[runner]
type = "docker"
docker_agent_no_network = false
`);

    const result = await ctx.lazy(['doctor']);
    expectOutputExcludes(result, "Unknown config option 'runner.type'");
    expectOutputExcludes(result, "Unknown config option 'runner.docker_agent_no_network'");
  });

  // INVARIANT: Legacy string runner = "docker" is not reported as unknown.
  test('legacy string runner not reported as unknown', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, `runner = "docker"\n${existingConfig}`);

    const result = await ctx.lazy(['doctor']);
    expectOutputExcludes(result, "Unknown config section '[runner]'");
    expectOutputExcludes(result, "Unknown config option 'runner'");
  });

  test('host-process runner still works with [runner] section', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, existingConfig + `
[runner]
type = "dangerously-host-process-without-any-isolation"
`);

    const result = await ctx.lazy(['doctor']);
    expectOutput(result, 'Runner mode: host-process');
    expectOutputExcludes(result, 'Docker installed');
  });
});
