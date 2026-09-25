/**
 * A tab body's identity is CANONICAL (the task's segment — code when unique,
 * id otherwise, the server's own `data-lz-task-id` / `data-lz-tab-path`
 * spelling), never the browser address. The task page is reachable at both
 * `/tasks/<code>` and `/tasks/<id>` — an id permalink resolves by design, and
 * a code shared by two tasks falls back to the id — so the SAME task can be
 * entered under either spelling while every tab link spells the canonical
 * segment.
 *
 * INVARIANT: the client tab island's tab-body identity must be canonical, or
 * a `/tasks/<uuid>` landing breaks the whole island on the first tab
 * round-trip: the strip's links spell `/tasks/<code>/...`, the landing body
 * (and the reading-position keys) were stamped from `location.pathname`, the
 * cache lookup misses, and `applyFragment` appends a SECOND landing body and
 * hides the original — taking the live terminal (the services-down notice),
 * half-typed drafts and the reading position with it. The server already
 * renders canonical stamps (task-page.ts renders `data-lz-tab-path` from
 * `taskPathSegment`'s result), so the fix is that the island keeps them, and
 * canonicalizes anything address-derived before comparing. History entries
 * keep their own spelling (the address bar is never rewritten — the uuid
 * permalink keeps resolving).
 *
 * This drives the SHIPPED island (`taskTabSwitchScript`) in a real DOM, in the
 * `setupRealSwitchPage` style (services-shell-in-place.test.ts), with the real
 * tab strip and a mocked fragment fetch — not a hand-rolled stand-in, because
 * the defect lives in exactly those lookup lines. The page markup has NO
 * pre-built `[data-lz-tab-bodies]` host, matching what the server really
 * renders: `hostEl()` creates the host on first run, and that is where the
 * wrong stamp used to land.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { Window } from 'happy-dom';
import { taskTabSwitchScript, taskTabStripHtml } from '../../src/server/task-tabs';
import { taskLiveStatusScript } from '../../src/server/task-live-status';

// A task whose code is unique: every rendered link spells the code, while the
// entry spelling (what the reader typed, bookmarked, or went Back to) may be
// the uuid.
const CODE = 'share-a-fix';
const UUID = '3f9c1c2e-9d4a-4b8f-a1c2-5e6f7089a1b2';

function stripTag(s: string): string {
  return s.replace(/^<script>/, '').replace(/<\/script>$/, '');
}

/**
 * What the server renders for a fragment request: strip + body, both stamped
 * with the CANONICAL segment (task-page.ts renders these from
 * `taskPathSegment`'s result, whatever spelling the request used).
 */
function fragmentHtml(current: 'landing' | 'turns', landingInner: string): string {
  const isTurns = current === 'turns';
  const path = isTurns ? `/tasks/${CODE}/turns` : `/tasks/${CODE}`;
  const body = isTurns ? '<p id="turns-copy">turns</p>' : landingInner;
  return (
    taskTabStripHtml({ taskId: CODE, current }) +
    `<div class="lz-tab-body" data-lz-tab-body data-lz-tab-path="${path}">${body}</div>`
  );
}

/**
 * The landing body arrives with the SERVER's canonical stamp already on it —
 * that is the stamp `hostEl()` must keep rather than overwrite with
 * `location.pathname`.
 */
function pageHtml(landingInner: string): string {
  return (
    `<div data-lz-task-page data-lz-task-id="${CODE}" data-lz-current-tab="landing">` +
    `<div class="lz-landing-header"><h1>Task</h1></div>` +
    taskTabStripHtml({ taskId: CODE, current: 'landing' }) +
    `<div class="lz-tab-body" data-lz-tab-body data-lz-tab-path="/tasks/${CODE}">${landingInner}</div>` +
    `</div>`
  );
}

interface Harness {
  win: InstanceType<typeof Window>;
  doc: Document;
  /** Fragment requests the island made, in order. */
  seen: string[];
}

/**
 * `entrySpelling` is the window's address — the spelling the reader LANDED
 * on. It is deliberately allowed to differ from the canonical segment.
 */
function setup(entrySpelling: string, landingInner = '<p id="landing-copy">landing</p>'): Harness {
  const win = new Window({
    url: `http://localhost/tasks/${entrySpelling}`,
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
    },
  });
  const doc = win.document as unknown as Document;
  doc.body.innerHTML = pageHtml(landingInner);

  const seen: string[] = [];
  const w = win as unknown as Record<string, unknown>;
  w.fetch = ((url: string) => {
    seen.push(url);
    const isTurns = url.indexOf('/turns') !== -1;
    return Promise.resolve({
      ok: true,
      text: () => Promise.resolve(fragmentHtml(isTurns ? 'turns' : 'landing', landingInner)),
    });
  }) as unknown;

  (win as unknown as { eval(c: string): void }).eval(stripTag(taskTabSwitchScript()));
  return { win, doc, seen };
}

async function until(fn: () => boolean, what: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

let harness: Harness | null = null;
afterEach(async () => {
  if (harness) await harness.win.happyDOM.close();
  harness = null;
});

const landingBodies = (doc: Document) =>
  doc.querySelectorAll(`[data-lz-tab-body][data-lz-tab-path="/tasks/${CODE}"]`);

describe('a tab body\u2019s identity is canonical (data-lz-task-id), not the address', () => {
  test('hostEl keeps the server\u2019s canonical landing stamp on a /tasks/<uuid> entry', () => {
    harness = setup(UUID);
    const doc = harness.doc;
    const landing = doc.querySelector('[data-lz-tab-body]') as HTMLElement;
    // The one stamp every lookup compares against — pre-fix, hostEl overwrote
    // it with the address here, and every round-trip lookup missed.
    expect(landing.getAttribute('data-lz-tab-path')).toBe(`/tasks/${CODE}`);
  });

  test('a uuid-permalink landing survives a tab round-trip as ONE body — the original', async () => {
    harness = setup(UUID);
    const doc = harness.doc;
    const original = doc.querySelector('[data-lz-tab-body]') as HTMLElement;
    const w = harness.win as unknown as Record<string, unknown>;

    (doc.querySelector('a[data-lz-tab="turns"]') as HTMLElement).click();
    await until(
      () => doc.querySelector(`[data-lz-tab-path="/tasks/${CODE}/turns"]`)?.hasAttribute('hidden') === false,
      'the turns switch to land',
    );
    // History keeps each entry's own spelling: the click pushes the link's
    // (canonical) spelling — the address is never rewritten.
    expect((harness.win as unknown as { location: { pathname: string } }).location.pathname).toBe(
      `/tasks/${CODE}/turns`,
    );

    (doc.querySelector('a[data-lz-tab="landing"]') as HTMLElement).click();
    await until(
      () => original.hasAttribute('hidden') === false,
      'the landing round-trip to land',
    );

    // Exactly ONE landing body, and it is the ORIGINAL node — a second
    // appended landing body would have hidden the original, with any live
    // terminal, half-typed drafts and the reading position in it.
    const bodies = doc.querySelectorAll(`[data-lz-tab-body][data-lz-tab-path="/tasks/${CODE}"]`);
    expect(bodies.length).toBe(1);
    expect(bodies[0]).toBe(original as never);
    expect(doc.querySelectorAll('[data-lz-tab-body]').length).toBe(2);
    expect((doc.querySelector(`[data-lz-tab-path="/tasks/${CODE}/turns"]`) as HTMLElement).hidden).toBe(true);
  });

  test('the popstate replay of a /tasks/<uuid> history entry resolves to the same cached body', async () => {
    harness = setup(UUID);
    const doc = harness.doc;
    const original = doc.querySelector('[data-lz-tab-body]') as HTMLElement;
    const w = harness.win as unknown as Record<string, unknown>;

    // Land on Turns, then go "Back" to the initial uuid-spelled entry: the
    // browser rewrites location FIRST (pushState here), then the island's
    // popstate handler calls switchTo with it, push=false.
    (doc.querySelector('a[data-lz-tab="turns"]') as HTMLElement).click();
    await until(
      () => doc.querySelector(`[data-lz-tab-path="/tasks/${CODE}/turns"]`)?.hasAttribute('hidden') === false,
      'the turns switch to land',
    );
    (w.history as { pushState(s: unknown, t: string, url: string): void } | null)?.pushState({}, '', `/tasks/${UUID}`);
    (w.lzSwitchTaskTab as (href: string, push: boolean) => void)?.(`/tasks/${UUID}`, false);
    await until(
      () => original.hasAttribute('hidden') === false,
      'the uuid-spelled switch to land',
    );

    const bodies = doc.querySelectorAll(`[data-lz-tab-body][data-lz-tab-path="/tasks/${CODE}"]`);
    expect(bodies.length).toBe(1);
    expect(bodies[0]).toBe(original as never);
    // The uuid entry stays a permalink: the island never rewrote the address.
    expect((harness.win as unknown as { location: { pathname: string } }).location.pathname).toBe(
      `/tasks/${UUID}`,
    );
  });

  test('a code-spelled landing survives the same round-trip (the mirror entry spelling)', async () => {
    harness = setup(CODE);
    const doc = harness.doc;
    const original = doc.querySelector('[data-lz-tab-body]') as HTMLElement;

    (doc.querySelector('a[data-lz-tab="turns"]') as HTMLElement).click();
    await until(
      () => doc.querySelector(`[data-lz-tab-path="/tasks/${CODE}/turns"]`)?.hasAttribute('hidden') === false,
      'the turns switch to land',
    );
    (doc.querySelector('a[data-lz-tab="landing"]') as HTMLElement).click();
    await until(
      () => original.hasAttribute('hidden') === false,
      'the landing round-trip to land',
    );

    const bodies = doc.querySelectorAll(`[data-lz-tab-body][data-lz-tab-path="/tasks/${CODE}"]`);
    expect(bodies.length).toBe(1);
    expect(bodies[0]).toBe(original as never);
  });

  test('clicking the current tab\u2019s link on a uuid entry is a no-op, address unchanged', async () => {
    harness = setup(UUID);
    const doc = harness.doc;
    const w = harness.win as unknown as Record<string, unknown>;

    (doc.querySelector('a[data-lz-tab="landing"]') as HTMLElement).click();
    await until(() => false, 'nothing', 1).catch(() => undefined);

    // The strip spells /tasks/<code> while the reader is on /tasks/<uuid> —
    // the same tab under two spellings. No fetch, no history entry, no
    // address rewrite: the reader is already there.
    expect(harness.seen.length).toBe(0);
    expect((harness.win as unknown as { location: { pathname: string } }).location.pathname).toBe(
      `/tasks/${UUID}`,
    );
  });

  test('the reading position survives a refetched landing after the spelling change', async () => {
    const landingInner =
      '<section class="rv-viewable" data-viewed-key="sec-3"><p>report</p></section>';
    harness = setup(UUID, landingInner);
    const doc = harness.doc;
    // The reader scrolled to sec-3 before a background change marked the body
    // stale (the live island's doing — pinned independently there).
    const original = doc.querySelector('[data-lz-tab-body]') as HTMLElement;
    original.setAttribute('data-lz-stale', '1');
    (original.querySelector('[data-viewed-key="sec-3"]') as HTMLElement).setAttribute('data-current', '');

    (doc.querySelector('a[data-lz-tab="turns"]') as HTMLElement).click();
    await until(
      () => doc.querySelector(`[data-lz-tab-path="/tasks/${CODE}/turns"]`)?.hasAttribute('hidden') === false,
      'the turns switch to land',
    );
    (doc.querySelector('a[data-lz-tab="landing"]') as HTMLElement).click();
    await until(
      () =>
        doc.querySelector(`[data-lz-tab-body][data-lz-tab-path="/tasks/${CODE}"]`) !== null &&
        (doc.querySelector(`[data-lz-tab-body][data-lz-tab-path="/tasks/${CODE}"]`) as HTMLElement)
          .hasAttribute('data-lz-stale') === false,
      'the refetched landing to land',
    );

    // The stale body was dropped and refetched, so the SERVER's render (the
    // mock's fragment marks NO section current) is on screen — the position
    // survives only because rememberCurrent/restoreCurrent keyed the tab
    // canonically: sec-3 is re-marked on the fresh body, and nothing else.
    const fresh = doc.querySelector(`[data-lz-tab-body][data-lz-tab-path="/tasks/${CODE}"]`) as HTMLElement;
    expect(fresh).not.toBe(original as never);
    expect(fresh.querySelectorAll('[data-current]').length).toBe(1);
    expect(fresh.querySelector('[data-viewed-key="sec-3"]')?.hasAttribute('data-current')).toBe(true);
  });
});

describe('the canonical-identity helper is one rule in both islands', () => {
  // INVARIANT: `canonicalTaskPath` is the ONE identity rule the task page's
  // islands share — the tab switcher (cache lookups, same-place guard,
  // reading position) and the live island (deferred-update park + flush)
  // must canonicalize the same way or a mixed spelling breaks exactly one of
  // them. The two scripts are self-contained template literals (no shared
  // runtime to import from), so this pins the duplicated helper VERBATIM in
  // both: edit one, the test names the other.
  const CANONICAL_HELPER = `function canonicalTaskPath(path) {
    var p = page();
    if (!p) return path;
    var seg = p.getAttribute('data-lz-task-id');
    if (!seg) return path;
    var m = path.match(/^\\/tasks\\/([^\\/?#]*)(.*)$/);
    if (!m) return path;
    return '/tasks/' + seg + (m[2] || '');
  }`;

  test('the tab switcher and the live island carry it verbatim', () => {
    expect(taskTabSwitchScript()).toContain(CANONICAL_HELPER);
    expect(taskLiveStatusScript()).toContain(CANONICAL_HELPER);
  });
});