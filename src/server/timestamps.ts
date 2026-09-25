/**
 * One way to print "when" on a web surface.
 *
 * Two facts a reviewer wants from a timestamp, and they want them at once:
 * how long ago it was (scanning a page: "3m ago" vs "5d ago" is the whole
 * answer) and exactly when (comparing against a log, a CI run, another task).
 * So the visible text is relative and the precise UTC stamp rides along in
 * `title`, on the same element — no click, no second surface.
 *
 * The relative buckets are the ones the review status bar has always used
 * (`relativeTime` moved here from review.ts, which still re-exports it); the
 * Subtasks "Updated" column mirrors them too. Keeping one implementation is
 * why this module exists rather than a fourth copy of the same if-ladder.
 */

import { formatDate } from '../utils/format';
import { escapeHtml } from './review-diff';

/** Compact "3m ago". Mirrored by relTime() in the review island. */
export function relativeTime(ts: number | null): string {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** The precise form that goes in `title`: "2026-09-13 08:41 UTC". */
export function absoluteTime(ts: number): string {
  return `${formatDate(ts)} UTC`;
}

export interface TimestampHtmlOptions {
  /** Extra classes on the `<time>` element. */
  className?: string;
  /** Say the absolute time instead of the relative one, with the age in `title`. */
  absolute?: boolean;
}

/**
 * A timestamp a reader can both scan and pin down: relative text, absolute
 * `title`, machine-readable `datetime`.
 *
 * A DEGRADED TIMESTAMP NEVER TAKES THE PAGE DOWN. `new Date(NaN).toISOString()`
 * throws `RangeError`, and one unparseable value in one turn record would have
 * 500'd the whole task page — every other turn, the diff, the actions, all of
 * it — over a field that is decoration. So a non-finite or out-of-range value
 * renders as `unknown` with no `datetime`, which is what the ad-hoc formatters
 * this helper replaced already did by accident.
 *
 * Call sites that guard explicitly (`turn.timestamp ? … : ''`) keep their
 * guards: "this record has no time, say nothing" and "this record's time is
 * broken, say so" are different statements, and the second should be visible.
 */
export function timestampHtml(ts: number, options: TimestampHtmlOptions = {}): string {
  const classes = ['lz-when', ...(options.className ? [options.className] : [])].join(' ');
  const iso = isoOrNull(ts);
  if (iso === null) {
    return `<time class="${escapeHtml(classes)}" title="timestamp is not a usable date">unknown</time>`;
  }
  const visible = options.absolute ? absoluteTime(ts) : relativeTime(ts);
  const title = options.absolute ? relativeTime(ts) : absoluteTime(ts);
  // Which half is the ageing one, for {@link relativeTimeScript}. A relative
  // form goes stale in its TEXT; an absolute form's text is right forever and
  // its relative TITLE is what ages.
  const shape = options.absolute ? ' data-lz-abs' : ' data-lz-rel';
  return (
    `<time class="${escapeHtml(classes)}"${shape} datetime="${escapeHtml(iso)}"` +
    ` title="${escapeHtml(title)}">${escapeHtml(visible)}</time>`
  );
}

/**
 * The ISO form, or null when this number cannot be a date. Covers NaN, the
 * infinities, and values outside the ±8.64e15 ms range `Date` accepts — all
 * three make `toISOString()` throw rather than return something odd.
 */
function isoOrNull(ts: number): string | null {
  if (!Number.isFinite(ts)) return null;
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * {@link relativeTime}'s ladder, as browser JS.
 *
 * It has to exist twice — once to render and once to keep rendering — so it
 * lives HERE, beside the original, rather than as a third if-ladder copied
 * into an island. `test/unit/timestamps-live.test.ts` runs both over the same
 * ages and fails if they ever disagree.
 */
export const RELATIVE_TIME_JS = `  function lzRelative(ms) {
    if (!ms) return 'never';
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return s + 's ago';
    var m = Math.round(s / 60);
    if (m < 60) return m + 'm ago';
    var h = Math.round(m / 60);
    if (h < 48) return h + 'h ago';
    return Math.round(h / 24) + 'd ago';
  }`;

/** How often the visible text is recomputed. */
export const RELATIVE_TIME_TICK_MS = 30_000;

/**
 * Keep every rendered relative time honest while the page stays open.
 *
 * WHY THIS IS NOT OPTIONAL POLISH. A relative time is computed once, on the
 * server, at the moment the document is served — and these pages are parked,
 * not glanced at. The Turns tab is where someone sits while a task runs, poll
 * islands refresh content under headings that were rendered an hour ago, and
 * the tab island CACHES tab bodies rather than re-rendering them. So a
 * heading that said "2m ago" goes on saying it, getting quietly wronger the
 * longer the page is useful. Scannability was the point of the relative form;
 * a number that lies is not scannable.
 *
 * The data is already on the element: `datetime` carries the ISO instant. So
 * this recomputes from that rather than re-parsing the human `title` — one is
 * a machine-readable attribute, the other is display text that could change
 * format. Nothing is fetched and nothing is stored.
 *
 * COVERS TIMESTAMPS THAT ARRIVE LATER, two ways. The tick re-scans the whole
 * document, so anything a poll inserted is kept current from then on (it
 * arrives freshly rendered, so it is never wrong on arrival). And
 * `window.lzRefreshTimes` lets the tab island refresh instantly when it
 * un-hides a body it cached earlier, which is the one case where content can
 * become visible already stale.
 *
 * A degraded timestamp (`unknown`, no `datetime`) is skipped: there is nothing
 * to recompute from, and it must keep saying so.
 */
export function relativeTimeScript(): string {
  return `<script>
(function () {
${RELATIVE_TIME_JS}

  function refresh() {
    var els = document.querySelectorAll('time.lz-when[datetime]');
    for (var i = 0; i < els.length; i++) {
      var ms = Date.parse(els[i].getAttribute('datetime'));
      if (isNaN(ms)) continue;
      // Two shapes, and each keeps the OTHER form in title. Only the relative
      // half goes stale in the visible text; on an absolute one the tooltip
      // is what ages, so refresh that instead of rewriting a correct date.
      if (els[i].hasAttribute('data-lz-rel')) els[i].textContent = lzRelative(ms);
      else if (els[i].hasAttribute('data-lz-abs')) els[i].title = lzRelative(ms);
    }
  }

  window.lzRefreshTimes = refresh;
  setInterval(refresh, ${RELATIVE_TIME_TICK_MS});
})();
</script>`;
}
