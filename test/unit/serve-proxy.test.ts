import { describe, test, expect } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  upstreamRequestHeaders,
  stripDashboardCookie,
  downstreamResponseHeaders,
  stripCookieDomain,
  isNavigationRequest,
  relayableCloseCode,
} from '../../src/server/serve-proxy';
import {
  parseServeNotice,
  serveNoticePath,
  serveNoticeHtml,
} from '../../src/server/serve-notice';
import { DASHBOARD_COOKIE_NAME } from '../../src/daemon/dashboard-auth';

/**
 * The reverse proxy's header rewriting and its down case.
 *
 * Being the proxy is a powerful seat: everything that crosses between the
 * browser and a task's container passes through two functions, and this file
 * pins what each of them must do — most importantly what they must REFUSE to
 * carry in either direction.
 */

const SERVE_HOST = 'web.my-task.lazy.localhost:26024';

function proxied(headers: Record<string, string>, init: RequestInit = {}): Request {
  return new Request('http://web.my-task.lazy.localhost:26024/some/path', {
    ...init,
    headers: { host: SERVE_HOST, ...headers },
  });
}

describe('upstreamRequestHeaders', () => {
  // The single most load-bearing decision in the proxy: Vite and Rails admit
  // `.localhost` names by default, and rewriting Host to 127.0.0.1 is exactly
  // what makes a dev server answer "Blocked request".
  test('passes the Host header through unchanged', () => {
    const headers = upstreamRequestHeaders(proxied({}), '127.0.0.1');
    expect(headers.get('host')).toBe(SERVE_HOST);
  });

  // INVARIANT: the dashboard session never reaches a task container. The
  // browser will not send it (host-only cookie), so this is the second lock on
  // the same door — a change in cookie scoping elsewhere cannot open it.
  test('strips the dashboard session cookie and keeps the app’s own', () => {
    const headers = upstreamRequestHeaders(
      proxied({ cookie: `${DASHBOARD_COOKIE_NAME}=secret-session; _app_session=abc; theme=dark` }),
      '127.0.0.1',
    );
    const cookie = headers.get('cookie') ?? '';
    expect(cookie).not.toContain(DASHBOARD_COOKIE_NAME);
    expect(cookie).not.toContain('secret-session');
    expect(cookie).toContain('_app_session=abc');
    expect(cookie).toContain('theme=dark');
  });

  test('drops the cookie header entirely when only the dashboard session was on it', () => {
    const headers = upstreamRequestHeaders(
      proxied({ cookie: `${DASHBOARD_COOKIE_NAME}=secret-session` }),
      '127.0.0.1',
    );
    expect(headers.has('cookie')).toBe(false);
  });

  test('adds the forwarding headers', () => {
    const headers = upstreamRequestHeaders(proxied({}), '127.0.0.1');
    expect(headers.get('x-forwarded-for')).toBe('127.0.0.1');
    expect(headers.get('x-forwarded-proto')).toBe('http');
    expect(headers.get('x-forwarded-host')).toBe(SERVE_HOST);
  });

  test('omits X-Forwarded-For when the peer address is unknown', () => {
    const headers = upstreamRequestHeaders(proxied({}), null);
    expect(headers.has('x-forwarded-for')).toBe(false);
  });

  // A client does not get to describe its own provenance: we are the edge, so
  // an app that trusts X-Forwarded-For cannot be lied to through us.
  test('replaces client-supplied forwarding headers rather than appending to them', () => {
    const headers = upstreamRequestHeaders(
      proxied({
        'x-forwarded-for': '10.9.9.9',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'evil.example.com',
        forwarded: 'for=10.9.9.9;host=evil.example.com',
      }),
      '127.0.0.1',
    );
    expect(headers.get('x-forwarded-for')).toBe('127.0.0.1');
    expect(headers.get('x-forwarded-proto')).toBe('http');
    expect(headers.get('x-forwarded-host')).toBe(SERVE_HOST);
    expect(headers.has('forwarded')).toBe(false);
  });

  test('drops hop-by-hop headers', () => {
    const headers = upstreamRequestHeaders(
      proxied({ connection: 'keep-alive', 'keep-alive': 'timeout=5', te: 'trailers' }),
      '127.0.0.1',
    );
    expect(headers.has('connection')).toBe(false);
    expect(headers.has('keep-alive')).toBe(false);
    expect(headers.has('te')).toBe(false);
  });

  // Bun's fetch decompresses the body but leaves content-encoding on the
  // response, so asking upstream not to compress removes the ambiguity at the
  // source rather than trying to undo it afterwards.
  test('forces identity encoding whatever the browser asked for', () => {
    const headers = upstreamRequestHeaders(proxied({ 'accept-encoding': 'gzip, br' }), '127.0.0.1');
    expect(headers.get('accept-encoding')).toBe('identity');
  });

  test('carries ordinary application headers through untouched', () => {
    const headers = upstreamRequestHeaders(
      proxied({ authorization: 'Bearer app-token', 'x-csrf-token': 'abc', accept: 'application/json' }),
      '127.0.0.1',
    );
    expect(headers.get('authorization')).toBe('Bearer app-token');
    expect(headers.get('x-csrf-token')).toBe('abc');
    expect(headers.get('accept')).toBe('application/json');
  });
});

describe('stripDashboardCookie', () => {
  test('removes only the dashboard pair', () => {
    expect(stripDashboardCookie(`a=1; ${DASHBOARD_COOKIE_NAME}=x; b=2`)).toBe('a=1; b=2');
    expect(stripDashboardCookie(`${DASHBOARD_COOKIE_NAME}=x`)).toBe('');
    expect(stripDashboardCookie('a=1; b=2')).toBe('a=1; b=2');
  });

  // A cookie whose name merely CONTAINS the dashboard's is a different cookie
  // and belongs to the app.
  test('matches the whole name, not a prefix or suffix', () => {
    expect(stripDashboardCookie(`${DASHBOARD_COOKIE_NAME}_other=x`)).toBe(`${DASHBOARD_COOKIE_NAME}_other=x`);
    expect(stripDashboardCookie(`my_${DASHBOARD_COOKIE_NAME}=x`)).toBe(`my_${DASHBOARD_COOKIE_NAME}=x`);
  });

  test('tolerates the whitespace browsers actually send', () => {
    expect(stripDashboardCookie(`  ${DASHBOARD_COOKIE_NAME} = x ;  b=2`)).toBe('b=2');
  });

  // INVARIANT: the dashboard session cannot ride through on a FOLDED header.
  // Two `Cookie:` headers on one request are folded by Headers iteration into a
  // single `", "`-joined value, so the second cookie's name is not at a `;`
  // boundary. Splitting on `;` alone read `a=1, lazy_dashboard=x` as one pair
  // named `a` and forwarded the session verbatim.
  test('removes the dashboard pair hidden behind a comma fold', () => {
    expect(stripDashboardCookie(`a=1, ${DASHBOARD_COOKIE_NAME}=x`)).toBe('a=1');
    expect(stripDashboardCookie(`${DASHBOARD_COOKIE_NAME}=x, a=1`)).toBe('a=1');
    expect(stripDashboardCookie(`a=1, ${DASHBOARD_COOKIE_NAME}=x; b=2`)).toBe('a=1; b=2');
    expect(stripDashboardCookie(`a=1, ${DASHBOARD_COOKIE_NAME}=x, b=2`)).toBe('a=1, b=2');
  });

  // The flip side of the rule above: a comma is illegal in a cookie NAME but
  // apps do put them in VALUES, and a value we split and rejoined would arrive
  // changed. A segment nothing was dropped from is passed through untouched.
  test('leaves a comma-bearing value byte-for-byte alone', () => {
    expect(stripDashboardCookie('prefs=a,b,c')).toBe('prefs=a,b,c');
    expect(stripDashboardCookie(`prefs=a,b,c; ${DASHBOARD_COOKIE_NAME}=x`)).toBe('prefs=a,b,c');
  });
});

describe('downstreamResponseHeaders', () => {
  // INVARIANT: an app cannot widen its cookie onto the dashboard's host.
  // `Domain=lazy.localhost` from a task app would be sent to every task
  // subdomain AND the dashboard, which is both the cookie collision this
  // feature exists to end and a way to shadow the human's session.
  test('strips Domain from every upstream Set-Cookie', () => {
    const upstream = new Headers();
    upstream.append('set-cookie', 'app=1; Path=/; Domain=lazy.localhost; HttpOnly');
    upstream.append('set-cookie', `${DASHBOARD_COOKIE_NAME}=forged; Domain=lazy.localhost; Path=/`);
    const headers = downstreamResponseHeaders(upstream);

    const cookies = headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    for (const cookie of cookies) expect(cookie.toLowerCase()).not.toContain('domain=');
    expect(cookies[0]).toContain('app=1');
    expect(cookies[0]).toContain('HttpOnly');
  });

  // MEASURED: Bun's fetch decompresses the body but leaves content-encoding and
  // the now-wrong content-length on the response, so relaying either would tell
  // the browser to gunzip plaintext.
  test('drops content-encoding and content-length as a pair when upstream encoded', () => {
    const upstream = new Headers({
      'content-encoding': 'gzip',
      'content-length': '512',
      'content-type': 'text/html',
    });
    const headers = downstreamResponseHeaders(upstream);
    expect(headers.has('content-encoding')).toBe(false);
    expect(headers.has('content-length')).toBe(false);
    expect(headers.get('content-type')).toBe('text/html');
  });

  test('keeps content-length on an unencoded response', () => {
    const headers = downstreamResponseHeaders(new Headers({ 'content-length': '512' }));
    expect(headers.get('content-length')).toBe('512');
  });

  test('drops hop-by-hop headers', () => {
    const headers = downstreamResponseHeaders(
      new Headers({ connection: 'close', 'transfer-encoding': 'chunked', 'x-app': 'keep' }),
    );
    expect(headers.has('connection')).toBe(false);
    expect(headers.has('transfer-encoding')).toBe(false);
    expect(headers.get('x-app')).toBe('keep');
  });
});

describe('stripCookieDomain', () => {
  test('removes the Domain attribute wherever it sits', () => {
    expect(stripCookieDomain('a=1; Domain=lazy.localhost; Path=/')).toBe('a=1; Path=/');
    expect(stripCookieDomain('a=1; Path=/; domain=.lazy.localhost')).toBe('a=1; Path=/');
    expect(stripCookieDomain('a=1; DOMAIN = lazy.localhost')).toBe('a=1');
  });

  test('leaves a cookie without one alone', () => {
    expect(stripCookieDomain('a=1; Path=/; HttpOnly')).toBe('a=1; Path=/; HttpOnly');
  });

  // The VALUE may spell "domain" without the attribute being present.
  test('does not confuse a value for the attribute', () => {
    expect(stripCookieDomain('last_domain=lazy.localhost; Path=/')).toBe('last_domain=lazy.localhost; Path=/');
  });
});

describe('isNavigationRequest', () => {
  test('reads Sec-Fetch-Mode when the browser sent it', () => {
    expect(isNavigationRequest(proxied({ 'sec-fetch-mode': 'navigate' }))).toBe(true);
    expect(isNavigationRequest(proxied({ 'sec-fetch-mode': 'no-cors' }))).toBe(false);
    expect(isNavigationRequest(proxied({ 'sec-fetch-mode': 'cors' }))).toBe(false);
  });

  // An `<img>` on an HTML page still sends `Accept: image/*,*/*` — and Chrome
  // sends `Sec-Fetch-Mode: no-cors` for it — so the header wins over Accept.
  test('an asset request on an HTML page is not a navigation', () => {
    expect(isNavigationRequest(proxied({
      'sec-fetch-mode': 'no-cors',
      accept: 'image/avif,image/webp,*/*',
    }))).toBe(false);
    expect(isNavigationRequest(proxied({
      'sec-fetch-mode': 'cors',
      accept: 'text/html, application/json',
    }))).toBe(false);
  });

  test('falls back to Accept for a client that sends no Sec-Fetch-Mode', () => {
    expect(isNavigationRequest(proxied({ accept: 'text/html,application/xhtml+xml' }))).toBe(true);
    expect(isNavigationRequest(proxied({ accept: 'application/json' }))).toBe(false);
    expect(isNavigationRequest(proxied({}))).toBe(false);
  });

  // A redirect to an HTML page is only ever a sensible answer to a GET: a
  // browser would replay a POST body against the task page.
  test('is never true for a non-GET', () => {
    expect(isNavigationRequest(proxied({ 'sec-fetch-mode': 'navigate' }, { method: 'POST' }))).toBe(false);
    expect(isNavigationRequest(proxied({ accept: 'text/html' }, { method: 'HEAD' }))).toBe(false);
  });
});

describe('relayableCloseCode', () => {
  // 1005 and 1006 are LOCAL OBSERVATIONS a library reports to its own caller;
  // relaying one verbatim makes the other side's library throw instead of
  // closing (RFC 6455 §7.4.1).
  test('maps codes no endpoint may send onto 1000', () => {
    expect(relayableCloseCode(1005)).toBe(1000);
    expect(relayableCloseCode(1006)).toBe(1000);
    expect(relayableCloseCode(1015)).toBe(1000);
    expect(relayableCloseCode(0)).toBe(1000);
    expect(relayableCloseCode(1001)).toBe(1000);
  });

  test('relays normal closure and the application range', () => {
    expect(relayableCloseCode(1000)).toBe(1000);
    expect(relayableCloseCode(3000)).toBe(3000);
    expect(relayableCloseCode(4999)).toBe(4999);
    expect(relayableCloseCode(5000)).toBe(1000);
  });
});

describe('serve notice params', () => {
  test('round-trips through the path the proxy redirects to', () => {
    const url = new URL(`http://lazy.localhost:26024${serveNoticePath('abcdef12', 'web', 'not-listening')}`);
    expect(url.pathname).toBe('/tasks/abcdef12');
    expect(parseServeNotice(url)).toEqual({ service: 'web', reason: 'not-listening' });
  });

  test('is absent on an ordinary task page', () => {
    expect(parseServeNotice(new URL('http://lazy.localhost:26024/tasks/abcdef12'))).toBeNull();
  });

  // Both params are validated, not trusted: a hand-typed or hostile query
  // string cannot put arbitrary text on the task page, nor make the banner
  // claim a cause lazy never determined.
  test('refuses a made-up reason or a service that is not a host label', () => {
    const notice = (query: string) =>
      parseServeNotice(new URL(`http://lazy.localhost:26024/tasks/abcdef12?${query}`));
    expect(notice('serve=web&serve_reason=on-fire')).toBeNull();
    expect(notice('serve=web')).toBeNull();
    expect(notice('serve_reason=not-listening')).toBeNull();
    expect(notice('serve=<script>&serve_reason=not-listening')).toBeNull();
    expect(notice('serve=a.b&serve_reason=not-listening')).toBeNull();
  });
});

describe('serveNoticeHtml', () => {
  const task = { id: 'abcdef1234567890', code: 'my-task' };
  const controls = {
    taskId: 'abcdef1234567890',
    canStart: true,
    start: null,
    startServicesCmd: 'bin/dev',
    shellAvailable: true,
  };

  test('names what was opened and why, and offers the existing start controls', () => {
    const html = serveNoticeHtml(
      task,
      { service: 'web', reason: 'not-listening' },
      {
        declared: [{ name: 'web', port: 3000 }],
        services: [{ name: 'web', port: 3000, binding: null, url: null, publicUrl: null, listening: false }],
        unavailable: null,
        containerName: 'lazy-my-task',
        runnerType: 'docker',
      },
      controls,
      'http://web.my-task.lazy.localhost:26024',
    );
    expect(html).toContain('<code>web</code>');
    expect(html).toContain('<code>my-task</code>');
    expect(html).toContain('nothing is listening on port 3000');
    expect(html).toContain('Start container');
    expect(html).toContain('Start services');
    expect(html).toContain('Try again');
    expect(html).toContain('http://web.my-task.lazy.localhost:26024');
    expect(html).toContain('href="/tasks/my-task/services"');
    // Same in-place shell-mount convention as the Services card: the button
    // and its terminal slot share one data-lz-shell-step wrap so the reader
    // is never pulled onto the Shell tab.
    expect(html).toMatch(
      /<div[^>]*data-lz-shell-step[^>]*>[\s\S]*?data-lz-shell-run="bin\/dev"[\s\S]*?data-lz-shell-mount[^>]*>[\s\S]*?<\/div>/,
    );
  });

  // INVARIANT: this banner is reached by a GET, and every start on it is a POST
  // or a shell command the human presses. Nothing here is a link or an image
  // that starts something when the page merely renders.
  test('offers no GET that starts anything', () => {
    const html = serveNoticeHtml(task, { service: 'web', reason: 'not-running' }, null, controls);
    expect(html).toContain('<form method="POST" action="/tasks/abcdef1234567890/container/start"');
    expect(html).not.toMatch(/<a[^>]+href="[^"]*start/i);
    expect(html).not.toMatch(/<img/i);
  });

  test('omits the Start services button when there is no shell to run it in', () => {
    const html = serveNoticeHtml(task, { service: 'web', reason: 'not-running' }, null, {
      ...controls,
      shellAvailable: false,
    });
    expect(html).not.toContain('Start services');
  });

  test('escapes the task reference it renders', () => {
    const html = serveNoticeHtml(
      { id: 'abcdef1234567890', code: '<script>alert(1)</script>' },
      { service: 'web', reason: 'not-running' },
      null,
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

/**
 * INVARIANT: nothing on the proxy path starts a container or runs
 * `start_services_cmd`. A page anywhere on the internet can embed
 * `<img src="http://web.my-task.lazy.localhost:26024/x">`; a proxy that started
 * things would hand that page this machine's CPU and disk.
 *
 * A source scan rather than a behavioural test because the failure mode is a
 * future "while we're here" edit, not a bug in today's control flow — and it
 * costs nothing to keep the check honest on every run.
 */
describe('the proxy never starts anything', () => {
  /**
   * Everything that actually starts something, spelled as it appears in source.
   * `startContainerHtml` is deliberately NOT here: it emits the POST form, which
   * is the very control this invariant says a start must go through.
   */
  const FORBIDDEN = [
    'beginContainerStart',
    'createRunner',
    'spawn',
    'execFile',
    'runOneshot',
    'start_services_cmd',
    'getStartServicesCmd',
  ];

  test.each(['src/server/serve-proxy.ts', 'src/server/serve-notice.ts'])(
    '%s reaches no start path',
    async (file) => {
      const source = await readFile(join(import.meta.dir, '../..', file), 'utf-8');
      // Strip comments: both modules DISCUSS starting containers at length,
      // because explaining why they must not is the point. Only executable code
      // is the subject here.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
        .join('\n');

      for (const forbidden of FORBIDDEN) {
        expect(code).not.toContain(forbidden);
      }
    },
  );

  // The proxy has no business with the start module at all — the notice may
  // import its MARKUP, which is how the human gets a button to press.
  test('the proxy does not import the container-start module', async () => {
    const source = await readFile(join(import.meta.dir, '../../src/server/serve-proxy.ts'), 'utf-8');
    expect(source).not.toContain("from './container-start'");
  });
});
