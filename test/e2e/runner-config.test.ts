import { describe, test, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { writeFileSync, readFileSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, expectOutputExcludes } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/** Replace the [runner] section's type value in a lazy.toml config string. */
function setRunnerType(config: string, type: string): string {
  return config.replace(/^type\s*=\s*"[^"]*"/m, `type = "${type}"`);
}

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

  // INVARIANT: host-process runner is test-harness-only — user lazy.toml must fail loud.
  test('host-process runner config is rejected with docker guidance', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, setRunnerType(existingConfig, 'dangerously-host-process-without-any-isolation'));

    const result = await ctx.lazy(['doctor']);
    expectFailure(result);
    expectOutput(result, 'Host-process runner is no longer supported');
    expectOutput(result, 'Docker');
  });

  test('list fails when lazy.toml requests host-process runner', async () => {
    const taskId = await createTask(ctx, 'Host process test');

    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, setRunnerType(existingConfig, 'dangerously-host-process-without-any-isolation'));

    const result = await ctx.lazy(['list', '--all']);
    expectFailure(result);
    expectError(result, 'Host-process runner is no longer supported');
  });

  test('invalid runner config fails with error', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, setRunnerType(existingConfig, 'invalid-runner'));

    // doctor always creates a runner, so it should fail with an invalid runner type
    const result = await ctx.lazy(['doctor']);
    expectFailure(result);
    expectOutput(result, 'Invalid runner type');
  });

  test('runner section is not reported as unknown by doctor', async () => {
    // Default config already has [runner] section — just verify no warnings
    const result = await ctx.lazy(['doctor']);
    expectOutput(result, 'No unknown config options');
  });

  test('show fails when lazy.toml requests host-process runner', async () => {
    const taskId = await createTask(ctx, 'Show in host-process mode');

    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, setRunnerType(existingConfig, 'dangerously-host-process-without-any-isolation'));

    const result = await ctx.lazy(['show', taskId]);
    expectFailure(result);
    expectError(result, 'Host-process runner is no longer supported');
  });

  // INVARIANT: Old top-level `runner = "host"` fails loud — never silently maps to docker.
  test('backward compat: top-level host runner string is rejected', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    writeFileSync(configPath, `runner = "host"\n[models]\ndefault = "sonnet"\n`);

    const result = await ctx.lazy(['doctor']);
    expectFailure(result);
    expectOutput(result, 'Host-process runner is no longer supported');
  });
});
