/**
 * "Viewable" sections — the one mechanism behind both a file in the review
 * diff and a markdown card (a turn, an agent report, a comment, a journal
 * entry, a follow-up, a prompt).
 *
 * WHY IT EXISTS
 * A markdown card is never a scroll container. It shows its full text, however
 * tall it grows, because a box that scrolls inside a page that also scrolls
 * makes the page unreadable, and a "preview" the reader has to expand hides the
 * report they came to read. What a long card needs is not a smaller box but the
 * affordance a file already has: tick it off when you have read it and it
 * collapses to its header line.
 *
 * So files and cards share ONE implementation. A viewable section carries
 * `data-viewed-key` (its identity) and `data-content-hash` (what it said when
 * it was ticked); {@link viewedStateScript} unhides the controls, collapses on
 * the chevron, and remembers the ticks. A card and a file behave identically
 * because they run the same code — not because two copies were kept in step.
 *
 * WHERE THE STATE LIVES
 * An object mapping a section's key to the content hash it carried when it was
 * ticked. Files store their path as the key (unchanged, so ticks predating
 * cards survive); cards store `card:<key>`. A stored hash that no longer
 * matches means the text changed since it was read, so the section comes back
 * unviewed and expanded.
 *
 * One backing store: the task's review draft (`ReviewDraftState.viewed_files`),
 * keyed by the local reviewer. That is what makes a tick on the phone show up
 * on the desktop, and what lets the Current review tab say anything true about
 * progress. The page seeds the island with `serverState` and this island saves
 * through `window.lazyReviewDraftSave`. A page with no draft of its own
 * (commit detail) passes a null scope and persists nothing.
 *
 * There is deliberately no localStorage mode. The two-page world needed one
 * (task page vs review page); the merged tabbed page does not. Existing
 * per-browser ticks do not migrate — a mid-review task is re-ticked once.
 *
 * NO-JS FALLBACK
 * Both controls ship `hidden` and the island unhides them. With JS off there is
 * no dead chrome and every card is simply expanded — which is the correct
 * reading state anyway. Tick persistence beyond a submit is a JS-on feature.
 *
 * OPEN MEANS NOT VIEWED
 * Collapse and the Viewed tick are the same state. Ticking Viewed collapses;
 * un-ticking expands. Opening a viewed card with the chevron is an explicit
 * re-read, so it clears the tick — otherwise the card would be open with the
 * box still checked, which is the lie n/p used to leave behind. Collapsing
 * with the chevron without ticking does not mark Viewed: that is "hide this
 * for a moment", not "I have read it". Navigation never opens a viewed card
 * (see review-navigation.ts); it only scrolls and focuses.
 *
 * IN-PLACE TAB SWITCH
 * The tab island swaps the strip and body without reloading the page, so this
 * script must re-scan after a swap. `window.lzRefreshViewable` does that —
 * listeners stay on `document` (once) and are not re-bound.
 */

import { escapeHtml, scriptJson } from './escape';

/**
 * Small, stable, non-cryptographic string hash. Shared so a file's content
 * hash, a card's content hash and a DOM id are all produced the same way.
 */
export function shortHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

export interface ViewedCardOptions {
  /**
   * Identity of this card WITHIN its page, e.g. `turn:12`, `comment:<id>`.
   * Stored prefixed with `card:` so it can never collide with a file path.
   */
  key: string;
  /** Raw text the tick is taken over — the markdown source, not the HTML. */
  content: string;
  /** Header line: what stays visible when the card is collapsed. */
  headHtml: string;
  /** Rendered card body. */
  bodyHtml: string;
  /** Extra classes on the <section> (e.g. `note`). */
  sectionClass?: string;
  /** Extra classes on the body container (e.g. `note-content turn-content`). */
  bodyClass?: string;
  /** DOM id, when the page links to the card. */
  id?: string;
  /**
   * Emit the "Viewed" tick. Default true. False where ticking off makes no
   * sense (a page with a single card and nothing to work through).
   */
  allowViewed?: boolean;
}

/**
 * One markdown card: header line, full body, chevron and "Viewed" tick.
 *
 * `headHtml` and `bodyHtml` are inserted as-is — callers escape their own text
 * and render their own markdown, exactly as they did before the card existed.
 */
export function viewedCardHtml(options: ViewedCardOptions): string {
  const { key, content, headHtml, bodyHtml, sectionClass, bodyClass, id, allowViewed = true } =
    options;
  const classes = ['rv-viewable', 'md-card', ...(sectionClass ? [sectionClass] : [])].join(' ');
  const bodyClasses = ['rv-vw-body', ...(bodyClass ? [bodyClass] : [])].join(' ');
  return `<section class="${classes}"${id ? ` id="${escapeAttr(id)}"` : ''} data-viewed-key="card:${escapeAttr(key)}" data-content-hash="${shortHash(content)}">` +
    `<header class="md-card-head">` +
    // Hidden until the island unhides it: collapse is view state, so with JS
    // off it would be a dead control.
    `<button type="button" class="rv-vw-toggle" aria-expanded="true" aria-label="Collapse" hidden>&#9662;</button>` +
    `<span class="md-card-head-text">${headHtml}</span>` +
    (allowViewed
      ? `<label class="rv-viewed" hidden><input type="checkbox" class="rv-viewed-box"> Viewed</label>`
      : '') +
    `</header>` +
    `<div class="${bodyClasses}">${bodyHtml}</div>` +
    `</section>`;
}

// Attribute escaping for the key and the id, which callers build from ids.
// The one escaper, not a "minimal" copy: the copy that used to live here left
// `'` raw, which is a hole for the next call site that quotes with it.
const escapeAttr = escapeHtml;

export interface ViewedStateOptions {
  /**
   * The ticks already stored on the task for this reviewer, keyed exactly as
   * the DOM keys them. Required whenever `scopeKey` is set — the island has
   * no other store. The page MUST also emit `reviewDraftScript` first so a
   * tick can save.
   */
  serverState?: Record<string, string>;
}

/**
 * The island that drives every viewable section on a page — files and cards
 * alike.
 *
 * `scopeKey` is the task the ticks belong to; pass null on a page that has
 * collapse but nothing worth remembering (commit detail shows a historical
 * commit, not a change under review). Collapse works either way.
 */
export function viewedStateScript(scopeKey: string | null, options: ViewedStateOptions = {}): string {
  const persist = scopeKey !== null;
  const server = options.serverState ?? {};
  // Seeded server-side and saved through the review draft. There is no
  // localStorage fallback — a page with a scope and no draft script still
  // collapses, it just cannot remember the tick past a reload.
  const store = persist
    ? `  var saveDraft = window.lazyReviewDraftSave || function () {};
  // A PATCH naming only what changed, with '' for a tick taken back — never the
  // whole map. The store merges per file (FileStorage.saveReviewDraft), so a
  // wholesale write from here would erase whatever another tab, or another
  // surface, has ticked since this page loaded.
  function save(patch) { saveDraft({ viewedFiles: patch }); }
  // scriptJson, not JSON.stringify: these keys and hashes arrive through the
  // review-draft patch route, so they are caller-supplied strings going into an
  // inline <script>. See src/server/escape.ts.
  var state = ${scriptJson(server)};
  // Merely OPENING a review is not a change to it: a save on every page load
  // would touch the task (and its updated_at) for nothing. Only an expired
  // tick is written back below — and that is ALL a load can have to write,
  // because a load never produces a tick (see the save call in refresh()).
  var SAVE_ON_LOAD = false;
  var persist = true;`
    : `  function save() {}
  var state = {};
  var SAVE_ON_LOAD = false;
  var persist = false;`;
  return `<script>
(function () {
  var SECTIONS = '[data-viewed-key]';

${store}

  // A section actually holding a live terminal must never collapse — the same
  // rule data-verify-step already got, expressed in terms of what the section
  // CONTAINS rather than a second hardcoded attribute name, so the Services
  // card (which is not a verify step) gets it too without a special case.
  function hostsLiveTerminal(section) {
    return !!section.querySelector('.lz-shell-mount.is-live');
  }

  function setViewed(section, viewed) {
    var id = section.dataset.viewedKey;
    section.dataset.viewed = viewed ? '1' : '0';
    // A verify-step tick is "I ran this", not "I have read this card" —
    // collapsing the step (or any card hosting a live terminal) would hide
    // the terminal mounted under it.
    var collapse = !section.hasAttribute('data-verify-step') && !hostsLiveTerminal(section);
    if (collapse) section.dataset.collapsed = viewed ? '1' : '0';
    var box = section.querySelector('.rv-viewed-box, .lz-verified-box');
    if (box) box.checked = viewed;
    var toggle = section.querySelector('.rv-vw-toggle');
    if (toggle && collapse) toggle.setAttribute('aria-expanded', viewed ? 'false' : 'true');
    if (!persist) return;
    if (viewed) state[id] = section.dataset.contentHash; else delete state[id];
    var patch = {};
    patch[id] = viewed ? section.dataset.contentHash : '';
    save(patch);
    updateCount();
    updateVerifyCount();
  }

  // Chevron: collapse/expand without going through the checkbox — except that
  // OPENING a viewed card is an explicit re-read, so it clears the tick.
  // Closing without ticking does not mark Viewed (hide-for-a-moment, not done).
  document.addEventListener('click', function (ev) {
    var toggle = ev.target.closest ? ev.target.closest('.rv-vw-toggle') : null;
    if (!toggle) return;
    var section = toggle.closest(SECTIONS);
    if (!section) return;
    // The chevron sets data-collapsed directly, bypassing setViewed's own
    // guard entirely — a card with no Viewed checkbox at all (allowViewed:
    // false, e.g. the Services card) has no OTHER way to collapse, so this is
    // the actual live path that would fold a running terminal away.
    if (hostsLiveTerminal(section)) return;
    var collapsed = section.dataset.collapsed === '1';
    if (collapsed) {
      if (section.dataset.viewed === '1') {
        setViewed(section, false);
        return;
      }
      section.dataset.collapsed = '0';
      toggle.setAttribute('aria-expanded', 'true');
    } else {
      section.dataset.collapsed = '1';
      toggle.setAttribute('aria-expanded', 'false');
    }
  });

  // The status bar counts FILES: it is the reviewer's progress through the
  // change, and cards are not part of that change.
  function updateCount() {
    var el = document.querySelector('[data-rv-sb="viewed"]');
    if (!el) return;
    var files = document.querySelectorAll('.rv-file[data-viewed-key]');
    if (!files.length) { el.textContent = ''; return; }
    var seen = 0;
    for (var i = 0; i < files.length; i++) if (files[i].dataset.viewed === '1') seen++;
    el.textContent = seen + '/' + files.length + ' files viewed';
  }

  // "N of M verified" on the Verify tab and its strip badge. Only current-turn
  // steps (data-verify-current) count — superseded history is not the live set.
  function updateVerifyCount() {
    var steps = document.querySelectorAll('[data-verify-step][data-verify-current]');
    var total = steps.length;
    var seen = 0;
    for (var i = 0; i < steps.length; i++) if (steps[i].dataset.viewed === '1') seen++;
    var label = total ? (seen + ' of ' + total + ' verified') : '';
    var els = document.querySelectorAll('[data-lz-verify-count]');
    for (var j = 0; j < els.length; j++) els[j].textContent = label;
    var badge = document.querySelector('.lz-tab[data-lz-tab="verify"] .lz-tab-badge');
    if (badge && total) badge.textContent = seen + '/' + total;
  }

  function refresh() {
    var sections = document.querySelectorAll(SECTIONS);
    var toggles = document.querySelectorAll('.rv-vw-toggle');
    for (var i = 0; i < toggles.length; i++) toggles[i].hidden = false;

    // Ticks whose content moved under the reviewer. Collected as a patch of
    // explicit removals rather than written back as "the map minus them" — the
    // store merges, and this page's map is not the whole truth.
    var expired = {};
    var stale = false;
    for (var j = 0; j < sections.length; j++) {
      var section = sections[j];
      var label = section.querySelector('.rv-viewed, .lz-verified');
      if (label) label.hidden = false;
      // A stored hash that no longer matches means the content changed since it
      // was ticked, so it comes back unviewed and expanded.
      var remembered = persist ? state[section.dataset.viewedKey] : null;
      if (remembered && remembered === section.dataset.contentHash) {
        section.dataset.viewed = '1';
        var isStep = section.hasAttribute('data-verify-step') || hostsLiveTerminal(section);
        if (!isStep) section.dataset.collapsed = '1';
        var box = section.querySelector('.rv-viewed-box, .lz-verified-box');
        if (box) box.checked = true;
        var toggle = section.querySelector('.rv-vw-toggle');
        if (toggle && !isStep) toggle.setAttribute('aria-expanded', 'false');
      } else if (remembered) {
        delete state[section.dataset.viewedKey];
        expired[section.dataset.viewedKey] = '';
        stale = true;
      }
    }
    // "expired" and not "state", on BOTH branches — and the SAVE_ON_LOAD one is
    // the surprising half, because when nothing expired it writes an empty
    // patch, which changes nothing. That is correct: a LOAD cannot produce a
    // tick. The only place a key is ever ADDED to "state" is setViewed, and its
    // two call sites are both click handlers (the checkbox change listener and
    // the chevron). Every other surface that ticks — the keyboard v,
    // approve-implies-viewed, the turn deeplink that re-opens a collapsed chunk
    // — deliberately routes through those same controls (review-navigation.ts
    // dispatches a real change event, or clicks the real chevron) so that
    // persistence flows through one implementation, and each has already saved
    // its own one-key patch by the time it returns. So at this line "state" is
    // exactly the map the server seeded minus whatever just expired: writing it
    // back would re-assert values the store already holds. The expirations are
    // the only thing the load actually learned, and they are what "expired"
    // carries. An empty patch is the honest way to say a load learned nothing.
    if (persist && (SAVE_ON_LOAD || stale)) save(expired);
    updateCount();
    updateVerifyCount();
    unhideVerifyControls();
  }

  // Copy/Run ship hidden. Unhide after every scan so an in-place switch onto
  // the Verify tab (which inserts the buttons without re-running tab-local
  // scripts) still shows them. Disabled Run buttons unhide too: their tooltip
  // is the reason.
  function unhideVerifyControls() {
    var canCopy = navigator.clipboard && navigator.clipboard.writeText;
    var copies = document.querySelectorAll('.rv-cmd-copy, .rv-cmd-copy-line');
    if (canCopy) for (var c = 0; c < copies.length; c++) copies[c].hidden = false;
    var runs = document.querySelectorAll('.rv-cmd-run');
    for (var r = 0; r < runs.length; r++) {
      var run = runs[r];
      // A step whose mount already holds a live session has Run/Open/Re-run
      // set correctly by setStepLive (shell-ui.ts) the moment the session
      // opened — unhiding Run here unconditionally on every scan (an in-place
      // tab switch, a live morph) would put it back next to Open/Re-run as a
      // visible-but-dead third control, since nothing else ever re-hides it.
      var step = run.closest ? run.closest('[data-lz-shell-step]') : null;
      var live = step && step.querySelector('.lz-shell-mount.is-live');
      if (live) continue;
      if (run.disabled || typeof window.lzShellRun === 'function') run.hidden = false;
    }
  }

  document.addEventListener('change', function (ev) {
    var box = ev.target.closest ? ev.target.closest('.rv-viewed-box, .lz-verified-box') : null;
    if (!box) return;
    var section = box.closest(SECTIONS);
    if (section) setViewed(section, box.checked);
  });

  // The tab island swaps the body without reloading; re-scan so new cards
  // pick up stored ticks and unhide their controls.
  window.lzRefreshViewable = refresh;
  refresh();
})();
</script>`;
}
