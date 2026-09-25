/**
 * Values interpolated into an inline `<script>` (src/server/escape.ts).
 *
 * WHY THIS IS ITS OWN SUITE. The review page seeds the island with the
 * reviewer's own half-typed comments. `JSON.stringify` alone is not safe there:
 * the HTML parser looks for `</script` before any JavaScript runs, so a draft
 * containing one ends the element early, the rest of the island is parsed as
 * HTML, and an `<img onerror=…>` in the remainder executes on the origin that
 * holds the dashboard session cookie — the cookie that authorizes every daemon
 * write route. There is no `script-src` CSP behind it (dashboard-auth.ts sets
 * `frame-ancestors` only), so nothing downstream catches it.
 *
 * And it is reachable by accident: half-typing a comment about this repo's own
 * inline islands produces that text, and drafts are stored under one shared
 * reviewer identity, so the person who types it need not be the person it runs
 * for.
 */

import { describe, test, expect } from 'bun:test';
import { ESCAPE_HTML_JS, escapeHtml, scriptJson } from '../../src/server/escape';
import { reviewScript } from '../../src/server/review';
import { viewedStateScript } from '../../src/server/viewed-cards';

const CLOSER = '</script>';
const PAYLOAD = `why ${CLOSER}<img src=x onerror="alert(1)"> here?`;

/** What a browser's HTML parser would cut the element at. */
function endsElementEarly(html: string): boolean {
  return /<\/script/i.test(html);
}

describe('scriptJson', () => {
  // INVARIANT: nothing that can close the element survives, in either
  // direction — `</script` ends it, and `<!--` / `<script` open a comment or a
  // nested element in some parsers.
  test('no angle bracket survives', () => {
    const out = scriptJson({ k: PAYLOAD });
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(endsElementEarly(out)).toBe(false);
  });

  // Escaping must not change the VALUE — a draft that came back mangled would
  // be its own kind of losing the reviewer's words.
  test('the value is unchanged: it is an escape, not a substitution', () => {
    const value = { k: PAYLOAD, u: 'unicode — “quotes”, émoji 🎉', n: 1, b: true };
    expect(JSON.parse(scriptJson(value))).toEqual(value);
    // The two line terminators JSON allows raw and JavaScript does not.
    const seps = { k: 'a b c' };
    expect(scriptJson(seps)).not.toContain(' ');
    expect(scriptJson(seps)).not.toContain(' ');
    expect(JSON.parse(scriptJson(seps))).toEqual(seps);
  });
});

describe('the browser mirror of escapeHtml', () => {
  // INVARIANT: the islands build markup as strings and assign it with
  // innerHTML, which is a second injection sink beside the script seed. They
  // embed THIS mirror rather than each hand-rolling an `esc` — the hand-rolled
  // one is what the next call site forgets — so it has to escape exactly what
  // the server-side function does.
  test('escapes the same characters as the TypeScript function', () => {
    const mirror = new Function(`${ESCAPE_HTML_JS}; return esc;`)() as (s: unknown) => string;
    const samples = [
      'plain',
      'a" onfocus="alert(1)',
      "it's <b>bold</b> & \"quoted\"",
      '</script><img src=x onerror=alert(1)>',
      'docs/a"b.md',
      'unicode — “quotes”, émoji 🎉',
    ];
    for (const s of samples) expect(mirror(s)).toBe(escapeHtml(s));
    // Non-strings are coerced, not thrown at: the island passes DOM values.
    expect(mirror(42)).toBe('42');
  });

  test('an attribute cannot be closed through it', () => {
    const mirror = new Function(`${ESCAPE_HTML_JS}; return esc;`)() as (s: string) => string;
    const out = mirror('a" autofocus onfocus="fetch(1)');
    expect(out).not.toContain('"');
    expect(out).not.toContain('<');
  });

  test('the review island embeds the mirror instead of its own copy', () => {
    const js = reviewScript('task1234abcd');
    expect(js).toContain(ESCAPE_HTML_JS);
  });
});

describe('islands that carry caller-supplied strings', () => {
  // The regression this suite exists for: a draft containing a closing script
  // tag must not break the island out of its element.
  test('a draft containing a closing script tag cannot end the island', () => {
    const js = reviewScript('task1234abcd', {
      lineDrafts: { 'line new 12 - src/server/review.ts': PAYLOAD },
    });
    const body = js.slice(js.indexOf('<script>') + '<script>'.length, js.lastIndexOf('</script>'));
    expect(endsElementEarly(body)).toBe(false);
    expect(body).not.toContain('onerror="alert(1)"');
    // The draft is still THERE — escaped, not dropped: the island parses and
    // the value survives the round trip.
    const seeded = /var LINE_DRAFTS = (\{.*?\});/.exec(body);
    expect(seeded).not.toBeNull();
    expect(JSON.parse(seeded![1])['line new 12 - src/server/review.ts']).toBe(PAYLOAD);
    expect(() => new Function(body)).not.toThrow();
  });

  // INVARIANT: the off-screen ("orphan") draft box takes its placeholder from
  // the draft's own file path, which comes off a stored key — an agent-authored
  // path or a crafted key can contain a double quote. It is set as a PROPERTY
  // on the textarea, so there is no attribute for it to close; the island must
  // not go back to interpolating it into the markup string.
  test('the off-screen draft box builds no markup around its placeholder', () => {
    const js = reviewScript('task1234abcd');
    expect(js).toContain("form.querySelector('textarea').placeholder = threadId");
    expect(js).not.toContain("required placeholder=\"' +");
  });

  // Viewed ticks arrive through the same patch route, so they are
  // caller-supplied strings going into a script too.
  test('a viewed tick cannot end the island either', () => {
    const js = viewedStateScript('task1234abcd', {
      serverState: { [`src/x${CLOSER}.ts`]: `abc${CLOSER}` },
    });
    const body = js.slice(js.indexOf('<script>') + '<script>'.length, js.lastIndexOf('</script>'));
    expect(endsElementEarly(body)).toBe(false);
    expect(() => new Function(body)).not.toThrow();
  });
});
