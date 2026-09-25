/**
 * A parked page's relative times keep up, including ones inserted after load.
 *
 * The unit suite proves the two ladders agree and that the island is wired the
 * way it claims. This one RUNS it: the staleness being fixed is a property of
 * a live document over time, and the whole bug was that server-rendered text
 * sat unchanged while the page stayed useful.
 *
 * Time is compressed rather than waited out — the fixture stubs `Date.now` a
 * fixed distance into the future and calls the island's own exported hook, so
 * the assertions are about what the island computes, not about a timer the
 * test would otherwise have to sleep through.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import { dumpDomOfHtml, browserSuiteSkipped } from '../helpers/page-screenshot';
import { timestampHtml, relativeTimeScript } from '../../src/server/timestamps';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * A page rendered "now" with a 2-minute-old stamp and a 3-hour-old absolute
 * one, then read again as if four hours had passed — with a third stamp
 * inserted during that window, the way a poll update inserts one.
 */
function fixtureHtml(): string {
  const now = Date.now();
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body>
<span id="rel">${timestampHtml(now - 2 * MINUTE)}</span>
<span id="abs">${timestampHtml(now - 3 * HOUR, { absolute: true })}</span>
<span id="late"></span>
<span id="broken">${timestampHtml(NaN)}</span>
${relativeTimeScript()}
<script>
window.addEventListener('load', function () {
  setTimeout(function () {
    var out = {};
    out.atRender = document.querySelector('#rel time').textContent;

    // Content that arrived after first render, e.g. from a poll. It is
    // rendered fresh by the server, so it starts correct.
    document.querySelector('#late').innerHTML =
      ${JSON.stringify(timestampHtml(now - 1 * MINUTE))};
    out.lateAtInsert = document.querySelector('#late time').textContent;

    // Four hours pass.
    var real = Date.now;
    Date.now = function () { return real() + ${4 * HOUR}; };
    window.lzRefreshTimes();
    Date.now = real;

    out.relAfter = document.querySelector('#rel time').textContent;
    out.lateAfter = document.querySelector('#late time').textContent;
    out.absTextAfter = document.querySelector('#abs time').textContent;
    out.absTitleAfter = document.querySelector('#abs time').getAttribute('title');
    out.brokenAfter = document.querySelector('#broken time').textContent;
    out.hasHook = typeof window.lzRefreshTimes === 'function';

    document.documentElement.setAttribute('data-times', JSON.stringify(out));
  }, 200);
});
</script>
</body></html>`;
}

interface Probe {
  atRender: string;
  lateAtInsert: string;
  relAfter: string;
  lateAfter: string;
  absTextAfter: string;
  absTitleAfter: string;
  brokenAfter: string;
  hasHook: boolean;
}

describe('relative times on a page that stays open', () => {
  let skipped = false;
  let probe: Probe;

  beforeAll(async () => {
    skipped = await browserSuiteSkipped('relative-time-refresh');
    if (skipped) return;
    const dom = await dumpDomOfHtml(fixtureHtml());
    const match = dom.match(/data-times="([^"]*)"/);
    if (!match) throw new Error(`no data-times in dumped DOM:\n${dom.slice(0, 800)}`);
    probe = JSON.parse(match[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  }, 120_000);

  test('the island is installed and exposes its refresh hook', () => {
    if (skipped) return;
    expect(probe.hasHook).toBe(true);
  });

  // INVARIANT: the visible relative text is recomputed, not left as the server
  // wrote it. This is the whole bug: "2m ago" rendered once and then asserted
  // forever on a page someone parks for hours.
  test('a stamp rendered at load catches up as time passes', () => {
    if (skipped) return;
    expect(probe.atRender).toBe('2m ago');
    expect(probe.relAfter).toBe('4h ago');
  });

  // The reviewer's second requirement: cover timestamps that ARRIVE later,
  // not only those present at first render.
  test('a stamp inserted after load is correct on arrival and keeps up', () => {
    if (skipped) return;
    expect(probe.lateAtInsert).toBe('1m ago');
    expect(probe.lateAfter).toBe('4h ago');
  });

  // An absolute stamp's text is right forever; its relative TITLE is the half
  // that ages, so that is what gets rewritten.
  test('an absolute stamp keeps its date and refreshes its tooltip', () => {
    if (skipped) return;
    expect(probe.absTextAfter).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
    expect(probe.absTitleAfter).toBe('7h ago');
  });

  // A degraded stamp has no `datetime`, so there is nothing to recompute from
  // and it must go on saying so rather than being blanked or invented.
  test('an unusable timestamp is left alone', () => {
    if (skipped) return;
    expect(probe.brokenAfter).toBe('unknown');
  });
});
