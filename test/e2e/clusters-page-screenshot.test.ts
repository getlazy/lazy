/**
 * Capture the Clusters page, the reordered header, and the palette's route to
 * search.
 *
 * Not an assertion about pixels — it renders the visual surfaces this work
 * added so a reviewer can see them without starting a daemon. Skips wherever no
 * headless browser is available.
 */

import { describe, test, beforeAll, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { readFile, rm } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';
import { screenshotDashboardPage, browserSuiteSkipped } from '../helpers/page-screenshot';
import { setTaskStatus } from '../helpers/storage';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('clusters page screenshots', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;
  let skipped = false;

  beforeAll(async () => {
    skipped = await browserSuiteSkipped('clusters-page-screenshot');
  });

  beforeEach(async () => {
    if (skipped) return;
    ctx = await setupTestLazy({ withDaemon: true });
    ({ base, fetch } = await signInToDashboard(ctx));
  });

  afterEach(async () => {
    if (skipped) return;
    await ctx.cleanup();
  });

  async function expectPng(out: string): Promise<void> {
    const bytes = await readFile(out);
    expect(bytes.subarray(0, 8)).toEqual(PNG_MAGIC);
    expect(bytes.length).toBeGreaterThan(5_000);
    if (process.env.LAZY_SCREENSHOT_KEEP) {
      // Kept on request so the capture can be attached to a turn report.
      console.log(`screenshot: ${out}`);
      return;
    }
    await rm(out, { force: true });
  }

  test('the Clusters page shows every cluster with its progress and children', async () => {
    if (skipped) return;

    expectSuccess(await ctx.lazy([
      'create', '--goal', 'Fix everything the API review found', '--prompt', 'Run the children',
      '--type', 'cluster', '--code', 'api-review-fixes',
    ]));
    const child = async (goal: string, code: string): Promise<string> => {
      const r = await ctx.lazy([
        'create', '--goal', goal, '--prompt', `${goal} work`,
        '--parent', 'api-review-fixes', '--code', code,
      ]);
      expectSuccess(r);
      return r.stdout.match(/ID:\s+([a-f0-9]{8})/)![1];
    };
    const done = await child('Validate the pagination cursor', 'fix-cursor');
    const running = await child('Reject unknown query params', 'fix-query-params');
    const deferred = await child('Re-model the error envelope', 'rework-errors');
    await child('Document the rate limit headers', 'document-rate-limits');
    setTaskStatus(ctx.root, done, 'complete');
    setTaskStatus(ctx.root, running, 'working');
    expectSuccess(await ctx.lazy(['tag', deferred, 'deferred-by-api-review-fixes']));

    expectSuccess(await ctx.lazy([
      'create', '--goal', 'Ship the release notes', '--prompt', 'Walk the checklist',
      '--type', 'cluster', '--code', 'release-checklist',
    ]));

    const out = join(tmpdir(), `lazy-clusters-page-${process.pid}.png`);
    await rm(out, { force: true });
    await screenshotDashboardPage({ fetch, base, path: '/clusters', out, height: 1500 });
    await expectPng(out);
  }, 120_000);

  test('the command palette reaches the full search page', async () => {
    if (skipped) return;

    const out = join(tmpdir(), `lazy-palette-search-${process.pid}.png`);
    await rm(out, { force: true });
    await screenshotDashboardPage({
      fetch, base, path: '/', out, height: 900,
      // Drives the REAL palette island into command mode and filters it — the
      // page's own code, not a mock-up of it.
      injectScript: `
        window.lzOpenCommandPalette(true);
        var box = document.getElementById('lz-palette-input');
        box.value = '>search';
        box.dispatchEvent(new Event('input'));
      `,
    });
    await expectPng(out);
  }, 120_000);
});
