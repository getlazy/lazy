/**
 * Link scheme allowlist in the shared markdown renderer.
 *
 * Every dashboard surface that renders prose goes through `renderMarkdown`:
 * turn bodies, agent reports, raised items, journal entries, and comments —
 * which are the one entity carrying text lazy did not author, since a comment
 * with `source: 'remote'` is synced verbatim from a PR/MR body.
 *
 * All of it renders on an origin holding the dashboard session cookie, the one
 * that authorizes Unblock, Accept, Reject and the web shell. So a clickable
 * `javascript:` href is script execution with full authority over the project's
 * tasks, one click away.
 */

import { describe, test, expect } from 'bun:test';
import { renderMarkdown, safeLinkHref } from '../../src/server/markdown';

describe('safeLinkHref', () => {
  // INVARIANT: only http, https and mailto may become an href. Anything else
  // renders inert. Adding a scheme here is a security decision, not a tidy-up —
  // `data:` and `blob:` in particular can carry a whole HTML document.
  test('allows the three safe schemes and refuses script-bearing ones', () => {
    expect(safeLinkHref('https://example.com/x')).toBe('https://example.com/x');
    expect(safeLinkHref('http://example.com')).toBe('http://example.com');
    expect(safeLinkHref('mailto:someone@example.com')).toBe('mailto:someone@example.com');

    expect(safeLinkHref('javascript:alert(1)')).toBeNull();
    expect(safeLinkHref('JavaScript:alert(1)')).toBeNull();
    expect(safeLinkHref('vbscript:msgbox(1)')).toBeNull();
    expect(safeLinkHref('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeLinkHref('blob:https://example.com/uuid')).toBeNull();
    expect(safeLinkHref('file:///etc/passwd')).toBeNull();
  });

  // Browsers STRIP ASCII whitespace and control characters while parsing a URL
  // scheme, so these all navigate as javascript:. A check that compares the
  // raw string would pass every one of them.
  test('refuses schemes obfuscated with whitespace and control characters', () => {
    expect(safeLinkHref(' javascript:alert(1)')).toBeNull();
    expect(safeLinkHref('java\tscript:alert(1)')).toBeNull();
    expect(safeLinkHref('java\nscript:alert(1)')).toBeNull();
    expect(safeLinkHref('java\r\nscript:alert(1)')).toBeNull();
    expect(safeLinkHref('\u0000javascript:alert(1)')).toBeNull();
    expect(safeLinkHref('jav\u0001ascript:alert(1)')).toBeNull();
  });

  // The forms lazy itself renders constantly. Breaking these would be a far
  // more visible bug than the one this guards against.
  test('leaves relative, fragment, query and protocol-relative links alone', () => {
    expect(safeLinkHref('/tasks/abc/changes')).toBe('/tasks/abc/changes');
    expect(safeLinkHref('/tasks/t/changes#l-src%2Ffoo.ts-new-12')).toBe('/tasks/t/changes#l-src%2Ffoo.ts-new-12');
    expect(safeLinkHref('#group-retry')).toBe('#group-retry');
    expect(safeLinkHref('?sort=age')).toBe('?sort=age');
    expect(safeLinkHref('web-shell.md')).toBe('web-shell.md');
    expect(safeLinkHref('../design/module-boundaries.md')).toBe('../design/module-boundaries.md');
    expect(safeLinkHref('//example.com/x')).toBe('//example.com/x');
  });

  // A colon only asserts a SCHEME when what precedes it is scheme-shaped: a
  // letter, then letters/digits/+/-, with no dot. `file.ts:120` is the most
  // common code reference agents write — CLAUDE.md tells them to, because it is
  // clickable — and an earlier, broader check rendered every one of them as
  // grey inert text captioned "unsupported URL scheme".
  test('a dotted first segment is a relative path, not a scheme', () => {
    expect(safeLinkHref('markdown.ts:192')).toBe('markdown.ts:192');
    expect(safeLinkHref('src/server/markdown.ts:192')).toBe('src/server/markdown.ts:192');
    expect(safeLinkHref('CLAUDE.md:1')).toBe('CLAUDE.md:1');
    expect(safeLinkHref('test/unit/task-notes-tabs.test.ts:88')).toBe('test/unit/task-notes-tabs.test.ts:88');

    // The narrowing keys on the DOT, not on "looks like a path": an undotted
    // first segment is still read as an asserted scheme and still refused.
    // `notes:2026.md` is inert, which is the cheap failure for a shape nobody
    // writes — the shape people do write has a file extension in it.
    expect(safeLinkHref('notes:2026')).toBeNull();
  });

  // INVARIANT: the narrowing above must NOT widen what the allowlist refuses.
  // Every dangerous scheme is an undotted lowercase word, so every one of them
  // still matches the scheme shape, still reaches the allowlist, and is still
  // refused. Anyone narrowing this further re-runs exactly these cases.
  test('narrowing to scheme-shaped prefixes still refuses every dangerous scheme', () => {
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'blob:https://example.com/uuid',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
    ]) {
      expect(safeLinkHref(bad)).toBeNull();
    }
    // And still refused when dressed up in the ways browsers see through.
    expect(safeLinkHref('JAVASCRIPT:alert(1)')).toBeNull();
    expect(safeLinkHref(' java\tscript:alert(1)')).toBeNull();
  });
});

describe('renderMarkdown link rendering', () => {
  test('a javascript: link renders as inert text, with no href at all', () => {
    const html = renderMarkdown('[Click for the fix](javascript:fetch("/evil"))');
    expect(html).not.toContain('href');
    expect(html).toContain('md-blocked-link');
    // The reader still sees there was a link and where it pointed.
    expect(html).toContain('Click for the fix');
    expect(html).toContain('javascript:');
  });

  test('a data: link renders inert too', () => {
    const html = renderMarkdown('[report](data:text/html,<script>alert(1)</script>)');
    expect(html).not.toContain('href="data:');
    expect(html).toContain('md-blocked-link');
    // The angle brackets were escaped before this ever reached the link path.
    expect(html).not.toContain('<script>');
  });

  test('ordinary links still work', () => {
    expect(renderMarkdown('[docs](https://docs.getlazy.dev/web-review)'))
      .toContain('href="https://docs.getlazy.dev/web-review"');
    expect(renderMarkdown('[the task](/tasks/abc)')).toContain('href="/tasks/abc"');
    expect(renderMarkdown('[mail](mailto:a@b.co)')).toContain('href="mailto:a@b.co"');
  });

  // The end-to-end shape of the regression: a code reference in a turn report.
  test('a file.ts:line reference renders as a real link, not a blocked one', () => {
    const html = renderMarkdown('See [markdown.ts:192](src/server/markdown.ts:192) for the check.');
    expect(html).toContain('href="src/server/markdown.ts:192"');
    expect(html).not.toContain('md-blocked-link');
  });

  test('the hashLinkBase rewrite still produces a real link', () => {
    const html = renderMarkdown('see [the retry path](#group-retry)', {
      hashLinkBase: '/tasks/t/changes',
    });
    expect(html).toContain('href="/tasks/t/changes#group-retry"');
  });

  // The other two link paths are fed by lazy's own linkify tables, not by
  // untrusted text — but they carry the same allowlist, so that a future table
  // built from somewhere else cannot reopen the hole on a path nobody rechecked.
  test('a linkify table with an unsafe href yields plain text, not a link', () => {
    const lookup = new Map([['badCode', 'javascript:alert(1)']]);
    const inlineCode = renderMarkdown('See `badCode` here.', { linkify: [{ lookup }] });
    expect(inlineCode).not.toContain('href');
    expect(inlineCode).toContain('<code>badCode</code>');

    const word = renderMarkdown('See badCode here.', {
      linkify: [{ lookup, matchWords: true }],
    });
    expect(word).not.toContain('href');
    expect(word).toContain('badCode');
  });

  test('a safe linkify table still links on both paths', () => {
    const lookup = new Map([['fix-docs', '/tasks/fix-docs']]);
    expect(renderMarkdown('See `fix-docs`.', { linkify: [{ lookup }] }))
      .toContain('href="/tasks/fix-docs"');
    expect(renderMarkdown('See fix-docs.', { linkify: [{ lookup, matchWords: true }] }))
      .toContain('href="/tasks/fix-docs"');
  });
});
