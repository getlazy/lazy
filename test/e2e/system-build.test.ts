/**
 * E2E tests for `lazy system build`.
 *
 * The command invokes `buildLazyRunnerImage()` from src/capture/claude.ts,
 * which is mocked via preload-mocks.ts. The mock records call options to
 * `LAZY_MOCK_BUILD_LOG` so tests can verify that flags like --no-cache are
 * passed through correctly without actually running Docker.
 */

import { describe, test, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { readFile, writeFile, unlink } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';

const MOCK_RESPONSE = {
  result: 'unused',
  session_id: 'unused',
  usage: { input_tokens: 0, output_tokens: 0 },
};

async function readBuildLog(path: string): Promise<Array<{ binary: string; noCache: boolean; timeoutMs: number }>> {
  const content = await readFile(path, 'utf-8');
  return content
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
}

describe('lazy system build', () => {
  let ctx: TestContext;
  let buildLogPath: string;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    buildLogPath = join(ctx.root, 'build-log.jsonl');
    // Start with an empty log file so readBuildLog doesn't ENOENT before any call
    await writeFile(buildLogPath, '');
  });

  afterEach(async () => {
    try { await unlink(buildLogPath); } catch { /* already gone */ }
    await ctx.cleanup();
  });

  test('builds the lazy-runner image and reports success', async () => {
    const result = await ctx.lazyMocked(
      ['system', 'build', 'lazy-runner'],
      MOCK_RESPONSE,
      { env: { LAZY_MOCK_BUILD_LOG: buildLogPath } },
    );

    expectSuccess(result);
    expectOutput(result, 'Built');
    expectOutput(result, 'lazy-runner');

    const calls = await readBuildLog(buildLogPath);
    if (calls.length !== 1) {
      throw new Error(`Expected 1 build call, got ${calls.length}: ${JSON.stringify(calls)}`);
    }
    if (calls[0].noCache !== false) {
      throw new Error(`Expected noCache=false, got ${calls[0].noCache}`);
    }
  });

  test('passes --no-cache through to the build', async () => {
    const result = await ctx.lazyMocked(
      ['system', 'build', 'lazy-runner', '--no-cache'],
      MOCK_RESPONSE,
      { env: { LAZY_MOCK_BUILD_LOG: buildLogPath } },
    );

    expectSuccess(result);

    const calls = await readBuildLog(buildLogPath);
    if (calls.length !== 1) {
      throw new Error(`Expected 1 build call, got ${calls.length}`);
    }
    if (calls[0].noCache !== true) {
      throw new Error(`Expected noCache=true, got ${calls[0].noCache}`);
    }
  });

  test('rejects an unknown image name and lists valid names', async () => {
    const result = await ctx.lazyMocked(
      ['system', 'build', 'my-custom-image'],
      MOCK_RESPONSE,
      { env: { LAZY_MOCK_BUILD_LOG: buildLogPath } },
    );

    expectFailure(result);
    expectError(result, "unknown system image 'my-custom-image'");
    expectError(result, 'lazy-runner');

    const calls = await readBuildLog(buildLogPath);
    if (calls.length !== 0) {
      throw new Error(`Expected no build calls, got ${calls.length}`);
    }
  });

  test('shows usage and fails when invoked without an image name', async () => {
    const result = await ctx.lazyMocked(
      ['system', 'build'],
      MOCK_RESPONSE,
      { env: { LAZY_MOCK_BUILD_LOG: buildLogPath } },
    );

    expectFailure(result);
    expectOutput(result, 'Usage: lazy system build');

    const calls = await readBuildLog(buildLogPath);
    if (calls.length !== 0) {
      throw new Error(`Expected no build calls, got ${calls.length}`);
    }
  });

  test('rejects multiple positional arguments', async () => {
    const result = await ctx.lazyMocked(
      ['system', 'build', 'lazy-runner', 'extra-arg'],
      MOCK_RESPONSE,
      { env: { LAZY_MOCK_BUILD_LOG: buildLogPath } },
    );

    expectFailure(result);
    expectError(result, 'too many arguments');

    const calls = await readBuildLog(buildLogPath);
    if (calls.length !== 0) {
      throw new Error(`Expected no build calls, got ${calls.length}`);
    }
  });

  // INVARIANT: image builds are UNBOUNDED unless a human asks for a bound.
  // A hardcoded default here once killed real builds on a 20-minute timer and
  // read as Docker failing. See test/unit/docker-build-timeout.test.ts.
  test('builds with no timeout unless --timeout is passed', async () => {
    const result = await ctx.lazyMocked(
      ['system', 'build', 'lazy-runner'],
      MOCK_RESPONSE,
      { env: { LAZY_MOCK_BUILD_LOG: buildLogPath } },
    );

    expectSuccess(result);

    const calls = await readBuildLog(buildLogPath);
    if (calls[0].timeoutMs !== 0) {
      throw new Error(`Expected timeoutMs=0 (unbounded), got ${calls[0].timeoutMs}`);
    }
  });

  test('--timeout is opt-in and expressed in seconds', async () => {
    const result = await ctx.lazyMocked(
      ['system', 'build', 'lazy-runner', '--timeout', '90'],
      MOCK_RESPONSE,
      { env: { LAZY_MOCK_BUILD_LOG: buildLogPath } },
    );

    expectSuccess(result);

    const calls = await readBuildLog(buildLogPath);
    if (calls[0].timeoutMs !== 90_000) {
      throw new Error(`Expected timeoutMs=90000, got ${calls[0].timeoutMs}`);
    }
  });

  // --timeout 0 spells out the default rather than meaning "kill instantly",
  // so a script computing a value never has to special-case zero.
  test('--timeout 0 means unbounded', async () => {
    const result = await ctx.lazyMocked(
      ['system', 'build', 'lazy-runner', '--timeout', '0'],
      MOCK_RESPONSE,
      { env: { LAZY_MOCK_BUILD_LOG: buildLogPath } },
    );

    expectSuccess(result);

    const calls = await readBuildLog(buildLogPath);
    if (calls[0].timeoutMs !== 0) {
      throw new Error(`Expected timeoutMs=0, got ${calls[0].timeoutMs}`);
    }
  });

  test('rejects a non-numeric --timeout instead of silently ignoring it', async () => {
    const result = await ctx.lazyMocked(
      ['system', 'build', 'lazy-runner', '--timeout', 'twenty'],
      MOCK_RESPONSE,
      { env: { LAZY_MOCK_BUILD_LOG: buildLogPath } },
    );

    expectFailure(result);
    expectError(result, '--timeout expects a whole number of seconds');

    const calls = await readBuildLog(buildLogPath);
    if (calls.length !== 0) {
      throw new Error(`Expected no build calls, got ${calls.length}`);
    }
  });

  test('system build --help documents --timeout and the unbounded default', async () => {
    const result = await ctx.lazy(['system', 'build', '--help']);

    expectSuccess(result);
    expectOutput(result, '--timeout <seconds>');
    expectOutput(result, 'NO time limit by default');
  });

  test('system --help mentions the build subcommand', async () => {
    const result = await ctx.lazy(['system', '--help']);

    expectSuccess(result);
    expectOutput(result, 'build');
    expectOutput(result, 'Prebuild');
  });
});
