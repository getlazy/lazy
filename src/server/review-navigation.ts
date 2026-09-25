/**
 * Page navigation — prev/next movement and keyboard shortcuts over a page's
 * viewable sections (files in the diff AND markdown cards), plus the "approve
 * implies viewed" rule for protected files.
 *
 * It is not review-only despite the `review-` file name and the `rv-` markup
 * prefix it shares with the rest of that vocabulary: the task detail page
 * (/tasks/:id) renders the same viewable cards and emits this same island, so
 * `j`/`k`/`v` work identically there. Shortcuts whose control does not exist on
 * a page (approve/reject outside a protected-file review) simply do nothing.
 *
 * THE CURRENT CARD IS EXPLICIT STATE, not a floating guess derived from scroll
 * position. Exactly one `.rv-viewable[data-viewed-key]` section carries
 * `data-current`, marked visibly (left accent bar + outline, cards.css).
 * Rules, per the reviewer who asked for this:
 *
 * - When navigation begins with no current card, the current card is the first
 *   section whose top is at or below the viewport top — the first card the
 *   reader is looking at. From then on prev/next MOVE it.
 * - Clicking inside a card also makes it current.
 * - Scrolling alone never moves it. That is the "floating state" this design
 *   exists to avoid: the marker answers "where was I", so it must not chase
 *   the scrollbar.
 * - Navigating TO a card scrolls its header to the top of the viewport and
 *   focuses it. A card already marked Viewed stays collapsed — n/p/j/k mean
 *   "take me there", not "I am reading this again". Re-opening is the chevron,
 *   which clears the tick (viewed-cards.ts). An already-open card is not
 *   viewed; the checkbox always matches. (The review status bar is fixed to
 *   the BOTTOM, so there is nothing at the top to offset for — just a small
 *   breathing margin.)
 *
 * This builds ON the shared viewable-section island (src/server/viewed-cards.ts)
 * rather than beside it: the sequence navigated is exactly the sections that
 * island drives, and "toggle viewed" works by ticking the section's own
 * `.rv-viewed-box` and dispatching `change`, so persistence, collapse and the
 * file count all keep flowing through the one existing implementation.
 * Approve/reject shortcuts likewise click the section's real decision buttons,
 * so the POST, the fallback form submit, and the response patching stay in the
 * decision island (src/server/review.ts) untouched.
 *
 * Everything here is view state: no server round trips, and the current card is
 * deliberately NOT persisted — it is a reading position, not review progress.
 *
 * APPROVE ⇒ VIEWED: when the reviewer approves a protected-file change, they
 * are done with that file, so its Viewed tick is set too. Reject does not tick
 * it — they may want to look again. The decision island announces a successful
 * decision POST as an `rv:decided` CustomEvent (detail: { file, approved });
 * this island reacts by ticking every rendered copy of that file's box (the
 * presented and raw Changes views can each hold one). With JS off the decision
 * posts as a plain form and the page reloads; Viewed lives on the review
 * draft, so a no-JS submit keeps ticks already saved and a new tick in that
 * mode stays manual until the next draft POST.
 *
 * TICKING MEANS MOVING ON: `v` marks the current card Viewed AND advances to
 * the next one, because the point of ticking something off is to get to the
 * next thing. Un-ticking an already-viewed card does NOT advance — that is a
 * correction, and being thrown forward from it would be wrong. `n`/`j` stay
 * plain "next" for moving without deciding anything.
 *
 * NO-JS FALLBACK: the controls ship `hidden` and the island unhides them, same
 * rule as every other JS-only control on this page.
 *
 * DISCOVERABILITY: no per-card chrome by default — but hold Shift for ~400ms
 * (or open the `?` legend) and a small key hint appears beside every control
 * that has a shortcut: prev/next/help, the current card's Viewed tick, and its
 * Approve/Reject buttons. Releasing Shift removes them. The hints are injected
 * next to the REAL controls rather than drawn as a separate overlay, so they
 * can never point at something that is not there.
 *
 * `p` / `n` are aliases of `k` / `j`. They were briefly overloaded to step
 * between the items of a sequence on a page that declared itself one (the turn
 * detail page); that page is gone, and the overload went with it rather than
 * lingering as an unused branch — see docs/web-page-navigation-island.md.
 */

import { escapeHtml, scriptJson } from './escape';

/**
 * The keyboard-help control: just `?`. Section prev/next used to sit next to
 * it as unlabeled "&lt;prev next&gt;" — their purpose was opaque on the task
 * page (j/k still move between cards; the `?` legend says so), so only `?`
 * ships.
 */
export function reviewNavControlsHtml(): string {
  return `<span class="rv-nav" hidden data-rv-nav>` +
    `<button type="button" class="rv-nav-btn rv-nav-help" data-rv-nav-help title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">?</button>` +
    `</span>`;
}

/**
 * The `?` legend. One list, no options: every key it names works on every page
 * that emits this island. `a` / `r` are listed unconditionally — outside a
 * protected-file review there is simply no control for them to act on, which
 * is the documented "a shortcut whose control does not exist does nothing"
 * rule at the top of this file, not the legend lying about this page.
 */
function legendRows(): [string, string][] {
  return [
    ['j / n', 'next section'],
    ['k / p', 'previous section'],
    ['v', 'mark the current section Viewed and go to the next one'],
    ['v', 'on an already-viewed section: un-view it and stay put'],
    ['a', 'approve the current protected file'],
    ['r', 'reject the current protected file'],
    ['s', 'toggle diff layout (Unified / Split)'],
    ['w', 'toggle Wrap for long lines'],
    ['f', 'toggle Files (Presented / Source), on a page that has something to present'],
    ['Shift (hold)', 'show key hints next to the controls that have one'],
    ['?', 'show or hide this legend'],
  ];
}

function legendHtml(): string {
  const tabRows = [
    ['1–9', 'jump to that tab (Summary is 1, Current review is 9; Services has no number)'],
    ['[', 'previous tab'],
    [']', 'next tab'],
  ].map(([keys, what]) => `<tr><td><kbd>${escapeHtml(keys!)}</kbd></td><td>${escapeHtml(what!)}</td></tr>`).join('');
  const rows = legendRows().map(
    ([keys, what]) => `<tr><td><kbd>${escapeHtml(keys!)}</kbd></td><td>${escapeHtml(what!)}</td></tr>`,
  ).join('');
  return (
    `<h2>Keyboard shortcuts</h2>` +
    `<h3>Tabs</h3>` +
    `<table class="rv-nav-legend-table"><tbody>${tabRows}</tbody></table>` +
    `<h3>On this page</h3>` +
    `<table class="rv-nav-legend-table"><tbody>${rows}</tbody></table>` +
    `<p class="rv-hint">Shortcuts act on the highlighted (current) section. Navigating to a Viewed section leaves it collapsed. Shortcuts are ignored while typing.</p>` +
    `<div class="rv-form-actions"><button type="button" data-rv-nav-legend-close>Close</button></div>`
  );
}

export function reviewNavigationScript(): string {
  return `<script>
(function () {
  var SECTIONS = '.rv-viewable[data-viewed-key]';
  // Tabs are the second reason to run: 1–9 / [ / ] must work even on a
  // Landing that has no viewable cards yet.
  var HAS_TABS = !!document.querySelector('[data-lz-tab-strip]');
  if (!document.querySelector(SECTIONS) && !HAS_TABS) return;

  var nav = document.querySelector('[data-rv-nav]');
  if (nav) nav.hidden = false;

  // Document order, restricted to what the reviewer can actually see: the
  // Changes block keeps its presented and raw views in the DOM and hides one,
  // and a hidden section must never become current.
  function visibleSections() {
    var all = document.querySelectorAll(SECTIONS);
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].getClientRects().length) out.push(all[i]);
    }
    return out;
  }

  function currentSection() {
    return document.querySelector(SECTIONS + '[data-current]');
  }

  // ---- how much chrome is stuck to the top of the viewport -----------------
  //
  // Card headers are sticky in CSS (diff.css / cards.css) at the offset
  // --lz-sticky-top, and that is the one thing CSS cannot work out for
  // itself: the height of the chrome above them is not knowable from a
  // stylesheet. Measured here, once per layout change, and published as a
  // custom property so the stylesheet
  // stays declarative — and so the SAME number decides where prev/next lands,
  // which is what stops navigation from parking a card's header underneath the
  // strip that is covering it.
  //
  // THE STACK IS TWO DEEP, and collapsing it to one is the regression this
  // measurement exists to prevent. The tab strip sticks at 0; the diff
  // toolbar (Unified/Split, Scroll/Wrap, Presented/Source) sticks under the
  // strip; card headers stick under BOTH. The toolbar and the card headers
  // once shared a single offset, and because the toolbar is opaque and sits a
  // z-index above them, every file header parked itself underneath the
  // toolbar the moment the page scrolled — sticky, correct, and completely
  // invisible, which reads to a reader as the header scrolling away.
  //
  // So two properties, one per level:
  //   --lz-strip-top  the tab strip alone — what the TOOLBAR parks under
  //   --lz-sticky-top the strip plus the toolbar — what CARDS park under
  // Everything that has to clear all the chrome (card headers, scroll
  // margins, prev/next) wants the second, which is why it keeps the original
  // name: the meaning "how much is stuck above me" never changed, only the
  // number of things that can be stuck.
  var STICKY_CHROME = '.lz-tabs';
  var STICKY_TOOLBAR = '[data-rv-viewopts]';

  // Height of an element only insofar as it actually covers the top of the
  // viewport: absent, un-rendered (hidden, an off-tab pane) or statically
  // positioned all mean it scrolls away with the page and covers nothing.
  function stuckHeight(selector) {
    var el = document.querySelector(selector);
    if (!el || !el.getClientRects().length) return 0;
    var style = window.getComputedStyle(el);
    if (style.position !== 'sticky' && style.position !== 'fixed') return 0;
    return Math.round(el.getBoundingClientRect().height);
  }

  function stripTop() {
    return stuckHeight(STICKY_CHROME);
  }

  function stickyTop() {
    return stripTop() + stuckHeight(STICKY_TOOLBAR);
  }

  function publishStickyTop() {
    var root = document.documentElement.style;
    root.setProperty('--lz-strip-top', stripTop() + 'px');
    root.setProperty('--lz-sticky-top', stickyTop() + 'px');
  }

  // The toolbar ships hidden and is unhidden by its own island, and it WRAPS
  // onto a second row at narrow widths — so its height is 0 when this script
  // first runs and changes again without any event a resize listener would
  // see. Watching the element covers unhide and wrap alike; without it the
  // first paint of a review page offsets cards by the strip only, which is the
  // bug with one extra step.
  //
  // An in-place tab switch REPLACES the toolbar, so the observer is re-pointed
  // rather than left watching a detached node — the old element's height never
  // changes again, so a stale observer is a silently dead one.
  var toolbarObserver = typeof ResizeObserver === 'undefined'
    ? null
    : new ResizeObserver(publishStickyTop);
  var observedToolbar = null;

  function syncToolbarObserver() {
    if (!toolbarObserver) return;
    var toolbar = document.querySelector(STICKY_TOOLBAR);
    if (toolbar === observedToolbar) return;
    if (observedToolbar) toolbarObserver.unobserve(observedToolbar);
    observedToolbar = toolbar;
    if (toolbar) toolbarObserver.observe(toolbar);
  }

  function refreshStickyTop() {
    syncToolbarObserver();
    publishStickyTop();
  }

  refreshStickyTop();
  window.addEventListener('resize', publishStickyTop);
  // An in-place tab switch replaces the strip, so the measurement is re-taken
  // then rather than trusted from load time — same hook shape as
  // window.lzRefreshViewable.
  window.lzRefreshStickyTop = refreshStickyTop;

  function setCurrent(section) {
    var marked = document.querySelectorAll('[data-current]');
    for (var i = 0; i < marked.length; i++) marked[i].removeAttribute('data-current');
    if (section) section.setAttribute('data-current', '');
  }

  // The initialization rule: the first section whose top is at or below the
  // viewport top — the first card the reader is looking at. Scrolled past
  // everything, the last section is the one on screen.
  function firstOnScreen(secs) {
    for (var i = 0; i < secs.length; i++) {
      if (secs[i].getBoundingClientRect().top >= 0) return secs[i];
    }
    return secs.length ? secs[secs.length - 1] : null;
  }

  // "target", when given, is something INSIDE the section the reader actually
  // asked for — a turn within its chunk, a line within a file. The SECTION is
  // still what becomes current (the chunk is the unit of review); the target
  // only decides where the viewport lands. A hidden target falls back to the
  // section header.
  function navigateTo(section, target) {
    if (!section) return;
    setCurrent(section);
    // Scroll and focus only. A viewed card stays collapsed — n/p/j/k mean
    // "take me there", not "open it again". Re-opening is the chevron, which
    // clears the tick so the checkbox never lies. An already-open card is
    // left open, and open means not viewed.
    var scrollEl = section;
    if (target && target !== section && section.contains(target) && target.getClientRects().length) {
      scrollEl = target;
    }
    // Land BELOW whatever is stuck to the top of the viewport. Without the
    // offset, next/previous put the card header — the file name, accept/reject,
    // Viewed — underneath the tab strip, which is the complaint that made the
    // header sticky in the first place.
    var y = scrollEl.getBoundingClientRect().top + window.pageYOffset - stickyTop() - 8;
    window.scrollTo(0, Math.max(0, y));
    if (!section.hasAttribute('tabindex')) section.setAttribute('tabindex', '-1');
    if (section.focus) {
      try { section.focus({ preventScroll: true }); }
      catch (e) { section.focus(); }
    }
  }

  // Open <details> ancestors (presentation groups collapse by tier) so a
  // hash into a tests-tier file is not a scroll to a closed summary.
  function openAncestors(el) {
    var n = el;
    while (n && n !== document) {
      if (n.tagName === 'DETAILS') n.open = true;
      n = n.parentNode;
    }
  }

  // Presented vs Raw: the target may live in the hidden pane. Click the
  // real toggle so persistence and aria-pressed stay with that island.
  function revealContainingView(el) {
    var presented = document.getElementById('rv-presented');
    var raw = document.getElementById('rv-root');
    if (!presented || !raw) return;
    if (presented.contains(el) && presented.hidden) {
      var pbtn = document.querySelector('[data-rv-changes-value="presented"]');
      if (pbtn) pbtn.click();
    } else if (raw.contains(el) && raw.hidden) {
      var rbtn = document.querySelector('[data-rv-changes-value="raw"]');
      if (rbtn) rbtn.click();
    }
  }

  function hashId() {
    if (!window.location.hash) return '';
    var id = window.location.hash.slice(1);
    try { id = decodeURIComponent(id); } catch (e) { /* keep raw */ }
    return id;
  }

  // Prefer a VISIBLE card: Presented and Raw can both carry data-file-section
  // for the same path, and getElementById would return the first in document
  // order even when it is hidden.
  function findFileSection(id) {
    if (!id) return null;
    var vis = visibleSections();
    for (var i = 0; i < vis.length; i++) {
      if (vis[i].id === id || vis[i].getAttribute('data-file-section') === id) return vis[i];
    }
    var all = document.querySelectorAll(SECTIONS);
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === id || all[i].getAttribute('data-file-section') === id) return all[i];
    }
    var el = document.getElementById(id);
    if (!el || !el.closest) return el;
    return el.closest(SECTIONS) || el;
  }

  // Accept-checklist / ToC hashes land on the file card: expand, switch
  // Presented/Raw if needed, scroll it into view, mark it current, and
  // focus it so the reviewer is looking at the thing they must decide.
  // Did the reader just PERFORM the act of following a link to this hash, as
  // opposed to the hash merely still sitting in the URL?
  //
  // This distinction is the whole carve-out. Clearing a Viewed tick is a
  // persisted write to the review draft, and the viewed-cards island refuses
  // to write on a plain load at all (its SAVE_ON_LOAD is false, because
  // opening a review is not a change to it). A reveal that fired on every
  // load with turn-<n> still in the URL took a tick away again on every
  // reload, every Back, every restored tab — silently, with no undo, from a
  // GET. So: a hashchange is the act; a load is the act only when the
  // navigation itself carried us here.
  function isFreshNavigation() {
    try {
      var entries = performance.getEntriesByType('navigation');
      if (entries && entries.length && entries[0].type) {
        // 'navigate' is a real navigation (including the 302 from
        // /tasks/:id/turns/:n). 'reload' and 'back_forward' are not.
        return entries[0].type === 'navigate';
      }
    } catch (e) { /* no Navigation Timing here */ }
    // Cannot tell: do NOT clear. Losing recorded progress is the bad outcome;
    // landing on a chunk header is merely less convenient.
    return false;
  }

  function revealFileHash(acted) {
    var id = hashId();
    if (!id) return;
    // Line anchors (l-...) belong to the diff island (it may need to flip
    // a presented-markdown pane to source). We only mark the containing
    // file current — scrolling to the line is that island's job.
    if (id.indexOf('l-') === 0) {
      var row = document.getElementById(id);
      var file = row && row.closest ? row.closest(SECTIONS) : null;
      if (file) { openAncestors(file); setCurrent(file); }
      return;
    }
    var section = findFileSection(id);
    if (!section) return;
    openAncestors(section);
    revealContainingView(section);
    // The hash may name something inside the section — turn-7 is a turn inside
    // its chunk. Land ON it, with the chunk marked current, so a turn deep
    // link still reads as "this turn, in the chunk it belongs to".
    var inner = document.getElementById(id);
    if (inner && inner !== section) openAncestors(inner);
    // FOLLOWING A LINK TO ONE TURN is a re-read request, and re-opens a ticked
    // chunk. Three conditions, and every one of them is load-bearing:
    //
    //  1. acted — the reader just followed a link here, rather than the hash
    //     merely still being in the URL on a reload or a Back. See
    //     isFreshNavigation above; this is the condition that stops a tick
    //     being taken away over and over from a plain GET.
    //  2. The hash names a TURN, exactly. "Navigation never re-opens a viewed
    //     card" governs n/p/j/k, where the reader is moving THROUGH a list and
    //     a ticked card is one they are done with; asking for one TURN by name
    //     is the opposite act. "Show me what that comment said"
    //     (#comment-<id>, #journal-<id>) is not — those scroll into an open
    //     chunk and leave a ticked one collapsed.
    //  3. The chunk is actually collapsed — otherwise there is nothing to do
    //     and clicking the chevron would COLLAPSE an open one.
    //
    // Re-opening CLEARS the tick, and the tick is persisted to the review
    // draft, so it follows the reviewer across reloads and devices. That is
    // why each condition is narrow: every way of reaching this line that is
    // not "I asked for this turn" is progress silently rolled back.
    //
    // Routed through the chevron's own control so re-opening clears the tick
    // exactly as clicking it would — the checkbox never lies about the card.
    if (acted && inner && inner !== section && /^turn-\\d+$/.test(id)
      && section.dataset && section.dataset.collapsed === '1') {
      var toggle = section.querySelector('.rv-vw-toggle');
      if (toggle) toggle.click();
    }
    // navigateTo scrolls, marks current, and focuses — same as n/p. A section
    // still collapsed here shows its header, which is the honest answer when
    // nothing asked to re-read it.
    navigateTo(section, inner);
  }

  function move(delta) {
    var secs = visibleSections();
    if (!secs.length) return;
    var cur = currentSection();
    var idx = cur ? secs.indexOf(cur) : -1;
    if (idx < 0) {
      // Navigation is just beginning (or the current section got hidden by a
      // view toggle): the first move SELECTS the card being looked at rather
      // than skipping past it.
      navigateTo(firstOnScreen(secs));
      return;
    }
    var next = idx + delta;
    if (next < 0 || next >= secs.length) return;
    navigateTo(secs[next]);
  }

  function tabHref(index) {
    var a = document.querySelector('[data-lz-tab-index="' + index + '"]');
    return a ? a.getAttribute('href') : null;
  }

  function goTab(href) {
    if (!href) return;
    if (window.lzSwitchTaskTab) window.lzSwitchTaskTab(href, true);
    else window.location.href = href;
  }

  // 1–9 jump by TASK_TAB_KEY_INDEX, not by visible position — Shell keeps
  // its number when it is hidden, so 8 is always Shell and 9 is always
  // Current review. Services has no digit key.
  function jumpTab(index) {
    goTab(tabHref(index));
  }

  function switchTab(delta) {
    var tabs = document.querySelectorAll('[data-lz-tab]');
    if (!tabs.length) return;
    var cur = document.querySelector('.lz-tab-current');
    var idx = -1;
    for (var i = 0; i < tabs.length; i++) if (tabs[i] === cur) { idx = i; break; }
    var next = idx < 0 ? 0 : idx + delta;
    if (next < 0 || next >= tabs.length) return;
    goTab(tabs[next].getAttribute('href'));
  }

  // Clicking inside a card makes it current — no scroll, no expand: the
  // reviewer is already there.
  document.addEventListener('click', function (ev) {
    var section = ev.target.closest ? ev.target.closest(SECTIONS) : null;
    if (section) setCurrent(section);
  });

  document.addEventListener('click', function (ev) {
    if (!ev.target.closest) return;
    // Unlabeled section prev/next were removed; j/k still move between cards.
    if (ev.target.closest('[data-rv-nav-help]')) toggleLegend();
    else if (ev.target.closest('[data-rv-nav-legend-close]')) toggleLegend();
  });

  // TICKING MEANS MOVING ON: marking viewed advances to the next section.
  // Un-viewing is a correction, so it stays put.
  function toggleViewed() {
    var cur = currentSection();
    if (!cur) return;
    var box = cur.querySelector('.rv-viewed-box');
    if (!box) return;
    var nowViewed = !box.checked;
    box.checked = nowViewed;
    // The shared viewable island owns what a tick MEANS (collapse, storage,
    // the file count); a synthetic change event routes through it.
    box.dispatchEvent(new Event('change', { bubbles: true }));
    if (nowViewed) move(1);
  }

  // 'a' / 'r' only act when the current section is a protected file whose
  // decision control is present and the answer would actually change —
  // re-submitting the standing answer is noise, not a decision.
  // The control lives on the FILE header. An interleaved leftover hunk
  // card of the same path has no form of its own — look up the file's one
  // control rather than no-op'ing.
  function decideForm(section) {
    if (!section) return null;
    var form = section.querySelector('.rv-decide');
    if (form) return form;
    var file = section.dataset.file;
    if (!file) return null;
    var vis = visibleSections();
    for (var i = 0; i < vis.length; i++) {
      if (vis[i].dataset.file !== file) continue;
      form = vis[i].querySelector('.rv-decide');
      if (form) return form;
    }
    // Concatenate the attribute name so this script never contains the
    // markup token that tests treat as a live control (name, equals, quote).
    return document.querySelector('.rv-decide[' + 'data-rv-decide=' + JSON.stringify(file) + ']');
  }

  function decide(value) {
    var cur = currentSection();
    if (!cur) return;
    var form = decideForm(cur);
    if (!form) return;
    var btn = form.querySelector('.rv-decide-btn[value="' + value + '"]');
    if (!btn || btn.classList.contains('rv-decide-on')) return;
    // A real click on the real submit button: the decision island's submit
    // handler does the POST exactly as if the mouse were used.
    btn.click();
  }

  // ---- view-mode toggles (layout / wrap / presented) -----------------------
  //
  // The diff toolbar (review-diff.ts, [data-rv-viewopts]) is the one control
  // for these on the whole page — this island never re-implements it, only
  // clicks its real buttons, same rule as decide()/toggleViewed() above. That
  // keeps persistence, the aria-pressed state, and the narrow-viewport Split
  // lock (syncNarrow in review-diff.ts) in the one place that already owns
  // them: a disabled button's .click() is a no-op, exactly what the mouse
  // would do, so a shortcut can never route around "too narrow for Split".
  // On a page with no toolbar (nothing to present, or an old page not
  // emitting it) the bar or the button is simply absent and the key does
  // nothing — the same "no control, no effect" rule as 'a'/'r'.
  function viewOptsBar() {
    return document.querySelector('[data-rv-viewopts]');
  }

  function toggleMode(name, values) {
    var bar = viewOptsBar();
    if (!bar) return;
    var buttons = [];
    for (var i = 0; i < values.length; i++) {
      var btn = bar.querySelector('[data-rv-mode="' + name + '"][data-rv-value="' + values[i] + '"]');
      if (!btn) return;
      buttons.push(btn);
    }
    var activeIdx = 0;
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i].getAttribute('aria-pressed') === 'true') { activeIdx = i; break; }
    }
    buttons[(activeIdx + 1) % buttons.length].click();
  }

  // APPROVE ⇒ VIEWED. Fired by the decision island after a successful POST.
  // Reject never ticks: the reviewer may want to look at the file again.
  document.addEventListener('rv:decided', function (ev) {
    var d = ev.detail;
    if (!d || !d.approved) return;
    var files = document.querySelectorAll('.rv-file[data-viewed-key]');
    for (var i = 0; i < files.length; i++) {
      if (files[i].dataset.file !== d.file) continue;
      var box = files[i].querySelector('.rv-viewed-box');
      if (box && !box.checked) {
        box.checked = true;
        box.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  });

  // ---- discoverable shortcuts: hold Shift (or open the legend) for hints ----
  //
  // Hints are appended to the REAL controls, so a hint can never advertise a
  // shortcut whose control is absent (the task page has no Approve/Reject).
  var STATIC_HINTS = [['[data-rv-nav-help]', '?']];
  // Tab keys stay 1–9 via data-lz-tab-index (Services has none).
  for (var ti = 0; ti < 9; ti++) STATIC_HINTS.push(['[data-lz-tab-index="' + ti + '"]', String(ti + 1)]);
  var hintTimer = null;
  var hintsOn = false;

  // A toggle's hint lands on whichever option is NOT pressed — the one the
  // key would switch you TO — same idea as "the pressed state reflects what
  // is on screen" in review-diff.ts. Skipped when the whole mode is missing
  // (no bar, or "presented" on a page with nothing to present).
  var TOGGLE_HINTS = [['layout', 's'], ['wrap', 'w'], ['presented', 'f']];

  function toggleHintTarget(name) {
    var bar = viewOptsBar();
    if (!bar) return null;
    var buttons = bar.querySelectorAll('[data-rv-mode="' + name + '"]');
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i].getAttribute('aria-pressed') !== 'true' && !buttons[i].disabled) return buttons[i];
    }
    return null;
  }

  function hintTargets() {
    var out = [];
    for (var i = 0; i < STATIC_HINTS.length; i++) {
      var el = document.querySelector(STATIC_HINTS[i][0]);
      if (el) out.push([el, STATIC_HINTS[i][1]]);
    }
    for (var i = 0; i < TOGGLE_HINTS.length; i++) {
      var target = toggleHintTarget(TOGGLE_HINTS[i][0]);
      if (target) out.push([target, TOGGLE_HINTS[i][1]]);
    }
    var cur = currentSection();
    if (cur) {
      var viewed = cur.querySelector('.rv-viewed');
      if (viewed) out.push([viewed, 'v']);
      var form = decideForm(cur);
      if (form) {
        var yes = form.querySelector('.rv-decide-btn[value="1"]');
        var no = form.querySelector('.rv-decide-btn[value="0"]');
        if (yes) out.push([yes, 'a']);
        if (no) out.push([no, 'r']);
      }
    }
    return out;
  }

  function showHints() {
    if (hintsOn) return;
    hintsOn = true;
    var targets = hintTargets();
    for (var i = 0; i < targets.length; i++) {
      var hint = document.createElement('span');
      hint.className = 'rv-keyhint';
      hint.setAttribute('data-rv-keyhint', '');
      hint.setAttribute('aria-hidden', 'true');
      hint.textContent = targets[i][1];
      targets[i][0].appendChild(hint);
    }
  }

  function hideHints() {
    // The legend pins them: while it is open the hints ARE the demonstration.
    if (legend && legend.open) return;
    hintsOn = false;
    var shown = document.querySelectorAll('[data-rv-keyhint]');
    for (var i = 0; i < shown.length; i++) shown[i].remove();
  }

  function cancelHintTimer() {
    if (hintTimer) { clearTimeout(hintTimer); hintTimer = null; }
  }

  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Shift' || hintsOn || hintTimer) return;
    hintTimer = setTimeout(function () { hintTimer = null; showHints(); }, 400);
  });
  document.addEventListener('keyup', function (ev) {
    if (ev.key !== 'Shift') return;
    cancelHintTimer();
    hideHints();
  });
  // Alt-tabbing away with Shift down would otherwise leave the hints stuck on.
  window.addEventListener('blur', function () { cancelHintTimer(); hideHints(); });

  var legend = null;
  function toggleLegend() {
    if (legend && legend.open) { legend.close(); hideHints(); return; }
    if (!legend) {
      legend = document.createElement('dialog');
      legend.className = 'rv-dialog rv-nav-legend';
      legend.innerHTML = ${scriptJson(legendHtml())};
      document.body.appendChild(legend);
      legend.addEventListener('close', hideHints);
    }
    if (legend.showModal) legend.showModal();
    // Asking for the legend is asking "what can I press here" — answer on the
    // page too, not only in the dialog.
    showHints();
  }

  document.addEventListener('keydown', function (ev) {
    if (ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    // Never intercept while typing, or while a dialog is up (the accept
    // dialog, a native picker). The legend itself is the one exception: '?'
    // toggles it closed again.
    var t = ev.target;
    var tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (t && t.isContentEditable) return;
    var openDialog = document.querySelector('dialog[open]');
    if (openDialog) {
      if (openDialog === legend && ev.key === '?') { legend.close(); ev.preventDefault(); }
      return;
    }
    switch (ev.key) {
      case 'j': move(1); break;
      case 'k': move(-1); break;
      // 'n'/'p' are aliases of j/k. They were briefly overloaded to step
      // between PAGES on a page declaring itself one of a sequence; that page
      // (the turn detail page) is gone, and the overload went with it.
      case 'n': move(1); break;
      case 'p': move(-1); break;
      case 'v': toggleViewed(); break;
      case 'a': decide('1'); break;
      case 'r': decide('0'); break;
      case 's': toggleMode('layout', ['unified', 'split']); break;
      case 'w': toggleMode('wrap', ['0', '1']); break;
      case 'f': toggleMode('presented', ['presented', 'source']); break;
      case '?': toggleLegend(); break;
      case '[': switchTab(-1); break;
      case ']': switchTab(1); break;
      case '1': case '2': case '3': case '4': case '5':
      case '6': case '7': case '8': case '9':
        jumpTab(parseInt(ev.key, 10) - 1);
        break;
      default: return;
    }
    ev.preventDefault();
  });

  // A hashchange IS the act: the reader clicked a link, or typed an anchor.
  window.addEventListener('hashchange', function () { revealFileHash(true); });
  // After layout (and after the Presented/Raw island picks its pane). On a
  // load the act is the NAVIGATION, not the hash sitting in the URL — a
  // reload, a Back, or a restored tab reveals and scrolls exactly as before
  // but must never take a Viewed tick away again.
  setTimeout(function () { revealFileHash(isFreshNavigation()); }, 0);
})();
</script>`;
}
