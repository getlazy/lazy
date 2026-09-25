/**
 * A turn deep link re-opens a ticked chunk ONCE — on the navigation that
 * carried the hash, and never again from the hash merely being in the URL.
 *
 * WHY THIS SUITE EXISTS, AND WHY IT IS A BROWSER TEST. The unit suite can only
 * read the island as text, and this rule has been got wrong twice in a row in
 * ways text assertions could not see:
 *
 *   1. The carve-out fired for ANY hash naming something inside a viewed card,
 *      so a comment or journal row cleared the chunk's tick.
 *   2. It then fired on EVERY load whose URL still carried `#turn-<n>`, so a
 *      reload, a Back, or a restored tab took the tick away again — silently,
 *      with no undo, as a persisted write performed on a plain GET. The
 *      viewed-cards island refuses to write on load at all for exactly that
 *      reason (`SAVE_ON_LOAD = false`).
 *
 * Clearing a tick is real, persisted review progress: it lives on the review
 * draft and follows the reviewer across reloads and devices. So the rule is
 * pinned by RUNNING the islands a reviewer runs and reading the resulting DOM.
 *
 * The fixture stubs `performance.getEntriesByType('navigation')` to choose the
 * navigation type, and sets the hash with `history.replaceState` so no
 * `hashchange` fires — a load, not a click. Both are installed before the
 * islands parse.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import { dumpDomOfHtml, browserSuiteSkipped } from '../helpers/page-screenshot';
import { bundledStylesheet } from '../../src/server/styles';
import { viewedCardHtml, viewedStateScript, shortHash } from '../../src/server/viewed-cards';
import { reviewNavigationScript } from '../../src/server/review-navigation';

/** The chunk card, ticked and collapsed, with a turn and a note inside it. */
const CHUNK_KEY = 'chunk:1';
const CHUNK_BODY = 'chunk body text';

function chunkCard(): string {
  return viewedCardHtml({
    key: CHUNK_KEY,
    content: CHUNK_BODY,
    id: 'chunk-1',
    headHtml: 'Chunk 1',
    bodyHtml:
      '<details class="chunk-turn" open id="turn-7"><summary>Turn #7</summary>' +
      '<p>the agent work</p></details>' +
      '<details class="chunk-note" open id="comment-abc"><summary>Comment</summary>' +
      '<p>a note</p></details>',
    sectionClass: 'turn-chunk',
  });
}

const PROBE = `<script>
window.addEventListener('load', function () {
  setTimeout(function () {
    var el = document.querySelector('[data-viewed-key="card:${CHUNK_KEY}"]');
    var box = el && el.querySelector('.rv-viewed-box');
    document.documentElement.setAttribute('data-probe', JSON.stringify({
      found: !!el,
      viewed: !!el && el.dataset.viewed === '1',
      collapsed: !!el && el.dataset.collapsed === '1',
      checked: !!(box && box.checked),
      saves: window.__saves || 0
    }));
  }, 400);
});
</script>`;

interface Probe {
  found: boolean;
  viewed: boolean;
  collapsed: boolean;
  checked: boolean;
  saves: number;
}

/**
 * @param navType what `performance.getEntriesByType('navigation')[0].type`
 *   reports: 'navigate' is a real navigation (including the 302 from
 *   `/tasks/:id/turns/:n`); 'reload' and 'back_forward' are not.
 * @param hash the hash the URL carries on load, set without a `hashchange`.
 */
function fixtureHtml(navType: string, hash: string): string {
  // Seed the tick the way the server does: key → the content hash it carried
  // when it was ticked, so the island marks the card viewed and collapses it.
  const seeded = { [`card:${CHUNK_KEY}`]: shortHash(CHUNK_BODY) };
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>${bundledStylesheet()}</style></head>
<body>
<script>
  // A LOAD, not a click: replaceState does not fire hashchange.
  history.replaceState(null, '', '${hash}');
  performance.getEntriesByType = function (t) {
    return t === 'navigation' ? [{ type: '${navType}' }] : [];
  };
  // Count persisted writes. A tick cleared by the carve-out goes through here;
  // a load that changes nothing must not write at all.
  window.__saves = 0;
  window.lazyReviewDraftSave = function () { window.__saves++; };
</script>
${chunkCard()}
${viewedStateScript('task-deeplink-probe', { serverState: seeded })}
${reviewNavigationScript()}
${PROBE}
</body></html>`;
}

async function run(navType: string, hash: string): Promise<Probe> {
  const dom = await dumpDomOfHtml(fixtureHtml(navType, hash));
  const match = dom.match(/data-probe="([^"]*)"/);
  if (!match) throw new Error(`no data-probe in dumped DOM:\n${dom.slice(0, 800)}`);
  return JSON.parse(match[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
}

describe('turn deep link vs a ticked chunk', () => {
  let skipped = false;

  beforeAll(async () => {
    skipped = await browserSuiteSkipped('turn-deeplink-viewed-state');
  });

  // The act: following /tasks/:id/turns/:n lands here as a real navigation.
  test('a navigation carrying #turn-<n> re-opens the chunk and clears the tick', async () => {
    if (skipped) return;
    const probe = await run('navigate', '#turn-7');
    expect(probe.found).toBe(true);
    expect(probe.collapsed).toBe(false);
    expect(probe.viewed).toBe(false);
    expect(probe.checked).toBe(false);
  }, 120_000);

  // INVARIANT: a reload is NOT the act. The reviewer followed the link, read
  // the chunk, ticked it — and then reloaded. The tick must survive, and
  // nothing may be persisted by the load.
  test('a reload with the same hash still in the URL leaves the tick alone', async () => {
    if (skipped) return;
    const probe = await run('reload', '#turn-7');
    expect(probe.found).toBe(true);
    expect(probe.collapsed).toBe(true);
    expect(probe.viewed).toBe(true);
    expect(probe.checked).toBe(true);
    expect(probe.saves).toBe(0);
  }, 120_000);

  // Back, forward, and a session-restored tab all report back_forward.
  test('a back/forward load with the same hash leaves the tick alone', async () => {
    if (skipped) return;
    const probe = await run('back_forward', '#turn-7');
    expect(probe.collapsed).toBe(true);
    expect(probe.checked).toBe(true);
    expect(probe.saves).toBe(0);
  }, 120_000);

  // INVARIANT: only a TURN anchor re-opens. A note link is "show me what that
  // said", not "let me re-read this chunk", and the rows on the Summary's
  // *Since you last looked* card link to exactly these.
  test('a comment anchor never re-opens, even on a real navigation', async () => {
    if (skipped) return;
    const probe = await run('navigate', '#comment-abc');
    expect(probe.collapsed).toBe(true);
    expect(probe.checked).toBe(true);
    expect(probe.saves).toBe(0);
  }, 120_000);

  // And the chunk's own anchor: the header IS what was asked for.
  test('a chunk anchor never re-opens its own chunk', async () => {
    if (skipped) return;
    const probe = await run('navigate', '#chunk-1');
    expect(probe.collapsed).toBe(true);
    expect(probe.checked).toBe(true);
    expect(probe.saves).toBe(0);
  }, 120_000);
});
