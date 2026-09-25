/**
 * Drift guard: no surface may advise a call that its own schema rejects.
 *
 * `lazy_search`'s description tells an agent to hand a hit's `index` back to
 * `lazy_show` as `offset` "with that one section". That works for turn, commit
 * and comment hits. It does NOT work for raised-item hits: `raised_items` is not
 * a member of `lazy_show`'s `sections` enum, so the advised call is rejected
 * during argument validation and never reaches a handler.
 *
 * The resolution keeps raised items unpaged — `lazy_show` always returns them in
 * full, which is why there is nothing to page to — and scopes the advice. So
 * these tests assert BOTH halves: every OTHER indexed hit type really does have
 * a section to page, and the one exception is named rather than papered over.
 *
 * INVARIANT: there is ONE exception, not two. Follow-ups and raised items are a
 * single entity separated only by a `blocking` flag, so a search hit on either
 * is type `raised` and lands in the same unpaged `raised_items` array. See
 * docs/design/raised-items-unified.md.
 */

import { describe, test, expect } from 'bun:test';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { searchTool, showTool } from '../../src/mcp/tools';

const REPO_ROOT = resolve(__dirname, '../..');

/**
 * The search hit types that carry an `index`, read off the in-memory searchable
 * index — so a NEW indexed hit type cannot be added without this test noticing
 * it has no `lazy_show` section to page.
 */
async function indexedSearchHitTypes(): Promise<string[]> {
  const src = await readFile(resolve(REPO_ROOT, 'src/search/searchable.ts'), 'utf-8');
  const types: string[] = [];
  for (const block of src.split('items.push({').slice(1)) {
    const body = block.split('});')[0];
    const typeMatch = body.match(/type:\s*'([a-z]+)'/);
    if (typeMatch && /entityIndex:/.test(body)) types.push(typeMatch[1]);
  }
  return [...new Set(types)];
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
const UNPAGEABLE_HIT_TYPES = new Set(['raised']);

describe('lazy_search locator advice matches lazy_show sections', () => {
  test('every indexed hit type either has a section to page, or is a declared exception', async () => {
    const indexed = await indexedSearchHitTypes();
    // Sanity: the scan found the known types. A silent zero would make the
    // parity assertion below vacuously true.
    expect(indexed).toContain('turn');
    expect(indexed).toContain('commit');
    expect(indexed).toContain('comment');
    expect(indexed).toContain('raised');
    // No separate follow-up hit type survives unification — one entity, one type.
    expect(indexed).not.toContain('followup');

    const sections = showSections();
    for (const type of indexed) {
      if (UNPAGEABLE_HIT_TYPES.has(type)) continue;
      // Hit types are singular ('turn'), sections plural ('turns').
      expect(sections).toContain(`${type}s`);
    }
  });

  // INVARIANT: raised items are lazy_show's triage queue at review — always
  // returned whole, never paged. So they have no section ON PURPOSE, and adding
  // one would duplicate content the caller already has. Neither spelling of the
  // old split may reappear as a section either.
  test('lazy_show offers no raised-items section, under either spelling', () => {
    const sections = showSections();
    for (const value of sections) {
      expect(value).not.toMatch(/raised/i);
      expect(value).not.toMatch(/follow/i);
    }
  });

  test('lazy_search names raised items as the exception to the offset advice', () => {
    const desc = searchTool.description;
    // It must say WHERE a raised hit's index points instead of pretending the
    // generic "pass it back as offset" instruction covers it.
    expect(desc).toMatch(/raised-item hits are the exception/i);
    expect(desc).toMatch(/raised_items/);
    // One exception, stated once: a lingering follow-up carve-out would advise
    // paging a section that no longer exists.
    expect(desc).not.toMatch(/follow-up hits are the exception/i);
    expect(desc).not.toMatch(/follow_ups/);
  });

  test('lazy_show says raised items are unpaged rather than leaving it inferable', () => {
    expect(showTool.description).toMatch(/no `raised_items` value in `sections`/);
    expect(showTool.description).not.toMatch(/follow_ups/);
  });

  test('public-docs/search.md carries the same exception', async () => {
    const doc = await readFile(resolve(REPO_ROOT, 'public-docs/search.md'), 'utf-8');
    expect(doc).toMatch(/Raised-item hits are the exception/);
    expect(doc).not.toMatch(/Follow-up hits are the exception/);
  });
});
