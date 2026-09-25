/**
 * The server-side escapers: text into HTML, and values into an inline
 * `<script>`.
 *
 * ONE home, because the two are asked for in the same breath and getting the
 * second one wrong is not a rendering bug. It imports nothing, deliberately:
 * every island renderer on the page has to be able to reach it, including
 * `viewed-cards.ts`, which `review-diff.ts` imports (so it cannot import back).
 */

/**
 * The browser mirror of {@link escapeHtml}, embedded verbatim in the islands.
 *
 * They need it: an island builds markup as strings and assigns it with
 * `innerHTML`, which is a second injection sink alongside the script seed
 * {@link scriptJson} closes. Shipping the mirror from HERE rather than letting
 * each island hand-roll its own `esc` is the point — the hand-rolled one is
 * what gets forgotten at the next call site.
 *
 * `test/unit/script-json-escape.test.ts` executes this against the function
 * below, so the two cannot drift.
 */
export const ESCAPE_HTML_JS = `function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}`;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A value, serialized for interpolation INTO an inline `<script>` body.
 *
 * `JSON.stringify` alone is not safe there and the difference is not academic:
 * the HTML parser looks for `</script` before the JavaScript parser sees
 * anything, so a string containing `</script>` ends the element early. The rest
 * of the island is then parsed as HTML — the island is dead, and an
 * `<img onerror=…>` in the remainder runs on the dashboard's own origin, which
 * is the origin holding the session cookie that authorizes every daemon write
 * route. The dashboard sets no `script-src` CSP (only `frame-ancestors`), so
 * nothing downstream catches it.
 *
 * This is reachable from ordinary use, not just from an attacker: a reviewer
 * half-typing a comment about this repo's own inline islands types `</script>`,
 * their words are stored, and the page seeds them straight back into a script
 * tag. Drafts are stored under one shared reviewer identity on a local daemon,
 * so the person who types it need not be the person it executes for.
 *
 * `<` and `>` are escaped as unicode escapes rather than replaced, so the
 * VALUE is unchanged — `JSON.parse` of the result yields the original string —
 * and the two line terminators JSON allows raw but JavaScript does not
 * (U+2028/U+2029) go with them.
 */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
