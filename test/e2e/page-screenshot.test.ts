/**
 * E2E coverage for the page-screenshot helper agents use to SHOW UI work.
 *
 * The helper exists so that the next task needing a screenshot does not have to
 * rediscover the session cookie and the inlined stylesheet. A helper nobody runs
 * rots into exactly the trap it was written to remove, so this suite drives the
 * whole path end to end: sign in, fetch a real page from a real daemon, and put
 * a real browser on it.
 *
 * It gates on a browser being present and prints one line when it skips — a skip
 * is not a pass. Inside lazy's agent container it never skips: the image ships
 * Chromium (docs/agent-container-lazy-dev.md).
 */

import { describe, test, beforeAll, beforeEach, afterEach, expect } from 'bun:test';
import { readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';
import { screenshotDashboardPage, inlineStylesheet, browserSuiteSkipped } from '../helpers/page-screenshot';
import { STYLESHEET_PATH } from '../../src/server/styles';

describe('page-screenshot helper', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;
  let skipped = false;

  beforeAll(async () => {
    skipped = await browserSuiteSkipped('page-screenshot');
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

  test('rasterises an authenticated page to a non-trivial PNG', async () => {
    if (skipped) return;
    await createTask(ctx, 'A task with a name that should be legible in the shot');

    const out = join(tmpdir(), `lazy-shot-test-${process.pid}.png`);
    await rm(out, { force: true });
    try {
      const written = await screenshotDashboardPage({ fetch, base, path: '/tasks', out });
      expect(written).toBe(out);

      const bytes = await readFile(out);
      // PNG magic — proves a real rasteriser ran, not that some file appeared.
      expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      // A styled 1280x1600 page is tens of KB. A few hundred bytes would be a
      // blank frame, which is the failure mode worth catching: it looks like a
      // screenshot right up until a human opens it.
      expect(bytes.length).toBeGreaterThan(5_000);
    } finally {
      await rm(out, { force: true });
    }
  }, 60_000);

  test('a page that needs a session is fetched signed in', async () => {
    if (skipped) return;
    // The helper's whole reason for taking a DashboardFetch: an unauthenticated
    // GET of the same path lands on the sign-in page, and a screenshot of THAT
    // is the bug this replaces.
    const res = await fetch(`${base}/tasks`);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('Sign in');
  });
});

// INVARIANT: a saved page must carry its CSS inline. The dashboard links
// `/assets/app.css`, which resolves against file:// once the HTML is on disk —
// so without this swap every screenshot is an unstyled page that reads as a CSS
// regression rather than as a broken capture.
describe('inlineStylesheet', () => {
  test('replaces the linked stylesheet with an inline one', () => {
    const html = `<html><head><link rel="stylesheet" href="${STYLESHEET_PATH}"></head><body>hi</body></html>`;
    const out = inlineStylesheet(html, '.x { color: red }');
    expect(out).not.toContain(STYLESHEET_PATH);
    expect(out).toContain('<style>');
    expect(out).toContain('.x { color: red }');
  });

  test('injects into head when there is no link to replace', () => {
    const out = inlineStylesheet('<html><head><title>t</title></head><body>hi</body></html>', '.x{}');
    expect(out).toContain('<style>');
    expect(out.indexOf('<style>')).toBeLessThan(out.indexOf('</head>'));
  });
});
