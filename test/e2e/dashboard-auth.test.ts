/**
 * The web dashboard's sign-in gate, end to end through a real daemon.
 *
 * WHY THIS SUITE EXISTS. The daemon serves `/rpc`, `/mcp` and the dashboard on
 * ONE TCP port, and task containers are started with
 * `--add-host=host.docker.internal:host-gateway` so they can reach it for MCP.
 * While the dashboard was unauthenticated, that meant any agent in any task
 * container could GET the whole task list and POST accept/unblock/close — this
 * was confirmed by curl from inside a container, not inferred. The gate is what
 * closes that, so every assertion here is about a real HTTP request against a
 * real daemon: an in-process call would skip the code under test.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';
import { signInToDashboard, mintDashboardLoginUrl, dashboardFetch } from '../helpers/dashboard-session';
import { DASHBOARD_HOSTNAME, formatDashboardUrl } from '../../src/daemon/dashboard-url';
import { storageDirFor } from '../helpers/storage';
import { checkDaemonHealth } from '../../src/daemon';
import { DaemonClient } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { readFile, writeFile } from 'fs/promises';

describe('dashboard authentication', () => {
  let ctx: TestContext;
  let base: string;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    const health = await checkDaemonHealth(ctx.root);
    expect(health.webPort).toBeGreaterThan(0);
    base = `http://${DASHBOARD_HOSTNAME}:${health.webPort}`;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // The core of the vulnerability this task closes: an unauthenticated caller
  // (a task container, a browser on the machine, anything that can reach the
  // port) must learn nothing beyond "a lazy daemon is here" — which the open
  // port already told it.
  test('an unauthenticated visitor gets the sign-in page and no data', async () => {
    const taskId = await createTask(ctx, 'Secret goal nobody should read', 'Secret prompt');

    for (const path of ['/', '/tasks', `/tasks/${taskId}`, `/review/${taskId}`, '/raised']) {
      const res = await dashboardFetch(`${base}${path}`);
      expect(res.status).toBe(401);
      const html = await res.text();
      expect(html).toContain('lazy dashboard');
      expect(html).not.toContain(taskId);
      expect(html).not.toContain('Secret goal');
      expect(html).not.toContain(ctx.root);
    }
  });

  test('unauthenticated JSON routes return 401 with the same instruction', async () => {
    const taskId = await createTask(ctx, 'Another secret goal');

    const res = await dashboardFetch(`${base}/api/tasks`);
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('lazy dashboard');
    expect(JSON.stringify(body)).not.toContain(taskId);
  });

  test('`lazy dashboard --print` prints a one-time login URL', async () => {
    const result = await ctx.lazy(['dashboard', '--print']);
    expectSuccess(result);
    const printed = result.stdout.trim();
    expect(printed).toMatch(/^https?:\/\//);
    expect(printed).toContain('lazy_login=');
    // On the dashboard's own hostname — the only host the gate accepts.
    expect(new URL(printed).hostname).toBe(DASHBOARD_HOSTNAME);
    // --print is machine-facing: the URL alone, so it composes in a shell.
    expect(printed.split('\n')).toHaveLength(1);
  });

  // INVARIANT: /daemon/status carries dashboardUrl so the builder prompt and
  // lazy_status do not re-derive it. Same address as formatDashboardUrl.
  test('/daemon/status reports dashboardUrl when the dashboard is on', async () => {
    const health = await checkDaemonHealth(ctx.root);
    expect(health.running).toBe(true);
    expect(health.webPort).toBeGreaterThan(0);
    expect(health.dashboardUrl).toBe(formatDashboardUrl(health.bindHost, health.webPort!));
  });

  test('a configured reverse-proxy origin is reported and accepted by the real daemon', async () => {
    expectSuccess(await ctx.lazy(['daemon', 'stop']));
    const configPath = `${ctx.root}/lazy.toml`;
    const config = await readFile(configPath, 'utf-8');
    await writeFile(
      configPath,
      config.replace('[server]\n', '[server]\ndashboard_url = "https://example.ngrok.app"\n'),
    );
    expectSuccess(await ctx.lazy(['daemon', 'start']));

    const health = await checkDaemonHealth(ctx.root);
    expect(health.dashboardUrl).toBe('https://example.ngrok.app');

    const printed = await ctx.lazy(['dashboard', '--print']);
    expectSuccess(printed);
    const loginUrl = new URL(printed.stdout.trim());
    expect(loginUrl.origin).toBe('https://example.ngrok.app');

    // Emulate an HTTPS-terminating proxy: connect to the daemon locally while
    // preserving the public Host header. The daemon must redeem the link for
    // that host and mark its browser session cookie Secure.
    const directUrl = new URL(loginUrl);
    directUrl.protocol = 'http:';
    directUrl.hostname = '127.0.0.1';
    directUrl.port = String(health.webPort);
    const redeemed = await fetch(directUrl, {
      redirect: 'manual',
      headers: { host: 'example.ngrok.app' },
    });
    expect(redeemed.status).toBe(302);
    expect(redeemed.headers.get('set-cookie')).toContain('Secure');
  });

  test('signing in unlocks the dashboard', async () => {
    const taskId = await createTask(ctx, 'Visible once signed in');
    const { fetch } = await signInToDashboard(ctx);

    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);

    const api = await fetch(`${base}/api/tasks`);
    expect(api.status).toBe(200);
    expect(await api.text()).toContain(taskId);
  });

  // A login link is a bearer secret in a URL — it ends up in shell history and
  // scrollback. Single use bounds what a leaked one is worth, and the redirect
  // keeps it out of the address bar.
  test('a login link works once and is refused the second time', async () => {
    const { loginUrl } = await mintDashboardLoginUrl(ctx);

    const first = await dashboardFetch(loginUrl, { redirect: 'manual' });
    expect(first.status).toBe(302);
    const cookie = first.headers.get('set-cookie');
    expect(cookie).toContain('lazy_dashboard=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    // The browser must land on a URL with no secret in it.
    expect(first.headers.get('location')).not.toContain('lazy_login');

    const second = await dashboardFetch(loginUrl, { redirect: 'manual' });
    expect(second.status).toBe(401);
    expect(second.headers.get('set-cookie')).toBeNull();
    expect(await second.text()).toContain('lazy dashboard');
  });

  test('a made-up login ticket is refused', async () => {
    const res = await dashboardFetch(`${base}/?lazy_login=deadbeef`, { redirect: 'manual' });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  // Sessions live in the daemon's runtime state, not in memory: being asked to
  // sign in again after every `lazy daemon restart` would be its own reason to
  // turn the dashboard off.
  test('a session survives a daemon restart', async () => {
    const { fetch } = await signInToDashboard(ctx);
    expect((await fetch(`${base}/`)).status).toBe(200);

    expectSuccess(await ctx.lazy(['daemon', 'restart']));
    const health = await checkDaemonHealth(ctx.root);
    expect(health.running).toBe(true);
    const after = `http://${DASHBOARD_HOSTNAME}:${health.webPort}`;

    const res = await fetch(`${after}/`);
    expect(res.status).toBe(200);
  });

  // INVARIANT: the dashboard answers on ONE hostname, and a session is neither
  // accepted nor minted on any other.
  //
  // WHY THIS IS SECURITY, not tidiness: browser cookies are scoped by HOST and
  // not by port, and `[serve]` publishes every task's app ports on 127.0.0.1
  // (SERVE_BIND_HOST). If a dashboard session were valid at
  // `http://127.0.0.1:<daemonPort>`, then the operator opening a task's app at
  // `http://127.0.0.1:3000` would hand that session to code the AGENT wrote,
  // running in a container that can already reach the daemon over
  // host.docker.internal. The separate hostname is what keeps the two cookie
  // jars apart, and these two tests are what keep the separation real.
  test('a valid session cookie is refused when presented on 127.0.0.1', async () => {
    const { cookie } = await signInToDashboard(ctx);
    const health = await checkDaemonHealth(ctx.root);

    // Deliberately the GLOBAL fetch: it sends `Host: 127.0.0.1:<port>`, which
    // is exactly what a browser sends when the operator types that address.
    const res = await fetch(`http://127.0.0.1:${health.webPort}/api/tasks`, {
      headers: { cookie },
    });
    expect(res.status).toBe(421);
    expect(JSON.stringify(await res.json())).toContain('lazy.localhost');
  });

  test('a login ticket redeemed on 127.0.0.1 mints nothing, and is not spent', async () => {
    const { base, loginUrl } = await mintDashboardLoginUrl(ctx);
    const wrongHost = new URL(loginUrl);
    wrongHost.hostname = '127.0.0.1';

    const refused = await fetch(wrongHost, { redirect: 'manual' });
    expect(refused.status).toBe(421);
    expect(refused.headers.get('set-cookie')).toBeNull();

    // The host check runs BEFORE redemption, so the operator's one-time link
    // still works at the right address — a mistyped host must not cost them
    // their sign-in.
    const accepted = await dashboardFetch(loginUrl, { redirect: 'manual' });
    expect(accepted.status).toBe(302);
    const cookie = accepted.headers.get('set-cookie');
    expect(cookie).toContain('lazy_dashboard=');

    const page = await dashboardFetch(`${base}/`, { headers: { cookie: cookie!.split(';')[0] } });
    expect(page.status).toBe(200);
  });

  // The shared daemon bearer token is what a task container's neighbours hold;
  // it is deliberately NOT a browser credential. If it were, the gate would be
  // decoration — the container could just present the token it already has.
  test('the daemon bearer token does not open the dashboard', async () => {
    const token = readToken(ctx.root);
    expect(typeof token).toBe('string');

    const res = await dashboardFetch(`${base}/api/tasks`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });
});

describe('dashboard authentication in managed mode', () => {
  let ctx: TestContext;
  let base: string;

  beforeEach(async () => {
    // Managed mode is armed in the DAEMON's environment, out of band, exactly
    // as the fleet supervisor arms it. It overrides the store, so point it at
    // the store this test project already uses.
    ctx = await setupTestLazy({ withDaemon: true });
    // Restart the daemon under managed mode with the project's own store: the
    // store path is only known after `lazy init`, so it cannot be passed as
    // daemonEnv at setup time.
    expectSuccess(await ctx.lazy(['daemon', 'stop']));
    expectSuccess(await ctx.lazy(['daemon', 'start'], {
      env: { LAZY_MANAGED: '1', LAZY_MANAGED_STORAGE_PATH: storageDirFor(ctx.root) },
    }));
    const health = await checkDaemonHealth(ctx.root);
    expect(health.webPort).toBeGreaterThan(0);
    base = `http://${DASHBOARD_HOSTNAME}:${health.webPort}`;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('every dashboard route 404s, and /rpc still works', async () => {
    for (const path of ['/', '/tasks', '/review/deadbeef', '/api/tasks', '/assets/app.css']) {
      const res = await dashboardFetch(`${base}${path}`);
      expect(res.status).toBe(404);
      expect(await res.text()).toContain('Lazy Teams');
    }

    // Teams talks to daemons over /rpc with actor tokens. That surface is
    // untouched by the dashboard kill switch — a managed host loses nothing.
    const target = getDaemonTcpTarget(ctx.root);
    const token = readToken(ctx.root);
    expect(target && token).toBeTruthy();
    const result = await DaemonClient.fromTarget(target!, token!).rpc('list', ctx.root, {}) as { tree: unknown[] };
    expect(Array.isArray(result.tree)).toBe(true);
  });

  test('`lazy dashboard` refuses on a managed daemon', async () => {
    const result = await ctx.lazy(['dashboard', '--print']);
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain('Lazy Teams');
  });

  // INVARIANT: /daemon/status reports dashboardUrl: null in managed mode so
  // the builder prompt and lazy_status do not invent a 404 link. The TCP
  // listener is still up (/rpc works); only the dashboard is off.
  test('/daemon/status reports dashboardUrl null when the dashboard is off', async () => {
    const health = await checkDaemonHealth(ctx.root);
    expect(health.running).toBe(true);
    expect(health.dashboardUrl).toBeNull();
  });
});
