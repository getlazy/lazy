/**
 * The task-service reverse proxy end to end:
 * `http://<service>.<task>.lazy.localhost:<dashboard port>` → the container port
 * `[serve]` published.
 *
 * Everything under test here is real — the daemon's listener, host parsing,
 * target resolution through `getTaskServeState`, header rewriting, the streamed
 * body, the WebSocket pump, the down page. Two things are pretend, and both are
 * the CONTAINER RUNTIME rather than any part of lazy:
 *
 *   - `docker` is a script on the daemon's PATH answering `ps` and `port` from
 *     a state directory this suite writes (the same fake `test/e2e/url.test.ts`
 *     uses), so the port MAPPING is produced by a real `docker port` parse.
 *   - `LAZY_MOCK_RUNNING_CONTAINERS` points the harness mock's
 *     `isContainerRunning` at that same state directory, so "is it up?" and
 *     "what does it publish?" cannot disagree.
 *
 * Behind the mapping is an ordinary `Bun.serve` standing in for the app inside
 * the container. It is on 127.0.0.1 like a published port is, so the proxy
 * reaches it exactly as it reaches a real one.
 *
 * NOTE ON HOSTNAMES: like test/helpers/dashboard-session.ts, every request here
 * TRANSPORTS to 127.0.0.1 while sending the `Host` header a browser would send.
 * Chromium and Firefox resolve `*.localhost` themselves; a test process may not
 * (glibc does not), and the daemon routes on the Host header regardless.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import type { Server, ServerWebSocket } from 'bun';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { checkDaemonHealth } from '../../src/daemon';
import { DASHBOARD_COOKIE_NAME } from '../../src/daemon/dashboard-auth';
import {
  dashboardFetch,
  mintDashboardLoginUrl,
  signInToDashboard,
} from '../helpers/dashboard-session';

/**
 * A `docker` that answers only what discovery asks — `ps` (is it running?) and
 * `port` (what does it publish?) — from a state directory the test writes.
 *
 * It also LOGS every invocation, which is what proves the no-auto-start
 * invariant: after a browser has hit a dead service, no `run`, `start`, `create`
 * or `exec` may appear in that log.
 */
const FAKE_DOCKER = `#!/usr/bin/env bash
set -uo pipefail
STATE="__STATE_DIR__"
echo "\$@" >> "\$STATE/log"
case "\${1:-}" in
  ps)
    if [ -f "\$STATE/running" ]; then echo "deadbeef1234"; fi
    exit 0
    ;;
  port)
    cat "\$STATE/ports" 2>/dev/null
    exit 0
    ;;
  info) exit 0 ;;
esac
exit 0
`;

/** Reject rather than hang: a proxy that buffers would otherwise stall a read forever. */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms)),
  ]);
}

describe('serve proxy', () => {
  let ctx: TestContext;
  let fakeRoot: string;
  let binDir: string;
  let stateDir: string;
  let webPort: number;

  /** The app inside the "container". */
  let upstream: Server<unknown>;
  /** Resolved by the test once it has seen the first chunk of /stream. */
  let releaseStream: () => void;

  beforeEach(async () => {
    fakeRoot = await mkdtemp(join(tmpdir(), 'lazy-serve-proxy-'));
    binDir = join(fakeRoot, 'bin');
    stateDir = join(fakeRoot, 'state');
    await mkdir(binDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    const script = join(binDir, 'docker');
    await writeFile(script, FAKE_DOCKER.replace('__STATE_DIR__', stateDir));
    await chmod(script, 0o755);

    upstream = startUpstream();

    // The daemon resolves the proxy target itself, so the fake runtime has to be
    // on ITS PATH — and known before it starts.
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: {
        PATH: `${binDir}:${process.env.PATH}`,
        LAZY_MOCK_RUNNING_CONTAINERS: join(stateDir, 'running'),
      },
    });

    const health = await checkDaemonHealth(ctx.root);
    expect(health.webPort).toBeGreaterThan(0);
    webPort = health.webPort!;
  });

  afterEach(async () => {
    upstream.stop(true);
    await ctx.cleanup();
    await rm(fakeRoot, { recursive: true, force: true });
  });

  /** The app the container "runs": enough routes to exercise every path the proxy has. */
  function startUpstream(): Server<unknown> {
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    return Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req, server): Response | undefined {
        const url = new URL(req.url);

        if (url.pathname === '/ws') {
          if (server.upgrade(req, { data: undefined })) return undefined;
          return new Response('expected a websocket upgrade', { status: 400 });
        }

        // Everything the app was told about this request, back as JSON.
        if (url.pathname === '/echo') {
          return Response.json({
            method: req.method,
            target: url.pathname + url.search,
            headers: Object.fromEntries(req.headers.entries()),
          });
        }

        // Two chunks, the second gated on the test having READ the first. A
        // proxy that buffers the response never delivers the first chunk, so
        // the gate never opens and the read times out.
        if (url.pathname === '/stream') {
          const encoder = new TextEncoder();
          return new Response(
            new ReadableStream({
              async start(controller) {
                controller.enqueue(encoder.encode('part1'));
                await streamGate;
                controller.enqueue(encoder.encode('part2'));
                controller.close();
              },
            }),
            { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
          );
        }

        // An app with a framing policy of its own to defend.
        if (url.pathname === '/csp') {
          return new Response('ok', {
            headers: { 'Content-Security-Policy': "frame-ancestors 'self'" },
          });
        }

        // An app trying (or being tricked into) widening its cookie to the whole
        // dashboard suffix.
        if (url.pathname === '/cookie') {
          return new Response('ok', {
            headers: { 'Set-Cookie': 'app=1; Domain=lazy.localhost; Path=/' },
          });
        }

        if (url.pathname === '/upload') {
          return new Response(req.body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
        }

        return new Response(`upstream saw ${url.pathname}`);
      },
      websocket: {
        message(ws: ServerWebSocket<unknown>, message: string | Buffer) {
          ws.send(`echo:${typeof message === 'string' ? message : message.toString()}`);
        },
      },
    });
  }

  /** Append a [serve] section to the project's lazy.toml (the template has none). */
  async function declareServe(section: string): Promise<void> {
    const path = join(ctx.root, 'lazy.toml');
    const before = await readFile(path, 'utf-8');
    await writeFile(path, `${before}\n${section}\n`);
  }

  /** Pretend the task's container is up and publishing these mappings. */
  async function publish(lines: string[]): Promise<void> {
    await writeFile(join(stateDir, 'running'), '');
    await writeFile(join(stateDir, 'ports'), lines.join('\n') + '\n');
  }

  /** Container up, `web` mapped to the stand-in app. Returns the task's short id. */
  async function liveTask(goal = 'Proxied task'): Promise<string> {
    await declareServe('[serve.services]\nweb = 3000');
    const taskId = await createTask(ctx, goal);
    await publish([`3000/tcp -> 127.0.0.1:${upstream.port}`]);
    return taskId;
  }

  function serveHost(task: string, service = 'web'): string {
    return `${service}.${task}.lazy.localhost:${webPort}`;
  }

  /** A browser request to a task subdomain, sent to the address the daemon bound. */
  function proxyFetch(
    task: string,
    path: string,
    init: RequestInit & { headers?: Record<string, string>; service?: string } = {},
  ): Promise<Response> {
    const { service = 'web', headers = {}, ...rest } = init;
    return fetch(`http://127.0.0.1:${webPort}${path}`, {
      ...rest,
      headers: { host: serveHost(task, service), ...headers },
    });
  }

  /** What the app was told about a request, as JSON. */
  async function echoOf(task: string, init?: Parameters<typeof proxyFetch>[2]) {
    const res = await proxyFetch(task, '/echo', init);
    expect(res.status).toBe(200);
    return (await res.json()) as { method: string; target: string; headers: Record<string, string> };
  }

  /** Every `docker` invocation the daemon made, one per line. */
  async function dockerLog(): Promise<string[]> {
    const raw = await readFile(join(stateDir, 'log'), 'utf-8').catch(() => '');
    return raw.split('\n').filter(Boolean);
  }

  // --- The happy path -----------------------------------------------------

  test('a request to a task subdomain comes back with the app’s own bytes', async () => {
    const taskId = await liveTask();

    // No cookie, no session: a task's app is unauthenticated on its published
    // port today, and giving it a name does not change who may open it.
    const res = await proxyFetch(taskId, '/hello?x=1');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('upstream saw /hello');

    const echo = await echoOf(taskId);
    expect(echo.target).toBe('/echo');
  });

  // A dev server decides what it serves from the Host it was asked for, and
  // rewriting it to 127.0.0.1 is precisely what breaks Vite and Rails.
  test('the Host header reaches the app unchanged', async () => {
    const taskId = await liveTask();
    const echo = await echoOf(taskId);
    expect(echo.headers.host).toBe(serveHost(taskId));
  });

  test('the app is told who is really calling', async () => {
    const taskId = await liveTask();
    const echo = await echoOf(taskId, {
      // A client asserting its own provenance. The proxy is the only thing
      // entitled to say this, so the spoof must not survive.
      headers: { 'x-forwarded-for': '203.0.113.9', forwarded: 'for=203.0.113.9' },
    });

    expect(echo.headers['x-forwarded-for']).toBe('127.0.0.1');
    expect(echo.headers['x-forwarded-proto']).toBe('http');
    expect(echo.headers['x-forwarded-host']).toBe(serveHost(taskId));
    expect(echo.headers.forwarded).toBeUndefined();
  });

  // INVARIANT: the dashboard's session cookie never leaves the dashboard host.
  // It is the key to a root shell in every task container, and the app on the
  // other side of this proxy is agent-written code.
  test('the dashboard session cookie is stripped, and the app’s own cookies are not', async () => {
    const taskId = await liveTask();
    const { cookie } = await signInToDashboard(ctx);

    const echo = await echoOf(taskId, {
      headers: { cookie: `${cookie}; app_pref=dark` },
    });

    expect(echo.headers.cookie).toBe('app_pref=dark');
    expect(echo.headers.cookie).not.toContain(DASHBOARD_COOKIE_NAME);
  });

  // The other half of the same invariant, at the source: a `Domain=` attribute
  // would send the session to every task subdomain — that is, into agent-written
  // code — on every request.
  test('the dashboard cookie is host-only', async () => {
    const { loginUrl } = await mintDashboardLoginUrl(ctx);
    const res = await dashboardFetch(loginUrl, { redirect: 'manual' });
    expect(res.status).toBe(302);

    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${DASHBOARD_COOKIE_NAME}=`);
    expect(setCookie.toLowerCase()).not.toContain('domain=');
  });

  // Cookie SHADOWING, the reverse direction: an app that sets a cookie for the
  // whole suffix would have it sent to the dashboard too, where a name collision
  // is a session the human never created.
  test('an app cannot widen its cookie to the dashboard host', async () => {
    const taskId = await liveTask();

    const res = await proxyFetch(taskId, '/cookie');
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('app=1');
    expect(setCookie.toLowerCase()).not.toContain('domain=');
    // The rest of the cookie survives — only the scope is narrowed.
    expect(setCookie).toContain('Path=/');
  });

  test('the response body is streamed, not buffered', async () => {
    const taskId = await liveTask();

    const res = await proxyFetch(taskId, '/stream');
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // The app is still holding the response open at this point.
    const first = await withTimeout(reader.read(), 5_000, 'the first chunk of a streamed response');
    expect(decoder.decode(first.value)).toBe('part1');

    releaseStream();
    const second = await withTimeout(reader.read(), 5_000, 'the second chunk');
    expect(decoder.decode(second.value)).toBe('part2');
    reader.releaseLock();
  }, 20_000);

  test('a request body is forwarded', async () => {
    const taskId = await liveTask();
    const res = await proxyFetch(taskId, '/upload', { method: 'POST', body: 'payload-from-browser' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('payload-from-browser');
  });

  // HMR and ActionCable are why this exists: a dev server that cannot hold a
  // socket open is a dev server nobody can use through the proxy.
  test('a WebSocket round-trips through the proxy', async () => {
    const taskId = await liveTask();

    // Bun's client takes an options object; the ambient DOM type in scope only
    // declares the `protocols` overload, so the shape is asserted (same cast
    // src/server/serve-proxy.ts uses for the upstream side).
    const options = { headers: { host: serveHost(taskId) } } as unknown as string[];
    const ws = new WebSocket(`ws://127.0.0.1:${webPort}/ws`, options);

    const echoed = new Promise<string>((resolve, reject) => {
      ws.addEventListener('message', (event) => resolve(String(event.data)));
      ws.addEventListener('error', () => reject(new Error('proxied WebSocket errored')));
      ws.addEventListener('close', (event) =>
        reject(new Error(`proxied WebSocket closed before echoing (${event.code})`)));
    });

    await withTimeout(
      new Promise<void>((resolve, reject) => {
        ws.addEventListener('open', () => resolve());
        ws.addEventListener('error', () => reject(new Error('proxied WebSocket failed to open')));
      }),
      10_000,
      'the proxied WebSocket to open',
    );
    ws.send('ping');
    expect(await withTimeout(echoed, 10_000, 'the echoed frame')).toBe('echo:ping');
    ws.close();
  }, 30_000);

  // --- Nothing there ------------------------------------------------------

  test('a navigation to a down container lands on the task page', async () => {
    await declareServe('[serve.services]\nweb = 3000');
    const taskId = await createTask(ctx, 'Container down');

    const res = await proxyFetch(taskId, '/', {
      headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get('location')!);
    expect(location.host).toBe(`lazy.localhost:${webPort}`);
    // The daemon's own resolved id, which the short id from `lazy create` prefixes.
    expect(location.pathname.startsWith(`/tasks/${taskId}`)).toBe(true);
    expect(location.searchParams.get('serve')).toBe('web');
    expect(location.searchParams.get('serve_reason')).toBe('not-running');
    // The state that produced it changes without warning.
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  // Redirecting an image or an XHR to an HTML page hands a JSON parser a chunk
  // of markup and reports the problem somewhere far from its cause.
  test('an asset request to a down container gets a plain 502', async () => {
    await declareServe('[serve.services]\nweb = 3000');
    const taskId = await createTask(ctx, 'Container down for assets');

    const res = await proxyFetch(taskId, '/app.js', {
      headers: { 'sec-fetch-mode': 'no-cors', accept: '*/*' },
      redirect: 'manual',
    });
    expect(res.status).toBe(502);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toContain('is not running');
  });

  // Published, but the dev server inside was never started — the commonest
  // version of "nothing answers", and the one a raw loopback port reported as a
  // bare connection refused.
  test('a published port with nothing behind it says so', async () => {
    await declareServe('[serve.services]\nweb = 3000');
    const taskId = await createTask(ctx, 'Nothing listening');
    const dead = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    const deadPort = dead.port;
    dead.stop(true);
    await publish([`3000/tcp -> 127.0.0.1:${deadPort}`]);

    const res = await proxyFetch(taskId, '/', {
      headers: { 'sec-fetch-mode': 'navigate' },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).searchParams.get('serve_reason')).toBe('not-listening');
  });

  // A name nobody owns is not a task in a bad state — it is a wrong address, and
  // redirecting it to a task page would be a lie about which task.
  test('an unknown task is a 404, even for a navigation', async () => {
    const res = await proxyFetch('zzzzzzzz', '/', {
      headers: { 'sec-fetch-mode': 'navigate' },
      redirect: 'manual',
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('no task matches');
  });

  test('the dashboard itself still answers on its own host', async () => {
    const { base, fetch: signedIn } = await signInToDashboard(ctx);
    const res = await signedIn(`${base}/tasks`);
    expect(res.status).toBe(200);
  });

  // --- Framing ------------------------------------------------------------

  /**
   * INVARIANT: the dashboard cannot be framed, and a task's app is left alone.
   *
   * A task app is same-site with the dashboard, so `SameSite=Strict` does not
   * stop the browser attaching the session to a framed dashboard page — and a
   * POST fired from inside that frame is from the dashboard's own origin, which
   * the cross-origin guard passes. Overlay the frame and one human click starts
   * a container. The headers are stamped in one place on the dashboard's
   * response path (src/daemon/dashboard-auth.ts), which sits BELOW the proxy.
   */
  test('every dashboard response refuses to be framed', async () => {
    const { base, fetch: signedIn } = await signInToDashboard(ctx);

    const signedOut = await dashboardFetch(`${base}/tasks`);
    expect(signedOut.status).toBe(401);
    expect(signedOut.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(signedOut.headers.get('x-frame-options')).toBe('DENY');

    const page = await signedIn(`${base}/tasks`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(page.headers.get('x-frame-options')).toBe('DENY');
  }, 20_000);

  // The other half: an app's pages are its own to frame, and its own policy is
  // not the proxy's to edit.
  test('a proxied response gets neither header, and keeps its own', async () => {
    const taskId = await liveTask();

    const plain = await proxyFetch(taskId, '/hello');
    expect(plain.status).toBe(200);
    expect(plain.headers.get('content-security-policy')).toBeNull();
    expect(plain.headers.get('x-frame-options')).toBeNull();

    const withPolicy = await proxyFetch(taskId, '/csp');
    expect(withPolicy.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
    expect(withPolicy.headers.get('x-frame-options')).toBeNull();
  });

  // --- The task page the down case lands on -------------------------------

  test('the task page explains what was opened and offers the buttons that fix it', async () => {
    await declareServe('[serve.services]\nweb = 3000');
    const taskId = await createTask(ctx, 'Banner task');
    const { base, fetch: signedIn } = await signInToDashboard(ctx);

    const redirect = await proxyFetch(taskId, '/', {
      headers: { 'sec-fetch-mode': 'navigate' },
      redirect: 'manual',
    });
    expect(redirect.status).toBe(302);

    // Follow it exactly as the browser would — same path, same query.
    const location = new URL(redirect.headers.get('location')!);
    const fullId = location.pathname.slice('/tasks/'.length);
    const page = await signedIn(`${base}${location.pathname}${location.search}`);
    expect(page.status).toBe(200);
    const html = await page.text();

    expect(html).toContain('lz-serve-notice');
    expect(html).toContain('You opened');
    expect(html).toContain('<code>web</code>');
    expect(html).toContain('the container is not running');
    // The existing Start container control, unchanged — and a POST.
    expect(html).toContain(`<form method="POST" action="/tasks/${fullId}/container/start"`);
    // Back to where they came from, composed from the task's own labels.
    expect(html).toContain(`http://web.${taskId}.lazy.localhost:${webPort}`);
    expect(html).toContain('Try again');
  }, 20_000);

  // The Services card is the other surface that names a task's services, and it
  // must agree with `lazy url` about which URL is the primary one.
  test('the Services card shows the subdomain URL for a live service', async () => {
    const taskId = await liveTask('Card task');
    const { base, fetch: signedIn } = await signInToDashboard(ctx);

    // The card lives on the Services tab — the tabbed task page moved it off
    // Landing, and this assertion had been failing against the task root ever
    // since (verified against the branch base, not introduced here).
    const page = await signedIn(`${base}/tasks/${taskId}/services`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<strong>Services</strong>');
    expect(html).toContain(`http://web.${taskId}.lazy.localhost:${webPort}`);
  }, 20_000);

  // --- The invariant ------------------------------------------------------

  /**
   * INVARIANT: nothing on the proxy path starts a container or runs
   * `start_services_cmd`. A GET that started a container would be a CSRF vector
   * — any page anywhere could embed `<img src="http://web.my-task.lazy.localhost:26024">`
   * and spend the human's machine — and it would make an idle tab on a reload
   * timer into a resource bomb. Every start is a POST behind a button.
   *
   * Proved against the runtime rather than the source: whatever the code does,
   * the only `docker` verbs it may have reached for here are the read-only ones.
   */
  test('nothing on the proxy path starts anything', async () => {
    await declareServe('[serve]\nports = [3000]\nstart_services_cmd = "bin/dev"');
    const taskId = await createTask(ctx, 'No auto start');

    await proxyFetch(taskId, '/', { headers: { 'sec-fetch-mode': 'navigate' }, redirect: 'manual', service: '3000' });
    await proxyFetch(taskId, '/app.js', { headers: { 'sec-fetch-mode': 'no-cors' }, service: '3000' });
    await proxyFetch(taskId, '/', { method: 'POST', body: 'x', service: '3000' });

    const invocations = await dockerLog();
    // The fake is only ever asked to look.
    for (const line of invocations) {
      expect(line.split(' ')[0]).toMatch(/^(ps|port|info|inspect|version)$/);
    }
    expect(invocations.some((l) => l.startsWith('run') || l.startsWith('start') || l.startsWith('exec'))).toBe(false);
  });
});
