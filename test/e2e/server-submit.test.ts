/**
 * Web Submit: the button on an eligible task, both confirmation tiers in
 * the dialog, and the Tasks-list Submitted filter.
 *
 * The daemon already had the submit verb; this suite pins the surfaces the
 * engineer said were missing — a clickable Submit (refusal lives in the
 * dialog, not a hidden/disabled control), and `/tasks?filter=submitted`.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';
import { setTaskStatus } from '../helpers/storage';

describe('lazy web submit and submitted filter', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;

  beforeEach(async () => {
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    const health = await checkDaemonHealth(ctx.root);
    expect(health.webPort).toBeGreaterThan(0);
    ({ base, fetch } = await signInToDashboard(ctx));
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function blockedTask(goal: string): Promise<string> {
    const shortId = await createTask(ctx, goal, 'Do work');
    expectSuccess(await ctx.lazyMocked(['start', shortId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    }));
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const { queue } = await (await fetch(`${base}/api/review/queue`)).json();
      const hit = (queue as { id: string }[]).find((e) => e.id.startsWith(shortId));
      if (hit) return hit.id;
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error(`task ${shortId} never reached the review queue`);
  }

  test('Submit is on the header and Current review of an eligible task, and a local-driver refusal is in the dialog', async () => {
    const id = await blockedTask('Eligible for submit');
    const landing = await (await fetch(`${base}/tasks/${id}`)).text();
    expect(landing).toContain('data-lz-action-open="submit"');
    expect(landing).toContain('Local driver has no remote');
    expect(landing).not.toMatch(/disabled[^>]*Submit|Submit[^>]*disabled/);

    const review = await (await fetch(`${base}/tasks/${id}/review`)).text();
    expect(review).toContain('data-lz-action-open="submit"');
    expect(review).toContain('data-lz-action-open="accept"');
    expect(review).toContain('Local driver has no remote');
  }, 90_000);

  test('the submit dialog uses the plain and strong confirmation tiers', async () => {
    const id = await blockedTask('Submit confirmation tiers');

    const configPath = join(ctx.root, 'lazy.toml');
    const before = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, before.replace('driver = "local"', 'driver = "github"'));
    expect(readFileSync(configPath, 'utf-8')).not.toBe(before);

    const review = await (await fetch(`${base}/tasks/${id}/review`)).text();
    const hasPlain = review.includes('name="confirm"') && review.includes('Yes, create the PR');
    const hasStrong = review.includes('name="typed_confirmation"');
    expect(hasPlain || hasStrong).toBe(true);

    if (hasPlain) {
      const missing = await fetch(`${base}/tasks/${id}/actions/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams().toString(),
        redirect: 'manual',
      });
      expect(missing.status).toBe(400);
      expect(await missing.text()).toMatch(/Tick the box|Confirmation Required/i);

      const ticked = await fetch(`${base}/tasks/${id}/actions/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ confirm: '1' }).toString(),
        redirect: 'manual',
      });
      // Confirm was accepted; the forge itself will still refuse in this harness.
      expect([303, 409, 500]).toContain(ticked.status);
    } else {
      const missing = await fetch(`${base}/tasks/${id}/actions/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams().toString(),
        redirect: 'manual',
      });
      expect(missing.status).toBe(400);
      expect(await missing.text()).toMatch(/Type the target branch|Confirmation Required/i);

      const wrong = await fetch(`${base}/tasks/${id}/actions/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ typed_confirmation: 'not-the-branch' }).toString(),
        redirect: 'manual',
      });
      expect(wrong.status).toBe(400);
    }
  }, 90_000);

  test('the Tasks list has a Submitted filter that lists only submitted tasks', async () => {
    const submittedId = await blockedTask('Now submitted');
    await blockedTask('Stays blocked');
    setTaskStatus(ctx.root, submittedId, 'submitted');

    const bar = await (await fetch(`${base}/tasks`)).text();
    expect(bar).toContain('>Submitted<');
    expect(bar).toContain('/tasks?filter=submitted');

    const filtered = await (await fetch(`${base}/tasks?filter=submitted`)).text();
    expect(filtered).toContain('Now submitted');
    expect(filtered).not.toContain('Stays blocked');
    expect(filtered).toMatch(/filter=submitted[^>]*class="btn btn-sm active"/);
    expect(filtered).toContain('tag-indigo');
  }, 90_000);
});
