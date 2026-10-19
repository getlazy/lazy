/**
 * The loopback half of `lazy login` for installs behind an authenticating proxy.
 *
 * WHY NOT THE DEVICE FLOW. The device flow has the CLI make anonymous requests
 * (ask for a code, poll for the token). Behind a proxy that verifies every
 * request, the CLI has nothing the proxy accepts until login has finished — so
 * those requests cannot be made at all. The browser can pass the proxy, so it
 * carries the result: the CLI listens on 127.0.0.1, opens the install's approval
 * page, and the page ends by POSTing the token (form body, never a URL) to
 * `http://127.0.0.1:<port>/callback`, where this listener receives it directly.
 *
 * What protects it:
 *   - The listener binds 127.0.0.1 only, on a port chosen by the OS before the
 *     browser is opened, so no other process can be sitting on it first.
 *   - `state` is 256 random bits the CLI chose; a callback with any other value
 *     is refused (400) and does NOT end the wait, so a stray or hostile request
 *     cannot cancel a login in progress.
 *   - The first valid callback wins and the listener closes: one delivery.
 *   - The token is never printed or logged, and is never in a URL: it arrives in a
 *     POST body, and the listener refuses a request whose Origin is not the install.
 *
 * PKCE is deliberately absent: it protects a code exchange, and there is none —
 * an exchange would be a request the proxy has to pass before a credential exists.
 */

import { randomBytes } from 'crypto';
import { TeamsRequestError } from './device-auth';

export interface LoopbackLoginResult {
  token: string;
  email: string;
}

export interface LoopbackLoginOptions {
  teamsUrl: string;
  deviceName: string;
  /** Called with the approval URL once the listener is ready. */
  onReady: (approvalUrl: string) => void | Promise<void>;
  /** Milliseconds to wait for the person. */
  timeoutMs?: number;
}

const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>lazy login</title>
<p style="font:16px system-ui;margin:3rem">Logged in. You can close this tab and return to your terminal.</p>`;

export function approvalUrlFor(teamsUrl: string, port: number, state: string, deviceName: string): string {
  const url = new URL('/cli/authorize', teamsUrl);
  url.searchParams.set('loopback_port', String(port));
  url.searchParams.set('state', state);
  url.searchParams.set('device_name', deviceName);
  return url.toString();
}

export async function loopbackLogin(opts: LoopbackLoginOptions): Promise<LoopbackLoginResult> {
  const state = randomBytes(32).toString('base64url');
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;

  let settle!: (value: LoopbackLoginResult | Error) => void;
  const outcome = new Promise<LoopbackLoginResult | Error>((resolve) => { settle = resolve; });

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      // POST ONLY: the token rides in the request body, never a URL that
      // history, extensions, proxies or logs would keep.
      if (req.method !== 'POST' || url.pathname !== '/callback') {
        return new Response('Not found', { status: 404 });
      }
      // A browser form post names the page it came from. Anything claiming to be
      // from somewhere other than the install is not the approval page.
      // `null` is allowed because the approval page sends no-referrer, which makes
      // some browsers send `Origin: null` on a cross-origin form post. Neither this
      // nor the state proves WHICH install approved: a look-alike can relay the
      // state to the real install's page. That is decided after the callback, by
      // the token's `iss` (assertTokenIssuedBy, ./token-origin.ts).
      const origin = req.headers.get('origin');
      if (origin && origin !== 'null' && origin !== new URL(opts.teamsUrl).origin) {
        return new Response('Not from the install this login is waiting on.', { status: 403 });
      }
      const form = new URLSearchParams(await req.text());
      if (form.get('state') !== state) {
        return new Response('This login link does not belong to the lazy login waiting here.', { status: 400 });
      }
      if (form.get('error') === 'denied') {
        settle(new TeamsRequestError('The login was denied in the browser. Run `lazy login` again if that was a mistake.'));
        return new Response(DONE_PAGE.replace('Logged in.', 'Login denied.'), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        });
      }
      const token = form.get('token');
      if (!token) return new Response('The install returned no token.', { status: 400 });

      settle({ token, email: form.get('email') || 'your account' });
      return new Response(DONE_PAGE, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
      });
    },
  });

  const timer = setTimeout(
    () => settle(new TeamsRequestError('Nobody approved this login before it timed out. Run `lazy login` again.')),
    timeoutMs,
  );

  try {
    if (server.port === undefined) throw new TeamsRequestError('Could not open a local port to receive the login on 127.0.0.1.');
    await opts.onReady(approvalUrlFor(opts.teamsUrl, server.port, state, opts.deviceName));
    const result = await outcome;
    // Let the browser's response flush before the caller exits the process.
    await new Promise((r) => setTimeout(r, 150));
    if (result instanceof Error) throw result;
    return result;
  } finally {
    clearTimeout(timer);
    // After the response flushes: closing at once can cut the page the browser is about to show.
    setTimeout(() => server.stop(true), 250);
  }
}

/** How `lazy login` should proceed against this install. */
export type LoginMode = 'device' | 'loopback';

/**
 * Ask the install which login it wants — the install's CONFIGURATION decides,
 * never a guess from how some other request failed. An install old enough not to
 * serve the document (404) is a device-flow install.
 */
export async function discoverLoginMode(
  teamsUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<LoginMode> {
  const { authProxyMessage, gatherProxyEvidence, looksLikeAuthProxy, redirectMessage } = await import('./auth-proxy');
  const url = `${teamsUrl}/.well-known/lazy-teams`;
  let response: Response;
  try {
    response = await fetcher(url, { headers: { accept: 'application/json' }, redirect: 'manual' });
  } catch (err) {
    throw new TeamsRequestError(
      `Could not reach ${teamsUrl}: ${err instanceof Error ? err.message : String(err)}\n` +
      `Check the address and that you can reach the install from this machine.`,
    );
  }
  if (response.status === 404) return 'device';
  const moved = redirectMessage(teamsUrl, response);
  if (moved) throw new TeamsRequestError(moved, response.status);

  const evidence = await gatherProxyEvidence(response.clone());
  const text = await response.text();
  try {
    const body = JSON.parse(text) as { login?: unknown };
    if (body.login === 'loopback') return 'loopback';
    if (body.login === 'device') return 'device';
  } catch {
    // Not JSON: decided below, by what kind of non-JSON it was.
  }
  if (looksLikeAuthProxy(evidence, url)) {
    throw new TeamsRequestError(authProxyMessage(url, evidence), response.status);
  }
  throw new TeamsRequestError(
    `${url} answered ${response.status} with something that is not JSON. ` +
    `Check the address — it should be the root of a Lazy Teams install, e.g. https://teams.example.com`,
    response.status,
  );
}
