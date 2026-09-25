/**
 * E2E for the global command palette: every page ships the island, live
 * search answers JSON, and create-task opens as a fragment without leaving
 * the current page's URL first.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';

describe('lazy web command palette', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    const health = await checkDaemonHealth(ctx.root);
    expect(health.webPort).toBeGreaterThan(0);
    ({ base, fetch } = await signInToDashboard(ctx));
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('dashboard HTML includes the palette island and shortcut wiring', async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('id="lz-palette"');
    expect(html).toContain('id="lz-create-dialog"');
    expect(html).toContain('window.lzOpenCommandPalette');
    expect(html).toContain("toLowerCase() !== 'k'");
    expect(html).toContain('openPalette(!!ev.shiftKey)');
    expect(html).toContain('Navigate to review queue');
  });

  test('GET /api/search returns matching JSON results', async () => {
    await createTask(ctx, 'Palette search alpha unique', 'find me in the palette');
    const res = await fetch(`${base}/api/search?q=${encodeURIComponent('Palette search alpha unique')}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('application/json');
    const body = await res.json() as { results: Array<{ task_goal: string; entity_type: string }> };
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results.some((r) => r.task_goal.includes('Palette search alpha unique'))).toBe(true);
  });

  test('GET /api/search with an empty query returns an empty list', async () => {
    const res = await fetch(`${base}/api/search?q=`);
    expect(res.status).toBe(200);
    const body = await res.json() as { results: unknown[] };
    expect(body.results).toEqual([]);
  });

  test('GET /tasks/new?fragment=1 is the form body without page chrome', async () => {
    const res = await fetch(`${base}/tasks/new?fragment=1`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="goal"');
    expect(html).toContain('data-lz-create-cancel');
    expect(html).not.toContain('<nav class="nav">');
    expect(html).not.toContain('id="lz-action-dialog"');
  });
});
