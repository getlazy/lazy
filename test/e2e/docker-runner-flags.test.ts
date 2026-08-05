import { describe, test, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { writeFileSync, readFileSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, expectOutputExcludes } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';

// The `lazy init` template ALREADY writes a [runner] section. Appending a second
// one is a TOML redefinition error, not a config change — and it used to be
// invisible, because loadConfig warned and silently returned DEFAULT_CONFIG. Every
// test in this file then asserted against defaults while believing it had
// configured something, which is how the host-process case shipped red.
// So: edit the section that is there (setRunnerType), or remove it outright
// (removeRunnerSection) when testing the legacy top-level `runner = "..."` form,
// which cannot coexist with a [runner] table either.

/** Replace the [runner] section's type value in a lazy.toml config string. */
function setRunnerType(config: string, type: string): string {
  return config.replace(/^type\s*=\s*"[^"]*"/m, `type = "${type}"`);
}

/** Drop the whole [runner] table so the legacy top-level `runner` key can be set. */
function removeRunnerSection(config: string): string {
  const lines = config.split('\n');
  const start = lines.findIndex(l => l.trim() === '[runner]');
  if (start === -1) return config;
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith('[')) end++;
  lines.splice(start, end - start);
  return lines.join('\n');
}

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
    writeFileSync(configPath, `runner = "docker"\n${removeRunnerSection(existingConfig)}`);

    const taskId = await createTask(ctx, 'Backward compat test');
    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
    expectOutput(result, 'Backward compat test');
  });

  // INVARIANT: The new [runner] section format is recognized and parsed correctly.
  test('[runner] section with type works', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, setRunnerType(existingConfig, 'docker'));

    const taskId = await createTask(ctx, 'Runner section test');
    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
    expectOutput(result, 'Runner section test');
  });

  // INVARIANT: [runner] section keys are not flagged as unknown by doctor.
  test('[runner] section keys not reported as unknown', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, setRunnerType(existingConfig, 'docker'));

    const result = await ctx.lazy(['doctor']);
    expectOutputExcludes(result, "Unknown config option 'runner.type'");
  });

  // INVARIANT: Legacy string runner = "docker" is not reported as unknown.
  test('legacy string runner not reported as unknown', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, `runner = "docker"\n${removeRunnerSection(existingConfig)}`);

    const result = await ctx.lazy(['doctor']);
    expectOutputExcludes(result, "Unknown config section '[runner]'");
    expectOutputExcludes(result, "Unknown config option 'runner'");
  });

  test('host-process runner still works with [runner] section', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(
      configPath,
      setRunnerType(existingConfig, 'dangerously-host-process-without-any-isolation'),
    );

    const result = await ctx.lazy(['doctor']);
    expectOutput(result, 'Runner mode: host-process');
    expectOutputExcludes(result, 'Docker installed');
  });
});
