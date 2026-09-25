import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  guardDashboardRequest,
  serveDashboardRequest,
  isSelfOriginatedRequest,
  DASHBOARD_COOKIE_NAME,
  DASHBOARD_LOGIN_PARAM,
} from '../../src/daemon/dashboard-auth';
import {
  clearDashboardSessionCache,
  mintDashboardLoginTicket,
} from '../../src/daemon/dashboard-sessions';

/**
 * The dashboard's cross-origin guard.
 *
 * THE REASON IT EXISTS: `SameSite` is evaluated on the registrable domain, and
 * `localhost` is not in the public suffix list — so `lazy.localhost` is the
 * registrable domain of `web.my-task.lazy.localhost` too, and a page served
 * from a task's container is SAME-SITE with the dashboard. `SameSite=Strict`
 * alone therefore stopped nothing once task apps got names under that suffix:
 * agent-written app code could auto-submit `POST .../container/start`, or open
 * the web shell's WebSocket, and the browser would attach the human's session.
 *
 * Same-site is not good enough here; same-ORIGIN is the bar.
 */

const DASHBOARD_HOST = 'lazy.localhost';
const DASHBOARD_AUTHORITY = 'lazy.localhost:26024';
const TASK_APP_ORIGIN = 'http://web.my-task.lazy.localhost:26024';

function req(
  path: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
): Request {
  const { headers = {}, ...rest } = init;
  return new Request(`http://${DASHBOARD_AUTHORITY}${path}`, {
    ...rest,
    headers: { host: DASHBOARD_AUTHORITY, ...headers },
  });
}

describe('isSelfOriginatedRequest', () => {
  test('uses a configured HTTPS proxy origin instead of the plain listener origin', () => {
    const request = req('/x', {
      method: 'POST',
      headers: { origin: 'https://example.ngrok.app' },
    });
    expect(isSelfOriginatedRequest(request, 'https://example.ngrok.app')).toBe(true);
    expect(isSelfOriginatedRequest(request, 'https://other.ngrok.app')).toBe(false);
  });

  test('accepts an Origin matching the host the request was addressed to', () => {
    expect(isSelfOriginatedRequest(req('/x', {
      method: 'POST',
      headers: { origin: `http://${DASHBOARD_AUTHORITY}` },
    }))).toBe(true);
  });

  // The case this guard was written for: same-site, different origin.
  test('refuses an Origin from a task subdomain', () => {
    expect(isSelfOriginatedRequest(req('/x', {
      method: 'POST',
      headers: { origin: TASK_APP_ORIGIN },
    }))).toBe(false);
  });

  test('refuses an Origin that differs only in port or scheme', () => {
    expect(isSelfOriginatedRequest(req('/x', {
      method: 'POST',
      headers: { origin: 'http://lazy.localhost:26025' },
    }))).toBe(false);
    expect(isSelfOriginatedRequest(req('/x', {
      method: 'POST',
      headers: { origin: `https://${DASHBOARD_AUTHORITY}` },
    }))).toBe(false);
  });

  // Opaque means "I will not say", not "I am you": a sandboxed iframe and a
  // `file://` page both send this.
  test('refuses an opaque Origin', () => {
    expect(isSelfOriginatedRequest(req('/x', {
      method: 'POST',
      headers: { origin: 'null' },
    }))).toBe(false);
  });

  test('falls back to Sec-Fetch-Site when there is no Origin', () => {
    const withSite = (site: string) =>
      isSelfOriginatedRequest(req('/x', { method: 'POST', headers: { 'sec-fetch-site': site } }));
    // `none` is a user-initiated load — typed, bookmarked, opened from outside a
    // page — so there is no other page to be impersonating.
    expect(withSite('none')).toBe(true);
    expect(withSite('same-origin')).toBe(true);
    expect(withSite('same-site')).toBe(false);
    expect(withSite('cross-site')).toBe(false);
  });

  // Origin wins: a browser sends both, and Origin is the more specific claim.
  test('prefers Origin over a same-site Sec-Fetch-Site', () => {
    expect(isSelfOriginatedRequest(req('/x', {
      method: 'POST',
      headers: { origin: TASK_APP_ORIGIN, 'sec-fetch-site': 'same-site' },
    }))).toBe(false);
  });

  // INVARIANT: neither header means a NON-BROWSER client — curl, a script,
  // lazy's own code — which has no ambient cookie to be tricked with. Both
  // headers are forbidden to page scripts, so a page cannot reach this branch
  // by omitting them.
  //
  // Do NOT "tighten" this to a refusal. It is not a gap a browser can walk
  // through (see the next test), and closing it locks out every non-browser
  // caller of the /api routes — lazy's own CLI among them — which is a
  // regression with no attacker on the other side of it.
  test('allows a request carrying neither header', () => {
    expect(isSelfOriginatedRequest(req('/x', { method: 'POST' }))).toBe(true);
  });

  // INVARIANT: the browser that cannot send `Sec-Fetch-Site` is caught by the
  // Origin branch instead, so the allowance above is not a way in for one.
  // Fetch appends `Origin` to every request whose method is not GET or HEAD,
  // and WebKit has done so on cross-origin form POSTs since 2008 — it was the
  // first engine to. So a cross-site form POST from Safari 16.3 or earlier
  // (no Sec-Fetch-* headers at all) still arrives carrying an Origin that is
  // not this host, and is refused on the first branch.
  test('refuses a pre-Sec-Fetch browser’s cross-site form POST on Origin alone', () => {
    expect(isSelfOriginatedRequest(req('/tasks/abcdef12/container/start', {
      method: 'POST',
      headers: { origin: TASK_APP_ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    }))).toBe(false);
  });
});

describe('guardDashboardRequest cross-origin step', () => {
  const projectRoot = '/tmp/lazy-dashboard-origin-project';
  let baseDir: string;
  let previousBaseDir: string | undefined;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'lazy-dashboard-origin-'));
    previousBaseDir = process.env.LAZY_DAEMON_BASE_DIR;
    process.env.LAZY_DAEMON_BASE_DIR = baseDir;
    clearDashboardSessionCache();
  });

  afterEach(async () => {
    if (previousBaseDir === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
    else process.env.LAZY_DAEMON_BASE_DIR = previousBaseDir;
    clearDashboardSessionCache();
    await rm(baseDir, { recursive: true, force: true });
  });

  const guard = (request: Request) => guardDashboardRequest(projectRoot, request, DASHBOARD_HOST);

  test('accepts only the configured proxy host and mints a Secure cookie for HTTPS', async () => {
    const origin = 'https://example.ngrok.app';
    const ticket = await mintDashboardLoginTicket(projectRoot);
    const request = new Request(`${origin}/?${DASHBOARD_LOGIN_PARAM}=${ticket}`, {
      headers: { host: 'example.ngrok.app', 'sec-fetch-site': 'none' },
    });
    const accepted = await guardDashboardRequest(projectRoot, request, 'example.ngrok.app', origin);
    expect(accepted!.status).toBe(302);
    expect(accepted!.headers.get('set-cookie')).toContain('Secure');

    const wrongHost = new Request(`https://other.ngrok.app/`, {
      headers: { host: 'other.ngrok.app' },
    });
    const refused = await guardDashboardRequest(projectRoot, wrongHost, 'example.ngrok.app', origin);
    expect(refused!.status).toBe(421);
    expect(await refused!.text()).toContain(origin);
  });

  test('refuses a POST from a task app with 403', async () => {
    const denial = await guard(req('/tasks/abcdef12/container/start', {
      method: 'POST',
      headers: { origin: TASK_APP_ORIGIN, cookie: `${DASHBOARD_COOKIE_NAME}=whatever` },
    }));
    expect(denial).toBeInstanceOf(Response);
    expect(denial!.status).toBe(403);
  });

  test('refuses a cross-origin API call with a JSON 403', async () => {
    const denial = await guard(req('/api/tasks', {
      method: 'POST',
      headers: { origin: TASK_APP_ORIGIN },
    }));
    expect(denial!.status).toBe(403);
    expect(denial!.headers.get('content-type')).toContain('application/json');
  });

  // A WebSocket handshake is a GET, and the web shell — a root shell inside a
  // task container — is the single most valuable thing on this port.
  test('refuses a cross-origin WebSocket upgrade', async () => {
    const denial = await guard(req('/tasks/abcdef12/shell/ws', {
      headers: { upgrade: 'websocket', origin: TASK_APP_ORIGIN },
    }));
    expect(denial).toBeInstanceOf(Response);
    expect(denial!.status).toBe(403);
  });

  // Deliberately NOT guarded: following a link from a task app back to the
  // dashboard must work, and every mutating route answers 405 to a GET.
  test('lets a cross-origin plain GET through to the session check', async () => {
    const denial = await guard(req('/tasks/abcdef12', {
      headers: { 'sec-fetch-site': 'same-site' },
    }));
    // Refused for being signed out, which is step 5 — not 403 at step 3.
    expect(denial).toBeInstanceOf(Response);
    expect(denial!.status).toBe(401);
  });

  // Ahead of the ticket on purpose: a cross-origin caller must not be able to
  // spend the human's one-time login link.
  test('refuses to redeem a login ticket for a cross-origin caller', async () => {
    const ticket = await mintDashboardLoginTicket(projectRoot);
    const denial = await guard(req(`/?${DASHBOARD_LOGIN_PARAM}=${ticket}`, {
      method: 'POST',
      headers: { origin: TASK_APP_ORIGIN },
    }));
    expect(denial!.status).toBe(403);
    expect(denial!.headers.get('set-cookie')).toBeNull();

    // And the ticket is unspent: the human's link still works for the human.
    const redeemed = await guard(req(`/?${DASHBOARD_LOGIN_PARAM}=${ticket}`, {
      headers: { 'sec-fetch-site': 'none' },
    }));
    expect(redeemed!.status).toBe(302);
  });

  // INVARIANT: the dashboard cookie is HOST-ONLY. A `Domain=lazy.localhost`
  // attribute would send the human's session to every task subdomain — that is
  // to say, into agent-written code — on every request. The reverse direction
  // is closed in src/server/serve-proxy.ts (stripCookieDomain).
  test('the session cookie it sets carries no Domain attribute', async () => {
    const ticket = await mintDashboardLoginTicket(projectRoot);
    const response = await guard(req(`/?${DASHBOARD_LOGIN_PARAM}=${ticket}`, {
      headers: { 'sec-fetch-site': 'none' },
    }));
    expect(response!.status).toBe(302);

    const cookie = response!.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${DASHBOARD_COOKIE_NAME}=`);
    expect(cookie.toLowerCase()).not.toContain('domain=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
  });
});

/**
 * The third leg of the same story.
 *
 * The origin check above closes the cross-origin POST, and the same fact —
 * a task app is SAME-SITE with the dashboard — opens clickjacking: a page in a
 * task container frames `http://lazy.localhost:<port>/tasks/<id>`, the browser
 * attaches the `SameSite=Strict` session cookie because the frame is same-site,
 * and the framed dashboard renders the real Start container / Accept buttons. A
 * POST fired from inside that frame IS from the dashboard's own origin, so the
 * origin check passes it; an opaque overlay turns one human click into it.
 */
describe('dashboard framing headers', () => {
  const projectRoot = '/tmp/lazy-dashboard-framing-project';
  let baseDir: string;
  let previousBaseDir: string | undefined;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'lazy-dashboard-framing-'));
    previousBaseDir = process.env.LAZY_DAEMON_BASE_DIR;
    process.env.LAZY_DAEMON_BASE_DIR = baseDir;
    clearDashboardSessionCache();
  });

  afterEach(async () => {
    if (previousBaseDir === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
    else process.env.LAZY_DAEMON_BASE_DIR = previousBaseDir;
    clearDashboardSessionCache();
    await rm(baseDir, { recursive: true, force: true });
  });

  const guard = (request: Request) => guardDashboardRequest(projectRoot, request, DASHBOARD_HOST);

  function expectUnframeable(res: Response): void {
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  }

  /** Redeem a login ticket the way a browser does, and keep the cookie. */
  async function signIn(): Promise<string> {
    const ticket = await mintDashboardLoginTicket(projectRoot);
    const redirect = await guard(req(`/?${DASHBOARD_LOGIN_PARAM}=${ticket}`, {
      headers: { 'sec-fetch-site': 'none' },
    }));
    expect(redirect!.status).toBe(302);
    return (redirect!.headers.get('set-cookie') ?? '').split(';')[0];
  }

  // INVARIANT: every response on the dashboard host is unframeable, and it is
  // stamped in ONE place (serveDashboardRequest) rather than per route — a new
  // page cannot forget a header it never sets.
  test('a routed dashboard response carries both headers', async () => {
    const cookie = await signIn();
    let routed = false;
    const res = await serveDashboardRequest(
      projectRoot,
      req('/tasks', { headers: { cookie } }),
      DASHBOARD_HOST,
      () => {
        routed = true;
        return new Response('<html>a task page</html>', {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      },
    );

    // The route really ran — otherwise this would be measuring a denial.
    expect(routed).toBe(true);
    expect(res.status).toBe(200);
    expectUnframeable(res);
  });

  // A route that redirects is the shape most likely to come back immutable
  // from a future runtime (the Fetch standard gives `Response.redirect` an
  // immutable header guard; Bun does not enforce it). If that ever changes,
  // this fails here rather than silently shipping frameable 303s — every POST
  // in src/server/index.ts answers with one.
  test('a routed redirect carries them too', async () => {
    const cookie = await signIn();
    const res = await serveDashboardRequest(
      projectRoot,
      req('/tasks/abcdef12/container/start', { headers: { cookie } }),
      DASHBOARD_HOST,
      () => Response.redirect('http://lazy.localhost:26024/tasks/abcdef12', 303),
    );
    expect(res.status).toBe(303);
    expectUnframeable(res);
  });

  // The gate's own answers are pages too, and a couple of them (sign-in, wrong
  // host) are exactly what an attacker would frame to phish a login.
  test('every gate denial carries them', async () => {
    // Signed out, HTML.
    expectUnframeable((await guard(req('/tasks')))!);
    // Signed out, JSON.
    expectUnframeable((await guard(req('/api/tasks')))!);
    // Cross-origin state change.
    expectUnframeable((await guard(req('/tasks/abcdef12/container/start', {
      method: 'POST',
      headers: { origin: TASK_APP_ORIGIN },
    })))!);
    // Wrong host — a request that never names this dashboard at all.
    expectUnframeable((await guard(new Request('http://127.0.0.1:26024/tasks', {
      headers: { host: '127.0.0.1:26024' },
    })))!);
    // The login redirect, which carries the session cookie.
    const ticket = await mintDashboardLoginTicket(projectRoot);
    const redeemed = await guard(req(`/?${DASHBOARD_LOGIN_PARAM}=${ticket}`, {
      headers: { 'sec-fetch-site': 'none' },
    }));
    expect(redeemed!.status).toBe(302);
    expectUnframeable(redeemed!);
  });

  // The other side — a proxied task-service response picking up NEITHER header,
  // and keeping its own CSP — is pinned end to end against the real proxy in
  // test/e2e/serve-proxy.test.ts, where there is an app to answer.
});
