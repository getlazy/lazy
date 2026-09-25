/**
 * Signing a test in to the web dashboard.
 *
 * Every dashboard route now requires a browser session, so a suite that pokes
 * the daemon's web surface has to hold a cookie. This is the ONE place that
 * knows how: it runs the real `lazy dashboard --print`, redeems the one-time
 * login link exactly as a browser would, and hands back a `fetch` that carries
 * the resulting cookie.
 *
 * Use it by destructuring, which shadows the global `fetch` for the rest of the
 * test body:
 *
 *   const { base, fetch } = await signInToDashboard(ctx);
 *   const res = await fetch(`${base}/tasks`);   // authenticated
 *
 * That is deliberate. It keeps cookie handling out of every call site — a suite
 * either signs in at the top or does not, and no individual `fetch` grows a
 * headers argument that a later edit can forget.
 *
 * THE HOSTNAME. The dashboard answers only on `lazy.localhost` (see
 * src/daemon/dashboard-url.ts: a hostname of its own is what keeps the session
 * cookie out of the task app ports published on 127.0.0.1). A browser resolves
 * that name itself; a test process may not — glibc does not — so the `fetch`
 * here TRANSPORTS to 127.0.0.1 while sending `Host: lazy.localhost:<port>`,
 * which is exactly what the browser puts on the wire. Suites therefore keep
 * using `${base}/path` with no DNS dependency and no per-call headers.
 */

import { checkDaemonHealth } from '../../src/daemon';
import { DASHBOARD_HOSTNAME } from '../../src/daemon/dashboard-url';
import type { TestContext } from './setup';

/**
 * The authenticated `fetch`. Declared next to a suite's `let base` so the
 * destructuring assignment in `beforeEach` has something to bind to:
 *
 *   let base: string;
 *   let fetch: DashboardFetch;
 *   ...
 *   ({ base, fetch } = await signInToDashboard(ctx));
 */
export type DashboardFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface DashboardSession {
  /** `http://lazy.localhost:<webPort>` — the dashboard's origin. */
  base: string;
  /** The raw `name=value` cookie pair, for tests that assert on it directly. */
  cookie: string;
  /** `fetch`, with the session cookie attached to every request. */
  fetch: DashboardFetch;
}

/**
 * `fetch` against the dashboard's hostname, with NO session.
 *
 * For the assertions about being signed out — they need the right Host header
 * (otherwise they measure the wrong-host refusal instead of the sign-in gate)
 * but must not carry a cookie.
 */
export const dashboardFetch: DashboardFetch = (input, init) => dashboardRequest(input, init, null);

function dashboardRequest(
  input: string | URL | Request,
  init: RequestInit | undefined,
  cookie: string | null,
): Promise<Response> {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (url.hostname === DASHBOARD_HOSTNAME) {
    // What a browser sends: Host names the dashboard, the packets go to the
    // loopback address the daemon actually bound.
    headers.set('host', url.port ? `${url.hostname}:${url.port}` : url.hostname);
    url.hostname = '127.0.0.1';
  }
  if (cookie) headers.set('cookie', cookie);
  return fetch(url, { ...init, headers });
}

/** Ask the daemon for a one-time login link, exactly as `lazy dashboard` does. */
export async function mintDashboardLoginUrl(ctx: TestContext): Promise<{ base: string; loginUrl: string }> {
  const health = await checkDaemonHealth(ctx.root);
  if (!health.webPort) throw new Error('daemon has no web port — dashboard sign-in needs withDaemon: true');
  const base = `http://${DASHBOARD_HOSTNAME}:${health.webPort}`;

  const result = await ctx.lazy(['dashboard', '--print']);
  if (result.exitCode !== 0) {
    throw new Error(`lazy dashboard --print failed (${result.exitCode}): ${result.stderr || result.stdout}`);
  }
  const match = result.stdout.match(/https?:\/\/\S+/);
  if (!match) throw new Error(`lazy dashboard --print printed no URL: ${JSON.stringify(result.stdout)}`);

  // The command prints the dashboard host already; rebuild against `base` so a
  // suite's URLs are all one origin regardless of how the daemon bound.
  const printed = new URL(match[0]);
  return { base, loginUrl: `${base}${printed.pathname}${printed.search}` };
}

/**
 * Sign in and return an authenticated `fetch`.
 *
 * Redeems the link with `redirect: 'manual'` so the 302 + `Set-Cookie` are
 * observable — following it would drop the cookie and land on the sign-in page.
 */
export async function signInToDashboard(ctx: TestContext): Promise<DashboardSession> {
  const { base, loginUrl } = await mintDashboardLoginUrl(ctx);

  const res = await dashboardFetch(loginUrl, { redirect: 'manual' });
  if (res.status !== 302) {
    throw new Error(`login link did not redirect (status ${res.status})`);
  }
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('login link set no cookie');
  const cookie = setCookie.split(';')[0];

  return {
    base,
    cookie,
    fetch: (input, init) => dashboardRequest(input, init, cookie),
  };
}
