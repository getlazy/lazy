import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { resolve } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';

const ENTRY_PATH = resolve(__dirname, '../../src/index.ts');

// Use a high port range to avoid conflicts with running servers
const TEST_PORT = 49152 + Math.floor(Math.random() * 1000);

describe('lazy server', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('stays running and responds to HTTP requests', async () => {
    const port = TEST_PORT;

    // Spawn server as a background process (don't await — it blocks forever)
    const proc = Bun.spawn(['bun', 'run', ENTRY_PATH, 'server', '--port', String(port)], {
      cwd: ctx.root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, LAZY_PROTOCOL_BASE: ctx.protocolBase },
    });

    try {
      // Wait for "Lazy server running at" message in stdout (up to 10s)
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let output = '';
      const readyTimeout = 10_000;
      const startTime = Date.now();

      while (Date.now() - startTime < readyTimeout) {
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: true }>(resolve =>
            setTimeout(() => resolve({ value: undefined, done: true }), readyTimeout - (Date.now() - startTime))
          ),
        ]);

        if (done && !output.includes('Lazy server running at')) {
          // Collect any stderr for diagnostics
          const stderr = await new Response(proc.stderr).text();
          throw new Error(`Server did not start within ${readyTimeout}ms.\nstdout: ${output}\nstderr: ${stderr}`);
        }

        if (value) {
          output += decoder.decode(value, { stream: true });
        }

        if (output.includes('Lazy server running at')) {
          reader.releaseLock();
          break;
        }
      }

      // Verify the process is still running (not killed by process.exit(0))
      // Give it a moment to ensure it hasn't exited
      const exitedEarly = await Promise.race([
        proc.exited.then(() => true),
        new Promise<false>(resolve => setTimeout(() => resolve(false), 500)),
      ]);
      expect(exitedEarly).toBe(false);

      // Make an HTTP request to the task list API endpoint
      const response = await fetch(`http://localhost:${port}/api/tasks`);
      expect(response.status).toBe(200);

      const data = await response.json();
      // API returns tasks array directly
      expect(Array.isArray(data)).toBe(true);
    } finally {
      // Clean up: kill the server process
      proc.kill('SIGTERM');
      await proc.exited;
    }
  });

  test('non-server commands still exit cleanly', async () => {
    const start = Date.now();
    const result = await ctx.lazy(['list']);
    const elapsed = Date.now() - start;

    // Should exit code 0 and finish promptly (not hang)
    expect(result.exitCode).toBe(0);
    expect(elapsed).toBeLessThan(10_000);
  });

  test('shows --help', async () => {
    const result = await ctx.lazy(['server', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Start an HTTP server');
    expect(result.stdout).toContain('--port');
  });

  // --- Dashboard landing page tests ---

  // Helper: start server and wait for it to respond (returns port and cleanup function)
  async function withServer(fn: (port: number) => Promise<void>): Promise<void> {
    const port = 49152 + Math.floor(Math.random() * 10000);
    const proc = Bun.spawn(['bun', 'run', ENTRY_PATH, 'server', '--port', String(port)], {
      cwd: ctx.root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, LAZY_PROTOCOL_BASE: ctx.protocolBase },
    });

    try {
      // Wait for server readiness by polling
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`http://localhost:${port}/api/tasks`);
          if (res.ok) break;
        } catch {
          // Not ready yet
        }
        await new Promise(r => setTimeout(r, 100));
      }

      await fn(port);
    } finally {
      proc.kill('SIGTERM');
      await proc.exited;
    }
  }

  // INVARIANT: The root URL (/) serves the dashboard, not the task list.
  // The task list lives at /tasks. This ensures the landing page shows
  // summary stats, charts, and items needing attention at a glance.
  test('serves dashboard at / with stat cards and chart', async () => {
    await withServer(async (port) => {
      const res = await fetch(`http://localhost:${port}/`);
      expect(res.status).toBe(200);

      const html = await res.text();
      expect(html).toContain('<title>Dashboard - Lazy</title>');
      expect(html).toContain('stat-grid');
      expect(html).toContain('Total Tasks');
      expect(html).toContain('Working');
      expect(html).toContain('Blocked');
      expect(html).toContain('Tasks Over Time');
      expect(html).toContain('tasksChart');
    });
  });

  // INVARIANT: Dashboard auto-refreshes to keep stats current.
  test('dashboard includes auto-refresh script', async () => {
    await withServer(async (port) => {
      const res = await fetch(`http://localhost:${port}/`);
      const html = await res.text();
      expect(html).toContain('setTimeout');
      expect(html).toContain('location.reload');
    });
  });

  test('serves task list at /tasks (separate from dashboard)', async () => {
    await withServer(async (port) => {
      const res = await fetch(`http://localhost:${port}/tasks`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<title>Tasks - Lazy</title>');
    });
  });

  test('dashboard shows recently created tasks', async () => {
    await createTask(ctx, 'Dashboard test task');

    await withServer(async (port) => {
      const res = await fetch(`http://localhost:${port}/`);
      const html = await res.text();
      expect(html).toContain('Recently Created');
      expect(html).toContain('Dashboard test task');
    });
  });

  test('dashboard embeds chart data as JSON', async () => {
    await withServer(async (port) => {
      const res = await fetch(`http://localhost:${port}/`);
      const html = await res.text();
      // Chart.js loaded from CDN
      expect(html).toContain('chart.js');
      // Chart data contains date entries for the time series
      expect(html).toMatch(/"date":"\d{4}-\d{2}-\d{2}"/);
    });
  });

  test('dashboard navigation links are correct', async () => {
    await withServer(async (port) => {
      const res = await fetch(`http://localhost:${port}/`);
      const html = await res.text();
      expect(html).toContain('href="/">dashboard</a>');
      expect(html).toContain('href="/tasks">tasks</a>');
      expect(html).toContain('href="/search">search</a>');
    });
  });
});
