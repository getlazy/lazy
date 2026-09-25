/**
 * The live island's staleness bookkeeping, driven in a real DOM.
 *
 * INVARIANT: a tab's body is marked current ONLY when it was actually patched.
 * A change the reader declined (a pill they ignored) or that the interaction
 * guard held back leaves the body BEHIND, and the island must keep saying so —
 * the freshness keys are stamped either way, so the key diff will never name
 * that region again for the same commit.
 *
 * Both sequences below were live bugs: the reader ended up on a cached tab body
 * showing pre-change content, with no dot and no pill, healed only by a full
 * page reload. That is the complaint this whole task exists to fix ("the
 * Subtasks tab never refreshed at all — I had to reload the page by hand"), in
 * a narrower form, and it was introduced by the per-region island: the old one
 * deleted every non-terminal cached body on any change, so it could not leave
 * one behind.
 *
 * These run the SHIPPED script text, not a re-implementation.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Window } from 'happy-dom';
import { domMorphScript } from '../../src/server/dom-morph';
import { taskLiveStatusScript } from '../../src/server/task-live-status';
import { taskTabStripHtml } from '../../src/server/task-tabs';
import { TASK_LIVE_REGION_IDS, type TaskLiveRegionId } from '../../src/server/task-live-regions';
import type { TaskTabId } from '../../src/server/task-tabs';

const TASK = 'task-1';
// An id-spelled entry address for the mixed-spelling deferral test below:
// the page is stamped with the task's code while the reader sits on the id.
const UUID = '3f9c1c2e-9d4a-4b8f-a1c2-5e6f7089a1b2';

type Keys = Record<TaskLiveRegionId, string>;

function keys(overrides: Partial<Keys> = {}): Keys {
  const out = {} as Keys;
  for (const id of TASK_LIVE_REGION_IDS) out[id] = 'v0';
  return { ...out, ...overrides };
}

function bodyHtml(tab: TaskTabId, text: string): string {
  const path = tab === 'landing' ? `/tasks/${seg}` : `/tasks/${seg}/${tab}`;
  return `<div class="lz-tab-body" data-lz-tab-body data-lz-tab-path="${path}">` +
    `<p data-lz-key="p1">${text}</p></div>`;
}

// The segment stamped into strips and bodies. Defaults to the task id; the
// mixed-spelling deferral test below overrides it (a code-spelled page).
let seg = TASK;

function pageHtml(current: TaskTabId, stamped: Keys, bodies: TaskTabId[]): string {
  const strip = taskTabStripHtml({ taskId: seg, current });
  const cells = bodies
    .map((t) => (t === current ? bodyHtml(t, 'old') : bodyHtml(t, 'old').replace('<div ', '<div hidden ')))
    .join('');
  return (
    `<div data-lz-task-page data-lz-task-id="${seg}" data-lz-current-tab="${current}"` +
    ` data-lz-live-token="t0" data-lz-live-keys='${JSON.stringify(stamped)}'>` +
    `<div class="lz-landing-header"><h1>Task</h1></div>` +
    strip +
    `<div data-lz-tab-bodies>${cells}</div>` +
    `</div>`
  );
}

/** What the server would answer for `?fragment=1&chrome=1[&body=0]`. */
function fragmentHtml(current: TaskTabId, withBody: boolean): string {
  const strip = taskTabStripHtml({ taskId: seg, current });
  return `<div class="lz-landing-header"><h1>Task</h1></div>${strip}` +
    (withBody ? bodyHtml(current, 'new') : '');
}

interface Harness {
  win: InstanceType<typeof Window>;
  doc: Document;
  /** Requests the island made, in order. */
  seen: string[];
}

interface SetupOptions {
  /** Stamp strips/bodies with a segment other than the task id. */
  seg?: string;
  /** Land the window on a path other than the canonical one. */
  entryPath?: string;
}

function setup(current: TaskTabId, stamped: Keys, bodies: TaskTabId[], served: Keys, opts: SetupOptions = {}): Harness {
  seg = opts.seg ?? TASK;
  const path = opts.entryPath ?? (current === 'landing' ? `/tasks/${seg}` : `/tasks/${seg}/${current}`);
  const win = new Window({ url: `http://localhost${path}` });
  const doc = win.document as unknown as Document;
  doc.body.innerHTML = pageHtml(current, stamped, bodies);

  const seen: string[] = [];
  const w = win as unknown as Record<string, unknown>;
  // The island schedules its first poll 3s out. Collapse long waits so the
  // test drives the real code path without a real three-second sleep.
  const realSetTimeout = win.setTimeout.bind(win);
  w.setTimeout = ((fn: () => void, ms?: number) =>
    realSetTimeout(fn, ms && ms > 40 ? 1 : (ms ?? 0))) as unknown;
  w.fetch = ((url: string) => {
    seen.push(url);
    if (url.indexOf('/live-status') !== -1) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ token: 't1', keys: served, status: 'working', progress: null }),
      });
    }
    const wantBody = url.indexOf('body=0') === -1;
    return Promise.resolve({ ok: true, text: () => Promise.resolve(fragmentHtml(current, wantBody)) });
  }) as unknown;

  const strip = (s: string) => s.replace(/^<script>/, '').replace(/<\/script>$/, '');
  (win as unknown as { eval(c: string): void }).eval(strip(domMorphScript()));
  (win as unknown as { eval(c: string): void }).eval(strip(taskLiveStatusScript()));
  return { win, doc, seen };
}

/** Wait for a condition the island reaches asynchronously. */
async function until(fn: () => boolean, what: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const visibleBody = (h: Harness) => h.doc.querySelector('[data-lz-tab-body]:not([hidden])');
const tabLink = (h: Harness, tab: string) => h.doc.querySelector(`a[data-lz-tab="${tab}"]`);

let harness: Harness | null = null;
beforeEach(() => { harness = null; });
afterEach(async () => {
  if (harness) await harness.win.happyDOM.close();
});

describe('a change the reader was offered but did not take', () => {
  /**
   * Sequence 1 — the declined pill. Changes is `pill` policy, so the body is
   * never swapped under the reader. If ignoring the pill also cleared the
   * tab's staleness, switching away and back showed the pre-change diff.
   */
  test('a pill tab stays stale, and the dot appears once the reader leaves it', async () => {
    const h = setup('changes', keys(), ['changes', 'subtasks'], keys({ changes: 'v1' }));
    harness = h;

    await until(() => !!h.doc.querySelector('[data-lz-live-pill]:not([hidden])'), 'the reload pill');
    expect(h.doc.querySelector('[data-lz-live-pill]')?.textContent).toBe('Changes updated — reload');

    // A pill tab is never fetched with a body — that is the point of body=0.
    expect(h.seen.some((u) => u.indexOf('body=0') !== -1)).toBe(true);

    // The body was NOT patched, so it must be marked behind.
    await until(() => visibleBody(h)?.hasAttribute('data-lz-stale') === true, 'the stale marker');
    expect(visibleBody(h)?.textContent).toBe('old');

    // While the reader is ON the tab the pill is the affordance, so no dot.
    expect(tabLink(h, 'changes')?.hasAttribute('data-lz-stale')).toBe(false);

    // They ignore it and switch away — exactly what the tab-switch island does.
    h.doc.querySelector('[data-lz-task-page]')?.setAttribute('data-lz-current-tab', 'subtasks');
    (h.win as unknown as { lzLiveRegions: { tabShown(t: string): void } })
      .lzLiveRegions.tabShown('subtasks');

    // Now it is a tab they are not reading, so it wears the dot — and the
    // cached body is still marked, so the switch back refetches it.
    expect(tabLink(h, 'changes')?.hasAttribute('data-lz-stale')).toBe(true);
    expect(h.doc.querySelector('[data-lz-tab-path="/tasks/task-1/changes"]')
      ?.hasAttribute('data-lz-stale')).toBe(true);
  });

  /**
   * Sequence 2 — the dropped deferral. The reader scrolled within the guard
   * window, so the fetched body is parked rather than applied. If they switch
   * tabs, `flushDeferred` throws the fragment away because the path changed —
   * which is fine ONLY because the tab is marked stale here.
   */
  test('an update held back by the interaction guard leaves the tab stale', async () => {
    const h = setup('subtasks', keys(), ['subtasks', 'changes'], keys({ subtasks: 'v1' }));
    harness = h;
    // Scrolling in the last 2s is one of the three "reader is working here"
    // signals; the island listens in the capture phase on window.
    h.win.dispatchEvent(new h.win.Event('scroll'));

    await until(() => !!h.doc.querySelector('[data-lz-live-pill]:not([hidden])'), 'the defer pill');
    expect(h.doc.querySelector('[data-lz-live-pill]')?.textContent).toBe('Updated — tap to refresh');

    // Held back, not applied — and marked so the switch-time refetch heals it.
    expect(visibleBody(h)?.textContent).toBe('old');
    expect(visibleBody(h)?.hasAttribute('data-lz-stale')).toBe(true);

    h.doc.querySelector('[data-lz-task-page]')?.setAttribute('data-lz-current-tab', 'changes');
    (h.win as unknown as { lzLiveRegions: { tabShown(t: string): void } })
      .lzLiveRegions.tabShown('changes');
    expect(tabLink(h, 'subtasks')?.hasAttribute('data-lz-stale')).toBe(true);
  });

  /** The other half of the rule: patching the body DOES clear the marker. */
  test('a morph that actually lands clears the marker and the dot', async () => {
    const h = setup('subtasks', keys(), ['subtasks', 'changes'], keys({ subtasks: 'v1' }));
    harness = h;

    await until(() => visibleBody(h)?.textContent === 'new', 'the morphed body');
    expect(visibleBody(h)?.hasAttribute('data-lz-stale')).toBe(false);

    h.doc.querySelector('[data-lz-task-page]')?.setAttribute('data-lz-current-tab', 'changes');
    (h.win as unknown as { lzLiveRegions: { tabShown(t: string): void } })
      .lzLiveRegions.tabShown('changes');
    expect(tabLink(h, 'subtasks')?.hasAttribute('data-lz-stale')).toBe(false);
  });

  /**
   * A tab whose own regions did not move is not touched either way — it must
   * not be marked stale just because some other region changed.
   */
  test('an unrelated region does not mark the tab being read', async () => {
    const h = setup('subtasks', keys(), ['subtasks', 'changes'], keys({ journal: 'v1' }));
    harness = h;

    await until(() => h.seen.length >= 2, 'the chrome fetch');
    expect(visibleBody(h)?.hasAttribute('data-lz-stale')).toBe(false);
    expect(h.doc.querySelector('[data-lz-live-pill]:not([hidden])')).toBeNull();
  });
});

describe('the strip keeps badges a body-less render could not compute', () => {
  /**
   * INVARIANT: a `body=0` poll must never DROP a badge. It renders the strip
   * without the data the omitted body would have loaded, so the region count
   * and the Verify x/y are absent from it — and an absent badge reads as
   * "none", which is worse than a slightly stale number.
   */
  test('a badge missing from the incoming strip is carried forward', async () => {
    const h = setup('changes', keys(), ['changes'], keys({ changes: 'v1' }));
    harness = h;
    // Stand in for the server-rendered "N queued" the poll render omits.
    const review = tabLink(h, 'review')!;
    const badge = h.doc.createElement('span');
    badge.className = 'lz-tab-badge';
    badge.textContent = '2';
    review.appendChild(badge);

    await until(() => !!h.doc.querySelector('[data-lz-live-pill]:not([hidden])'), 'the poll to land');
    // The strip was replaced by one rendered without review comments.
    expect(tabLink(h, 'review')?.querySelector('.lz-tab-badge')?.textContent).toBe('2');
  });
});

describe('a deferral parked under one URL spelling flushes under the other', () => {
  /**
   * INVARIANT: a deferred update is parked for a TAB (its canonical segment —
   * `data-lz-task-id`, the same value the bodies and links are stamped with),
   * never for a URL spelling. The task page is reachable at /tasks/<code> AND
   * /tasks/<id>, and the reader moving between spellings of the SAME tab
   * (history Back onto an id-spelled entry, say) is still exactly in place to
   * receive the parked update — dropping it there would silently lose a
   * change the pill promised, with the reader watching the tab.
   *
   * The mixed-spelling world needs a code-unique task: the page (strip,
   * bodies, data-lz-task-id) is stamped with the code, while the reader's
   * address is the id spelling. The park happens on the id address (the
   * reader was busy); they then move to the code-spelled entry of the same
   * tab; the flush retries every defer tick while the reader stays busy, and
   * the moment they stop, the parked update must APPLY here — under the old
   * address keying it was dropped instead.
   */
  test('an update parked on a /tasks/<uuid> address still applies on the code-spelled entry of the same tab', async () => {
    const h = setup('subtasks', keys(), ['subtasks', 'changes'], keys({ subtasks: 'v1' }), {
      seg: 'share-a-fix',
      entryPath: `/tasks/${UUID}/subtasks`,
    });
    harness = h;
    const w = h.win as unknown as Record<string, unknown>;

    // The reader is working here — scrolling is one of the busy signals, and
    // a busy reader parks the fetched body behind a pill.
    (w.dispatchEvent as ((ev: unknown) => void) | undefined)?.(new h.win.Event('scroll'));
    await until(() => !!h.doc.querySelector('[data-lz-live-pill]:not([hidden])'), 'the defer pill');
    expect(visibleBody(h)?.textContent).toBe('old');

    // They go Back onto the other spelling of the SAME tab while still busy:
    // location changes, the tab does not. (pushState stands in for the
    // history move: identical location state, no island involvement.)
    (w.history as { pushState(s: unknown, t: string, url: string): void } | null)?.pushState({}, '', '/tasks/share-a-fix/subtasks');
    // Returning to the tab is one of the island's flush triggers.
    (w.dispatchEvent as ((ev: unknown) => void) | undefined)?.(new h.win.Event('visibilitychange'));

    // The parked update lands the moment the reader stops being busy — the
    // same body, morphed in place, not dropped and not re-fetched.
    await until(() => visibleBody(h)?.textContent === 'new', 'the parked update to flush', 5000);
    expect(visibleBody(h)?.hasAttribute('data-lz-stale')).toBe(false);
    expect(h.doc.querySelectorAll(`[data-lz-tab-path="/tasks/share-a-fix/subtasks"]`).length).toBe(1);
  });

  // INVARIANT: `data-lz-task-id` carries the URL-ESCAPED segment (a code with
  // a space reads `my%20task`); the island's poll must interpolate it raw.
  // Re-escaping it builds /tasks/my%2520task/live-status — a different
  // address that 404s. Pinned behaviorally through the fetch-capture seam.
  test('the poll URL interpolates an escaped space-code segment raw', async () => {
    const h = setup('subtasks', keys(), ['subtasks', 'changes'], keys({ subtasks: 'v1' }), {
      seg: 'my%20task',
    });
    harness = h;
    await until(() => h.seen.some((u) => u.indexOf('/tasks/my%20task/live-status') !== -1), 'the poll');
    expect(h.seen.some((u) => u.indexOf('my%2520task') !== -1)).toBe(false);
  });
});
