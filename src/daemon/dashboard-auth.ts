/**
 * The web dashboard's front door.
 *
 * Every dashboard request passes through `guardDashboardRequest` before the
 * router in src/server/ ever sees it — one choke point, so a new page or API
 * route cannot forget to authenticate. `serveDashboardRequest` is that gate and
 * the router composed, and is what both surfaces serving these pages (the
 * daemon and src/dev/web-server.ts) call: the response headers below are then
 * stamped in one place rather than per route. `/rpc`, `/mcp`, `/builder` and
 * `/daemon/status` are routed earlier in the daemon's handler and are NOT
 * affected: they have their own token auth (and `/daemon/status` is the
 * deliberate unauthenticated liveness probe).
 *
 * Six outcomes:
 *
 *   0. WRONG HOST — the request was addressed to something other than the
 *      dashboard's hostname (see THE HOST CHECK below). No session is read or
 *      minted; the response names the right URL and nothing else — or, when
 *      `[server] dashboard_url` is set, the Host that actually arrived, since
 *      the usual cause there is a reverse proxy rewriting it.
 *   1. MANAGED MODE — the dashboard does not exist. A managed daemon is a Lazy
 *      Teams fleet host; its operator surface is Teams, which talks to daemons
 *      over `/rpc` with actor tokens and never loads a page from here. Every
 *      dashboard route, asset, the login endpoint and the web shell answer 404.
 *   2. ANOTHER ORIGIN asked for something that changes state (see THE ORIGIN
 *      CHECK below) — refused before the session is even read.
 *   3. A LOGIN TICKET in the query string — redeemed once for a session cookie,
 *      then a redirect to the same URL without the ticket, so the secret does
 *      not survive in the address bar, the browser's history, or a copied link.
 *      A 302 when the link was typed or opened by `lazy dashboard`; a
 *      same-origin bounce page when it was clicked on another site (see
 *      `sameOriginBouncePage` for why a 302 cannot work there).
 *   4. A PAGE LOAD ANOTHER SITE STARTED, with no session on it — bounced once
 *      through this origin, because the browser withholds the Strict cookie
 *      from exactly that load even when it holds a valid one.
 *   5. NO VALID SESSION — one plain sign-in page (or a 401 with the same
 *      instruction, for JSON routes). It names no task, no project path and no
 *      count: an unauthenticated caller learns only that a lazy daemon is here,
 *      which the port already told them.
 *
 * `hasDashboardSession` is exported for surfaces that are not plain HTTP
 * responses — the web shell's WebSocket upgrade must call it on EVERY bind, not
 * once per page load: an upgrade request carries the cookie like any other, and
 * a shell into a task container is the single most valuable thing on this port.
 *
 * THE HOST CHECK
 *
 * Both entry points take the host the dashboard is served on (see
 * ./dashboard-url.ts) and refuse a request whose `Host` header is anything
 * else. That is not pedantry about virtual hosts: cookies are scoped by HOST,
 * not by port, and `[serve]` publishes task app ports on `127.0.0.1`. Serving
 * the dashboard at `http://127.0.0.1:<port>` too would put its session cookie
 * in the same jar as agent-written app code the engineer opens in the same
 * browser. So a session is neither MINTED nor ACCEPTED on the wrong host —
 * and a login ticket presented on the wrong host is not even spent.
 *
 * THE ORIGIN CHECK
 *
 * A state-changing request must come from the dashboard's OWN origin. Same-site
 * is not enough, and that distinction is the whole point: task services are
 * served at `<service>.<task>.lazy.localhost` through the proxy in
 * src/server/serve-proxy.ts, and `localhost` is not a public suffix, so the
 * registrable domain of both that name and `lazy.localhost` is
 * `lazy.localhost` — they are SAME-SITE. `SameSite=Strict` therefore does not
 * hold a page served out of a task container away from this dashboard's
 * cookie: agent-written app code could auto-submit
 * `POST /tasks/<id>/container/start`, or open the web shell's WebSocket, and
 * the browser would attach the human's session.
 *
 * So every unsafe method AND every WebSocket upgrade (which is a GET, and is
 * the most valuable thing on this port) must present an `Origin` matching this
 * host, or `Sec-Fetch-Site: same-origin`/`none`. A request carrying NEITHER
 * header is allowed: browsers always send at least one on exactly the requests
 * this guards, so their joint absence means a non-browser client — curl, a
 * script, lazy's own code — which has no ambient cookie to be tricked with.
 * Both headers are forbidden to page scripts, so neither can be forged from the
 * place it would matter.
 *
 * AND IT MUST NOT BE FRAMED
 *
 * The same fact opens one more door, which the check above cannot close. A page
 * served out of a task container can put THIS dashboard in an iframe: the
 * framed load is a GET, `SameSite=Strict` lets the session cookie ride along
 * because the two are same-site, and the framed page renders the real Start
 * container / Start services / Accept buttons. A POST fired from inside that
 * frame is from the dashboard's OWN origin, so the origin check passes it —
 * overlay the frame with something opaque and one human click starts whatever
 * the app chose. Hence `Content-Security-Policy: frame-ancestors 'none'` and
 * `X-Frame-Options: DENY` on every response this module lets through, stamped
 * once in `serveDashboardRequest` so a new route cannot forget a header it
 * never sets. Proxied responses get NEITHER: a task app framing its own pages
 * is its own business, and the proxy answers before this module is reached.
 *
 * Host-only cookie, own-origin proof, no framing: three legs of one story, and
 * pulling any one out puts the weight on the other two.
 */

import { isManagedMode } from '../config/managed';
import { escapeHtml } from '../server/escape';
import {
  DASHBOARD_SESSION_IDLE_MS,
  isValidDashboardSession,
  redeemDashboardLoginTicket,
} from './dashboard-sessions';

/** Name of the session cookie the browser holds. */
export const DASHBOARD_COOKIE_NAME = 'lazy_dashboard';

/**
 * Cookie lifetime handed to the browser. Derived from the server-side idle
 * window so the two cannot drift apart; the server remains the authority either
 * way — a cookie the browser still holds is refused once the session is gone.
 */
export const DASHBOARD_SESSION_COOKIE_MAX_AGE_SECONDS = Math.floor(DASHBOARD_SESSION_IDLE_MS / 1000);

/** Query parameter carrying a one-time login ticket. */
export const DASHBOARD_LOGIN_PARAM = 'lazy_login';

/** The one instruction every unauthenticated response gives. */
const SIGN_IN_INSTRUCTION = 'Run `lazy dashboard` in the project to sign in.';

/** The one line every managed-mode 404 gives. */
const MANAGED_MESSAGE = 'This daemon is managed; use Lazy Teams.';

/**
 * Read one cookie out of a Cookie header.
 *
 * Deliberately minimal: cookie values here are hex session ids, so there is no
 * quoting or encoding to undo, and a hand-rolled split cannot be surprised by
 * one. Returns the FIRST match — a duplicate cookie name is not a valid way to
 * present a second credential.
 */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

/**
 * The hostname a request was addressed to, lower-cased and without its port.
 *
 * Returns null when there is no `Host` header or it does not parse — both are
 * treated as "not the dashboard host", because a request that cannot say where
 * it was sent cannot be shown to have been sent here.
 */
export function requestHostname(req: Request): string | null {
  const header = req.headers.get('host');
  if (!header) return null;
  let hostname: string;
  try {
    hostname = new URL(`http://${header}`).hostname;
  } catch (err) {
    // A malformed Host header is a caller error, not a server one, and the only
    // useful response is the same refusal an unknown host gets. Verified the
    // only thing lost here is the parser's message about the client's own
    // header, which the client already has.
    void err;
    return null;
  }
  // URL brackets IPv6 literals (`[::1]`); the configured bind host does not.
  const bare = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  return bare.toLowerCase();
}

/** Was this request addressed to the host the dashboard is served on? */
export function isDashboardHost(req: Request, dashboardHost: string): boolean {
  const hostname = requestHostname(req);
  return hostname !== null && hostname === dashboardHost.toLowerCase();
}

/** Methods HTTP itself defines as changing nothing on the server. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Is this a WebSocket handshake? They are GETs, and they are not safe. */
function isWebSocketUpgrade(req: Request): boolean {
  const upgrade = req.headers.get('upgrade');
  if (!upgrade) return false;
  return upgrade
    .split(',')
    .some((token) => token.trim().toLowerCase() === 'websocket');
}

/**
 * Does this request need to prove where it came from?
 *
 * Everything that can change state: any unsafe method, plus WebSocket upgrades
 * — a shell into a task container is opened by a GET, and is the single most
 * valuable thing reachable on this port. Plain GET navigations are deliberately
 * NOT included: following a link from a task app back to the dashboard must
 * work, and a GET changes nothing (every mutating route in src/server/ answers
 * 405 to one).
 */
function needsOriginProof(req: Request): boolean {
  return !SAFE_METHODS.has(req.method.toUpperCase()) || isWebSocketUpgrade(req);
}

/**
 * Was this request made BY the dashboard's own origin?
 *
 * See THE ORIGIN CHECK above for why same-site is not good enough here. Both
 * headers absent means a non-browser client, which is allowed — see there.
 *
 * `Origin` first, and it carries the older browsers on its own: Fetch appends
 * `Origin` to every request whose method is not GET or HEAD, so a cross-site
 * form POST from a browser too old to send `Sec-Fetch-Site` (Safari 16.3 and
 * earlier) is still refused by the first branch below. WebKit has done this
 * since 2008 — it was the first engine to.
 *
 * The comparison is against the request's own `Host`, not against the
 * configured dashboard host, purely so this stays a pure function of the
 * request; the caller has already established that the two are the same
 * (`isDashboardHost` runs first, and a mismatch never reaches this).
 */
export function isSelfOriginatedRequest(req: Request, dashboardOrigin?: string): boolean {
  const origin = req.headers.get('origin');
  if (origin !== null) {
    // `Origin: null` (sandboxed iframe, `file://`, some redirect chains) does
    // not parse as a URL and so is refused here, which is the right answer:
    // opaque means "I will not say", not "I am you".
    let sent: URL;
    try {
      sent = new URL(origin);
    } catch (err) {
      void err;
      return false;
    }
    const host = req.headers.get('host');
    if (!host) return false;
    let addressed: URL;
    try {
      addressed = new URL(`http://${host}`);
    } catch (err) {
      void err;
      return false;
    }
    // A configured reverse proxy may terminate HTTPS before forwarding plain
    // HTTP to this listener. In that case the public origin is authoritative;
    // otherwise the listener's own HTTP Host remains the expected origin.
    const expected = dashboardOrigin
      ? new URL(dashboardOrigin)
      : addressed;
    return sent.origin.toLowerCase() === expected.origin.toLowerCase();
  }

  const site = req.headers.get('sec-fetch-site');
  if (site !== null) {
    const value = site.trim().toLowerCase();
    // `none` is a user-initiated load — typed, bookmarked, opened from outside
    // a page. There is no other page involved, so there is nobody to be
    // impersonating.
    return value === 'same-origin' || value === 'none';
  }

  return true;
}

/**
 * Does this request carry a live dashboard session?
 *
 * The check every non-HTML dashboard surface (today: the web shell's WebSocket
 * upgrade) must make for itself, on every bind. `dashboardHost` is the host the
 * dashboard is served on (`dashboardHostFor(bindHost)`): a cookie presented on
 * any other host is refused, whatever the session store says about it.
 */
export async function hasDashboardSession(
  projectRoot: string,
  req: Request,
  dashboardHost: string,
): Promise<boolean> {
  if (!isDashboardHost(req, dashboardHost)) return false;
  const sessionId = readCookie(req.headers.get('cookie'), DASHBOARD_COOKIE_NAME);
  return isValidDashboardSession(projectRoot, sessionId);
}

/**
 * The Set-Cookie value for a freshly redeemed session.
 *
 * `HttpOnly` keeps it out of reach of any script on the page; `SameSite=Strict`
 * means no other SITE can make the browser use it. That is half the CSRF story
 * and not all of it — a task's own services are same-site with this dashboard
 * (see THE ORIGIN CHECK above), so the guard also requires state-changing
 * requests to come from this exact ORIGIN. `Secure` is deliberately NOT set:
 * the dashboard is plain HTTP on loopback, and a Secure cookie would simply
 * never be sent back, locking the operator out of their own machine.
 *
 * No `Domain=` attribute, ever: that would widen the cookie to every
 * `*.lazy.localhost` name, which is exactly the jar the task-service proxy
 * exists to keep separate. Pinned by test.
 */
function sessionCookie(sessionId: string, maxAgeSeconds: number, secure: boolean): string {
  return [
    `${DASHBOARD_COOKIE_NAME}=${sessionId}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

/** Is this a machine-facing dashboard route (JSON in, JSON out)? */
function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

function page(title: string, body: string, status: number): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { background: #14161a; color: #d7dae0; font: 15px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
         margin: 0; display: flex; min-height: 100vh; align-items: center; justify-content: center; }
  main { max-width: 32rem; padding: 2rem; }
  h1 { font-size: 1.1rem; letter-spacing: .04em; text-transform: uppercase; color: #8b93a1; margin: 0 0 1rem; }
  code { background: #1e222a; padding: .15rem .4rem; border-radius: 3px; color: #e8c07d; }
  p { margin: 0 0 .8rem; }
</style>
</head>
<body><main>${body}</main></body>
</html>
`;
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/** The single page every unauthenticated dashboard route renders. */
export function signInPage(): Response {
  return page(
    'Sign in - Lazy',
    `<h1>Lazy</h1>
<p>This is the web dashboard of a lazy daemon running on this machine. It needs a signed-in browser session.</p>
<p>To sign in, run <code>lazy dashboard</code> in the project. It opens this dashboard with a one-time login link.</p>`,
    401,
  );
}

/**
 * The page a request addressed to the wrong host gets.
 *
 * Actionable rather than blank: the overwhelmingly likely visitor is the
 * operator who typed `127.0.0.1:<port>` out of habit, and the fix is one URL.
 * It names no task and no project — the same leak-free rule as the sign-in
 * page — and it is served BEFORE any session is read or minted.
 */
function wrongHostPage(correctUrl: string): Response {
  return page(
    'Wrong address - Lazy',
    `<h1>Lazy</h1>
<p>The lazy dashboard is served at <code>${escapeHtml(correctUrl)}</code>, not at this address.</p>
<p>It has its own hostname on purpose: task apps are published on <code>127.0.0.1</code>, and a browser
would send them the dashboard's session cookie if the two shared a hostname.</p>
<p>Run <code>lazy dashboard</code> in the project to open the right URL and sign in.</p>`,
    421,
  );
}

/**
 * The same refusal when `[server] dashboard_url` is configured.
 *
 * Here the likely visitor did not type the wrong address: they opened the
 * configured origin, and a reverse proxy in front of the daemon REPLACED the
 * Host header on the way in (nginx's default `proxy_pass` does; so does Apache
 * without `ProxyPreserveHost`). "The dashboard is served at <the URL in your
 * address bar>" is true and useless there, so this page says what actually
 * arrived and what to change. The echoed Host is the caller's own header,
 * escaped, and says nothing about this daemon.
 */
function wrongHostBehindProxyPage(configuredOrigin: string, receivedHost: string | null): Response {
  const origin = escapeHtml(configuredOrigin);
  return page(
    'Wrong address - Lazy',
    `<h1>Lazy</h1>
<p>This dashboard is configured to be reached at <code>${origin}</code> (<code>[server] dashboard_url</code>),
but this request arrived addressed to <code>${escapeHtml(receivedHost ?? '(no Host header)')}</code>.</p>
<p>If you opened <code>${origin}</code> through a reverse proxy or tunnel, the proxy is replacing the
Host header. Configure it to forward the original Host header (for nginx:
<code>proxy_set_header Host $host;</code>). The dashboard accepts no other host.</p>`,
    421,
  );
}

/** The JSON form of the wrong-host refusal, for `/api` routes. */
function wrongHostMessage(
  correctUrl: string,
  configuredOrigin: string | undefined,
  receivedHost: string | null,
): string {
  if (!configuredOrigin) return `Wrong host. The lazy dashboard is served at ${correctUrl}.`;
  return (
    `Wrong host. The lazy dashboard is configured at ${configuredOrigin} ([server] dashboard_url), ` +
    `but this request arrived addressed to ${receivedHost ?? '(no Host header)'}. ` +
    'A reverse proxy in front of the daemon must forward the original Host header.'
  );
}

/**
 * A page that sends the browser on to `target` from THIS origin.
 *
 * WHY IT EXISTS. The session cookie is `SameSite=Strict`, and Chromium
 * withholds a Strict cookie from every request in a navigation that ANOTHER
 * site started — redirects included. So a login link clicked in a chat, an
 * email or any web page redeemed its ticket, 302'd to the clean URL, and arrived
 * there WITHOUT the cookie it had just set: the sign-in page, with the one-time
 * link already spent. A dashboard link clicked from the same places showed the
 * sign-in page to someone who was signed in. A typed URL, and `lazy dashboard`
 * opening the browser, are not cross-site — which is why this surfaced only once
 * the dashboard was reached through `[server] dashboard_url`, where the link is
 * almost always opened on another device, from another app.
 *
 * A navigation this page starts has the dashboard as its initiator, so it is
 * same-origin and the Strict cookie rides on it. That admits no more than
 * `SameSite=Lax` would — a top-level GET — and GETs change nothing here: every
 * state-changing request still needs the origin proof above, and framing is
 * still refused. The declarative refresh navigates with history REPLACEMENT, so
 * the ticket URL does not survive behind the back button either (it is spent
 * anyway). No referrer is sent and nothing is cached.
 *
 * Served ONLY for a navigation the browser labelled `cross-site`, which is what
 * makes it loop-free: the navigation it starts is `same-origin`, and a
 * same-origin request never gets it.
 */
function sameOriginBouncePage(target: string, setCookie?: string): Response {
  // A `'` would end the quoted URL inside the refresh directive early.
  const href = escapeHtml(target.replace(/'/g, '%27'));
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0; url='${href}'">
<title>Lazy</title>
</head>
<body><p><a href="${href}">Continue to the lazy dashboard</a></p></body>
</html>
`;
  const headers = new Headers({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  });
  if (setCookie) headers.set('Set-Cookie', setCookie);
  return new Response(html, { status: 200, headers });
}

/**
 * The request's own path and query, as a redirect target that cannot leave
 * this origin.
 *
 * Every "send the browser on to the same URL" the gate answers with — the 302
 * after a login link, the bounce page's refresh — echoes the request's path
 * back to the browser, and a path is attacker-chosen: `//evil.example/` (or
 * `/\evil.example`, which URL parsing turns into `//evil.example`) is a
 * PROTOCOL-RELATIVE URL once it is a redirect target, and the browser would
 * leave for another site. So leading slashes collapse to exactly one, and the
 * result is resolved against the request's own origin and refused (answered
 * with `/`) if it lands anywhere else — the collapse is the fix, the resolve is
 * the proof.
 */
function sameOriginPathOf(url: URL): string {
  const path = `/${url.pathname.replace(/^[/\\]+/, '')}${url.search}`;
  return new URL(path, url.origin).origin === url.origin ? path : '/';
}

/**
 * Is this a top-level page load that ANOTHER site started?
 *
 * Exactly the requests a `SameSite=Strict` cookie is withheld from: a
 * navigation GET the browser labels `cross-site` in Fetch Metadata. Anything
 * else — typed, bookmarked, same-origin, same-site, or a non-browser client
 * with no Fetch Metadata at all — gets the ordinary answer.
 */
function isCrossSiteNavigation(req: Request): boolean {
  if (req.method.toUpperCase() !== 'GET') return false;
  if (req.headers.get('sec-fetch-site')?.trim().toLowerCase() !== 'cross-site') return false;
  const mode = req.headers.get('sec-fetch-mode');
  return mode === null || mode.trim().toLowerCase() === 'navigate';
}

/**
 * The answer to a state-changing request from somewhere other than this origin.
 *
 * Says what was refused and nothing about what is here: an unauthenticated
 * caller who guessed the port learns no task, no project and no state.
 */
function crossOriginPage(): Response {
  return page(
    'Blocked - Lazy',
    `<h1>Lazy</h1>
<p>This request came from another origin, and it would change something. The lazy dashboard only
accepts those from its own pages.</p>
<p>Open the dashboard directly and try again there.</p>`,
    403,
  );
}

/** The single page every dashboard route renders on a managed daemon. */
function managedPage(): Response {
  return page('Not Found', `<h1>Lazy</h1><p>${MANAGED_MESSAGE}</p>`, 404);
}

/**
 * The headers that keep a dashboard page out of somebody else's frame.
 *
 * See AND IT MUST NOT BE FRAMED above. `frame-ancestors` is the directive
 * browsers actually enforce today and covers `<iframe>`, `<embed>` and
 * `<object>`; `X-Frame-Options` is what a browser that predates CSP obeys, and
 * costs one header to keep.
 */
const NO_FRAMING_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['Content-Security-Policy', "frame-ancestors 'none'"],
  ['X-Frame-Options', 'DENY'],
];

/**
 * Stamp the framing headers on a dashboard response.
 *
 * The ONE place they are set. `set` rather than `append` because no dashboard
 * route sets a CSP of its own — if one ever needs to, it has to merge its
 * directives here rather than answer with a policy that drops frame-ancestors.
 */
function denyFraming(res: Response): Response {
  for (const [name, value] of NO_FRAMING_HEADERS) res.headers.set(name, value);
  return res;
}

/**
 * Gate one dashboard request, then route it — the whole dashboard response path.
 *
 * What both surfaces that serve these pages call, so that authentication and
 * the framing headers are applied together and exactly once. A response the
 * gate produces and a response the router produces are equally framed-in-an-app
 * material, and neither can opt out.
 *
 * Proxied task-service responses never reach this: src/server/serve-proxy.ts
 * answers ahead of it and returns the app's own headers untouched.
 */
export async function serveDashboardRequest(
  projectRoot: string,
  req: Request,
  dashboardHost: string,
  route: (req: Request) => Response | Promise<Response>,
  dashboardOrigin?: string,
): Promise<Response> {
  const denial = await guardDashboardRequest(projectRoot, req, dashboardHost, dashboardOrigin);
  // Already stamped: the guard is also called on its own by the WebSocket
  // upgraders, which never reach the router.
  if (denial) return denial;
  return denyFraming(await route(req));
}

/**
 * Gate one dashboard request.
 *
 * Returns the Response to send instead of routing, or `null` when the request
 * is authenticated and should proceed to the dashboard router. Prefer
 * `serveDashboardRequest` for anything that routes; this is for surfaces that
 * are not plain HTTP responses (the WebSocket upgraders), which need the
 * verdict rather than a page.
 */
export async function guardDashboardRequest(
  projectRoot: string,
  req: Request,
  dashboardHost: string,
  dashboardOrigin?: string,
): Promise<Response | null> {
  const denial = await evaluateDashboardRequest(projectRoot, req, dashboardHost, dashboardOrigin);
  return denial === null ? null : denyFraming(denial);
}

/** The gate's decision, before the framing headers are stamped on it. */
async function evaluateDashboardRequest(
  projectRoot: string,
  req: Request,
  dashboardHost: string,
  dashboardOrigin?: string,
): Promise<Response | null> {
  const url = new URL(req.url);
  const api = isApiPath(url.pathname);

  // 1. Managed mode: there is no dashboard on this daemon at all.
  if (isManagedMode()) {
    return api
      ? Response.json({ error: MANAGED_MESSAGE }, { status: 404 })
      : managedPage();
  }

  // 2. The dashboard answers on ONE hostname. This is checked before the ticket
  //    below, so a link opened at the wrong address does not burn its one use,
  //    and before the cookie, so a session never leaves this host's jar.
  if (!isDashboardHost(req, dashboardHost)) {
    const correctUrl = dashboardOrigin ?? `http://${dashboardHost}${url.port ? `:${url.port}` : ''}`;
    const receivedHost = req.headers.get('host');
    if (api) {
      return Response.json(
        { error: wrongHostMessage(correctUrl, dashboardOrigin, receivedHost) },
        { status: 421 },
      );
    }
    return dashboardOrigin
      ? wrongHostBehindProxyPage(dashboardOrigin, receivedHost)
      : wrongHostPage(correctUrl);
  }

  // 3. Anything that can change state must come from this dashboard's own
  //    origin. Ahead of the ticket and the cookie on purpose: a cross-origin
  //    caller must not be able to spend a login link, and must never have the
  //    session read on its behalf.
  if (needsOriginProof(req) && !isSelfOriginatedRequest(req, dashboardOrigin)) {
    return api
      ? Response.json(
          { error: 'Cross-origin request refused. Use the dashboard at its own address.' },
          { status: 403 },
        )
      : crossOriginPage();
  }

  // 4. A login ticket redeems for a cookie, then redirects to the clean URL.
  const ticket = url.searchParams.get(DASHBOARD_LOGIN_PARAM);
  if (ticket) {
    const sessionId = await redeemDashboardLoginTicket(projectRoot, ticket);
    url.searchParams.delete(DASHBOARD_LOGIN_PARAM);
    if (!sessionId) {
      // Spent, expired, or never real — all the same answer. Send the operator
      // to the sign-in page rather than a bare error: the usual cause is a link
      // opened twice, and the fix is the same as never having signed in.
      return signInPage();
    }
    // Never rendered here: the browser must end up on a URL with no secret in
    // it, so a bookmark or a screenshot of the address bar is inert.
    const cleanUrl = sameOriginPathOf(url);
    const cookie = sessionCookie(
      sessionId,
      DASHBOARD_SESSION_COOKIE_MAX_AGE_SECONDS,
      dashboardOrigin?.startsWith('https://') ?? false,
    );
    // A link clicked on another site cannot be answered with a 302: the
    // redirect would arrive without the Strict cookie it sets.
    if (isCrossSiteNavigation(req)) return sameOriginBouncePage(cleanUrl, cookie);
    return new Response(null, {
      status: 302,
      headers: { Location: cleanUrl, 'Set-Cookie': cookie },
    });
  }

  // 5. Otherwise the cookie decides.
  if (await hasDashboardSession(projectRoot, req, dashboardHost)) return null;

  // 6. A page load another site started carries no Strict cookie even when the
  //    browser holds a valid one, so bounce it once through this origin before
  //    concluding the browser is signed out.
  if (!api && isCrossSiteNavigation(req)) {
    return sameOriginBouncePage(sameOriginPathOf(url));
  }

  return api
    ? Response.json({ error: `Not signed in. ${SIGN_IN_INSTRUCTION}` }, { status: 401 })
    : signInPage();
}
