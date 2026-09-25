/**
 * E2E for the Settings page: Memories (moved from /memory), Doctor run, and
 * one remedy through the live-steps dialog.
 *
 * Doctor GET is a last-report read — the sweep only runs on POST. The remedy
 * path uses the same dialog header the page's script sends (`X-Lazy-Doctor-Dialog`)
 * so we assert on NDJSON steps rather than a full HTML page.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';

function parseNdjson(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

describe('web settings page', () => {
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

  test('Settings is in the nav and hosts Memories and Doctor', async () => {
    const tasks = await (await fetch(`${base}/tasks`)).text();
    expect(tasks).toContain('href="/settings"');

    const settings = await fetch(`${base}/settings`);
    expect(settings.status).toBe(200);
    const memories = await settings.text();
    expect(memories).toContain('Settings');
    expect(memories).toContain('href="/settings/memory"');
    expect(memories).toContain('href="/settings/doctor"');
    expect(memories).toContain('id="memory-intro"');

    const doctor = await (await fetch(`${base}/settings/doctor`)).text();
    expect(doctor).toContain('id="doctor-run"');
    expect(doctor).toContain('Doctor has not run on this machine yet');
    expect(doctor).toContain('data-lz-doctor-remedy="unset-upstream-tracking"');
  });

  test('/memory still reaches Memories via redirect', async () => {
    // Native fetch-follow would drop the Host rewrite the dashboard helper
    // applies (transport is 127.0.0.1; Host is lazy.localhost). A browser
    // stays on lazy.localhost. Assert the 308, then GET the target.
    const redirected = await fetch(`${base}/memory`, { redirect: 'manual' });
    expect(redirected.status).toBe(308);
    const location = redirected.headers.get('location') ?? '';
    expect(location).toMatch(/\/settings\/memory$/);
    const res = await fetch(`${base}/settings/memory`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="memory-intro"');
  });

  test('Run doctor stores a report that GET then shows', async () => {
    const run = await fetch(`${base}/settings/doctor/run`, {
      method: 'POST',
      headers: { 'X-Lazy-Doctor-Dialog': '1' },
    });
    expect(run.status).toBe(200);
    const events = parseNdjson(await run.text());
    expect(events.some((e) => e.kind === 'report')).toBe(true);
    const reportEvent = events.find((e) => e.kind === 'report') as { report: { ranAt: string; checks: unknown[] } };
    expect(reportEvent.report.ranAt).toBeTruthy();
    expect(reportEvent.report.checks.length).toBeGreaterThan(0);

    const page = await (await fetch(`${base}/settings/doctor`)).text();
    expect(page).toContain('id="doctor-report"');
    expect(page).toContain('Last run');
    expect(page).toContain('id="doctor-ran-at"');
  }, 60_000);

  test('a remedy through the dialog previews then reports', async () => {
    const res = await fetch(`${base}/settings/doctor/remedy/unset-upstream-tracking`, {
      method: 'POST',
      headers: { 'X-Lazy-Doctor-Dialog': '1' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('ndjson');
    const events = parseNdjson(await res.text());
    const preview = events.find((e) => e.kind === 'preview') as
      | { empty: boolean; emptyMessage?: string; flag: string }
      | undefined;
    expect(preview).toBeDefined();
    expect(preview!.flag).toBe('unset-upstream-tracking');
    // A fresh test project has no leftover tracking, so this is the empty
    // preview — still a real remedy trip through the dialog.
    if (preview!.empty) {
      expect(preview!.emptyMessage).toContain('nothing to unset');
    } else {
      expect(events.some((e) => e.kind === 'result')).toBe(true);
    }
  });
});
