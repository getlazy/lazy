import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, expectOutputExcludes } from '../helpers/assertions';
// The default base is version-pinned (`…/v0.23`), so the expected pointer is
// composed from the same constant the CLI builds it from rather than restated
// as a literal — a restated literal is what went stale here once already.
import { DEFAULT_DOCS_URL, DOCS_DOMAIN, DOCS_VERSION_SEGMENT } from '../../src/docs/links';

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
   *
   * The key is INSERTED under the `[docs]` header rather than substituted into
   * the template's commented example line: that comment is prose, it has been
   * reworded once already (the example URL changed from docs.getlazy.dev to
   * docs.internal.example.com), and a literal match against it turned this
   * helper into a silent no-op that took three assertions with it. The header
   * is the actual structure, and the anchor assertion below fails loudly if
   * even that ever moves.
   */
  async function setDocsUrl(value: string): Promise<void> {
    const path = join(ctx.root, 'lazy.toml');
    const before = await readFile(path, 'utf-8');
    const anchor = '\n[docs]\n';
    expect(before).toContain(anchor);
    const after = before.replace(
      anchor,
      `${anchor}${value === '' ? 'url = ""' : `url = "${value}"`}\n`,
    );
    expect(after).not.toBe(before);
    await writeFile(path, after, 'utf-8');
  }

  test('top-level help carries a documentation footer', async () => {
    const result = await ctx.lazy(['--help']);
    expectSuccess(result);
    expectOutput(result, `Documentation: ${DEFAULT_DOCS_URL}`);
  });

  // INVARIANT: the DEFAULT base is pinned to the minor this build ships with, so
  // a pointer printed today keeps resolving after the docs site moves on. A bare
  // domain here would pass while silently losing the pin.
  test('command help points at that command’s page', async () => {
    const result = await ctx.lazy(['protect', '--help']);
    expectSuccess(result);
    expectOutput(result, `Documentation: ${DEFAULT_DOCS_URL}/protected-branches`);
    // Guarded, not asserted outright: a checkout whose VERSION is not a numeric
    // major.minor pin has no segment BY DESIGN and points at the site root.
    if (DOCS_VERSION_SEGMENT) expect(DEFAULT_DOCS_URL).toBe(`${DOCS_DOMAIN}/${DOCS_VERSION_SEGMENT}`);
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
