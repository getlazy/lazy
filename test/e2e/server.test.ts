import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';

describe('lazy server', () => {
  let ctx: TestContext;

  // `lazy server` is a thin alias for the daemon's built-in web dashboard, so
  // every test needs a real daemon running. The daemon serves the dashboard on
  // its TCP web port; `lazy server` only ensures it's up and prints the URL.
  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // Run `lazy server` and return the dashboard base URL it prints. The daemon
  // (started in beforeEach) is already serving the dashboard, so this returns
  // promptly — there is no standalone server to spawn or tear down.
  async function dashboardUrl(): Promise<string> {
    const result = await ctx.lazy(['server']);
    expect(result.exitCode).toBe(0);
    // The daemon binds to 127.0.0.1 (loopback) by default, so the printed URL
    // uses the real interface, not a hardcoded `localhost` (which can resolve
    // to IPv6 ::1 and miss the IPv4 bind).
    const match = result.stdout.match(/Web dashboard: (http:\/\/[\d.]+:\d+)/);
    if (!match) {
      throw new Error(`No web dashboard URL in output.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    }
    return match[1];
  }

  // INVARIANT: `lazy server` is a daemon alias — it does NOT start a standalone
  // server. It ensures the daemon is running and prints the daemon's dashboard
  // URL, then exits. The standalone/--port mode was removed (it was undocumented
  // and at odds with the daemon-single-writer architecture).
  test('prints the daemon dashboard URL and exits', async () => {
    const result = await ctx.lazy(['server']);
    expect(result.exitCode).toBe(0);
    // INVARIANT: the URL reflects the actual loopback bind (127.0.0.1), not a
    // hardcoded `localhost` — `localhost` can resolve to IPv6 ::1 and fail to
    // reach the IPv4-only 127.0.0.1 bind, leaving the user on an empty page.
    expect(result.stdout).toContain('Web dashboard: http://127.0.0.1:');
    expect(result.stdout).not.toContain('http://localhost:');
  });

  // INVARIANT: the standalone/--port flag is gone. `lazy server` takes no flags.
  test('no longer advertises a --port flag in help', async () => {
    const result = await ctx.lazy(['server', '--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Show the web dashboard URL');
    expect(result.stdout).not.toContain('--port');
    expect(result.stdout).not.toContain('standalone');
  });

  test('dashboard responds to HTTP requests on the daemon web port', async () => {
    const base = await dashboardUrl();
    const response = await fetch(`${base}/api/tasks`);
    expect(response.status).toBe(200);

    const data = await response.json();
    // API returns tasks array directly
    expect(Array.isArray(data)).toBe(true);
  });

  test('non-server commands still exit cleanly', async () => {
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

  test('dashboard navigation links are correct', async () => {
    const base = await dashboardUrl();
    const res = await fetch(`${base}/`);
    const html = await res.text();
    expect(html).toContain('href="/">dashboard</a>');
    expect(html).toContain('href="/tasks">tasks</a>');
    expect(html).toContain('href="/search">search</a>');
  });
});
