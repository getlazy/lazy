import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';
import { DASHBOARD_HOSTNAME } from '../../src/daemon/dashboard-url';

describe('lazy daemon dashboard-url', () => {
  let ctx: TestContext;
  // `dashboard-url` prints the ADDRESS; signing in is `lazy dashboard`'s job.
  // These tests still have to fetch pages, so they hold a session from the one
  // sign-in helper rather than each growing a cookie header.
  let fetch: DashboardFetch;

  // `lazy daemon dashboard-url` reads the running daemon's web dashboard port
  // and prints its URL. Unlike the old `lazy server` alias, it does NOT
  // auto-start the daemon — every test needs a real one running already.
  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    ({ fetch } = await signInToDashboard(ctx));
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // Run `lazy daemon dashboard-url` and return the URL it prints.
  async function dashboardUrl(): Promise<string> {
    const result = await ctx.lazy(['daemon', 'dashboard-url']);
    expect(result.exitCode).toBe(0);
    // The printed URL is on the dashboard's own hostname (see below); the
    // sign-in helper's `fetch` transports it to the loopback bind.
    const match = result.stdout.match(/(http:\/\/\S+:\d+)/);
    if (!match) {
      throw new Error(`No dashboard URL in output.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    }
    return match[1];
  }

  // INVARIANT: prints ONLY the URL (no "Web dashboard:" label or other text) —
  // this is a scripting-oriented command, e.g. `open $(lazy daemon dashboard-url)`.
  test('prints just the daemon dashboard URL and exits 0', async () => {
    const result = await ctx.lazy(['daemon', 'dashboard-url']);
    expect(result.exitCode).toBe(0);
    // INVARIANT: the URL is on the dashboard's OWN hostname, and specifically
    // not the bare `localhost` — `localhost` can resolve to IPv6 ::1 and fail
    // to reach the IPv4-only 127.0.0.1 bind, leaving the user on an empty page.
    //
    // It used to assert the literal 127.0.0.1 the daemon binds. That changed
    // for a security reason, not a cosmetic one: cookies are scoped by host and
    // not by port, so a dashboard session valid at 127.0.0.1 would also be sent
    // to the task app ports `[serve]` publishes there (src/daemon/dashboard-url.ts).
    // What the invariant protects — a connectable, unambiguous host that the
    // whole CLI prints identically — is unchanged.
    const printed = result.stdout.trim();
    expect(printed).toMatch(new RegExp(`^http://${DASHBOARD_HOSTNAME}:\\d+$`));
    expect(new URL(printed).hostname).not.toBe('localhost');
  });

  // INVARIANT: unlike the old `lazy server` alias, dashboard-url does NOT
  // auto-start the daemon — it just reports what's there (or isn't), the same
  // posture as `lazy daemon status`.
  test('exits non-zero and does not start a daemon when none is running', async () => {
    // Fresh project with no daemon started.
    const bare = await setupTestLazy();
    try {
      const result = await bare.lazy(['daemon', 'dashboard-url']);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('daemon is not running');

      const status = await bare.lazy(['daemon', 'status']);
      expect(status.stdout).toContain('Daemon is not running');
    } finally {
      await bare.cleanup();
    }
  });

  test('dashboard responds to HTTP requests on the daemon web port', async () => {
    const base = await dashboardUrl();
    const response = await fetch(`${base}/api/tasks`);
    expect(response.status).toBe(200);

    const data = await response.json();
    // API returns tasks array directly
    expect(Array.isArray(data)).toBe(true);
  });

  test('non-daemon commands still exit cleanly', async () => {
    const start = Date.now();
    const result = await ctx.lazy(['list']);
    const elapsed = Date.now() - start;

    // Should exit code 0 and finish promptly (not hang)
    expect(result.exitCode).toBe(0);
    expect(elapsed).toBeLessThan(10_000);
  });

  // --- Dashboard landing page tests ---

  // INVARIANT: The root URL (/) serves the dashboard, not the task list.
  // The task list lives at /tasks. This ensures the landing page shows
  // summary stats, charts, and items needing attention at a glance.
  test('serves dashboard at / with stat cards and chart', async () => {
    const base = await dashboardUrl();
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain('<title>Dashboard - Lazy</title>');
    expect(html).toContain('stat-grid');
    expect(html).toContain('Total Tasks');
    expect(html).toContain('Working');
    expect(html).toContain('Blocked');
    expect(html).toContain('Daily Task Throughput');
    expect(html).toContain('tasksChart');
  });

  // INVARIANT: Dashboard auto-refreshes to keep stats current.
  test('dashboard includes auto-refresh script', async () => {
    const base = await dashboardUrl();
    const res = await fetch(`${base}/`);
    const html = await res.text();
    expect(html).toContain('setTimeout');
    expect(html).toContain('location.reload');
  });

  test('serves task list at /tasks (separate from dashboard)', async () => {
    const base = await dashboardUrl();
    const res = await fetch(`${base}/tasks`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<title>Tasks - Lazy</title>');
  });

  test('dashboard shows recently created tasks', async () => {
    await createTask(ctx, 'Dashboard test task');

    const base = await dashboardUrl();
    const res = await fetch(`${base}/`);
    const html = await res.text();
    expect(html).toContain('Recently Created');
    expect(html).toContain('Dashboard test task');
  });

  test('dashboard embeds chart data as JSON', async () => {
    const base = await dashboardUrl();
    const res = await fetch(`${base}/`);
    const html = await res.text();
    // Chart.js loaded from CDN
    expect(html).toContain('chart.js');
    // Chart data contains date entries for the time series
    expect(html).toMatch(/"date":"\d{4}-\d{2}-\d{2}"/);
  });

  // Labels are title-cased (Dashboard / Loops / Tasks) since the Teams-CSS
  // restyle. Match the exact casing so a later accidental change is caught.
  // Search is deliberately NOT a nav link: the box and the palette are its two
  // entry points.
  test('dashboard navigation links are correct', async () => {
    const base = await dashboardUrl();
    const res = await fetch(`${base}/`);
    const html = await res.text();
    expect(html).toContain('href="/">Dashboard</a>');
    expect(html).toContain('href="/tasks">Tasks</a>');
    expect(html).toContain('href="/clusters">Clusters');
    expect(html).not.toContain('>Search</a>');
  });
});
