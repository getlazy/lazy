import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, expectOutputExcludes } from '../helpers/assertions';

/**
 * "Check documentation at <url>" pointers.
 *
 * INVARIANT: a doc pointer SUPPLEMENTS an actionable message, it never
 * replaces one. Both halves are asserted here — the pointer appears, and the
 * message it decorates still reads correctly with the pointer switched off.
 */
describe('documentation pointers', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /**
   * Edit the key in the lazy.toml `lazy init` wrote — never overwrite the file,
   * which would throw away the external_path init put there (see CLAUDE.md).
   */
  async function setDocsUrl(value: string): Promise<void> {
    const path = join(ctx.root, 'lazy.toml');
    const before = await readFile(path, 'utf-8');
    const after = before.replace(
      '# url = "https://docs.getlazy.dev"',
      value === '' ? 'url = ""' : `url = "${value}"`,
    );
    expect(after).not.toBe(before);
    await writeFile(path, after, 'utf-8');
  }

  test('top-level help carries a documentation footer', async () => {
    const result = await ctx.lazy(['--help']);
    expectSuccess(result);
    expectOutput(result, 'Documentation: https://docs.getlazy.dev');
  });

  test('command help points at that command’s page', async () => {
    const result = await ctx.lazy(['protect', '--help']);
    expectSuccess(result);
    expectOutput(result, 'Documentation: https://docs.getlazy.dev/protected-branches');
  });

  test('a configured mirror replaces the domain', async () => {
    await setDocsUrl('https://docs.acme.internal/lazy');
    const result = await ctx.lazy(['protect', '--help']);
    expectSuccess(result);
    expectOutput(result, 'Documentation: https://docs.acme.internal/lazy/protected-branches');
    expectOutputExcludes(result, 'docs.getlazy.dev');
  });

  // INVARIANT: with pointers off, help text is still complete — nothing that
  // matters was delegated to a link.
  test('url = "" removes every pointer and leaves the help intact', async () => {
    await setDocsUrl('');

    const top = await ctx.lazy(['--help']);
    expectSuccess(top);
    expectOutputExcludes(top, 'Documentation:');
    expectOutput(top, "Run 'lazy <command> --help'");

    const protect = await ctx.lazy(['protect', '--help']);
    expectSuccess(protect);
    expectOutputExcludes(protect, 'Documentation:');
    expectOutput(protect, 'Usage: lazy protect');
  });
});
