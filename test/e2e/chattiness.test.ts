import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure } from '../helpers/assertions';

/**
 * E2E tests for the [chattiness] lazy.toml section.
 *
 * INVARIANT: chattiness levels are validated at config-load time. Invalid values
 * fail loudly (no silent fallback), listing the valid levels. Valid values and
 * the absence of the section both load cleanly — absence preserves today's
 * behavior (no verbosity guidance injected).
 */
describe('lazy.toml [chattiness]', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function appendToml(snippet: string): Promise<void> {
    const tomlPath = join(ctx.root, 'lazy.toml');
    const existing = await readFile(tomlPath, 'utf-8');
    await writeFile(tomlPath, existing + '\n' + snippet + '\n');
  }

  // INVARIANT: No [chattiness] section → config loads fine (unchanged behavior).
  test('absent section loads cleanly', async () => {
    const result = await ctx.lazy(['list']);
    expectSuccess(result);
  });

  // INVARIANT: A shared default is accepted.
  test('valid default loads', async () => {
    await appendToml('[chattiness]\ndefault = "normal"');
    const result = await ctx.lazy(['list']);
    expectSuccess(result);
  });

  // INVARIANT: Per-role overrides alongside a default are accepted.
  test('valid per-role overrides load', async () => {
    await appendToml('[chattiness]\ndefault = "normal"\nbuilder = "chatty"\nagent = "terse"');
    const result = await ctx.lazy(['list']);
    expectSuccess(result);
  });

  // INVARIANT: An invalid `default` fails loudly with the valid levels listed.
  test('invalid default fails loudly', async () => {
    await appendToml('[chattiness]\ndefault = "loud"');
    const result = await ctx.lazy(['list']);
    expectFailure(result);
    expect(result.stderr).toMatch(/Invalid chattiness level\s+\\?"loud\\?"/);
    expect(result.stderr).toContain('terse, normal, chatty');
  });

  // INVARIANT: An invalid per-role value fails loudly and names the offending key.
  test('invalid builder value fails loudly and names the key', async () => {
    await appendToml('[chattiness]\nbuilder = "screaming"');
    const result = await ctx.lazy(['list']);
    expectFailure(result);
    expect(result.stderr).toMatch(/Invalid chattiness level\s+\\?"screaming\\?"/);
    expect(result.stderr).toContain('builder');
  });

  // INVARIANT: An invalid agent value fails loudly.
  test('invalid agent value fails loudly', async () => {
    await appendToml('[chattiness]\nagent = "whisper"');
    const result = await ctx.lazy(['list']);
    expectFailure(result);
    expect(result.stderr).toMatch(/Invalid chattiness level\s+\\?"whisper\\?"/);
  });
});
