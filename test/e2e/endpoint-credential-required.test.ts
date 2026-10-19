/**
 * Every endpoint names its credential — through the real CLI.
 *
 * A lazy.toml whose `[endpoints.<name>]` block or inline profile `endpoint`
 * names no `credential` is a config error: lazy never guesses which of the
 * user's secrets a host receives. The refusal must reach the person running a
 * command, naming the block and the line to add.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';

describe('an endpoint with no credential', () => {
  let ctx: TestContext;

  beforeEach(async () => { ctx = await setupTestLazy(); });
  afterEach(async () => { await ctx.cleanup(); });

  async function appendConfig(extra: string): Promise<void> {
    const path = join(ctx.root, 'lazy.toml');
    await writeFile(path, (await readFile(path, 'utf-8')) + extra, 'utf-8');
  }

  // INVARIANT: a named endpoint without `credential` stops the command with
  // the block named and the exact lines to add — never a guessed credential.
  test('a named endpoint is refused, naming the block and the fix', async () => {
    await appendConfig('\n[endpoints.lunaroute]\nurl = "https://gw.lunaroute.com/"\n');
    const result = await ctx.lazy(['list']);
    const out = result.stdout + result.stderr;
    expect(result.exitCode).not.toBe(0);
    expect(out).toContain('[endpoints.lunaroute] has no credential');
    expect(out).toContain('credential = "lunaroute"');
    expect(out).toContain('credential = "none"');
  });

  test('an inline profile endpoint is refused the same way', async () => {
    await appendConfig('\n[agents.gw]\nharness = "claude-code"\nmodel = "m"\nendpoint = "https://gw.example.com"\n');
    const result = await ctx.lazy(['list']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('[agents.gw] has no credential');
  });

  test('the same blocks load once they name their credentials', async () => {
    await appendConfig(
      '\n[endpoints.lunaroute]\nurl = "https://gw.lunaroute.com/"\ncredential = "lunaroute-api-key"\n' +
      '\n[agents.gw]\nharness = "claude-code"\nmodel = "m"\nendpoint = "https://gw.example.com"\ncredential = "anthropic"\n',
    );
    const result = await ctx.lazy(['list']);
    expect(result.exitCode).toBe(0);
  });
});
