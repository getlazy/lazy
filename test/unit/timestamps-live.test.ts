/**
 * A rendered relative time must stay true while the page is open, and the two
 * copies of the ladder that make that possible must agree.
 *
 * WHY THERE ARE TWO. `relativeTime` renders "7h ago" on the server, once, at
 * the moment the document is served. These pages are parked, not glanced at —
 * the Turns tab is where someone sits while a task runs — so the number has to
 * be recomputed in the browser or it quietly becomes a lie. That means the same
 * if-ladder exists as TypeScript and as browser JS.
 *
 * They live side by side in `src/server/timestamps.ts` for that reason, and
 * this suite runs both over the same ages so they cannot drift apart.
 */

import { describe, test, expect } from 'bun:test';
import {
  relativeTime,
  absoluteTime,
  timestampHtml,
  relativeTimeScript,
  RELATIVE_TIME_JS,
  RELATIVE_TIME_TICK_MS,
} from '../../src/server/timestamps';

/** The browser ladder, compiled out of the same source the island ships. */
function browserLadder(): (ms: number) => string {
  // eslint-disable-next-line no-new-func
  return new Function(`${RELATIVE_TIME_JS}\nreturn lzRelative;`)() as (ms: number) => string;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('the two relative-time ladders agree', () => {
  const lzRelative = browserLadder();
  const ages = [
    0, 1 * SECOND, 30 * SECOND, 59 * SECOND,
    MINUTE, 90 * SECOND, 5 * MINUTE, 59 * MINUTE,
    HOUR, 90 * MINUTE, 5 * HOUR, 47 * HOUR,
    48 * HOUR, 3 * DAY, 30 * DAY, 400 * DAY,
  ];

  for (const age of ages) {
    test(`${age}ms ago reads the same in both`, () => {
      const ts = Date.now() - age;
      expect(lzRelative(ts)).toBe(relativeTime(ts));
    });
  }

  // Both spell the no-timestamp case the same way. The island only ever sees
  // a parsed `datetime`, but a shared ladder that disagreed here would be one
  // refactor away from showing "never" where the server showed a real age.
  test('a falsy timestamp is "never" in both', () => {
    expect(lzRelative(0)).toBe('never');
    expect(relativeTime(null)).toBe('never');
  });
});

describe('timestampHtml marks which half ages', () => {
  // INVARIANT: the island must be able to tell the two shapes apart WITHOUT
  // re-parsing display text. A relative timestamp goes stale in its text; an
  // absolute one is right forever and its relative TITLE is what ages.
  test('a relative timestamp is marked for text refresh', () => {
    const html = timestampHtml(Date.now() - 5 * MINUTE);
    expect(html).toContain('data-lz-rel');
    expect(html).not.toContain('data-lz-abs');
    expect(html).toContain('>5m ago<');
  });

  test('an absolute timestamp is marked for title refresh', () => {
    const ts = Date.now() - 5 * MINUTE;
    const html = timestampHtml(ts, { absolute: true });
    expect(html).toContain('data-lz-abs');
    expect(html).not.toContain('data-lz-rel');
    expect(html).toContain(`>${absoluteTime(ts)}<`);
  });

  // A degraded timestamp has nothing to recompute from and must keep saying
  // so — no `datetime`, so the island's selector never matches it.
  test('an unusable timestamp carries no datetime for the island to read', () => {
    const html = timestampHtml(NaN);
    expect(html).toContain('>unknown<');
    expect(html).not.toContain('datetime=');
    expect(html).not.toContain('data-lz-rel');
  });
});

describe('the refresh island', () => {
  const js = relativeTimeScript();

  // It reads the machine-readable attribute, not the human one: `title` is
  // display text whose format could change, `datetime` is an ISO instant.
  test('recomputes from datetime, never from the title text', () => {
    expect(js).toContain("querySelectorAll('time.lz-when[datetime]')");
    expect(js).toContain("Date.parse(els[i].getAttribute('datetime'))");
  });

  test('updates the text of relative ones and the title of absolute ones', () => {
    expect(js).toMatch(/data-lz-rel'\)\) els\[i\]\.textContent = lzRelative\(ms\)/);
    expect(js).toMatch(/data-lz-abs'\)\) els\[i\]\.title = lzRelative\(ms\)/);
  });

  // Content that arrives later is covered two ways: the tick re-scans the
  // whole document, and the tab island calls the exported hook when it
  // un-hides a body it cached earlier (which can be visibly stale at once).
  test('ticks on a timer and exposes a hook for cached content', () => {
    expect(js).toContain('window.lzRefreshTimes = refresh;');
    expect(js).toContain(`setInterval(refresh, ${RELATIVE_TIME_TICK_MS})`);
  });

  test('an unparseable datetime is skipped rather than blanked', () => {
    expect(js).toContain('if (isNaN(ms)) continue;');
  });
});
