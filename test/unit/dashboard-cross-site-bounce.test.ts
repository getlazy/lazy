import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  guardDashboardRequest,
  DASHBOARD_COOKIE_NAME,
  DASHBOARD_LOGIN_PARAM,
} from '../../src/daemon/dashboard-auth';
import {
  clearDashboardSessionCache,
  mintDashboardLoginTicket,
} from '../../src/daemon/dashboard-sessions';
import { describeDashboardAddress } from '../../src/doctor/sweep';
import { statusOf } from '../../src/doctor/registry';
import {
  compareDashboardAddress,
  dashboardAddressNote,
  misplacedDashboardUrlTables,
} from '../../src/daemon/dashboard-address';

/**
 * The same-origin bounce for page loads another site started.
 *
 * The session cookie is `SameSite=Strict`, and a browser withholds it from
 * every request in a navigation another site started — including the redirect
 * after a login link. So a link clicked in a chat app spent its ticket and
 * landed on the sign-in page, and a task link clicked there showed sign-in to a
 * signed-in human. The real-browser proof is test/e2e/dashboard-public-origin;
 * these pin which requests get the bounce and which do not.
 */

const ORIGIN = 'https://lazy.example.com';
const HOST = 'lazy.example.com';
const projectRoot = '/tmp/lazy-dashboard-bounce-project';

function req(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, { headers: { host: HOST, ...headers } });
}

const CROSS_SITE_NAV = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' };

describe('cross-site navigation bounce', () => {
  let baseDir: string;
  let previousBaseDir: string | undefined;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'lazy-dashboard-bounce-'));
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

  const guard = (request: Request) => guardDashboardRequest(projectRoot, request, HOST, ORIGIN);

  // INVARIANT: a login link clicked on another site sets the cookie on a page
  // that navigates on from THIS origin — never on a 302, whose target the
  // browser loads without the Strict cookie it just set. The clean URL carries
  // no ticket, and the page is uncached, unframeable and sends no referrer.
  test('a login link clicked on another site redeems on a same-origin bounce page', async () => {
    const ticket = await mintDashboardLoginTicket(projectRoot);
    const res = await guard(req(`/tasks?view=all&${DASHBOARD_LOGIN_PARAM}=${ticket}`, CROSS_SITE_NAV));

    expect(res!.status).toBe(200);
    expect(res!.headers.get('location')).toBeNull();
    const cookie = res!.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${DASHBOARD_COOKIE_NAME}=`);
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Secure');
    expect(res!.headers.get('cache-control')).toBe('no-store');
    expect(res!.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res!.headers.get('x-frame-options')).toBe('DENY');

    const html = await res!.text();
    expect(html).toContain(`<meta http-equiv="refresh" content="0; url='/tasks?view=all'">`);
    expect(html).not.toContain(ticket);
  });

  test('a login link opened directly still answers with a 302', async () => {
    const ticket = await mintDashboardLoginTicket(projectRoot);
    const res = await guard(req(`/?${DASHBOARD_LOGIN_PARAM}=${ticket}`, { 'sec-fetch-site': 'none' }));
    expect(res!.status).toBe(302);
    expect(res!.headers.get('location')).toBe('/');
  });

  // INVARIANT: the bounce never stands in for a session and never loops. It
  // sets nothing, and the navigation it starts is same-origin, which gets the
  // ordinary sign-in answer.
  test('a cross-site page load with no session is bounced once, then refused', async () => {
    const bounced = await guard(req('/tasks/abc123', CROSS_SITE_NAV));
    expect(bounced!.status).toBe(200);
    expect(bounced!.headers.get('set-cookie')).toBeNull();
    const html = await bounced!.text();
    expect(html).toContain("url='/tasks/abc123'");
    expect(html).not.toContain('abc123</');

    const followed = await guard(req('/tasks/abc123', { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' }));
    expect(followed!.status).toBe(401);
  });

  test('API calls and non-navigations are never bounced', async () => {
    expect((await guard(req('/api/tasks', CROSS_SITE_NAV)))!.status).toBe(401);
    expect((await guard(req('/tasks', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' })))!.status).toBe(401);
    expect((await guard(req('/tasks')))!.status).toBe(401);
  });

  /** The URL the bounce page's refresh directive navigates to. */
  function refreshTarget(html: string): string {
    const m = html.match(/content="0; url='([^']*)'"/);
    if (!m) throw new Error(`no refresh directive in: ${html}`);
    return m[1]!.replace(/&amp;/g, '&');
  }

  // INVARIANT: every place the gate sends a browser on to "the same URL" keeps
  // it on THIS origin. A path starting `//` (or `/\\`, which URL parsing
  // turns into `//`) is a protocol-relative URL when echoed back as a
  // redirect target: `<dashboard>//evil.example/` would send the human — or,
  // on redemption, a freshly signed-in browser — to another site.
  const OFFSITE_PATHS = ['//evil.example/', '/\\evil.example', '///evil.example/x?y=1'];

  for (const path of OFFSITE_PATHS) {
    test(`the bounce for ${JSON.stringify(path)} stays on this origin`, async () => {
      const res = await guard(req(path, CROSS_SITE_NAV));
      expect(res!.status).toBe(200);
      const target = refreshTarget(await res!.text());
      expect(new URL(target, ORIGIN).origin).toBe(ORIGIN);
      expect(target.startsWith('//')).toBe(false);
    });

    test(`redeeming a login link at ${JSON.stringify(path)} stays on this origin`, async () => {
      const bounced = await guard(req(`${path}${path.includes('?') ? '&' : '?'}${DASHBOARD_LOGIN_PARAM}=${await mintDashboardLoginTicket(projectRoot)}`, CROSS_SITE_NAV));
      expect(bounced!.status).toBe(200);
      const target = refreshTarget(await bounced!.text());
      expect(new URL(target, ORIGIN).origin).toBe(ORIGIN);
      expect(target.startsWith('//')).toBe(false);

      const redirected = await guard(req(`${path}${path.includes('?') ? '&' : '?'}${DASHBOARD_LOGIN_PARAM}=${await mintDashboardLoginTicket(projectRoot)}`, { 'sec-fetch-site': 'none' }));
      expect(redirected!.status).toBe(302);
      const location = redirected!.headers.get('location')!;
      expect(new URL(location, ORIGIN).origin).toBe(ORIGIN);
      expect(location.startsWith('//')).toBe(false);
    });
  }

  test("a quote in the path cannot end the refresh URL early", async () => {
    const res = await guard(req("/tasks/a'b", CROSS_SITE_NAV));
    const html = await res!.text();
    expect(html).toContain("url='/tasks/a%27b'");
  });
});

describe('wrong host behind a configured origin', () => {
  // A proxy that rewrites Host delivers the upstream address. The refusal must
  // say so, rather than send the human to the URL they are already on.
  test('names the Host that arrived and the header to forward', async () => {
    const res = await guardDashboardRequest(
      projectRoot,
      new Request('http://127.0.0.1:26024/', { headers: { host: '127.0.0.1:26024' } }),
      HOST,
      ORIGIN,
    );
    expect(res!.status).toBe(421);
    const html = await res!.text();
    expect(html).toContain('127.0.0.1:26024');
    expect(html).toContain(ORIGIN);
    expect(html).toContain('Host header');
  });

  test('escapes the echoed Host', async () => {
    const res = await guardDashboardRequest(
      projectRoot,
      new Request('http://127.0.0.1:26024/', { headers: { host: 'a<b' } }),
      HOST,
      ORIGIN,
    );
    expect(await res!.text()).not.toContain('a<b');
  });
});

describe('lazy doctor: Dashboard address', () => {
  const running = { running: true, webPort: 26024, bindHost: '127.0.0.1' };

  test('nothing to say when unset and the daemon serves the default', () => {
    expect(describeDashboardAddress('', { ...running, dashboardUrl: 'http://lazy.localhost:26024' })).toBeNull();
    expect(describeDashboardAddress('', null)).toBeNull();
  });

  // INVARIANT: a correct, applied dashboard_url is plain OK — not a warning.
  // Only a disagreement between lazy.toml and the running daemon is a finding;
  // yellow on a working setup teaches people to ignore the colour.
  test('says which origin links and sign-in use, and what is refused', () => {
    const result = describeDashboardAddress(ORIGIN, { ...running, dashboardUrl: ORIGIN })!;
    expect(result.ok).toBe(true);
    expect(statusOf(result)).toBe('ok');
    expect(result.warning).toBeUndefined();
    expect(result.label).toBe(
      `Dashboard address: ${ORIGIN} ([server] dashboard_url) — links and sign-in use it; http://lazy.localhost:26024 is refused`,
    );
  });

  test('a daemon that has not started yet is reported as pending', () => {
    const result = describeDashboardAddress(ORIGIN, { running: false })!;
    expect(result.ok).toBe(true);
    expect(result.label).toContain('takes effect when the daemon starts');
  });

  test('a daemon still serving another address fails with the restart remedy', () => {
    const result = describeDashboardAddress(ORIGIN, { ...running, dashboardUrl: 'http://lazy.localhost:26024' })!;
    expect(result.ok).toBe(false);
    expect(result.label).toBe('Dashboard address');
    expect(result.detail).toContain('http://lazy.localhost:26024');
    expect(result.detail).toContain('lazy daemon restart');
  });

  test('removing the setting without a restart is flagged too', () => {
    const result = describeDashboardAddress('', { ...running, dashboardUrl: ORIGIN })!;
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('no longer sets');
  });

  test('a managed daemon (dashboard off) is not second-guessed', () => {
    expect(describeDashboardAddress('', { ...running, dashboardUrl: null })).toBeNull();
  });
});

describe('dashboard_url placement and the one-line note', () => {
  test('finds dashboard_url in any table but [server]', () => {
    expect(misplacedDashboardUrlTables({ server: { dashboard_url: 'x' } })).toEqual([]);
    expect(misplacedDashboardUrlTables({ protection: { enabled: true, dashboard_url: 'x' } })).toEqual(['[protection]']);
    expect(misplacedDashboardUrlTables({ automation: { maintain: [{ title: 'a', dashboard_url: 'x' }] } }))
      .toEqual(['[[automation.maintain]]']);
    expect(misplacedDashboardUrlTables({ dashboard_url: 'x' })).toEqual(['the top level (before any [section])']);
    expect(misplacedDashboardUrlTables(null)).toEqual([]);
  });

  test('a misplaced key is reported ahead of drift, and only when [server] has none', () => {
    const status = { running: true, webPort: 26024, bindHost: '127.0.0.1', dashboardUrl: 'http://lazy.localhost:26024' };
    expect(compareDashboardAddress('', ['[remote]'], status)).toEqual({ kind: 'misplaced', tables: ['[remote]'] });
    expect(compareDashboardAddress(ORIGIN, ['[remote]'], { ...status, dashboardUrl: ORIGIN })).toBeNull();
  });

  // INVARIANT: the point of occurrence says ONE line and points at doctor,
  // which holds the diagnosis — never a paragraph at every command.
  test('every note is a single line that points at lazy doctor', () => {
    for (const problem of [
      { kind: 'misplaced' as const, tables: ['[remote]'] },
      { kind: 'drift' as const, configured: ORIGIN, served: 'http://lazy.localhost:26024' },
      { kind: 'drift' as const, configured: '', served: ORIGIN },
      { kind: 'unreadable' as const },
    ]) {
      const note = dashboardAddressNote(problem);
      expect(note).not.toContain('\n');
      expect(note).toContain('lazy doctor');
    }
  });

  test('doctor fails a misplaced key with the move-and-restart remedy', () => {
    const result = describeDashboardAddress('', { running: true, webPort: 26024, bindHost: '127.0.0.1', dashboardUrl: 'http://lazy.localhost:26024' }, ['[remote]'])!;
    expect(statusOf(result)).not.toBe('ok');
    expect(result.detail).toContain('[remote]');
    expect(result.detail).toContain('[server]');
  });
});
