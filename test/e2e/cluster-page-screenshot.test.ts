/**
 * Capture the cluster progress line on a cluster task's page.
 *
 * Not an assertion about pixels — it renders the one visual surface this work
 * added so a reviewer can see it without starting a daemon. Skips wherever no
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
import { findFullTaskId, setTaskStatus } from '../helpers/storage';

describe('cluster progress on the task page', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;
  let skipped = false;

  beforeAll(async () => {
    skipped = await browserSuiteSkipped('cluster-page-screenshot');
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

  test('a cluster task page shows k-of-n, the running child and the deferred one', async () => {
    if (skipped) return;

    const cluster = await ctx.lazy([
      'create', '--goal', 'Fix everything the API review found', '--prompt', 'Run the children',
      '--type', 'cluster', '--code', 'api-review-fixes',
    ]);
    expectSuccess(cluster);

    // The storage helpers address a task by its short hex id, never its code.
    const shortIdOf = (stdout: string): string =>
      stdout.match(/ID:\s+([a-f0-9]{8})/)![1];

    const child = async (goal: string, code: string): Promise<string> => {
      const r = await ctx.lazy([
        'create', '--goal', goal, '--prompt', `${goal} work`,
        '--parent', 'api-review-fixes', '--code', code,
      ]);
      expectSuccess(r);
      return shortIdOf(r.stdout);
    };
    const done = await child('Validate the pagination cursor', 'fix-cursor');
    const running = await child('Reject unknown query params', 'fix-query-params');
    const deferred = await child('Re-model the error envelope', 'rework-errors');
    await child('Document the rate limit headers', 'document-rate-limits');

    setTaskStatus(ctx.root, done, 'complete');
    setTaskStatus(ctx.root, running, 'working');
    expectSuccess(await ctx.lazy(['tag', deferred, 'deferred-by-api-review-fixes']));

    const fullId = findFullTaskId(ctx.root, cluster.stdout.match(/ID:\s+([a-f0-9]{8})/)![1]);
    const out = join(tmpdir(), `lazy-cluster-progress-${process.pid}.png`);
    await rm(out, { force: true });
    try {
      await screenshotDashboardPage({ fetch, base, path: `/tasks/${fullId}`, out });
      const bytes = await readFile(out);
      expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      expect(bytes.length).toBeGreaterThan(5_000);
      if (process.env.LAZY_SCREENSHOT_KEEP) {
        // Kept on request so the capture can be attached to a turn report.
        console.log(`cluster progress screenshot: ${out}`);
        return;
      }
    } finally {
      if (!process.env.LAZY_SCREENSHOT_KEEP) await rm(out, { force: true });
    }
  }, 90_000);
});
