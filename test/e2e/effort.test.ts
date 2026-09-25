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

/**
 * Set `effort` INSIDE a table the `lazy init` template already writes.
 *
 * The three lazy.toml tests below used to APPEND `[agent]` / `[builder]`, which
 * became a TOML redefinition error ("Cannot redefine table 'agent'") the moment
 * the init template started writing both tables itself. The loader then failed
 * on the duplicate table before ever reading the effort value, so all three
 * invariants stopped being exercised while two of them still went red for the
 * wrong reason. Per CLAUDE.md: rewrite the key that is already there, and fail
 * loudly if the template moves rather than silently editing nothing.
 *
 * Section-scoped because the template ships a commented `effort` line in BOTH
 * tables — a file-wide replace would rewrite whichever came first.
 */
async function setSectionEffort(
  root: string,
  section: 'agent' | 'builder',
  value: string,
): Promise<void> {
  const tomlPath = join(root, 'lazy.toml');
  const toml = await readFile(tomlPath, 'utf-8');

  const header = `\n[${section}]\n`;
  const headerAt = toml.indexOf(header);
  if (headerAt === -1) {
    throw new Error(`setSectionEffort: no [${section}] table in ${tomlPath} — init template changed`);
  }

  const bodyStart = headerAt + header.length;
  const nextTable = toml.slice(bodyStart).search(/^\[/m);
  const bodyEnd = nextTable === -1 ? toml.length : bodyStart + nextTable;

  const body = toml.slice(bodyStart, bodyEnd);
  const rewritten = body.replace(/^#?\s*effort\s*=.*$/m, `effort = "${value}"`);
  if (rewritten === body) {
    throw new Error(`setSectionEffort: no effort key under [${section}] in ${tomlPath} to rewrite`);
  }

  await writeFile(tomlPath, toml.slice(0, bodyStart) + rewritten + toml.slice(bodyEnd));
}

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
    await setSectionEffort(ctx.root, 'agent', 'ultra');

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
    await setSectionEffort(ctx.root, 'builder', 'turbo');

    const result = await ctx.lazy(['list']);
    expectFailure(result);
    expect(result.stderr).toMatch(/Invalid effort level\s+\\?"turbo\\?"/);
    expect(result.stderr).toContain('[builder]');
  });

  // INVARIANT: lazy.toml with valid [agent].effort and [builder].effort is
  // accepted and doesn't disrupt other commands.
  test('lazy.toml with valid [agent].effort and [builder].effort loads', async () => {
    await setSectionEffort(ctx.root, 'agent', 'xhigh');
    await setSectionEffort(ctx.root, 'builder', 'max');

    const result = await ctx.lazy(['list']);
    expectSuccess(result);
  });
});
