/**
 * Capture the search page: the inline grammar cheat sheet, and a `task:spike`
 * result set.
 *
 * Not an assertion about pixels — it renders the visual surface this work added
 * so a reviewer can see it without starting a daemon. Skips wherever no
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

describe('the dashboard search page', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;
  let skipped = false;

  beforeAll(async () => {
    skipped = await browserSuiteSkipped('search-page-screenshot');
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

  test('renders the grammar cheat sheet and a task: result set', async () => {
    if (skipped) return;

    for (const [code, goal] of [
      ['spike-vm-isolation', 'Investigate VM isolation vehicles for per-project sandboxes'],
      ['publish-runner-spike', 'Design publishing the lazy-runner image at release'],
      ['spike-app-peer-container', 'Serve app processes from a peer container'],
      ['unrelated-widget', 'Nothing to do with the others'],
    ]) {
      expectSuccess(await ctx.lazy(['create', '--goal', goal, '--code', code]));
    }

    const help = join(tmpdir(), `lazy-search-grammar-${process.pid}.png`);
    const results = join(tmpdir(), `lazy-search-results-${process.pid}.png`);
    try {
      // The empty search page opens the cheat sheet by default: nothing to read
      // yet, and the grammar is the whole reason to be there.
      await screenshotDashboardPage({ fetch, base, path: '/search', out: help, height: 1500 });
      await screenshotDashboardPage({
        fetch, base, path: `/search?q=${encodeURIComponent('task:spike')}`, out: results, height: 900,
      });

      for (const png of [help, results]) {
        expect((await readFile(png)).byteLength).toBeGreaterThan(1000);
        console.log(`search page screenshot: ${png}`);
      }
    } finally {
      await rm(help, { force: true });
      await rm(results, { force: true });
    }
  }, 120_000);
});
