/**
 * The closed set of task-page tabs, their URLs, the strip, and the in-place
 * switching island.
 *
 * WHY A CLOSED SET
 * `/tasks/:id/<slug>` is both a tab and a place later leaves nest
 * (`/turns/3`, `/shell/ws`). A future `/tasks/:id/artifacts` must not quietly
 * become a tab, and a tab slug must not collide with a non-tab first segment
 * (`edit`, `actions`, `prompts`, …). The unit test in
 * `test/unit/task-tabs.test.ts` pins both: the slug list is this array, and
 * it is disjoint from the reserved non-tab first segments.
 *
 * `turns`, `shell`, `commits` and `comments` appear as tabs that also host a
 * leaf (`/turns/:seq`, `/shell/ws`, `/commits/:id`, `/comments/add`). The
 * disjoint check is on first segments that are ONLY leaves — those four are
 * tabs, not in TASK_NON_TAB_SEGMENTS.
 *
 * Landing has no slug: it is the bare `/tasks/:id`.
 */

// Value import; task-live-regions imports only the TaskTabId TYPE back, so the
// cycle is erased at runtime.
import { TASK_TAB_REGIONS, TASK_TAB_POLICY } from './task-live-regions';
import { escapeHtml } from './escape';

export const TASK_TAB_SLUGS = [
  'regions',
  'changes',
  'verify',
  'turns',
  'commits',
  'reviews',
  'subtasks',
  'raised',
  'comments',
  'journal',
  'stats',
  'shell',
  'services',
  'review',
] as const;

export type TaskTabSlug = (typeof TASK_TAB_SLUGS)[number];

/** Landing is the bare path; every other tab has a slug. */
export type TaskTabId = 'landing' | TaskTabSlug;

/**
 * First path segments under `/tasks/:id/` that are NOT tabs.
 *
 * `turns`, `shell`, `commits` and `comments` are omitted: they are tabs that
 * also host a leaf (`turns/:seq`, `shell/ws`, `commits/:id`, `comments/add`).
 */
export const TASK_NON_TAB_SEGMENTS = [
  'edit',
  'prompts',
  'actions',
  'container',
  'watch',
  'live-status',
] as const;

export type TaskNonTabSegment = (typeof TASK_NON_TAB_SEGMENTS)[number];

/**
 * The leaf (and redirect) routes a future tab must not shadow.
 *
 * Named the way the design doc names them so the unit test can assert this
 * list is exactly those paths, not a paraphrase.
 */
export const TASK_NON_TAB_ROUTES = [
  'edit',
  'turns/:seq',
  'commits/:id',
  'prompts/:version',
  'actions/:verb',
  'container/start',
  'container/ensure',
  'container/state',
  'comments/add',
  'comments/:commentId/edit',
  'shell/ws',
  'watch/ws',
  'live-status',
] as const;

const TAB_SLUG_SET = new Set<string>(TASK_TAB_SLUGS);
const NON_TAB_SEGMENT_SET = new Set<string>(TASK_NON_TAB_SEGMENTS);

export function isTaskTabSlug(value: string): value is TaskTabSlug {
  return TAB_SLUG_SET.has(value);
}

export function isTaskNonTabSegment(value: string): value is TaskNonTabSegment {
  return NON_TAB_SEGMENT_SET.has(value);
}

/** Parse a tab id from the first segment after `/tasks/:id`, or null. */
export function parseTaskTabSegment(segment: string | undefined): TaskTabId | null {
  if (segment === undefined || segment === '') return 'landing';
  if (isTaskTabSlug(segment)) return segment;
  return null;
}

/**
 * @param segment the task's URL segment — code or id, already URL-escaped by
 *   {@link ./task-urls.ts | task-urls}'s `taskPathSegment` (callers pass it so
 *   the duplicate-code fallback is decided in ONE place, not here).
 */
export function taskTabHref(segment: string, tab: TaskTabId): string {
  return tab === 'landing' ? `/tasks/${segment}` : `/tasks/${segment}/${tab}`;
}

/** Old review-page URL → new tab URL. Path only; caller keeps the query. */
export function relocatedReviewPath(oldPath: string): string | null {
  // `/review` (the queue) and `/api/review/...` do not move.
  const match = oldPath.match(/^\/review\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  const taskId = match[1];
  const rest = match[2] ?? '';
  return `/tasks/${taskId}/review${rest}`;
}

/**
 * A review action (form POST or fetch) under the Current review tab.
 *
 * `rest` is the suffix after the tab (`/draft`, `/unblock`, `/comment/x/withdraw`).
 * The JSON API at `/api/review/:id/…` does not use this — those paths stay put.
 */
/**
 * @param segment the task's URL segment (code or id, already URL-escaped) —
 *   see {@link taskTabHref}.
 */
export function reviewActionPath(segment: string, rest: string = ''): string {
  const suffix = rest === '' || rest.startsWith('/') ? rest : `/${rest}`;
  return `/tasks/${segment}/review${suffix}`;
}

export interface TaskTabBadge {
  /** Visible badge text, e.g. `2` or `3/5`. Empty/undefined = no badge. */
  text?: string;
  /** Extra meaning for a screen reader, when the visible text is terse. */
  title?: string;
}

export interface TaskTabStripInput {
  /** The task's URL segment (code or id, already URL-escaped) — see task-urls. */
  taskId: string;
  current: TaskTabId;
  /**
   * Hide the Shell tab on a runner with no container — the capability does
   * not exist, same refusal `lazy shell --container` gives.
   */
  hideShell?: boolean;
  /** Cheap counts from the task summary. Missing = no badge. */
  badges?: Partial<Record<TaskTabId, TaskTabBadge>>;
}

const TAB_LABELS: Record<TaskTabId, string> = {
  landing: 'Summary',
  regions: 'Regions',
  changes: 'Changes',
  verify: 'Verify',
  turns: 'Turns',
  commits: 'Commits',
  reviews: 'Reviews',
  subtasks: 'Subtasks',
  raised: 'Raised',
  comments: 'Comments',
  journal: 'Journal',
  stats: 'Stats',
  shell: 'Shell',
  services: 'Services',
  review: 'Current review',
};

/**
 * Reading order. Current review is last, set apart by a separator.
 *
 * **Regions comes BEFORE Changes, and Verify before both.** That is the
 * reading order a reviewer actually wants on a large branch: what was I asked
 * to check (Verify), what units of work are in here (Regions), and only then
 * the diff itself (Changes). Regions used to be a strip buried at the top of
 * Changes, which put the map after the territory.
 *
 * Fifteen tabs, nine digit keys (1–9). Services, Reviews, Commits, Comments,
 * Journal and Stats have no number — less visited than Shell / Current review,
 * and `[` / `]` still reach them. Keys stay stable when Shell is hidden (its
 * index is reserved).
 *
 * Stats sits after Journal: it is an insight surface read on purpose, not a
 * step in reviewing a task, so it must not push Shell or Current review
 * around — and it takes no digit key for the same reason.
 */
export const TASK_TAB_ORDER: readonly TaskTabId[] = [
  'landing',
  'verify',
  'regions',
  'changes',
  'turns',
  'commits',
  'reviews',
  'subtasks',
  'raised',
  'comments',
  'journal',
  'stats',
  'shell',
  'services',
  'review',
];

/**
 * Digit-key index (0 → key "1", …, 8 → key "9") for each tab that has one.
 *
 * Services, Reviews, Commits, Comments, Journal and Stats are omitted on
 * purpose — see TASK_TAB_ORDER. Commits lost its number when Regions gained
 * one: there are nine digits and more tabs than that, and a per-commit list is
 * the one a reviewer reaches for least often.
 */
export const TASK_TAB_KEY_INDEX: Readonly<Partial<Record<TaskTabId, number>>> = {
  landing: 0,
  verify: 1,
  regions: 2,
  changes: 3,
  turns: 4,
  subtasks: 5,
  raised: 6,
  shell: 7,
  review: 8,
};

// One escaper for both positions. The two partial ones that used to live here
// (attribute: no `'`; text: no quotes at all) were correct for the position
// they were written for and a hole for the next call site that reached for the
// wrong one.
const escapeAttr = escapeHtml;
const escapeText = escapeHtml;

/**
 * The tab strip: real links, so JS-off is a real navigation. The island
 * intercepts clicks when scripting is on.
 *
 * The strip WRAPS: tabs that do not fit take another row rather than
 * disappearing off the right edge (see tabs.css). Every tab, Current review
 * included, is a direct child of the strip — an inner container of its own
 * would be a full-width flex line and would push Current review onto a row by
 * itself even when the whole strip fits on one.
 */
export function taskTabStripHtml(input: TaskTabStripInput): string {
  const tabs = TASK_TAB_ORDER.filter((tab) => !(tab === 'shell' && input.hideShell));
  const main = tabs.filter((t) => t !== 'review');
  const review = tabs.includes('review') ? 'review' : null;

  const item = (tab: TaskTabId): string => {
    const href = taskTabHref(input.taskId, tab);
    const current = tab === input.current;
    const badge = input.badges?.[tab];
    const badgeHtml = badge?.text
      ? ` <span class="lz-tab-badge"${badge.title ? ` title="${escapeAttr(badge.title)}"` : ''}>${escapeText(badge.text)}</span>`
      : '';
    const keyIndex = TASK_TAB_KEY_INDEX[tab];
    const keyAttr = keyIndex !== undefined ? ` data-lz-tab-index="${keyIndex}"` : '';
    const titleSuffix = keyIndex !== undefined ? ` (${keyIndex + 1})` : '';
    // Live-update contract, stamped per tab so the poll island never has to
    // know which tabs exist: which regions make this body stale, and how it is
    // allowed to be brought up to date. A new tab registers by adding a row to
    // the two maps in task-live-regions.ts.
    const regions = TASK_TAB_REGIONS[tab] ?? [];
    const liveAttrs =
      ` data-lz-tab-regions="${escapeAttr(regions.join(' '))}"` +
      ` data-lz-tab-policy="${TASK_TAB_POLICY[tab]}"`;
    return (
      `<a class="lz-tab${current ? ' lz-tab-current' : ''}${tab === 'review' ? ' lz-tab-review' : ''}"` +
      ` href="${escapeAttr(href)}"` +
      ` data-lz-tab="${tab}"` +
      keyAttr +
      liveAttrs +
      ` title="${escapeAttr(TAB_LABELS[tab])}${titleSuffix}"` +
      (current ? ' aria-current="page"' : '') +
      `>${escapeText(TAB_LABELS[tab])}${badgeHtml}</a>`
    );
  };

  return (
    `<nav class="lz-tabs" data-lz-tab-strip aria-label="Task sections">` +
    main.map((tab) => item(tab)).join('') +
    (review ? item(review) : '') +
    `</nav>`
  );
}

/**
 * In-place tab switching. A real navigation closes every open web shell
 * (`beforeunload` → `closeAll`); this island is what keeps a running
 * verification alive when the reviewer clicks from Verify to Changes.
 *
 * Fetches the same URL with `?fragment=1` so there is one renderer per tab.
 * Back/forward replay the swap. Per-tab `data-current` is kept in memory and
 * restored on return — a reading position, not review progress.
 *
 * Tab bodies are cached (hidden, not replaced). A live terminal mounted under
 * a verification step lives in the Verify tab body; replacing that node would
 * destroy the session. A full navigation still closes every shell.
 */
export function taskTabSwitchScript(): string {
  return `<script>
(function () {
  var ROOT = '[data-lz-task-page]';
  var STRIP = '[data-lz-tab-strip]';
  var BODY = '[data-lz-tab-body]';
  var HOST = '[data-lz-tab-bodies]';
  // Reading position per tab href, unpersisted — same rule as the nav island.
  var currentByTab = {};

  function page() { return document.querySelector(ROOT); }

  // A tab body's identity is the task's CANONICAL segment — the code when the
  // code is unique, the id otherwise, the same value the server stamps into
  // data-lz-task-id and every data-lz-tab-path (task-page.ts) — never the
  // browser address. The task page is reachable at BOTH /tasks/<code> and
  // /tasks/<id> (an id permalink resolves; a code shared by two tasks falls
  // back to the id), and comparing a code-spelled link against a uuid-stamped
  // body — or the reverse — is exactly what made the first round-trip append
  // a second landing body and hide the original, with any live terminal,
  // drafts and the reading position in it. History entries keep their own
  // spelling (the address bar is never rewritten), so every comparison below
  // goes through this: swap the first /tasks/ segment for data-lz-task-id,
  // keep the rest. Keep in sync with the same helper in task-live-status.ts.
  function canonicalTaskPath(path) {
    var p = page();
    if (!p) return path;
    var seg = p.getAttribute('data-lz-task-id');
    if (!seg) return path;
    var m = path.match(/^\\/tasks\\/([^\\/?#]*)(.*)$/);
    if (!m) return path;
    return '/tasks/' + seg + (m[2] || '');
  }

  function hostEl() {
    var existing = document.querySelector(HOST);
    if (existing) return existing;
    var body = document.querySelector(BODY);
    if (!body) return null;
    var wrap = document.createElement('div');
    wrap.setAttribute('data-lz-tab-bodies', '');
    body.parentNode.insertBefore(wrap, body);
    wrap.appendChild(body);
    // The server stamps data-lz-tab-path from the task's canonical segment
    // (task-page.ts), and that stamp is the identity every applyFragment
    // lookup below compares against. Overwriting it with location.pathname
    // was the uuid-permalink bug: on a /tasks/<uuid> landing the body said
    // <uuid> while every tab link spelled <code>, the round-trip lookup
    // missed, and a second landing body was appended over the original. Only
    // a body with NO stamp at all (a hand-built page) falls back — to the
    // address canonicalized, so it agrees with every lookup either way.
    if (!body.getAttribute('data-lz-tab-path')) {
      body.setAttribute('data-lz-tab-path', canonicalTaskPath(location.pathname));
    }
    return wrap;
  }

  function rememberCurrent() {
    var p = page();
    if (!p) return;
    var href = canonicalTaskPath(location.pathname);
    var cur = document.querySelector('.rv-viewable[data-viewed-key][data-current]');
    if (cur && cur.getAttribute('data-viewed-key')) {
      currentByTab[href] = cur.getAttribute('data-viewed-key');
    }
  }

  function restoreCurrent() {
    var href = canonicalTaskPath(location.pathname);
    var key = currentByTab[href];
    if (!key) return;
    var section = document.querySelector('.rv-viewable[data-viewed-key="' + key.replace(/"/g, '\\\\"') + '"]');
    if (!section) return;
    var marked = document.querySelectorAll('[data-current]');
    for (var i = 0; i < marked.length; i++) marked[i].removeAttribute('data-current');
    section.setAttribute('data-current', '');
  }

  function fragmentUrl(href) {
    var url = new URL(href, location.origin);
    url.searchParams.set('fragment', '1');
    return url.pathname + url.search + url.hash;
  }

  // A <script> parsed into detached markup (innerHTML, DOMParser, ...) never
  // runs — the browser only executes a <script> it parses itself, or one it
  // sees inserted as a genuinely new node. So a tab-local island (one whose
  // <script> ships INSIDE the tab fragment, e.g. the diff toolbar) was dead
  // on any tab reached by an in-place switch rather than a full page load.
  // Re-creating each <script> node (rather than a hand-maintained re-init
  // registry) means a new tab-local island needs zero opt-in: it just works,
  // the same way it would on a full navigation.
  //
  // What this DOES guarantee: a body's own DOM (elements, and closures over
  // elements captured this run) is genuinely fresh every time — the body is
  // only ever appended once per fetch (there is exactly ONE call site, in
  // the !shown branch of applyFragment below), never reused across a re-run.
  //
  // What this does NOT guarantee: a script re-run every time its tab body is
  // refetched (first load, and every data-lz-stale refetch after) is free to
  // register on document or window, which OUTLIVE the body — and those
  // registrations are not once-per-body, they ADD UP. An island that needs a
  // page-lifetime document/window listener (not scoped to elements inside
  // its own body) must go through window.lzOnce, or live in the page-level
  // 'scripts' block instead (emitted once, on full load only — see
  // reviewScript, verifyRunScript) and delegate through document so it needs
  // no re-binding at all, ever.
  //
  // window.lzOnce itself is defined in templates.ts's layoutOpenHtml, not
  // here: this script sits in the task page's page-level 'scripts' block,
  // which renders AFTER the tab body in inner (see task-page.ts). Inline
  // scripts run in parse order, so defining lzOnce here would leave it
  // undefined for the whole first tab body's own <script>s on every full
  // page load — exactly the ordering bug this island exists to avoid
  // creating elsewhere. layoutOpenHtml runs first on every page, full stop.

  function activateScripts(container) {
    var scripts = container.querySelectorAll('script');
    for (var i = 0; i < scripts.length; i++) {
      var old = scripts[i];
      var fresh = document.createElement('script');
      for (var j = 0; j < old.attributes.length; j++) {
        fresh.setAttribute(old.attributes[j].name, old.attributes[j].value);
      }
      fresh.text = old.textContent;
      // A script running earlier in this same loop can rewrite the DOM
      // underneath a LATER one still in this static NodeList (a re-render
      // that replaces innerHTML, say) and detach it before its turn comes —
      // replaceChild on a parentless node throws, which would escape
      // applyFragment's caller and fall into switchTo's catch: a real
      // navigation that silently closes every open web shell.
      if (old.parentNode) old.parentNode.replaceChild(fresh, old);
    }
  }

  function applyFragment(html, href, push) {
    var wrap = document.createElement('div');
    wrap.innerHTML = html;
    var nextStrip = wrap.querySelector(STRIP);
    var nextBody = wrap.querySelector(BODY);
    var curStrip = document.querySelector(STRIP);
    if (!nextStrip || !nextBody || !curStrip) {
      location.href = href;
      return;
    }
    rememberCurrent();
    curStrip.replaceWith(nextStrip);
    var host = hostEl();
    // Canonical, not the address: the fetched fragment may have been asked
    // for by either spelling (a tab link, or the popstate handler replaying a
    // /tasks/<uuid> history entry), and the cache lookup below compares this
    // against the bodies' canonical stamps.
    var targetPath = canonicalTaskPath(new URL(href, location.origin).pathname);
    if (!host) {
      location.href = href;
      return;
    }
    // BEFORE the body swap / activateScripts below, not after: a freshly
    // activated island reads location synchronously while it initialises
    // (changesViewScript's read() consults location.search for ?view=), so
    // it has to see the URL it was fetched for, not the tab just left.
    if (push) history.pushState({ lzTab: href }, '', href);
    var bodies = Array.prototype.slice.call(host.querySelectorAll(BODY));
    var shown = null;
    for (var i = 0; i < bodies.length; i++) {
      var b = bodies[i];
      if (b.getAttribute('data-lz-tab-path') === targetPath) {
        // A cached body the live-status island marked stale is exactly what
        // the reader is switching to in order to see afresh — drop it and take
        // the fragment we just fetched. Refetching on SWITCH rather than
        // eagerly on every change is what keeps a background update cheap.
        //
        // Except a body hosting a live shell session (the down-service
        // notice's own terminal, on the landing tab): task-live-status.ts
        // tries hard never to stale-mark one of these, but this is the
        // backstop if it ever ends up stale anyway — dropping the node would
        // destroy a running PTY the reader cannot get back. Morph it instead,
        // which data-lz-live-children (dom-morph.ts) makes safe.
        if (b.hasAttribute('data-lz-stale')) {
          if (b.querySelector('.lz-shell-mount.is-live') && typeof window.lzMorph === 'function') {
            window.lzMorph(b, nextBody);
            b.removeAttribute('data-lz-stale');
            b.hidden = false;
            shown = b;
            continue;
          }
          b.remove();
          continue;
        }
        b.hidden = false;
        shown = b;
      } else {
        b.hidden = true;
      }
    }
    if (!shown) {
      nextBody.setAttribute('data-lz-tab-path', targetPath);
      nextBody.hidden = false;
      host.appendChild(nextBody);
      // nextBody is genuinely new to the document as of this line — its
      // <script> tags parsed inert and never ran. Bring its islands to life
      // exactly as a full page load would.
      activateScripts(nextBody);
    }
    var p = page();
    if (p) {
      var currentTab = nextStrip.querySelector('.lz-tab-current');
      if (currentTab) p.setAttribute('data-lz-current-tab', currentTab.getAttribute('data-lz-tab') || '');
      // The freshly rendered strip carries no stale dots. The live island owns
      // that state: tell it this tab is now read, then let it repaint the rest.
      if (currentTab) {
        callHook('lzLiveRegions.tabShown', function () {
          if (window.lzLiveRegions) window.lzLiveRegions.tabShown(currentTab.getAttribute('data-lz-tab') || '');
        });
      }
    }
    restoreCurrent();
    // New [data-rv-prose] blocks (the report, raised items, presentation
    // group summaries) arrived with this body unannotated: reviewScript's
    // "+" and anchors are added client-side, never in the server markup, so
    // without this a fragment lands with no comment affordance on its prose
    // and renderProseThreads drops any existing thread on it into the orphan
    // box (task-live-status.ts documents the same failure on its own path).
    callHook('lzAnnotateProse', function () { if (window.lzAnnotateProse) window.lzAnnotateProse(); });
    // A half-typed comment box's words live in the stored draft, not the DOM
    // (see reviewScript's "half-typed comments survive" note) — without this
    // they would not reappear on a fresh Changes body until the next 10s
    // poll, which is the never-lose-feedback rule in miniature.
    callHook('lzRestoreDrafts', function () { if (window.lzRestoreDrafts) window.lzRestoreDrafts(); });
    // A diagram in this body is un-rendered raw source until this runs —
    // only claims blocks it has not already enhanced, so it is safe to call
    // on every switch, not only the first.
    callHook('lzRefreshMermaid', function () { if (window.lzRefreshMermaid) window.lzRefreshMermaid(); });
    callHook('lzRefreshViewable', function () { if (window.lzRefreshViewable) window.lzRefreshViewable(); });
    // The strip was just replaced, so the height the sticky card headers park
    // under is re-measured (see review-navigation.ts).
    callHook('lzRefreshStickyTop', function () { if (window.lzRefreshStickyTop) window.lzRefreshStickyTop(); });
    // Tab bodies are CACHED, not re-rendered (see the comment on this island),
    // so un-hiding one can put an hour-old "2m ago" back on screen. The tick
    // would catch it within 30s; this makes it instant.
    callHook('lzRefreshTimes', function () { if (window.lzRefreshTimes) window.lzRefreshTimes(); });
  }

  // A re-init hook is agent-authored-markup-adjacent (annotateProse walks
  // the report), autosave state, or third-party (mermaid) — any of them can
  // throw. Unguarded, that throw would escape applyFragment entirely into
  // switchTo's catch, which does \`location.href = href\`: a REAL navigation,
  // which closes every open web shell — silently, and for a reason that had
  // nothing to do with navigation. One hook failing must never take the
  // other hooks — or the switch itself — down with it.
  function callHook(name, fn) {
    try {
      fn();
    } catch (err) {
      if (window.console) console.warn('tab switch: ' + name + ' failed', err);
    }
  }

  function pendingTabFor(href) {
    var target = new URL(href, location.origin);
    var tabs = document.querySelectorAll('a[data-lz-tab]');
    for (var i = 0; i < tabs.length; i++) {
      var tabHref = tabs[i].getAttribute('href');
      if (!tabHref) continue;
      try {
        var u = new URL(tabHref, location.origin);
        if (canonicalTaskPath(u.pathname) === canonicalTaskPath(target.pathname) && u.search === target.search) return tabs[i];
      } catch (e) { /* ignore a malformed tab href */ }
    }
    return null;
  }

  function startProgress(tab) {
    if (window.lzNavProgress) window.lzNavProgress.start(tab);
  }

  function stopProgress() {
    if (window.lzNavProgress) window.lzNavProgress.stop();
  }

  function switchTo(href, push) {
    if (!href) return;
    // Both sides canonical: clicking the current tab's link on a /tasks/<uuid>
    // landing is a no-op (the strip spells /tasks/<code>), and a caller that
    // passes the uuid spelling of the tab we are on does not refetch it.
    var here = canonicalTaskPath(location.pathname) + location.search;
    var target = new URL(href, location.origin);
    if (canonicalTaskPath(target.pathname) + target.search === here && push) return;
    // Feedback on a slow server render: the bar appears immediately, and
    // the pressed tab looks pending so a silent click is never the UI.
    startProgress(pendingTabFor(href));
    fetch(fragmentUrl(href), { headers: { Accept: 'text/html' }, credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(function (html) {
        applyFragment(html, href, push);
        stopProgress();
      })
      .catch(function () { location.href = href; });
  }

  document.addEventListener('click', function (ev) {
    if (ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    if (ev.button !== 0) return;
    var a = ev.target.closest ? ev.target.closest('a[data-lz-tab]') : null;
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href) return;
    ev.preventDefault();
    switchTo(href, true);
  });

  window.addEventListener('popstate', function () {
    // /raised/:id is the raised-item dialog's URL, not a tab. The dialog
    // island owns that history entry; treating it as a tab fetch would load
    // the permalink HTML into the tab body (and kill any web shell).
    // NOTE: this island is a template literal, so a backslash has to be
    // doubled to reach the browser — in a comment like this one too, which is
    // why the next line reads \\/. Written singly it arrived as /^/raised/…,
    // a syntax error that killed the WHOLE island: no in-place tab switching,
    // no lzSwitchTaskTab. test/unit/island-syntax.test.ts now parses every
    // island AND scans for eaten escapes, so neither half can ship silently.
    if (/^\\/raised\\/[^/]+$/.test(location.pathname)) return;
    switchTo(location.pathname + location.search, false);
  });

  window.lzSwitchTaskTab = switchTo;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hostEl);
  else hostEl();
})();
</script>`;
}
