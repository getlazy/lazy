/**
 * `[server] dashboard_url` — the dashboard reached at a public origin through a
 * reverse proxy, end to end: a real daemon, a real Host-preserving proxy in
 * front of it, and (where only a browser can tell) a real headless Chromium.
 *
 * WHY THIS SUITE EXISTS. The setting shipped with a test that redeemed a login
 * link with `fetch` and stopped at the 302. Every hop after that — the browser
 * following the redirect with its new cookie, links into the dashboard, a proxy
 * that rewrites Host, what doctor says is in effect — was unexercised, and the
 * first person to configure it for real reported that it did not work.
 *
 * The browser tests reproduce what they hit. Someone reaching the dashboard
 * through a proxy is, almost by definition, not at the machine running lazy:
 * they get the `lazy dashboard --print` link through a chat message, an email or
 * another web page, and CLICK it. That navigation is cross-site, and Chromium
 * withholds a `SameSite=Strict` cookie from every request in a cross-site
 * redirect chain — so the 302 that redeemed the one-time link arrived at `/`
 * without the cookie it had just set, showed the sign-in page, and had already
 * spent the link. Typing the URL, or `lazy dashboard` opening it, is not
 * cross-site, which is why it always worked on the machine it was built on.
 *
 * The proxy serves HTTPS with a throwaway self-signed certificate, like the
 * tunnels the setting is documented for (ngrok, Tailscale serve). That matters
 * beyond fidelity: browsers only tell a server where a navigation came from
 * (`Sec-Fetch-Site`) on a secure origin, and the fix keys on it.
 */

import { describe, test, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';
import { browserSuiteSkipped, launchBrowser, type Browser } from '../helpers/cdp-browser';
import { checkDaemonHealth } from '../../src/daemon';

/** The public hostname the proxy answers on; the browser maps it to loopback. */
const PUBLIC_HOST = 'lazy-proxy.test';
/** "Another site" — where the human clicked the link from. */
const OTHER_HOST = 'chat.test';

const SIGN_IN_TITLE = 'Sign in - Lazy';

/** A throwaway self-signed certificate for the proxy's HTTPS listener. */
interface Cert { cert: string; key: string }

async function makeCert(): Promise<Cert> {
  const dir = await mkdtemp(join(tmpdir(), 'lazy-proxy-cert-'));
  try {
    const proc = Bun.spawn([
      'openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', `/CN=${PUBLIC_HOST}`,
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
    ], { stdout: 'ignore', stderr: 'pipe' });
    if (await proc.exited !== 0) {
      throw new Error(`openssl could not make a test certificate: ${await new Response(proc.stderr).text()}`);
    }
    return {
      cert: await readFile(join(dir, 'cert.pem'), 'utf-8'),
      key: await readFile(join(dir, 'key.pem'), 'utf-8'),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

let cert: Cert;
beforeAll(async () => { cert = await makeCert(); });

interface Proxy {
  port: number;
  origin: string;
  /** Point the proxy at the daemon's current web port. */
  target(port: number): void;
  /** Rewrite Host to the upstream address, as nginx's default `proxy_pass` does. */
  rewriteHost: boolean;
  stop(): void;
}

/**
 * A minimal HTTPS-terminating reverse proxy: forwards every request to the
 * daemon's loopback bind over plain HTTP and, like ngrok, Caddy and Tailscale
 * serve by default, PRESERVES the Host header. `rewriteHost` switches to
 * nginx's default instead.
 */
function startProxy(): Proxy {
  let upstreamPort = 0;
  const proxy = {
    port: 0,
    origin: '',
    target(port: number) { upstreamPort = port; },
    rewriteHost: false,
    stop() { server.stop(true); },
  };
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    tls: cert,
    async fetch(req) {
      const url = new URL(req.url);
      const headers = new Headers(req.headers);
      headers.set('host', proxy.rewriteHost ? `127.0.0.1:${upstreamPort}` : req.headers.get('host')!);
      const res = await fetch(`http://127.0.0.1:${upstreamPort}${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
        redirect: 'manual',
      });
      const out = new Headers(res.headers);
      // Bun's fetch has already decoded the body.
      out.delete('content-encoding');
      out.delete('content-length');
      return new Response(await res.arrayBuffer(), { status: res.status, headers: out });
    },
  });
  proxy.port = server.port!;
  proxy.origin = `https://${PUBLIC_HOST}:${server.port}`;
  return proxy;
}

/** "Another site": one page with one link on it. */
function startOtherSite(href: () => string): { origin: string; stop(): void } {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch() {
      return new Response(
        `<!doctype html><title>chat</title><a id="link" href="${href()}">the link</a>`,
        { headers: { 'Content-Type': 'text/html' } },
      );
    },
  });
  return { origin: `http://${OTHER_HOST}:${server.port}`, stop: () => server.stop(true) };
}

/** Restart the daemon with `dashboard_url` set, and aim the proxy at it. */
async function configurePublicOrigin(ctx: TestContext, proxy: Proxy): Promise<void> {
  expectSuccess(await ctx.lazy(['daemon', 'stop']));
  const configPath = `${ctx.root}/lazy.toml`;
  const config = await readFile(configPath, 'utf-8');
  const edited = config.replace('[server]\n', `[server]\ndashboard_url = "${proxy.origin}"\n`);
  expect(edited).not.toBe(config);
  await writeFile(configPath, edited);
  expectSuccess(await ctx.lazy(['daemon', 'start']));
  const health = await checkDaemonHealth(ctx.root);
  expect(health.dashboardUrl).toBe(proxy.origin);
  proxy.target(health.webPort!);
}

async function printLoginUrl(ctx: TestContext): Promise<string> {
  const printed = await ctx.lazy(['dashboard', '--print']);
  expectSuccess(printed);
  return printed.stdout.trim();
}

describe('dashboard at a configured public origin', () => {
  let ctx: TestContext;
  let proxy: Proxy;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    proxy = startProxy();
    await configurePublicOrigin(ctx, proxy);
  });

  afterEach(async () => {
    proxy.stop();
    await ctx.cleanup();
  });

  test('every link surface prints the configured origin', async () => {
    const printed = await ctx.lazy(['dashboard', '--print']);
    expectSuccess(printed);
    const loginUrl = new URL(printed.stdout.trim());
    expect(loginUrl.origin).toBe(proxy.origin);
    // lazy.toml and the daemon agree, so there is nothing to warn about.
    expect(printed.stderr).not.toContain('dashboard_url');

    const address = await ctx.lazy(['daemon', 'dashboard-url']);
    expectSuccess(address);
    expect(address.stdout.trim()).toBe(proxy.origin);

    const status = await ctx.lazy(['daemon', 'status']);
    expectSuccess(status);
    expect(status.stdout).toContain(proxy.origin);
    expect(status.stdout).not.toContain('lazy.localhost');
  });

  // A proxy that replaces Host (nginx's default `proxy_pass`, Apache without
  // ProxyPreserveHost) delivers every request addressed to the upstream. The
  // daemon must refuse it — the host check is what scopes the session cookie —
  // but it used to refuse by telling the human the dashboard lives at the very
  // URL they were looking at. The page must name what actually arrived and what
  // to change.
  test('a proxy that rewrites Host is told what arrived and what to fix', async () => {
    proxy.rewriteHost = true;
    const loginUrl = await printLoginUrl(ctx);

    const page = await fetch(loginUrl.replace(PUBLIC_HOST, '127.0.0.1'), {
      headers: { host: `${PUBLIC_HOST}:${proxy.port}` },
      redirect: 'manual',
      tls: { rejectUnauthorized: false },
    });
    expect(page.status).toBe(421);
    const html = await page.text();
    expect(html).toContain(`127.0.0.1:`);
    expect(html).toContain('Host header');

    const api = await fetch(`https://127.0.0.1:${proxy.port}/api/tasks`, {
      headers: { host: `${PUBLIC_HOST}:${proxy.port}` },
      tls: { rejectUnauthorized: false },
    });
    expect(api.status).toBe(421);
    expect(((await api.json()) as { error: string }).error).toContain('Host header');
  });

  test('lazy doctor says which origin links and sign-in use', async () => {
    const doctor = await ctx.lazy(['doctor']);
    expect(doctor.stdout).toContain(`Dashboard address: ${proxy.origin}`);
    expect(doctor.stdout).toContain('[server] dashboard_url');
  });

  test('lazy doctor flags a daemon still serving the old address', async () => {
    // Edit lazy.toml WITHOUT restarting: the daemon keeps the origin it
    // started with, which is what "I set it and nothing changed" looks like.
    const configPath = `${ctx.root}/lazy.toml`;
    const config = await readFile(configPath, 'utf-8');
    const edited = config.replace(`dashboard_url = "${proxy.origin}"`, 'dashboard_url = "https://lazy.example.com"');
    expect(edited).not.toBe(config);
    await writeFile(configPath, edited);

    const doctor = await ctx.lazy(['doctor']);
    expect(doctor.stdout).toContain('✗ Dashboard address');
    expect(doctor.stdout).toContain('https://lazy.example.com');
    expect(doctor.stdout).toContain(proxy.origin);
    expect(doctor.stdout).toContain('lazy daemon restart');
  });
});

// What the engineer hit, verbatim: "it just displayed the same lazy.localhost
// message". The daemon reads `[server] dashboard_url` when it STARTS, and the
// key was set on a daemon that was already running — the ordinary way to edit
// a config file. `lazy dashboard` then printed the old address with nothing to
// say why. It must still print what the daemon serves (that is the address that
// works), but never silently: one line naming both addresses, pointing at the
// restart that applies it and at `lazy doctor`, which holds the diagnosis.
describe('dashboard_url edited while the daemon is running', () => {
  let ctx: TestContext;
  const CONFIGURED = 'https://lazy.example.com';

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function editConfig(from: string, to: string): Promise<void> {
    const configPath = `${ctx.root}/lazy.toml`;
    const config = await readFile(configPath, 'utf-8');
    const edited = config.replace(from, to);
    expect(edited).not.toBe(config);
    await writeFile(configPath, edited);
  }

  /** The stderr lines that mention dashboard_url. */
  function driftLines(stderr: string): string[] {
    return stderr.split('\n').filter((line) => line.includes('dashboard_url'));
  }

  test('lazy dashboard says the daemon still serves the old address', async () => {
    const served = (await checkDaemonHealth(ctx.root)).dashboardUrl!;
    expect(served).toContain('lazy.localhost');
    await editConfig('[server]\n', `[server]\ndashboard_url = "${CONFIGURED}"\n`);

    const printed = await ctx.lazy(['dashboard', '--print']);
    expectSuccess(printed);
    // stdout stays the one working link, so `--print` still composes.
    expect(new URL(printed.stdout.trim()).origin).toBe(served);
    const lines = driftLines(printed.stderr);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(CONFIGURED);
    expect(lines[0]).toContain(served);
    expect(lines[0]).toContain('lazy daemon restart');
    expect(lines[0]).toContain('lazy doctor');
  });

  test('lazy daemon dashboard-url says so too', async () => {
    const served = (await checkDaemonHealth(ctx.root)).dashboardUrl!;
    await editConfig('[server]\n', `[server]\ndashboard_url = "${CONFIGURED}"\n`);

    const address = await ctx.lazy(['daemon', 'dashboard-url']);
    expectSuccess(address);
    expect(address.stdout.trim()).toBe(served);
    const lines = driftLines(address.stderr);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(CONFIGURED);
    expect(lines[0]).toContain('lazy doctor');
  });

  test('after a restart the configured origin is printed, with no warning', async () => {
    await editConfig('[server]\n', `[server]\ndashboard_url = "${CONFIGURED}"\n`);
    expectSuccess(await ctx.lazy(['daemon', 'restart']));

    const printed = await ctx.lazy(['dashboard', '--print']);
    expectSuccess(printed);
    expect(new URL(printed.stdout.trim()).origin).toBe(CONFIGURED);
    expect(driftLines(printed.stderr)).toEqual([]);
  });

  // The other way to get "the same lazy.localhost message": the key typed into
  // the wrong table. A lazy.toml with no [server] section invites appending the
  // line at the bottom, where it lands in whatever table came last and is
  // ignored — restart or no restart.
  test('a dashboard_url outside [server] is named as ignored', async () => {
    await editConfig('driver = "local"\n', `driver = "local"\ndashboard_url = "${CONFIGURED}"\n`);
    expectSuccess(await ctx.lazy(['daemon', 'restart']));

    const printed = await ctx.lazy(['dashboard', '--print']);
    expectSuccess(printed);
    const lines = driftLines(printed.stderr);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[remote]');
    expect(lines[0]).toContain('[server]');
    expect(lines[0]).toContain('lazy doctor');
  });
});

describe.skipIf(browserSuiteSkipped('dashboard at a configured public origin (browser)'))(
  'dashboard at a configured public origin, in a real browser',
  () => {
    let ctx: TestContext;
    let proxy: Proxy;
    let browser: Browser;
    let other: { origin: string; stop(): void };
    let linkHref = '';

    beforeEach(async () => {
      ctx = await setupTestLazy({ withDaemon: true });
      proxy = startProxy();
      other = startOtherSite(() => linkHref);
      await configurePublicOrigin(ctx, proxy);
      browser = await launchBrowser([PUBLIC_HOST, OTHER_HOST]);
    });

    afterEach(async () => {
      await browser.close();
      other.stop();
      proxy.stop();
      await ctx.cleanup();
    });

    // What the engineer hit. The link was redeemed (it cannot be used twice),
    // yet the browser ended on the sign-in page.
    test('a login link clicked on another site signs the browser in', async () => {
      linkHref = await printLoginUrl(ctx);
      await browser.goto(`${other.origin}/`);
      const landed = await browser.click('#link');

      expect(landed.title).not.toBe(SIGN_IN_TITLE);
      expect(new URL(landed.url).origin).toBe(proxy.origin);
      expect(landed.url).not.toContain('lazy_login');
    }, 60_000);

    test('a login link opened directly still signs the browser in', async () => {
      const landed = await browser.goto(await printLoginUrl(ctx));
      expect(landed.title).not.toBe(SIGN_IN_TITLE);
      expect(landed.url).not.toContain('lazy_login');
    }, 60_000);

    // The same cookie rule, one step later: a signed-in human clicking a task
    // link that the builder posted into a chat.
    test('a dashboard link clicked on another site opens signed in', async () => {
      const taskId = await createTask(ctx, 'Reachable from a pasted link');
      await browser.goto(await printLoginUrl(ctx));

      linkHref = `${proxy.origin}/tasks/${taskId}`;
      await browser.goto(`${other.origin}/`);
      const landed = await browser.click('#link');

      expect(landed.title).not.toBe(SIGN_IN_TITLE);
      expect(landed.text).toContain('Reachable from a pasted link');
    }, 60_000);

    // The bounce that makes the previous test pass must not loop, and must not
    // stand in for a session: with none, the sign-in page is still the answer.
    test('a dashboard link clicked on another site without a session shows sign-in', async () => {
      const taskId = await createTask(ctx, 'Not for strangers');
      linkHref = `${proxy.origin}/tasks/${taskId}`;
      await browser.goto(`${other.origin}/`);
      const landed = await browser.click('#link');

      expect(landed.title).toBe(SIGN_IN_TITLE);
      expect(landed.text).not.toContain('Not for strangers');
    }, 60_000);
  },
);
