/**
 * Drift guard: no surface may advise a call that its own schema rejects.
 *
 * `lazy_search`'s description tells an agent to hand a hit's `index` back to
 * `lazy_show` as `offset` "with that one section". That works for turn, commit
 * and comment hits. It does NOT work for follow-up hits: `follow_ups` is not a
 * member of `lazy_show`'s `sections` enum, so the advised call is rejected
 * during argument validation and never reaches a handler.
 *
 * The resolution keeps follow-ups unpaged — `lazy_show` always returns them in
 * full, which is why there is nothing to page to — and scopes the advice. So
 * these tests assert BOTH halves: every OTHER indexed hit type really does have
 * a section to page, and the one exception is named rather than papered over.
 */

import { describe, test, expect } from 'bun:test';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { searchTool, showTool } from '../../src/mcp/tools';

const REPO_ROOT = resolve(__dirname, '../..');

/**
 * The search hit types that carry an `index`, read off BOTH places that build
 * them — the in-memory searchable index (file storage / fuzzy) and the
 * Postgres backend's own SQL projection — so a NEW indexed hit type cannot be
 * added on either path without this test noticing it has no `lazy_show`
 * section to page.
 */
async function indexedSearchHitTypes(): Promise<{ searchable: string[]; postgres: string[] }> {
  const scan = async (file: string, push: string, typeKey: string, indexKey: string) => {
    const src = await readFile(resolve(REPO_ROOT, file), 'utf-8');
    const types: string[] = [];
    for (const block of src.split(push).slice(1)) {
      const body = block.split('});')[0];
      const typeMatch = body.match(new RegExp(`${typeKey}:\\s*'([a-z]+)'`));
      if (typeMatch && new RegExp(`${indexKey}:`).test(body)) types.push(typeMatch[1]);
    }
    return [...new Set(types)];
  };

  return {
    searchable: await scan('src/search/searchable.ts', 'items.push({', 'type', 'entityIndex'),
    postgres: await scan(
      'src/storage/postgres-storage.ts',
      'results.push({',
      'entity_type',
      'entity_index'
    ),
  };
}

/** `sections` values `lazy_show` actually accepts. */
function showSections(): string[] {
  const sections = (showTool.inputSchema.properties as Record<string, any>).sections;
  return sections.items.enum as string[];
}

/**
 * Indexed hit types with no `lazy_show` section, and why that is correct.
 * An entry here is a promise that the surface says so out loud — asserted below.
 */
const UNPAGEABLE_HIT_TYPES = new Set(['followup']);

describe('lazy_search locator advice matches lazy_show sections', () => {
  test('every indexed hit type either has a section to page, or is a declared exception', async () => {
    const { searchable, postgres } = await indexedSearchHitTypes();
    // Sanity: BOTH scans found the known types. A silent zero on either backend
    // would make the parity assertion below vacuously true for that backend.
    for (const produced of [searchable, postgres]) {
      expect(produced).toContain('turn');
      expect(produced).toContain('commit');
      expect(produced).toContain('comment');
      expect(produced).toContain('followup');
    }

    const indexed = [...new Set([...searchable, ...postgres])];
    const sections = showSections();
    for (const type of indexed) {
      if (UNPAGEABLE_HIT_TYPES.has(type)) continue;
      // Hit types are singular ('turn'), sections plural ('turns').
      expect(sections).toContain(`${type}s`);
    }
  });

  // INVARIANT: follow-ups are lazy_show's triage queue at review — always
  // returned whole, never paged. So they have no section ON PURPOSE, and adding
  // one would duplicate content the caller already has.
  test('lazy_show offers no follow-ups section', () => {
    const sections = showSections();
    for (const value of sections) {
      expect(value).not.toMatch(/follow/i);
    }
  });

  test('lazy_search names follow-ups as the exception to the offset advice', () => {
    const desc = searchTool.description;
    // It must say WHERE a follow-up hit's index points instead of pretending
    // the generic "pass it back as offset" instruction covers it.
    expect(desc).toMatch(/follow-up hits are the exception/i);
    expect(desc).toMatch(/follow_ups/);
  });

  test('lazy_show says follow-ups are unpaged rather than leaving it inferable', () => {
    expect(showTool.description).toMatch(/no `follow_ups` value in `sections`/);
  });

  test('docs/search.md carries the same exception', async () => {
    const doc = await readFile(resolve(REPO_ROOT, 'docs/search.md'), 'utf-8');
    expect(doc).toMatch(/Follow-up hits are the exception/);
  });
});
