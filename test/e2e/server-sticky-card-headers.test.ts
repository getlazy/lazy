/**
 * E2E: the file card header on the Changes tab stays VISIBLE while its file is
 * on screen — in a real browser, with a real layout.
 *
 * THE BUG THIS PINS, and why a text assertion could not have caught it. The
 * header was made sticky by `ui-review-keep-your-place`, and it never stopped
 * being sticky: the unit suite's text assertions over the stylesheet stayed
 * green throughout. What changed is that the diff toolbar (Unified/Split,
 * Scroll/Wrap, Presented/Source) was ALSO made sticky, at the same offset, with
 * an opaque background and a z-index above the header. So from the first scroll
 * onwards the header parked itself exactly underneath the toolbar: sticky,
 * correctly positioned, and completely invisible — which to a reader is
 * indistinguishable from the header scrolling out of the viewport, and is
 * exactly how it was reported.
 *
 * "Is it sticky" is therefore the wrong question, and the one the stylesheet
 * can answer. The question is whether the reader can SEE it, and only a browser
 * that has done layout, painting and hit-testing can answer that — so this
 * suite asks `elementFromPoint` what is actually on top at the header's own
 * coordinates after a scroll. Any future chrome that parks on top of the header
 * fails here however it is spelled.
 *
 * The suite gates on a browser being present (`browserSuiteSkipped`), like
 * every other browser suite — a skip prints one line and is never a pass.
 */

import { describe, test, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';
import { dumpDomOfHtml, inlineStylesheet, browserSuiteSkipped } from '../helpers/page-screenshot';
import { bundledStylesheet } from '../../src/server/styles';

/** Three files, each long enough that one card alone outruns the viewport. */
const MOCK_FILES = JSON.stringify(
  [0, 1, 2].map((i) => ({
    path: `src/sticky-probe-${i}.ts`,
    content: Array.from({ length: 120 }, (_, n) => `export const v${i}_${n} = ${n};`).join('\n') + '\n',
  })),
);

/**
 * Scrolls 300px into the first file card, then reports what the reader sees.
 *
 * `elementFromPoint` at the header's own midpoint is the whole assertion: it
 * hit-tests the painted page, so it accounts for stacking, opacity and
 * position in one answer, which is precisely what a stylesheet scan cannot do.
 */
const PROBE = `<script>
window.addEventListener('load', function () {
  setTimeout(function () {
    var head = document.querySelector('.rv-file-head');
    if (!head) {
      document.documentElement.setAttribute('data-sticky-probe', JSON.stringify({ error: 'no .rv-file-head' }));
      return;
    }
    var sec = head.closest('.rv-file');
    var toolbar = document.querySelector('[data-rv-viewopts]');
    window.scrollTo(0, Math.round(sec.getBoundingClientRect().top + window.pageYOffset + 300));

    var r = head.getBoundingClientRect();
    var hit = document.elementFromPoint(Math.round(r.left + 40), Math.round(r.top + r.height / 2));
    var out = {
      headPosition: getComputedStyle(head).position,
      // The card really did scroll (so "visible" is not just "never moved").
      scrolledIntoCard: Math.round(sec.getBoundingClientRect().top) < 0,
      headTop: Math.round(r.top),
      headBottom: Math.round(r.bottom),
      viewportHeight: window.innerHeight,
      // THE ASSERTION: the topmost painted element at the header's own
      // coordinates is the header (or something inside it), not other chrome.
      headerIsOnTop: !!(hit && (hit === head || head.contains(hit))),
      coveredBy: hit && !(hit === head || head.contains(hit))
        ? (hit.tagName + '.' + (hit.className || '')).slice(0, 120)
        : null
    };
    if (toolbar) {
      var tr = toolbar.getBoundingClientRect();
      out.toolbar = {
        position: getComputedStyle(toolbar).position,
        top: Math.round(tr.top),
        bottom: Math.round(tr.bottom),
        visible: toolbar.getClientRects().length > 0
      };
    }
    document.documentElement.setAttribute('data-sticky-probe', JSON.stringify(out));
  }, 300);
});
</script>`;

interface Probe {
  error?: string;
  headPosition: string;
  scrolledIntoCard: boolean;
  headTop: number;
  headBottom: number;
  viewportHeight: number;
  headerIsOnTop: boolean;
  coveredBy: string | null;
  toolbar?: { position: string; top: number; bottom: number; visible: boolean };
}

function parseProbe(dom: string): Probe {
  const match = dom.match(/data-sticky-probe="([^"]*)"/);
  if (!match) throw new Error(`no data-sticky-probe in dumped DOM:\n${dom.slice(0, 800)}`);
  return JSON.parse(match[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
}

const skipped = await browserSuiteSkipped('server-sticky-card-headers');

describe.skipIf(skipped)('the Changes tab keeps a file card header on screen', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;

  beforeEach(async () => {
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FILES: MOCK_FILES },
    });
    ({ base, fetch } = await signInToDashboard(ctx));
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: while any part of a file is on screen, that file's header is
  // VISIBLE — not merely `position: sticky`. Sticky under opaque chrome parked
  // at the same offset is the regression this exists to catch, and it reads to
  // the reviewer as the header scrolling away.
  test('the file header stays visible and uncovered once the card is scrolled into', async () => {
    const taskId = await createTask(ctx, 'Sticky file header', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    let html = '';
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const res = await fetch(`${base}/tasks/${taskId}/changes`);
      html = await res.text();
      if (html.includes('class="rv-file-head"')) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    expect(html).toContain('class="rv-file-head"');

    const page = inlineStylesheet(html, bundledStylesheet()).replace('</body>', `${PROBE}</body>`);
    const probe = parseProbe(await dumpDomOfHtml(page));

    expect(probe.error).toBeUndefined();
    // The card really is taller than the viewport and we really scrolled into
    // it — otherwise "the header is visible" would be trivially true.
    expect(probe.scrolledIntoCard).toBe(true);

    // Still sticky, and still inside the viewport.
    expect(probe.headPosition).toBe('sticky');
    expect(probe.headTop).toBeGreaterThanOrEqual(0);
    expect(probe.headBottom).toBeLessThanOrEqual(probe.viewportHeight);

    // THE REGRESSION: nothing is painted on top of it. `coveredBy` names the
    // offender so a failure says what covered it, not just that it failed.
    expect(probe.coveredBy).toBeNull();
    expect(probe.headerIsOnTop).toBe(true);
  }, 120_000);

  // INVARIANT: the fix is a STACK, not a trade. The toolbar was made sticky
  // because it was the one control gone from sight on a long review, so
  // "uncover the header" must not be achieved by pushing the toolbar off
  // screen or hiding it — both stay stuck, the toolbar above the header.
  test('the diff toolbar stays stuck too, directly above the header', async () => {
    const taskId = await createTask(ctx, 'Sticky toolbar and header', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    let html = '';
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const res = await fetch(`${base}/tasks/${taskId}/changes`);
      html = await res.text();
      if (html.includes('class="rv-file-head"')) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    expect(html).toContain('data-rv-viewopts');

    const page = inlineStylesheet(html, bundledStylesheet()).replace('</body>', `${PROBE}</body>`);
    const probe = parseProbe(await dumpDomOfHtml(page));

    expect(probe.toolbar).toBeDefined();
    const toolbar = probe.toolbar!;
    expect(toolbar.visible).toBe(true);
    expect(toolbar.position).toBe('sticky');
    // On screen, and above the header rather than on top of it.
    expect(toolbar.top).toBeGreaterThanOrEqual(0);
    expect(toolbar.bottom).toBeLessThanOrEqual(probe.headTop);
  }, 120_000);
});
