/**
 * What a browser terminal does when its socket closes: reattach by itself, or
 * say the session really ended. One policy for every terminal page.
 *
 * The daemon dashboard's shell and Watch embed {@link TERMINAL_RECONNECT_JS}
 * as it is. Lazy Teams' terminal controller carries the same functions in
 * `lazy-teams/app/javascript/terminal_reconnect.js` (a separate app with its
 * own asset pipeline); test/unit/terminal-reconnect-policy.test.ts runs one
 * table of cases against BOTH, so the two cannot drift apart.
 *
 * The rules:
 *  - The session really ended — the program exited, the server said why in an
 *    `error`/`ended` frame, the person closed it, or a close code that is a
 *    decision (1008 policy/refused, 4000 idle or too long, 4001 opened in
 *    another window) — never reconnect.
 *  - Otherwise the connection dropped. A terminal holding a resume token, or
 *    a read-only stream that can simply be opened again (Watch), reconnects
 *    with backoff: quick tries first, then every 30 seconds. One with neither
 *    lost its session with the connection.
 *  - A resumable terminal stops trying after its server-side hold
 *    (src/server/terminal-hold.ts, 5 minutes) has run out; a read-only stream
 *    keeps trying.
 */

export const TERMINAL_RECONNECT_JS = String.raw`
var LZ_RECONNECT_DELAYS_MS = [250, 1000, 2000, 4000, 8000, 15000, 30000];
var LZ_RECONNECT_WINDOW_MS = 5 * 60 * 1000;
var LZ_FINAL_CLOSE_CODES = { 1008: 'refused', 4000: 'expired', 4001: 'elsewhere' };
function lzReconnectDelay(attempt) {
  return LZ_RECONNECT_DELAYS_MS[Math.min(Math.max(attempt, 0), LZ_RECONNECT_DELAYS_MS.length - 1)];
}
/* o: { code, ended, resumable, restartable }. 'ended' | 'lost' | 'reconnect'. */
function lzCloseOutcome(o) {
  if (o.ended || LZ_FINAL_CLOSE_CODES[o.code]) return 'ended';
  if (o.resumable || o.restartable) return 'reconnect';
  return 'lost';
}
/* Whether to try again after attempts that began at startedAt. */
function lzKeepTrying(o) {
  return o.restartable || o.now - o.startedAt < LZ_RECONNECT_WINDOW_MS;
}
/* A socket refused before it opened may be a signed-out page: the refusal is
   plain HTTP, which a browser reports as a bare close. Ask this page's own
   address, which redirects or refuses a signed-out visitor. Resolves true only
   for that; a network that is down resolves false, and the page keeps trying. */
function lzSignedOut() {
  return fetch(location.href, { method: 'GET', redirect: 'follow', credentials: 'same-origin', cache: 'no-store' }).then(
    function (r) {
      if (r.status === 401 || r.status === 403) return true;
      /* A signed-in page may redirect for its own reasons; only one that
         lands on a sign-in page means signed out. */
      return r.redirected && /\/(session|sign[-_]?in|login)(\/|$|\?)/.test(new URL(r.url).pathname);
    },
    function () { return false; });
}
/* What the page says for a close code that is a decision. */
function lzFinalCloseMessage(code) {
  switch (LZ_FINAL_CLOSE_CODES[code]) {
    case 'elsewhere': return 'This terminal was opened in another window.';
    case 'expired': return 'This terminal was closed by the server.';
    default: return 'The server closed this terminal.';
  }
}
`;
