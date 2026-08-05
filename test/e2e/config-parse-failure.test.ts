/**
 * A lazy.toml that exists but does not parse must fail LOUDLY.
 *
 * loadConfig used to warn and return DEFAULT_CONFIG on a parse error. That is
 * the worst available behaviour: every setting the user wrote is discarded at
 * once, and lazy then runs on defaults that look deliberate. It shipped a real
 * bug — a duplicate `[runner]` table meant agents ran in Docker while lazy.toml
 * plainly said host-process, and `lazy doctor` reported "✗ Docker installed"
 * with no hint that the config had been thrown away.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { writeFile, readFile } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectFailure, expectOutput, expectError } from '../helpers/assertions';

describe('broken lazy.toml', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** Break the config the way a user most plausibly does: append a duplicate table. */
  async function breakConfig(): Promise<void> {
    const configPath = join(ctx.root, 'lazy.toml');
    const existing = await readFile(configPath, 'utf-8');
    await writeFile(configPath, `${existing}\n[runner]\ntype = "docker"\n`, 'utf-8');
  }

  // INVARIANT: "file missing" and "file present but broken" are different
  // conditions. Missing falls through to defaults; broken must not — silently
  // running on defaults puts the failure arbitrarily far from its cause.
  test('a command fails with an actionable error rather than running on defaults', async () => {
    await breakConfig();

    const result = await ctx.lazy(['list']);
    expectFailure(result);
    expectError(result, 'Failed to parse');
    expectError(result, 'lazy.toml');
    // The parser knows the line; the user should not have to find it.
    expect(result.stderr).toMatch(/line \d+/);
    // And the most common cause is named, because it is not guessable.
    expectError(result, 'DUPLICATE table');
  });

  // INVARIANT: `lazy doctor` is THE surface for "my setup is broken", so it must
  // not be the one command that dies on a broken config. It reports the failure
  // as a check and keeps going.
  test('lazy doctor reports the parse failure as a failed check instead of crashing', async () => {
    await breakConfig();

    const result = await ctx.lazy(['doctor']);
    expectOutput(result, 'lazy.toml parses');
    expectOutput(result, 'Failed to parse');
  });

  // INVARIANT: doctor must not run config-dependent checks against defaults on a
  // broken config. A green sweep would read as "my configured setup is healthy"
  // when none of the user's settings were in force — which is precisely the
  // misdiagnosis this whole change exists to remove.
  test('lazy doctor skips config-dependent checks rather than checking defaults', async () => {
    await breakConfig();

    const result = await ctx.lazy(['doctor']);
    expectOutput(result, 'every config-dependent check is skipped');
  });

  test('a valid config is unaffected', async () => {
    const result = await ctx.lazy(['list']);
    expect(result.exitCode).toBe(0);
  });
});
