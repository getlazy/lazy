/**
 * The shared renderer's opt-in per-line element marking.
 *
 * This exists because the review surface needs to say "the patch added THIS
 * line" without re-implementing block structure or splitting the document into
 * one render call per changed line — splitting is what turns one list into
 * three `<ul>`s and restarts `<ol>` numbering. A caller passes the source line
 * numbers it knows about; the renderer stamps a class on the element each of
 * those lines produced, and changes nothing else.
 *
 * Two properties are load-bearing and are what these tests pin:
 *
 *  1. Marking is OFF unless a caller asks for it, and an unmarked render is
 *     byte-identical to one with no options at all. Every other caller of
 *     renderMarkdown (turn bodies, comments, reports, memory, the CLI's
 *     printable report — 20+ sites) passes no options and must be untouched.
 *  2. A mark resolves to the innermost element this renderer emits for that
 *     line, and never to a line the render did not consume.
 */

import { describe, test, expect } from 'bun:test';
import { renderMarkdown } from '../../src/server/markdown';

/** Render with exactly one source line marked, and report the marked tags. */
function markedTags(doc: string, line: number): string[] {
  const html = renderMarkdown(doc, { markLines: new Set([line]), markClass: 'M' });
  return [...html.matchAll(/<(\w+)[^>]*class="M"/g)].map((m) => m[1]);
}

const DOC = [
  '# Title', //                             1
  '', //                                    2
  'A paragraph that is hard wrapped', //     3
  'onto a second physical line here.', //    4
  '', //                                    5
  '> a quote', //                           6
  '> - an item inside a blockquote', //      7
  '', //                                    8
  '| a | b |', //                           9
  '|---|---|', //                          10
  '| 1 | 2 |', //                          11
  '| 3 | 4 |', //                          12
  '', //                                   13
  '```ts', //                              14
  'const x = 1;', //                       15
  '```', //                                16
  '', //                                   17
  '- top', //                              18
  '  - nested', //                         19
  '', //                                   20
  '---', //                                21
].join('\n');

describe('renderMarkdown line marking is opt-in', () => {
  // INVARIANT: an unmarked render is byte-identical to a render with no
  // options. The marking API was added to a renderer with 20+ existing call
  // sites, none of which pass options; any byte of drift is a regression in
  // every card, comment and report in the web UI.
  test('every "no marks asked for" spelling renders identically', () => {
    const bare = renderMarkdown(DOC);
    expect(renderMarkdown(DOC, {})).toBe(bare);
    // Empty set: nothing to mark.
    expect(renderMarkdown(DOC, { markLines: new Set(), markClass: 'M' })).toBe(bare);
    // A class with no set, and a set with no class, are both incomplete asks.
    expect(renderMarkdown(DOC, { markClass: 'M' })).toBe(bare);
    expect(renderMarkdown(DOC, { markLines: new Set([1, 3, 9]) })).toBe(bare);
    // firstLine alone changes nothing: it only shifts which numbers mean what.
    expect(renderMarkdown(DOC, { firstLine: 100 })).toBe(bare);
  });

  // INVARIANT: marking adds attributes, it does not restructure. The document
  // must still render as one document — one <ul> per list run, one <table> per
  // table — which is the whole reason a region is rendered by ONE call.
  test('marking every line changes only the class attributes', () => {
    const all = renderMarkdown(DOC, {
      markLines: new Set(Array.from({ length: 21 }, (_, n) => n + 1)),
      markClass: 'M',
    });
    expect(all.replace(/ class="M"/g, '')).toBe(renderMarkdown(DOC));
  });
});

describe('a mark lands on the element its line produced', () => {
  test('block-level lines mark their own element', () => {
    expect(markedTags(DOC, 1)).toEqual(['h1']);
    expect(markedTags(DOC, 21)).toEqual(['hr']);
    expect(markedTags(DOC, 18)).toEqual(['li']);
    expect(markedTags(DOC, 19)).toEqual(['li']);
    expect(markedTags(DOC, 15)).toEqual(['pre']);
  });

  test('a hard-wrapped paragraph marks the paragraph from either line', () => {
    // The paragraph is the finest unit this renderer has: it emits no element
    // per physical line, so both lines resolve to the same <p>.
    expect(markedTags(DOC, 3)).toEqual(['p']);
    expect(markedTags(DOC, 4)).toEqual(['p']);
  });

  test('a nested item inside a blockquote marks the blockquote', () => {
    // Quoted content is rendered by a recursive call that is not given the
    // marks, so the quote is the unit. Coarser than a bare list item, and
    // honest about it: the accent still points at the passage that changed.
    expect(markedTags(DOC, 6)).toEqual(['blockquote']);
    expect(markedTags(DOC, 7)).toEqual(['blockquote']);
  });

  test('table rows mark independently, and the delimiter marks the header', () => {
    const header = renderMarkdown(DOC, { markLines: new Set([9]), markClass: 'M' });
    expect(header).toContain('<tr class="M"><th>a</th><th>b</th></tr>');
    // The delimiter row emits no element of its own; it belongs to the header.
    const delim = renderMarkdown(DOC, { markLines: new Set([10]), markClass: 'M' });
    expect(delim).toContain('<tr class="M"><th>a</th><th>b</th></tr>');
    const first = renderMarkdown(DOC, { markLines: new Set([11]), markClass: 'M' });
    expect(first).toContain('<tr class="M"><td>1</td><td>2</td></tr>');
    expect(first).toContain('<tr><td>3</td><td>4</td></tr>');
    const second = renderMarkdown(DOC, { markLines: new Set([12]), markClass: 'M' });
    expect(second).toContain('<tr class="M"><td>3</td><td>4</td></tr>');
    expect(second).toContain('<tr><td>1</td><td>2</td></tr>');
  });

  test('a line that produces no element marks nothing', () => {
    // Blank lines are separators. A change that touches only blanks opens its
    // region with no accent — nothing is hidden, nothing is over-claimed.
    for (const blank of [2, 5, 8, 13, 17, 20]) expect(markedTags(DOC, blank)).toEqual([]);
  });

  test('firstLine makes marks absolute source line numbers', () => {
    // The review surface renders one region at a time out of a whole file, so
    // the marks it holds are file line numbers, not offsets into the slice.
    const slice = '# Title\n\nBody.\n';
    const html = renderMarkdown(slice, {
      firstLine: 41,
      markLines: new Set([43]),
      markClass: 'M',
    });
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<p class="M">Body.</p>');
    // The same number without the offset resolves to nothing in this slice.
    expect(renderMarkdown(slice, { markLines: new Set([43]), markClass: 'M' })).toBe(
      renderMarkdown(slice),
    );
  });

  // REGRESSION: an unterminated fence leaves the render cursor one line past
  // the end (it skips a closing ``` that was never there), so the <pre>'s mark
  // range used to probe a source line the render never consumed. Harmless in
  // the review path — a region's changed lines stop at the region — but wrong
  // for any caller that trusts the documented "the element this line produced".
  test('an unterminated fence does not claim the line after the end', () => {
    const doc = 'para\n\n```unterminated\nstill inside';
    expect(markedTags(doc, 3)).toEqual(['pre']);
    expect(markedTags(doc, 4)).toEqual(['pre']);
    expect(markedTags(doc, 5)).toEqual([]);
    expect(markedTags(doc, 6)).toEqual([]);
  });
});
