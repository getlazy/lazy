import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, extractTaskId } from '../helpers/assertions';

/**
 * E2E tests for the `--effort` CLI flag across create / start / unblock /
 * builder commands.
 *
 * INVARIANT: The `--effort` flag is validated against the five valid levels
 * (low, medium, high, xhigh, max) and stored on the task so the resolved
 * effort persists across turns. The flag appears in usage output for every
 * command that accepts it.
 */

describe('lazy --effort flag', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: lazy create --effort <level> stores the level on task metadata
  // so lazy show displays it and subsequent turns can pick it up without
  // re-passing the flag.
  test('create --effort stores level on task metadata', async () => {
    const result = await ctx.lazy([
      'create', '--goal', 'Test effort', '--effort', 'xhigh',
    ]);
    expectSuccess(result);
    expectOutput(result, 'Effort: xhigh');

    const taskId = extractTaskId(result.stdout);
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'effort: xhigh');
  });

  // INVARIANT: Invalid effort values are rejected with a clear error that
  // lists the valid levels so the user can fix the typo.
  test('create --effort rejects invalid levels', async () => {
    const result = await ctx.lazy([
      'create', '--goal', 'Bad', '--effort', 'ultra',
    ]);
    expectFailure(result);
    expectError(result, "Invalid effort 'ultra'");
    expectError(result, 'low, medium, high, xhigh, max');
  });

  // INVARIANT: Without --effort, no `effort` metadata entry is added up-front.
  // launchTask will backfill the resolved default when the task first starts.
  test('create without --effort does not set metadata', async () => {
    const result = await ctx.lazy(['create', '--goal', 'No effort flag']);
    expectSuccess(result);

    const taskId = extractTaskId(result.stdout);
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    // Metadata section may or may not be present, but there should be no
    // "effort:" line pre-start.
    expect(showResult.stdout).not.toContain('effort:');
  });

  // INVARIANT: All five valid levels are accepted on `lazy create`.
  test('create --effort accepts every valid level', async () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      const result = await ctx.lazy([
        'create', '--goal', `Level ${level}`, '--effort', level,
      ]);
      expectSuccess(result);
      expectOutput(result, `Effort: ${level}`);
    }
  });

  // INVARIANT: `lazy start --effort` is rejected at parse time when the value
  // is invalid — we don't want to reach the daemon with bad input.
  test('start --effort rejects invalid levels', async () => {
    const createResult = await ctx.lazy(['create', '--goal', 'To start']);
    const taskId = extractTaskId(createResult.stdout);

    const result = await ctx.lazy(['start', taskId, '--effort', 'ultra']);
    expectFailure(result);
    expectError(result, "Invalid effort 'ultra'");
  });

  // INVARIANT: `lazy unblock --effort` is rejected at parse time when invalid.
  test('unblock --effort rejects invalid levels', async () => {
    const createResult = await ctx.lazy(['create', '--goal', 'To unblock']);
    const taskId = extractTaskId(createResult.stdout);

    const result = await ctx.lazy(['unblock', taskId, '--effort', 'bogus'], {
      input: 'some feedback\n',
    });
    expectFailure(result);
    expectError(result, "Invalid effort 'bogus'");
  });

  // INVARIANT: `lazy resume --effort` is rejected at parse time when invalid.
  test('resume --effort rejects invalid levels', async () => {
    const createResult = await ctx.lazy(['create', '--goal', 'To resume']);
    const taskId = extractTaskId(createResult.stdout);

    const result = await ctx.lazy(['resume', taskId, '--effort', 'turbo']);
    expectFailure(result);
    expectError(result, "Invalid effort 'turbo'");
  });

  // INVARIANT: `lazy builder --effort` is rejected at parse time when invalid,
  // before any attempt to launch Claude Code.
  test('builder --effort rejects invalid levels', async () => {
    const result = await ctx.lazy(['builder', '--effort', 'bananas'], {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    });
    expectFailure(result);
    expectError(result, "Invalid effort 'bananas'");
  });

  // INVARIANT: --effort appears in usage/help text for every command that
  // accepts it. If someone removes the flag, help must stop advertising it.
  test('create --help documents --effort', async () => {
    const result = await ctx.lazy(['create', '--help']);
    expectSuccess(result);
    expectOutput(result, '--effort');
    expectOutput(result, 'low, medium, high, xhigh, max');
  });

  test('builder --help documents --effort', async () => {
    const result = await ctx.lazy(['builder', '--help']);
    expectSuccess(result);
    expectOutput(result, '--effort');
    expectOutput(result, 'low, medium, high, xhigh, max');
  });

  // INVARIANT: lazy.toml [agent].effort with an invalid value must fail
  // loudly at config load time, not silently fall back to a default.
  test('lazy.toml with invalid [agent].effort fails loudly', async () => {
    const tomlPath = join(ctx.root, 'lazy.toml');
    const existing = await readFile(tomlPath, 'utf-8');
    await writeFile(tomlPath, existing + '\n[agent]\neffort = "ultra"\n');

    const result = await ctx.lazy(['list']);
    expectFailure(result);
    // stderr may be a JSON-encoded RPC error (escaped quotes) or a plain
    // loader error — both cases must include the invalid level and the [agent] section.
    expect(result.stderr).toMatch(/Invalid effort level\s+\\?"ultra\\?"/);
    expect(result.stderr).toContain('[agent]');
  });

  // INVARIANT: lazy.toml [builder].effort with an invalid value must fail
  // loudly at config load time, not silently fall back to a default.
  test('lazy.toml with invalid [builder].effort fails loudly', async () => {
    const tomlPath = join(ctx.root, 'lazy.toml');
    const existing = await readFile(tomlPath, 'utf-8');
    await writeFile(tomlPath, existing + '\n[builder]\neffort = "turbo"\n');

    const result = await ctx.lazy(['list']);
    expectFailure(result);
    expect(result.stderr).toMatch(/Invalid effort level\s+\\?"turbo\\?"/);
    expect(result.stderr).toContain('[builder]');
  });

  // INVARIANT: lazy.toml with valid [agent].effort and [builder].effort is
  // accepted and doesn't disrupt other commands.
  test('lazy.toml with valid [agent].effort and [builder].effort loads', async () => {
    const tomlPath = join(ctx.root, 'lazy.toml');
    const existing = await readFile(tomlPath, 'utf-8');
    await writeFile(tomlPath, existing + '\n[agent]\neffort = "xhigh"\n\n[builder]\neffort = "max"\n');

    const result = await ctx.lazy(['list']);
    expectSuccess(result);
  });
});
