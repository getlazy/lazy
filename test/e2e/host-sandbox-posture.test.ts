/**
 * Host sandbox permission posture — config validation surface.
 *
 * Host-process runner is test-harness-only now; these e2e cases cover config
 * rejection and that sandbox keys still parse. Argument-level invariants live in
 * test/unit/host-sandbox-posture.test.ts; fake-binary launch coverage lives in
 * test/e2e/agent-binary-seam.test.ts (sandbox posture block).
 */

import { describe, test, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { writeFileSync, readFileSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectFailure, expectOutput } from '../helpers/assertions';

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

  test('host-process runner config is rejected with docker guidance', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    writeFileSync(
      configPath,
      readFileSync(configPath, 'utf-8').replace(
        /^type\s*=\s*"[^"]*"/m,
        'type = "dangerously-host-process-without-any-isolation"',
      ),
    );

    const result = await ctx.lazy(['doctor']);
    expectFailure(result);
    expectOutput(result, 'Host-process runner is no longer supported');
  });

  test('invalid permission_mode still fails with an actionable error on docker', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    let config = readFileSync(configPath, 'utf-8');
    config = appendRunnerKey(config, 'permission_mode = "nonsense"');
    writeFileSync(configPath, config);

    const result = await ctx.lazy(['doctor']);
    expectFailure(result);
    expectOutput(result, 'Invalid permission_mode');
    expectOutput(result, 'lazy.toml parses');
  });

  test('runner sandbox keys are not reported as unknown config', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    let config = readFileSync(configPath, 'utf-8');
    config = appendRunnerKey(config, 'sandbox_allowed_domains = ["*.anthropic.com", "github.com"]');
    config = appendRunnerKey(config, 'sandbox_allow_weaker_nested = false');
    writeFileSync(configPath, config);

    const result = await ctx.lazy(['doctor']);
    expectOutput(result, 'No unknown config options');
  });
});
