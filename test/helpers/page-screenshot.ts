/**
 * Rasterising a dashboard page, so an agent can SHOW its UI work.
 *
 * A turn report can carry screenshots (`presentation.screenshots`), and for
 * anything visual that image is the fastest answer a reviewer gets. Producing
 * one from a lazy web page has two obstacles that are not obvious, and every
 * task that has needed a screenshot so far has rediscovered both:
 *
 *  1. **The page needs a session.** Every dashboard route is behind the sign-in
 *     cookie, so a browser pointed at the URL gets the sign-in page. Handing the
 *     cookie to a browser is fiddly; fetching the HTML with the authenticated
 *     `fetch` from {@link signInToDashboard} is not.
 *  2. **A saved page loses its stylesheet.** The HTML links
 *     `/assets/app.css`, which resolves against `file://` once the page is on
 *     disk — so a naive save-and-rasterise produces an unstyled wall of text
 *     that looks like a regression rather than a screenshot. The fix is to
 *     inline `bundledStylesheet()` in place of the link.
 *
 * So this helper fetches, inlines, writes a standalone file, and rasterises it
 * with whatever headless browser {@link findChromeBinary} turns up (lazy's agent
 * container images ship one — see docs/agent-container-lazy-dev.md).
 *
 *   const { base, fetch } = await signInToDashboard(ctx);
 *   const png = await screenshotDashboardPage({
 *     fetch, base, path: '/followups?sort=age', out: '/tmp/followups.png',
 *   });
 *
 * WHY THIS LIVES UNDER test/. It needs `signInToDashboard`, which drives the
 * real `lazy dashboard --print` flow through a `TestContext`, and it renders
 * lazy's own dashboard — it is a utility for working ON lazy, not a product
 * surface, so shipping it in `src/` would put a test-only dependency in the
 * binary. Agents reach it the way they reach every other helper: by importing
 * it from a test file in this repo.
 *
 * LIMITS, so a surprising screenshot is not read as a bug:
 *  - Cross-origin scripts (the Chart.js CDN tag on pages with charts) do not
 *    load from `file://` with no network, so a chart renders as empty space.
 *  - Inline scripts that fetch `/api/...` for the nav badge counts fail the same
 *    way, so those badges come out blank. Neither affects page layout.
 */

import { writeFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from '../../src/utils/spawn';
import { findChromeBinary, CHROME_NOT_FOUND_HINT } from '../../src/utils/chrome';
import { STYLESHEET_PATH, bundledStylesheet } from '../../src/server/styles';
import type { DashboardFetch } from './dashboard-session';

export interface PageScreenshotOptions {
  /** The authenticated `fetch` from `signInToDashboard(ctx)`. */
  fetch: DashboardFetch;
  /** The dashboard origin from `signInToDashboard(ctx)`. */
  base: string;
  /** Path (and query) to capture, e.g. `/followups?sort=age`. */
  path: string;
  /** Where to write the PNG. */
  out: string;
  /** Viewport width in CSS pixels. Default 1280 — the desktop layout. */
  width?: number;
  /**
   * Viewport height in CSS pixels. Default 1600. Chromium's `--screenshot`
   * captures the VIEWPORT, not the whole document, so a page taller than this
   * is cropped: raise it when you need the bottom of a long list.
   */
  height?: number;
  /**
   * JS appended to the page before it is rasterised, for capturing a state the
   * human reaches by ACTING — an open dialog, an expanded section. It runs
   * after the page's own islands, so it drives the real thing rather than
   * standing in for it (`window.lzOpenCommandPalette(true)` opens the real
   * palette). Anything needing `/api/...` still fails: the copy is on `file://`.
   */
  injectScript?: string;
}

/**
 * Swap the linked stylesheet for an inline one.
 *
 * Matches the `<link>` by its href rather than by a hand-written regex over the
 * whole tag, so it stays correct if the template reorders attributes; and it
 * reads `STYLESHEET_PATH` from the server module, so a route rename cannot leave
 * this silently matching nothing.
 */
export function inlineStylesheet(html: string, css: string): string {
  const link = new RegExp(`<link[^>]*href="${STYLESHEET_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`);
  const inlined = `<style>\n${css}\n</style>`;
  if (link.test(html)) return html.replace(link, inlined);

  // No link to replace: either the page does not use the layout template, or the
  // template changed. Inject before </head> rather than returning an unstyled
  // page — an unstyled screenshot looks exactly like a CSS regression.
  if (html.includes('</head>')) return html.replace('</head>', `${inlined}\n</head>`);
  return `${inlined}\n${html}`;
}

/**
 * Fetch a dashboard page as an authenticated user and write a PNG of it.
 *
 * Returns the path written. Throws with an actionable message when no browser
 * is available, when the page did not return 200, or when the browser produced
 * no file — never silently leaves a missing or empty screenshot behind, because
 * a report that names a screenshot which is not there fails at `lazy_report`,
 * far from the cause.
 */
export async function screenshotDashboardPage(options: PageScreenshotOptions): Promise<string> {
  const { fetch, base, path, out, width = 1280, height = 1600, injectScript } = options;

  const chrome = await findChromeBinary();
  if (!chrome) throw new Error(`${CHROME_NOT_FOUND_HINT} (needed to screenshot ${path})`);

  const url = path.startsWith('http') ? path : `${base}${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} returned ${res.status} — is the session signed in?`);
  let html = inlineStylesheet(await res.text(), bundledStylesheet());
  if (injectScript) {
    // Last thing in the body, so every island the page ships has already run
    // and the injected code drives them rather than racing them.
    html = html.replace('</body>', `<script>${injectScript}</script>\n</body>`);
  }

  const tmpHtml = join(tmpdir(), `lazy-shot-${process.pid}-${Date.now()}.html`);
  await writeFile(tmpHtml, html, 'utf-8');

  try {
    // `--no-sandbox`: the agent container has no user namespaces for Chromium's
    // own sandbox, and the input here is lazy's own rendered HTML, not
    // untrusted web content. `--virtual-time-budget` gives the page's inline
    // scripts a moment to run before the frame is grabbed.
    const proc = spawn([
      chrome,
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      `--window-size=${width},${height}`,
      '--virtual-time-budget=2000',
      `--screenshot=${out}`,
      `file://${tmpHtml}`,
    ], { stdout: 'pipe', stderr: 'pipe', timeout: 60_000 });

    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    // Headless Chromium chatters on stderr about D-Bus and GPU on every run in a
    // container, so stderr is NOT a failure signal — the exit code and the file
    // on disk are. stderr is only quoted when one of those says it failed.
    if (exitCode !== 0) {
      throw new Error(
        `${chrome} exited ${exitCode} screenshotting ${path}: ` +
        stderr.trim().split('\n').slice(-5).join('\n'),
      );
    }
    const written = await stat(out).catch(() => null);
    if (!written || written.size === 0) {
      throw new Error(
        `${chrome} exited 0 but wrote no screenshot to ${out}: ` +
        stderr.trim().split('\n').slice(-5).join('\n'),
      );
    }
  } finally {
    await rm(tmpHtml, { force: true });
  }

  return out;
}

export interface LivePageScreenshotOptions {
  /** One-time login URL from `mintDashboardLoginUrl(ctx)`. */
  loginUrl: string;
  /** Absolute dashboard URL to capture, on the same origin as `loginUrl`. */
  url: string;
  /** Where to write the PNG. */
  out: string;
  width?: number;
  height?: number;
  /**
   * Virtual milliseconds granted to the page after load. The default clears
   * the review island's SLOW poll cadence (10s), so the captured frame is the
   * one the reviewer sees a few seconds in, not the one the server rendered.
   */
  settleMs?: number;
}

/**
 * Screenshot a dashboard page in a browser that actually TALKS to the daemon.
 *
 * `screenshotDashboardPage` above captures the server's HTML off a `file://`
 * copy, so every in-page island that fetches `/api/...` is dead in the frame.
 * That is fine for layout, and wrong whenever the thing under review is what
 * the page looks like AFTER its own poll has replaced a container — a live
 * capture is the only way to show that the poll did not, say, leave a second
 * copy of a list behind.
 *
 * Two Chromium runs sharing one `--user-data-dir`: the first redeems the
 * one-time login link (which is what puts the session cookie in the profile),
 * the second navigates to the page and grabs the frame. Chromium resolves
 * `*.localhost` to loopback itself, so the dashboard hostname needs no DNS.
 */
export async function screenshotDashboardLive(options: LivePageScreenshotOptions): Promise<string> {
  const { loginUrl, url, out, width = 1280, height = 1600, settleMs = 20_000 } = options;

  const chrome = await findChromeBinary();
  if (!chrome) throw new Error(`${CHROME_NOT_FOUND_HINT} (needed to screenshot ${url})`);

  const profile = join(tmpdir(), `lazy-shot-profile-${process.pid}-${Date.now()}`);
  const run = async (target: string, extra: string[]): Promise<string> => {
    const proc = spawn([
      chrome,
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      ...extra,
      target,
    ], { stdout: 'pipe', stderr: 'pipe', timeout: 120_000 });
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `${chrome} exited ${exitCode} loading ${target}: ` +
        stderr.trim().split('\n').slice(-5).join('\n'),
      );
    }
    return stderr;
  };

  try {
    // Sign in. The redirect is followed by the browser, and the cookie lands in
    // the profile — screenshotting to a throwaway path keeps this one run.
    await run(loginUrl, ['--virtual-time-budget=5000', `--screenshot=${join(profile, 'login.png')}`]);
    const stderr = await run(url, [`--virtual-time-budget=${settleMs}`, `--screenshot=${out}`]);

    const written = await stat(out).catch(() => null);
    if (!written || written.size === 0) {
      throw new Error(
        `${chrome} exited 0 but wrote no screenshot to ${out}: ` +
        stderr.trim().split('\n').slice(-5).join('\n'),
      );
    }
  } finally {
    await rm(profile, { recursive: true, force: true });
  }

  return out;
}

/**
 * Load standalone HTML in headless Chrome and return the serialised DOM after
 * scripts have run. Used to exercise in-page islands (viewed cards, keyboard
 * nav) that unit tests can only pin as text — there is no DOM harness in the
 * unit suite.
 *
 * `--dump-dom` writes the post-script document to stdout. Chromium chatter
 * still goes to stderr, so stderr is not a failure signal (same as screenshots).
 */
export async function dumpDomOfHtml(html: string): Promise<string> {
  const chrome = await findChromeBinary();
  if (!chrome) throw new Error(`${CHROME_NOT_FOUND_HINT} (needed to dump rendered HTML)`);

  const tmpHtml = join(tmpdir(), `lazy-dump-${process.pid}-${Date.now()}.html`);
  await writeFile(tmpHtml, html, 'utf-8');

  try {
    const proc = spawn([
      chrome,
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--virtual-time-budget=4000',
      '--dump-dom',
      `file://${tmpHtml}`,
    ], { stdout: 'pipe', stderr: 'pipe', timeout: 60_000 });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      throw new Error(
        `${chrome} exited ${exitCode} dumping DOM: ` +
        stderr.trim().split('\n').slice(-5).join('\n'),
      );
    }
    if (!stdout.includes('<html') && !stdout.includes('<HTML')) {
      throw new Error(
        `${chrome} exited 0 but dumped no HTML: ` +
        stderr.trim().split('\n').slice(-5).join('\n'),
      );
    }
    return stdout;
  } finally {
    await rm(tmpHtml, { force: true });
  }
}

/**
 * Skip gate for a suite that needs a browser, mirroring `sandboxSuiteSkipped`:
 * skip when the dependency is absent, and print exactly ONE line saying so, so
 * the suite is never silently green-by-omission.
 *
 * Async because the lookup is — call it from `beforeAll` and store the verdict,
 * or `await` it at module scope before `describe.skipIf(...)`.
 */
export async function browserSuiteSkipped(suiteName: string): Promise<boolean> {
  if (await findChromeBinary()) return false;
  console.log(`skipped: browser suite "${suiteName}" — ${CHROME_NOT_FOUND_HINT}`);
  return true;
}
