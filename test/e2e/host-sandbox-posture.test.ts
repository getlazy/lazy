/**
 * Host sandbox permission posture — config surface + doctor reporting.
 *
 * Covers the new default (host execution runs under Claude Code's OS sandbox) and
 * the explicit bypass opt-in. The argument-level invariants (what flags lazy hands
 * Claude) live in test/unit/host-sandbox-posture.test.ts; this file covers the
 * user-facing config and diagnostics.
 */

import { describe, test, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { writeFileSync, readFileSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectOutputExcludes } from '../helpers/assertions';

const HOST_RUNNER = 'dangerously-host-process-without-any-isolation';

/** Replace the [runner] section's type value in a lazy.toml config string. */
function setRunnerType(config: string, type: string): string {
  return config.replace(/^type\s*=\s*"[^"]*"/m, `type = "${type}"`);
}

/** Append a key to the [runner] section (it is the last section we touch in tests). */
function appendRunnerKey(config: string, line: string): string {
  return config.replace(/^type\s*=\s*"[^"]*"/m, (m) => `${m}\n${line}`);
}

describe('host sandbox permission posture', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: the host runner defaults to the OS sandbox, NOT to full bypass.
  // This is the whole point of the task — host execution must be safe-by-default,
  // and `--dangerously-skip-permissions` must be an explicit opt-in.
  test('default host posture is "sandbox" (doctor reports it)', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    writeFileSync(configPath, setRunnerType(readFileSync(configPath, 'utf-8'), HOST_RUNNER));

    const result = await ctx.lazy(['doctor']);
    expectOutput(result, 'permission_mode = "sandbox"');
    // It must NOT silently be the old full-bypass posture.
    expectOutputExcludes(result, 'permission_mode = "bypass"');
  });

  test('permission_mode = "bypass" is reported as the no-sandbox opt-in', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    let config = setRunnerType(readFileSync(configPath, 'utf-8'), HOST_RUNNER);
    config = appendRunnerKey(config, 'permission_mode = "bypass"');
    writeFileSync(configPath, config);

    const result = await ctx.lazy(['doctor']);
    expectOutput(result, 'permission_mode = "bypass"');
  });

  test('invalid permission_mode fails with an actionable error', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    let config = setRunnerType(readFileSync(configPath, 'utf-8'), HOST_RUNNER);
    config = appendRunnerKey(config, 'permission_mode = "nonsense"');
    writeFileSync(configPath, config);

    const result = await ctx.lazy(['doctor']);
    expectFailure(result);
    // The message lands on STDOUT, not stderr, and that is deliberate: `lazy
    // doctor` is THE surface for "my setup is broken", so it catches a config
    // parse/validation failure and reports it as a failed CHECK inside its own
    // report (see the `configError` block in src/cli/commands/doctor.ts) rather
    // than dying through the generic stderr handler in src/index.ts. Every other
    // command still surfaces this on stderr (see effort.test.ts). The exit code
    // is still non-zero, so scripts are unaffected.
    expectOutput(result, 'Invalid permission_mode');
    expectOutput(result, 'lazy.toml parses');
  });

  test('runner sandbox keys are not reported as unknown config', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    let config = setRunnerType(readFileSync(configPath, 'utf-8'), HOST_RUNNER);
    config = appendRunnerKey(config, 'permission_mode = "sandbox"');
    config = appendRunnerKey(config, 'sandbox_allowed_domains = ["*.anthropic.com", "github.com"]');
    config = appendRunnerKey(config, 'sandbox_allow_weaker_nested = false');
    writeFileSync(configPath, config);

    const result = await ctx.lazy(['doctor']);
    expectOutput(result, 'No unknown config options');
  });

  test('sandbox allowlist is surfaced by doctor', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    let config = setRunnerType(readFileSync(configPath, 'utf-8'), HOST_RUNNER);
    config = appendRunnerKey(config, 'sandbox_allowed_domains = ["*.anthropic.com", "github.com"]');
    writeFileSync(configPath, config);

    const result = await ctx.lazy(['doctor']);
    expectSuccess(result);
    expectOutput(result, 'github.com');
  });
});
