/**
 * Shared markdown linkify pass: symbol table + task-code table compose in one
 * walk of the inline-code path. Empty tables leave the render byte-identical
 * to no options — same contract as line marking.
 */

import { describe, test, expect } from 'bun:test';
import { renderMarkdown } from '../../src/server/markdown';
import { buildTaskCodeLinkify } from '../../src/server/task-code-links';
import { renderPresentedChanges } from '../../src/server/review-presentation';

const DOC = 'See `soAndSo()` and fix-docs-release-wiring in the report.';

describe('renderMarkdown linkify', () => {
  test('absent or empty tables render identically to no options', () => {
    const bare = renderMarkdown(DOC);
    expect(renderMarkdown(DOC, {})).toBe(bare);
    expect(renderMarkdown(DOC, { linkify: [] })).toBe(bare);
    expect(renderMarkdown(DOC, { linkify: [{ lookup: new Map() }] })).toBe(bare);
  });

  test('a backticked name in the symbol table becomes a jump link', () => {
    const html = renderMarkdown('Changed `soAndSo()` this turn.', {
      linkify: [{
        lookup: new Map([['soAndSo', '/tasks/t/changes#l-src%2Ffoo.ts-new-12']]),
        className: 'lz-sym-link',
      }],
    });
    expect(html).toContain('href="/tasks/t/changes#l-src%2Ffoo.ts-new-12"');
    expect(html).toContain('class="lz-sym-link"');
    expect(html).toContain('<code>soAndSo()</code>');
  });

  test('Type.method and trailing () fall back to the last dotted segment', () => {
    const lookup = new Map([['save', '/tasks/t/changes#l-x-new-1']]);
    const dotted = renderMarkdown('See `Widget.save()`.', {
      linkify: [{ lookup, className: 'lz-sym-link' }],
    });
    expect(dotted).toContain('href="/tasks/t/changes#l-x-new-1"');
    expect(dotted).toContain('<code>Widget.save()</code>');
  });

  test('a name missing from the table stays a plain code span', () => {
    const html = renderMarkdown('See `unknownFn()`.', {
      linkify: [{ lookup: new Map([['soAndSo', '#x']]), className: 'lz-sym-link' }],
    });
    expect(html).toContain('<code>unknownFn()</code>');
    expect(html).not.toContain('href=');
  });

  test('task-code table linkifies backticks AND bare words; first table wins', () => {
    const tasks = buildTaskCodeLinkify([
      { id: 'aaa', code: 'fix-docs-release-wiring' },
    ]);
    const symbols = {
      lookup: new Map([['soAndSo', '/tasks/t/changes#sym']]),
      className: 'lz-sym-link',
    };
    const html = renderMarkdown(
      'See `soAndSo()` and fix-docs-release-wiring plus `fix-docs-release-wiring`.',
      { linkify: [tasks, symbols] },
    );
    expect(html).toContain('href="/tasks/fix-docs-release-wiring"');
    expect(html).toContain('class="lz-task-link"');
    expect(html).toContain('href="/tasks/t/changes#sym"');
    // Bare word wrapped once, not inside the backticked span.
    expect(html).toMatch(/<a href="\/tasks\/fix-docs-release-wiring" class="lz-task-link">fix-docs-release-wiring<\/a>/);
    expect(html).toMatch(/<a href="\/tasks\/fix-docs-release-wiring" class="lz-task-link"><code>fix-docs-release-wiring<\/code><\/a>/);
  });

  test('does not linkify inside fences or existing markdown links', () => {
    const tasks = buildTaskCodeLinkify([{ id: 'aaa', code: 'fix-docs-release-wiring' }]);
    const fenced = renderMarkdown('```\nfix-docs-release-wiring\n```', { linkify: [tasks] });
    expect(fenced).toContain('<pre>');
    expect(fenced).not.toContain('<a href');

    const linked = renderMarkdown('[fix-docs-release-wiring](/already)', { linkify: [tasks] });
    expect(linked).toContain('href="/already"');
    expect(linked).not.toContain('href="/tasks/fix-docs-release-wiring"');
  });

  /**
   * INVARIANT: the word matcher is compiled per table set, not per render.
   *
   * Compiling it escapes and sorts every key and joins them into one
   * alternation — O(codes) — and the task-code table holds every code in the
   * store. renderMarkdown runs per paragraph, so recompiling per call made
   * rendering one task's turns scale with the size of the whole store.
   *
   * Counted through the table's own lookup: building the matcher is the only
   * thing that iterates it, so a second render that iterates again has
   * recompiled.
   */
  test('the word matcher is built once per table set, not once per render', () => {
    class CountingLookup extends Map<string, string> {
      iterations = 0;
      override [Symbol.iterator](): MapIterator<[string, string]> {
        this.iterations++;
        return super[Symbol.iterator]();
      }
    }
    const lookup = new CountingLookup([['fix-docs-release-wiring', '/tasks/aaa']]);
    const table = { lookup, className: 'lz-task-link', matchWords: true };

    const first = renderMarkdown('See fix-docs-release-wiring.', { linkify: [table] });
    // The href here is whatever the hand-built table maps to, not a rule —
    // only buildTaskCodeLinkify decides the href shape.
    expect(first).toContain('href="/tasks/aaa"');
    expect(lookup.iterations).toBe(1);

    // A fresh array around the same table — review composes one per item.
    for (let i = 0; i < 5; i++) {
      expect(renderMarkdown('Again fix-docs-release-wiring.', { linkify: [table] })).toContain(
        'href="/tasks/aaa"',
      );
    }
    expect(lookup.iterations).toBe(1);

    // A DIFFERENT table is a different key: it compiles, and links its own code.
    const other = buildTaskCodeLinkify([{ id: 'bbb', code: 'other-task-code' }]);
    const html = renderMarkdown('See other-task-code and fix-docs-release-wiring.', {
      linkify: [other, table],
    });
    expect(html).toContain('href="/tasks/other-task-code"');
    expect(html).toContain('href="/tasks/aaa"');
  });

  test('hash-only markdown links pick up hashLinkBase', () => {
    const html = renderMarkdown('[the retry path](#group-retry)', {
      hashLinkBase: '/tasks/t/changes',
    });
    expect(html).toContain('href="/tasks/t/changes#group-retry"');
  });
});

describe('presentation group anchors', () => {
  test('an agent-authored group id becomes id="group-retry"', () => {
    const html = renderPresentedChanges(
      {
        groups: [{
          id: 'retry',
          title: 'Retry path',
          tier: 'core',
          items: [{ kind: 'prose', body: 'the retry path' }],
        }],
      },
      [],
      new Map(),
      {},
    );
    expect(html).toContain('id="group-retry"');
  });
});
