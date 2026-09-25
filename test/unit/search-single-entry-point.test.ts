/**
 * The mechanical half of "one entry point runs a search" (CLAUDE.md).
 *
 * Four surfaces search: the daemon's `search` RPC, the `lazy_search` MCP
 * handler, the dashboard's `/search` page and the command palette's
 * `/api/search`. Two of them once carried their own copy of the mode
 * selection, and the divergence was invisible from either side — the same
 * query answered 0 on the CLI and 4 in the browser, from one store.
 *
 * A behavioural test catches that only for the query someone thought to write.
 * This is a source scan, because the drift never arrives as one reviewable
 * violation: it arrives as a new surface reaching for `storage.search()`
 * because that is the obvious call, months after the prose was written.
 */

import { describe, test, expect } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';

const SRC = join(import.meta.dir, '../../src');

/** The files that own a search surface, and must call in rather than match. */
const SURFACES = [
  { file: 'daemon/rpc-handlers.ts', what: "the daemon's search RPC (lazy search)" },
  { file: 'mcp/tools.ts', what: 'the lazy_search MCP handler' },
  { file: 'server/index.ts', what: 'the dashboard /search page and /api/search palette' },
];

/**
 * Ways to run a search that bypass the shared rules. `storage.search()` is the
 * regex mode's backend, `structuredSearch` the structured mode's, and a bare
 * `new Fuse` the fuzzy mode's — reaching any of them directly means that
 * surface picked its own mode.
 */
const BYPASSES = [
  { pattern: /\bstorage\.search\s*\(/, name: 'storage.search()' },
  { pattern: /\bstructuredSearch\s*\(/, name: 'structuredSearch()' },
  { pattern: /\bnew Fuse\s*\(/, name: 'new Fuse()' },
];

async function readSource(file: string): Promise<string> {
  return await readFile(join(SRC, file), 'utf-8');
}

describe('one entry point runs a search', () => {
  // INVARIANT: every search surface calls executeSearch(). Mode selection, the
  // type filter and the empty-tag hint are business rules; a surface that
  // re-implements them answers the same query differently the first time one
  // of the four is edited alone.
  test.each(SURFACES)('$what calls executeSearch', async ({ file }) => {
    const source = await readSource(file);
    expect(source).toMatch(/\bexecuteSearch\s*\(/);
  });

  // INVARIANT: and none of them reaches a single mode's backend directly.
  // This is the half that fails when a NEW surface is added the obvious way,
  // which is how the dashboard acquired its own copy in the first place.
  test.each(SURFACES)('$what runs no matching of its own', async ({ file }) => {
    const source = await readSource(file);
    const found = BYPASSES.filter(b => b.pattern.test(source)).map(b => b.name);
    expect(found).toEqual([]);
  });

  // INVARIANT: src/search/run.ts is the ONLY module allowed those calls — it
  // is where the choice between them lives. Pinned so that "move the bypass
  // into a helper next door" does not quietly satisfy the scan above.
  test('executeSearch itself is the one place the modes are chosen', async () => {
    const run = await readSource('search/run.ts');
    for (const { pattern, name } of BYPASSES.filter(b => b.name !== 'new Fuse()')) {
      expect(run, `run.ts should own ${name}`).toMatch(pattern);
    }
    expect(run).toMatch(/fuzzySearch\s*\(/);
  });
});
