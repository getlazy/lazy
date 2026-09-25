/**
 * The web review surface: blocked-task queue → line-anchored diff → threaded
 * inline comments answered by the agent via read-only `ask` → unblock/accept.
 *
 * Server-rendered HTML with one progressive-enhancement island (no bundler, no
 * CDN, no SPA) per docs/spikes/ui-redo.md. Every mutation is a POST that the
 * handler forwards to the daemon through the ReviewActions port; the page works
 * without JavaScript for unblock, accept and ask-retry, and the island only
 * upgrades the comment thread to inline posting, the accept form to a dialog,
 * and the status bar to a live one.
 */

import { layoutHtml } from './templates';
import { scriptJson } from './escape';
import { REVIEW_DRAFT_KEY_JS } from '../review/draft-key';
import { ESCAPE_HTML_JS } from './escape';
import {
  orderPhrase,
  parseSortParam,
  sortHeadersHtml,
  type SortColumn,
  type SortColumnKind,
  type SortConfig,
} from './sort';
import { shellPanelHtml, shellClientScript, type ShellAvailability } from './shell-ui';
import { reviewActivityCardHtml, type ReviewActivity } from './review-activity';
import { unmeasured, type RenderTimings } from './render-timings';
import { renderMarkdown, type RenderMarkdownOptions } from './markdown';
import { turnText } from '../utils/turn-content';
import { formatTurnLaunchLabels, formatTurnModelWarning } from '../utils/turn-labels';
import {
  parseUnifiedDiff,
  renderReviewDiff,
  anchorKey,
  anchorDomId,
  escapeHtml,
  fileSectionId,
  violationDecision,
  diffViewOptionsHtml,
  diffViewScript,
  type RenderedThread,
} from './review-diff';
import { regionsCardHtml, regionsStripOptions } from './review-regions';
import type { RegionSummary } from '../regions';
import {
  changesViewOptionsHtml,
  changesViewScript,
  renderPresentedChanges,
  screenshotsCardHtml,
} from './review-presentation';
import { renderMarkdownFile, type MarkdownSources } from './review-markdown';
import { PROSE_BLOCK_TAGS } from '../review/prose-blocks';
import { discussionPromoteSeed as seedDiscussionPromotion, type DiscussionPromoteSeed } from '../review/promote-discussion';
import {
  askThreadIsCurrent,
  resolveAskAvailability,
  unblockUnavailableReason,
  type AskRoute,
  hasAnyAsk,
  hasAnyQueuedComment,
  isPendingDelivery,
  isWithdrawn,
  withdrawRefusalReason,
  type ReviewActions,
  type ReviewQueueEntry,
} from './review-actions';
import { actionDialogButtonHtml, actionDialogTemplateHtml } from './action-dialog';
import { submitActionHtml } from './submit-action';
import type { TaskSubmitPreflight } from './task-actions';
import { reviewDraftScript } from './review-draft-script';
import { taskPath, taskPathSegment } from './task-urls';
import { viewedCardHtml, viewedStateScript } from './viewed-cards';
import { relativeTime, timestampHtml } from './timestamps';
import { servicesCardHtml, type ProbedServeState, type ServicesCardControls } from './services-card';
import {
  stripVerifySections,
  verifyCopyScript,
  verifyRunScript,
  verifyReportBlockHtml,
} from './review-verify';
import { reviewNavControlsHtml, reviewNavigationScript } from './review-navigation';
import { screenshotLightboxScript } from './screenshot-lightbox';
import { clusterProgressBarHtml } from './cluster-progress-html';
import {
  asksBarLabel,
  queuedBarLabel,
  ASKS_BAR_TITLE,
  QUEUED_BAR_TITLE,
  STATUS_BAR_LABELS_JS,
} from './status-bar-labels';
import { raisedDisplayTitle } from '../raised/content';
import { raisedDecisionBadgeHtml, raisedGateBadgeHtml } from './raised-badges';
import { attributionLabel } from '../actor-ref';
import { raisedGateVocabulary } from '../raised/vocabulary';
import {
  REPORT_SECTION_LABELS,
  reportDeclaresNoBehavior,
  sectionsForSurface,
  type ReportSurface,
} from '../review/report-policy';
import { buildSymbolTable } from './review-symbols';
import type {
  AcceptRemedy,
  FileViolation,
  RaisedItem,
  RaisedItemResolution,
  ActiveRaisedResolveAction,
  ReviewComment,
  Turn,
  TurnReport,
  FileDecision,
} from '../types';
import { ACTIVE_RAISED_ACTIONS } from '../types';
import type { Task } from '../storage';
import {
  isTaskLevelReviewAnchor,
  TASK_LEVEL_REVIEW_ANCHOR,
} from '../review/task-level-anchor';
import {
  isProseReviewAnchor,
  proseAnchorReviewerWhere,
  PROSE_REPORT_FILE,
  PROSE_ANCHOR_HASH_JS,
  PROSE_ANCHOR_FILE_RE_SOURCE,
} from '../review/prose-anchor';

/** Human labels for report section kinds — display only; ranking lives in report-policy. */

/**
 * The island. It only enhances what already exists server-side:
 * - clicking a gutter "+" opens a form offering BOTH intents — "Ask agent"
 *   (dispatched now, read-only) and "Add comment" (batched into the next
 *   unblock) — warning first when the task cannot answer right now;
 * - submitting posts JSON and re-renders threads, the queued list and the
 *   status bar from the API;
 * - Unblock / Ask / Accept open as dialogs (action-dialog.ts) that narrate
 *   the same CLI phases; this island copies raised-item decisions into the
 *   form on submit via window.lzCopyRaisedFields;
 * - on Accept, the last-saved feedback draft is already on the form so a
 *   refused accept can hand those words back (never-lose-human-feedback);
 * - polling keeps the status bar honest AND flips Unblock / Accept when the
 *   task goes busy or idle: fast while an ask is in flight or the task is
 *   working/pairing, slow otherwise.
 * With JS off, the diff, every thread, the queued list, the retry buttons and
 * the action forms (in <noscript> next to each dialog template) still work as
 * plain form POSTs — and the drafts are still persisted, because the unblock
 * and accept routes save what was typed before they attempt anything.
 *
 * Autosave of unsent words is reviewDraftScript's; the viewed ticks are the
 * shared viewable-section island's (viewed-cards.ts), which this page hands the
 * task's stored ticks so they follow the reviewer off this browser.
 */
export function reviewScript(
  taskId: string,
  options: { lineDrafts?: Record<string, string> } = {},
): string {
  const taskAnchorFile = scriptJson(TASK_LEVEL_REVIEW_ANCHOR.file);
  const taskAnchorLine = TASK_LEVEL_REVIEW_ANCHOR.line;
  return `<script>
(function () {
  var TASK = ${scriptJson(taskId)};
  // Half-typed comment boxes, as last saved on the task's review draft.
  // Seeded server-side so an accidental reload — or a second tab, or another
  // machine — comes back with the words still in the box.
  // scriptJson, NOT JSON.stringify: this is free-form text the reviewer typed,
  // going into an inline script element. A draft containing a literal closing
  // script tag would otherwise
  // end the element early and the remainder would be parsed as HTML — script
  // execution on the origin that holds the dashboard session cookie. The one
  // escaper lives in src/server/escape.ts.
  var LINE_DRAFTS = ${scriptJson(options.lineDrafts ?? {})};
  var TASK_ANCHOR_FILE = ${taskAnchorFile};
  var TASK_ANCHOR_LINE = ${taskAnchorLine};
  // Must match isProseReviewAnchor() / proseAnchorLine() in
  // src/review/prose-anchor.ts — both are interpolated from there.
  var PROSE_FILE_RE = new RegExp(${scriptJson(PROSE_ANCHOR_FILE_RE_SOURCE)});
  ${PROSE_ANCHOR_HASH_JS}
  function isProseFile(f) { return PROSE_FILE_RE.test(f); }
  var bar = document.getElementById('rv-statusbar');
  // NEVER a captured reference: an in-place tab switch (task-tabs.ts) removes
  // #rv-changes / #rv-root wholesale and appends a fresh element with the same
  // id, so a \`var root = document.getElementById(...)\` taken once at load —
  // this script is page-level, not tab-local, and never runs again — goes
  // stale the moment the reviewer leaves Changes and comes back. Every use
  // re-resolves through this instead. The detached stand-in keeps a
  // root-scoped helper (closeForms, the thread poll) a safe no-op on a tab
  // with neither element, rather than a throw — landing has the agent report
  // (data-rv-prose markers, read straight off \`document\` by annotateProse)
  // but no diff root at all.
  var DETACHED_ROOT = document.createElement('div');
  function currentRoot() {
    return document.getElementById('rv-changes') || document.getElementById('rv-root') || DETACHED_ROOT;
  }

  // The shared escaper, embedded from src/server/escape.ts rather than
  // hand-rolled here: an island builds markup as strings, so every value
  // interpolated into one is an injection sink, and a per-island copy is what
  // the next call site forgets to use.
  ${ESCAPE_HTML_JS}

  // Must match anchorDomId() in review-diff.ts — see the note there.
  function domId(file, side, line) {
    return 'l-' + encodeURIComponent(file) + '-' + side + '-' + line;
  }

  // Where an anchor lives depends on the layout: on the <tr> in unified, on the
  // code cell of its own side in split (a split row holds two lines, so it
  // cannot carry one anchor). Thread rows carry theirs too, so a Reply knows
  // which of the two lines above it is replying to. Everything below addresses
  // anchors through these two helpers rather than assuming a row.
  var ANCHOR_SEL = 'tr.rv-line[data-line], td.rv-code[data-line]';

  function anchorElement(el) {
    var found = el.closest('[data-file][data-line]');
    if (found) return found;
    // Split: the comment button sits in the gutter cell beside its code cell.
    var gutter = el.closest('td.rv-gutter');
    return gutter && gutter.nextElementSibling && gutter.nextElementSibling.dataset.line
      ? gutter.nextElementSibling
      : null;
  }

  function anchorOf(el) {
    return { file: el.dataset.file, side: el.dataset.side, line: parseInt(el.dataset.line, 10) };
  }

  // The code text of an anchored line, for the snippet stored with a comment.
  // Resolved by id so it works from a Reply button too, where the anchor
  // element is the thread row and holds no code.
  function snippetFor(a) {
    var el = document.getElementById(domId(a.file, a.side, a.line));
    if (!el) return '';
    var code = el.classList.contains('rv-code') ? el : el.querySelector('.rv-code');
    return code ? code.textContent : '';
  }

  // Why an ask cannot be dispatched right now, per the last poll. Empty when
  // the agent can answer. Kept on the status bar so it is refreshed in one
  // place and read wherever the reviewer is about to type.
  function askBlockedReason() {
    return bar && bar.dataset.rvAskable === '0' ? (bar.dataset.rvAskReason || '') : '';
  }

  // Why Unblock would be refused right now, per the last poll. The RULE is the
  // daemon's (unblockUnavailableReason in review-actions.ts); the status bar
  // only carries its answer, refreshed on every poll.
  function unblockBlockedReason() {
    return bar ? (bar.dataset.rvUnblockReason || '') : '';
  }

  // Every text box that offers Ask offers the same row:
  // [Ask agent] [Add comment] [Unblock] [Cancel]. An action the task cannot
  // take right now is HIDDEN, and its reason is visible text in the row — a
  // disabled button cannot say why it is off (engineer's call, 2026-09-23).
  // The poll re-gates open rows (refreshActionGates) when the status moves.
  function actionButtonHtml(intent, label, reason) {
    return '<button type="submit" data-intent="' + intent + '"' +
      (reason ? ' hidden' : '') + '>' + label + '</button>';
  }
  function gateReasonText(gates) {
    var parts = [];
    if (gates.ask) parts.push('Ask agent: ' + gates.ask);
    if (gates.unblock) parts.push('Unblock: ' + gates.unblock);
    return parts.join(' ');
  }
  function actionRowHtml() {
    var gates = { ask: askBlockedReason(), unblock: unblockBlockedReason() };
    var why = gateReasonText(gates);
    return actionButtonHtml('ask', 'Ask agent', gates.ask) +
      actionButtonHtml('comment', 'Add comment', '') +
      actionButtonHtml('unblock', 'Unblock', gates.unblock) +
      '<span class="rv-hint rv-gate-reason" data-rv-gate-reason' + (why ? '' : ' hidden') + '>' + esc(why) + '</span>' +
      '<button type="button" class="rv-cancel">Cancel</button>' +
      '<span class="rv-hint">Ask = answered now, read-only. Comment = batched into your next unblock. ' +
      'Unblock = sends this now and the agent starts working on it.</span>';
  }
  function refreshActionGates() {
    var gates = { ask: askBlockedReason(), unblock: unblockBlockedReason() };
    var btns = document.querySelectorAll('form.rv-form button[data-intent="ask"], form.rv-form button[data-intent="unblock"]');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      // A button mid-send reads "Saving…"; leave it to its own handler.
      if (b.textContent === 'Saving…') continue;
      var reason = gates[b.dataset.intent];
      b.hidden = !!reason;
      b.disabled = false;
      b.removeAttribute('title');
    }
    var why = gateReasonText(gates);
    var notes = document.querySelectorAll('form.rv-form [data-rv-gate-reason]');
    for (var k = 0; k < notes.length; k++) {
      notes[k].textContent = why;
      notes[k].hidden = !why;
    }
  }
  function intentOf(btn) {
    var i = btn && btn.dataset.intent;
    return i === 'comment' || i === 'unblock' ? i : 'ask';
  }
  // Unblock SAVES the words as a queued comment first and then asks for the
  // turn. When the turn is refused the words are already on the task (they
  // ride the next unblock), so the box is not reopened for a retype — it says
  // where the words went and why nothing started.
  function noteUnblockFailed(form, msg, key) {
    dropDraft(key);
    form.innerHTML = '<div class="rv-warn">Your comment is saved and queued for the next unblock. ' +
      'Unblock did not start: ' + esc(msg) + '</div>' +
      '<div class="rv-form-actions"><button type="button" class="rv-cancel">Close</button></div>';
    form.querySelector('.rv-cancel').addEventListener('click', function () {
      var host = form.closest('.rv-form-row, .rv-prose-form, .rv-task-form');
      (host || form).remove();
    });
    return refresh();
  }

  // The ask-blocked reason, as shown above a form that offers BOTH buttons.
  // Only "Ask agent" is status-gated: a comment is queued for the next unblock
  // and never dispatched, so it is unaffected by the task being busy. Without
  // that sentence the warning reads as if the whole form were unavailable.
  function warnHtml(blocked) {
    return blocked
      ? '<div class="rv-warn">' + esc(blocked) + ' Adding a comment is unaffected.</div>'
      : '';
  }

  // ---- half-typed comments survive the page moving underneath them ---------
  //
  // An open comment box holds words the reviewer has not sent, and the review
  // page re-renders around it constantly: expanding context rebuilds the
  // side-by-side body, a layout switch swaps the whole <tbody>, a poll
  // re-renders threads. Every one of those used to take the typing with it —
  // the "never lose human feedback" rule of CLAUDE.md, in miniature.
  //
  // So the text does not live in the DOM alone. Each box autosaves under its
  // ANCHOR through the same review-draft endpoint the feedback box uses, and
  // the island re-opens every stored draft after a re-render and on load. The
  // DOM is then free to churn: the words are not in it.
  //
  // A draft belongs to one BOX — a SURFACE plus an anchor, never an anchor
  // alone: the same (file, side, line) is reachable from a diff row, from the
  // header of that file's presented document, and from a diagram inside it.
  // Why that matters, and the key's shape, are in src/review/draft-key.ts.
  //
  // The key builder and parser are the SHARED mirror from
  // src/review/draft-key.ts, embedded verbatim: the server-side helpers write
  // the same keys (the e2e round trip seeds a draft under one), and a unit test
  // executes this mirror against them so the two cannot drift.
  ${REVIEW_DRAFT_KEY_JS}

  // ONE KEY PER SAVE, never the whole map. Two tabs open on one review is
  // ordinary use, and a wholesale PUT of the map THIS tab was seeded with
  // erases every draft the other tab has written since it loaded. The daemon
  // merges one anchor at a time and reads an empty string as "delete this one",
  // so two tabs can only ever collide on the same box.
  function saveDraft(key, text) {
    if (!window.lazyReviewDraftSave) return;
    var patch = {};
    patch[key] = text || '';
    window.lazyReviewDraftSave({ lineDrafts: patch });
  }

  function setDraft(key, text) {
    if (text) LINE_DRAFTS[key] = text; else delete LINE_DRAFTS[key];
    saveDraft(key, text);
  }

  function dropDraft(key) {
    delete LINE_DRAFTS[key];
    // Sent unconditionally: the reviewer cancelled or sent this box, and the
    // stored copy may have come from another tab.
    saveDraft(key, '');
  }

  // ---- the caret is part of the feedback -----------------------------------
  //
  // Restoring the words but not the cursor stops a sentence halfway with no
  // explanation, and the poll that re-renders the task-thread container runs
  // every few seconds while the task is working — exactly when someone is
  // typing a question about it. So the focused box's key and selection are
  // captured before a re-render and put back after it.
  function captureDraftFocus() {
    var el = document.activeElement;
    if (!el || el.tagName !== 'TEXTAREA' || !el.closest) return null;
    var form = el.closest('form.rv-form[data-rv-draft-key]');
    if (!form) return null;
    // The NODE rides along: whether it is still in the document is how the
    // restore below tells "the re-render took the caret" from "the reviewer
    // clicked somewhere else".
    return { key: form.dataset.rvDraftKey, start: el.selectionStart, end: el.selectionEnd, el: el };
  }

  // The last box the reviewer had the caret in, remembered continuously: a
  // rebuild that removes the focused node does not reliably fire a blur, and
  // some of them (the side-by-side rebuild behind expand-context) happen in
  // another island before this one hears about it. Reading activeElement after
  // the fact is too late.
  var lastDraftFocus = null;
  function trackDraftFocus() {
    var state = captureDraftFocus();
    if (state) lastDraftFocus = state;
  }
  document.addEventListener('focusin', trackDraftFocus);
  document.addEventListener('input', trackDraftFocus);
  document.addEventListener('keyup', trackDraftFocus);
  // A caret moved with the mouse changes the selection without an input or a
  // keyup, and "where you left it" has to mean where it actually was.
  document.addEventListener('selectionchange', trackDraftFocus);

  // LEAVING a box on purpose is forgetting it. Clicking the page background, a
  // diff row or a heading leaves document.activeElement as <body>, which is
  // indistinguishable from "a re-render took the caret" if all we look at is
  // activeElement — and a poll runs every couple of seconds, so the caret would
  // be pulled back into a box the reviewer had walked away from (and their next
  // keystrokes typed into it, and autosaved). The box being still ON the page
  // is what makes this a departure rather than churn.
  document.addEventListener('focusout', function () {
    setTimeout(function () {
      var active = document.activeElement;
      if (active && active.closest && active.closest('form.rv-form[data-rv-draft-key]')) return;
      if (lastDraftFocus && lastDraftFocus.el && lastDraftFocus.el.isConnected) lastDraftFocus = null;
    }, 0);
  });

  function restoreDraftFocus(state) {
    state = state || lastDraftFocus;
    if (!state) return;
    // ONLY when this re-render actually removed the box the caret was in. A
    // node still in the document was not taken from anybody: the reviewer
    // clicked away, and taking the caret back would be the same rudeness in
    // the other direction.
    if (state.el && state.el.isConnected) return;
    var active = document.activeElement;
    if (active && active !== document.body && active.tagName !== 'BODY') return;
    lastDraftFocus = null;
    var forms = document.querySelectorAll('form.rv-form[data-rv-draft-key]');
    for (var i = 0; i < forms.length; i++) {
      if (forms[i].dataset.rvDraftKey !== state.key) continue;
      var ta = forms[i].querySelector('textarea');
      if (!ta || ta === document.activeElement) return;
      try {
        ta.focus({ preventScroll: true });
        ta.setSelectionRange(state.start, state.end);
      } catch (e) { /* a browser that refuses either is not worth failing over */ }
      return;
    }
  }

  // A comment box inside a collapsed fold (a markdown "N unchanged lines"
  // block, a presentation group closed by tier) is a box nobody can see. Open
  // what is around it — for a restored draft especially, where the reviewer
  // never clicked anything and would otherwise just never find their words.
  function revealAncestors(el) {
    var n = el;
    while (n && n !== document) {
      if (n.tagName === 'DETAILS') n.open = true;
      n = n.parentNode;
    }
  }

  // Every form goes through this: prefill from the stored draft, then keep the
  // store in step with the box on every keystroke.
  function bindDraft(form, key) {
    var ta = form.querySelector('textarea');
    if (!ta) return;
    if (LINE_DRAFTS[key] && !ta.value) ta.value = LINE_DRAFTS[key];
    form.dataset.rvDraftKey = key;
    ta.addEventListener('input', function () { setDraft(key, ta.value); });
  }

  // Does this form still hold words? Closing one that does would discard them,
  // so "close the other forms" leaves those alone — they stay on screen where
  // the reviewer can see what they still owe an answer to.
  function formHasText(el) {
    var ta = el.querySelector('textarea');
    return !!(ta && ta.value.trim());
  }

  function closeForms() {
    var open = currentRoot().querySelectorAll('tr.rv-form-row');
    for (var i = 0; i < open.length; i++) {
      if (!formHasText(open[i])) open[i].remove();
    }
  }

  // ---- one box per draft key, and it has to be one the reviewer can SEE ----
  //
  // Is this element somewhere the reviewer can actually reach? Two terms,
  // both earning their place. The page keeps copies of the same anchor in
  // panes it is not showing — Presented vs Raw (changesViewScript's set()), a
  // file's rendered document vs its source (applyPresented), and every tab
  // body the tab island CACHED rather than destroyed (task-tabs.ts) — and all
  // three hide by setting the \`hidden\` PROPERTY, so the attribute is the
  // thing to ask about; the stylesheet's display:none follows it
  // (review.css). getClientRects() then catches what no attribute can: a
  // collapsed <details>, a file card folded shut, a zero-size subtree.
  //
  // Same rule and same reason as hostForAnchor / presentHostFor below: a box
  // that exists somewhere off screen is indistinguishable, from where the
  // reviewer sits, from the loss this whole feature exists to stop.
  //
  // WITH ONE EXCEPTION, and it is the whole reason this is not a plain "is it
  // visible": A TAB YOU ARE NOT LOOKING AT IS NOT A PANE YOU ARE LOOKING
  // PAST. The tab island CACHES a body rather than destroying it
  // (task-tabs.ts sets hidden and keeps it), so every box on every tab the
  // reviewer has visited is sitting in the document behind a hidden
  // attribute. Those are not lost and must not be moved: the words are
  // exactly where they left them and will be there when they come back.
  //
  // A hidden PANE is the opposite case — Presented vs Raw, a rendered
  // document vs its source — where the SAME anchor exists twice on the tab
  // the reviewer is on, and the other copy is on screen right now. There,
  // relocating is strictly better. Off-tab there is nowhere better to go:
  // the only alternative is the orphan box above the diff, on a tab they are
  // not looking at, under a label saying the line is not on screen — while
  // the line is right there.
  //
  // Encoded here rather than as an early return in restoreDrafts because ONE
  // predicate governs both of its consumers: openFormsByKey (should this
  // draft be re-placed?) and reusableFormForKey (may this box be removed?).
  // Guarding only restoreDrafts would leave the second one still believing a
  // perfectly good box on another tab is garbage. A restoreDrafts-level
  // early return keyed on currentRoot() would also be wrong outright: it
  // describes the DIFF ROOT, not the visible surface, so a report-prose
  // draft whose host is on the tab the reviewer IS looking at would stop
  // being restored whenever a Changes body happened to be cached.
  // Two questions, deliberately NOT one predicate — conflating them is how
  // this went wrong twice, once in each direction.
  //
  // "Can the reviewer see and use this box RIGHT NOW?" No hidden ancestor of
  // any kind: a hidden pane, a collapsed <details>, or a tab body the island
  // cached. This is what governs reuse and what counts as already-open,
  // because a box on a tab you are not looking at is not a box you can type
  // in — treating one as usable meant clicking Reply focused a display:none
  // node and built nothing: visible, pressable, nothing happens.
  function isOnScreen(el) {
    return !!el && !el.closest('[hidden]') && el.getClientRects().length > 0;
  }

  // "Is this on a tab the reviewer merely stepped away from?" The island
  // CACHES a body rather than destroying it, so every box on every tab
  // visited this session is in the document behind a hidden attribute. Those
  // are not lost and not misplaced — the words are where they were left and
  // will be there on return — so nothing may re-place or churn them from
  // another tab. That is a rule about WHEN TO ACT (see restoreDrafts), not
  // about whether a box is usable here, which is why it is not folded into
  // isOnScreen.
  function isOffTab(el) {
    return !!el && !!el.closest('[data-lz-tab-body][hidden]');
  }

  // The raised-item dialog (raised-dialog.ts) is page-level, not inside any
  // [data-lz-tab-body] — so isOffTab never applies to its content, and its
  // fetched panel carries [data-rv-prose] on the item's own body. Opening one
  // raised item therefore used to make anyOnLiveTab('[data-rv-prose]') true
  // for the rest of the session: closing the dialog leaves the fetched HTML
  // sitting in the body's innerHTML (fillAndShow only overwrites it on the
  // NEXT open), and nothing about a closed <dialog> is [hidden] or inside a
  // cached tab body for isOffTab to catch. A closed dialog's content really
  // is off screen, same as a cached tab's — it is just off screen for a
  // different mechanical reason (native dialog visibility, not the tab
  // island's [hidden]).
  function isInClosedDialog(el) {
    var dialog = el && el.closest ? el.closest('dialog') : null;
    return !!dialog && !dialog.open;
  }

  /** Any marker of this kind that is not stranded on a cached tab or a closed dialog. */
  function anyOnLiveTab(selector) {
    var els = document.querySelectorAll(selector);
    for (var i = 0; i < els.length; i++) {
      if (!isOffTab(els[i]) && !isInClosedDialog(els[i])) return true;
    }
    return false;
  }

  // Every form bound to this draft key.
  //
  // Compared in JS, never through an attribute SELECTOR: a key ends with a
  // file path, a path may contain a double quote (legal in git, and task
  // branches are agent-writable — see the note in openProseForm), and a
  // selector built by concatenation either carries escaping somebody gets
  // wrong or throws outright. A throw here would escape the delegated click
  // listener and kill [+] for every line of that file.
  function formsForKey(key) {
    var all = document.querySelectorAll('form.rv-form[data-rv-draft-key]');
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].dataset.rvDraftKey === key) out.push(all[i]);
    }
    return out;
  }

  /** The removable shell a form sits in, whichever surface built it. */
  function formShell(form) {
    return form.closest('tr.rv-form-row, .rv-task-form, .rv-prose-form') || form;
  }

  // The box already holding this draft if it is on screen, plus the removal
  // of every other copy.
  //
  // A SECOND box on one key is what the never-lose-feedback rule forbids
  // here: sending one calls dropDraft(key) and removes only its own wrap,
  // leaving the other showing words with no backing draft — which a second
  // send posts again as a duplicate comment. So reuse the one on screen and
  // drop the rest: their words live in LINE_DRAFTS, never in the node (see
  // the autosave note above), so the box that replaces them is prefilled
  // from the store and nothing is lost.
  //
  // This DOES remove an off-tab copy, and that is correct here even though
  // restoreDrafts must never touch one: getting this far means a host for
  // this anchor is on the tab being shown and a box is being built on it, so
  // the copy elsewhere — an orphan entry parked on another tab, a stale twin
  // — is now redundant rather than the reviewer's only copy. The protection
  // off-tab boxes need is "do not re-place me from another tab", and it
  // lives in restoreDrafts, which never reaches this function in that case.
  //
  // A second ON-SCREEN copy is left alone — it may be the box the reviewer is
  // typing in, and this file does not remove those.
  function reusableFormForKey(key) {
    var forms = formsForKey(key);
    var reusable = null;
    for (var i = 0; i < forms.length; i++) {
      if (isOnScreen(forms[i])) {
        if (!reusable) reusable = forms[i];
        continue;
      }
      formShell(forms[i]).remove();
    }
    return reusable;
  }

  // Shared by every surface that opens a box — diff lines and task threads
  // (openCommentForm), prose, presented controls and the orphan entry
  // (openProseForm). True means a box was reused and the caller must not
  // build a second one.
  function reuseOpenForm(key, focus) {
    var reusable = reusableFormForKey(key);
    if (!reusable) return false;
    if (focus !== false) {
      var ta = reusable.querySelector('textarea');
      // focus() scrolls it into view, which is the answer to "I clicked here
      // and nothing happened": the reused box may be the orphan entry above
      // the diff, or further up the pane than the row just clicked.
      if (ta) ta.focus();
    }
    return true;
  }

  function closeTaskForms() {
    var open = document.querySelectorAll('.rv-task-form');
    for (var i = 0; i < open.length; i++) {
      if (!formHasText(open[i])) open[i].remove();
    }
  }

  // Cancel is explicit: the reviewer said they do not want these words.
  function discardForm(el) {
    if (!el) return;
    var form = el.matches && el.matches('form') ? el : el.querySelector('form');
    if (form && form.dataset.rvDraftKey) dropDraft(form.dataset.rvDraftKey);
    el.remove();
  }

  function wireAskForm(form, a, threadId, wrapEl, surface) {
    var key = draftKey(a, threadId, surface || 'task');
    bindDraft(form, key);
    form.querySelector('.rv-cancel').addEventListener('click', function () {
      dropDraft(key);
      if (wrapEl) wrapEl.remove(); else closeTaskForms();
    });
    // Which submit button was used decides the intent, exactly as on a line
    // form. e.submitter is not universal, so remember the last click too.
    var lastClicked = null;
    form.addEventListener('click', function (e) {
      var b = e.target.closest('button[type=submit]');
      if (b) lastClicked = b;
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = form.querySelector('textarea').value.trim();
      if (!text) return;
      var btnEl = e.submitter || lastClicked || form.querySelector('button[type=submit]');
      var intent = intentOf(btnEl);
      var label = btnEl.textContent;
      btnEl.disabled = true;
      btnEl.textContent = 'Saving…';
      var taskLevel = a.file === TASK_ANCHOR_FILE && a.line === TASK_ANCHOR_LINE;
      // A task-level ask has its own endpoint; a task-level COMMENT is an
      // ordinary comment that happens to hang off the task thread, so it goes
      // through the comment route with the sentinel anchor and its threadId.
      var url = taskLevel && intent === 'ask'
        ? '/tasks/' + TASK + '/review/ask'
        : '/tasks/' + TASK + '/review/comment';
      var body = taskLevel && intent === 'ask'
        ? { content: text, threadId: threadId || undefined }
        : {
            file: a.file, side: a.side, line: a.line, content: text, intent: intent,
            threadId: threadId || undefined,
            anchorSnippet: taskLevel ? undefined : snippetFor(a)
          };
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
        .then(function (res) {
          if (!res.ok) throw new Error(res.body && res.body.error || 'request failed');
          if (res.body && res.body.unblockError) return noteUnblockFailed(form, res.body.unblockError, key);
          // Sent: the words are on the task now, so the draft goes.
          dropDraft(key);
          if (wrapEl) wrapEl.remove(); else closeTaskForms();
          closeForms();
          return refresh().then(function (stillPending) {
            if (stillPending) schedule(true);
          });
        })
        .catch(function (err) {
          btnEl.disabled = false;
          btnEl.textContent = label;
          var msg = form.querySelector('.rv-err') || document.createElement('div');
          msg.className = 'rv-err rv-state rv-state-failed';
          msg.textContent = 'Could not send: ' + err.message;
          form.appendChild(msg);
        });
    });
  }

  // Line-anchored comment buttons (gutter + / Reply) live inside #rv-changes.
  // Delegated on \`document\`, not the element \`currentRoot()\` resolves right
  // now: an in-place switch onto Changes replaces that element wholesale
  // AFTER this (page-level, load-once) script already ran, so a listener
  // bound to today's element would never see tomorrow's clicks. \`document\`
  // outlives every tab body, so this needs no re-binding, ever, on any tab.
  //
  // :not(.rv-task-reply) is load-bearing: a task-level Reply carries BOTH
  // \`rv-reply\` and \`rv-task-reply\` (it is a reply thread, so it needs the
  // draft/thread machinery \`.rv-reply\` gets — see the replyClass comment
  // below), and the OTHER listener a few lines down already handles
  // \`.rv-task-reply\`. Matching it here too would fire handleCommentClick
  // twice per click (preventDefault, never stopPropagation) — two comment
  // boxes prefilled from the same draft, one of which sends and clears the
  // stored draft while the other sits on screen with now-orphaned text a
  // second click would re-post as a duplicate. Never double-handle the
  // human's own words.
  document.addEventListener('click', function (ev) {
    var btn = ev.target.closest('.rv-add-comment, .rv-reply:not(.rv-task-reply)');
    if (!btn) return;
    handleCommentClick(ev, btn);
  });

  // Task-level Reply buttons live OUTSIDE #rv-changes (in the actions card),
  // so they need a document-level listener.
  document.addEventListener('click', function (ev) {
    var btn = ev.target.closest('.rv-task-reply');
    if (!btn) return;
    handleCommentClick(ev, btn);
  });

  function handleCommentClick(ev, btn) {
    ev.preventDefault();
    var threadId = btn.classList.contains('rv-reply') || btn.classList.contains('rv-task-reply')
      ? btn.dataset.thread : '';
    var anchorEl = anchorElement(btn);
    if (!anchorEl && btn.classList.contains('rv-task-reply')) {
      anchorEl = btn.closest('.rv-task-thread');
    }
    if (!anchorEl) return;
    openCommentForm(anchorEl, anchorOf(anchorEl), threadId, true);
  }

  // Open (or re-open) a comment box against an anchor. focus is false when
  // the island is RESTORING a saved draft: the reviewer did not just ask for
  // this box, so it must not steal the caret or the scroll position.
  function openCommentForm(anchorEl, anchor, threadId, focus) {
    var isTask = anchorEl.classList && anchorEl.classList.contains('rv-task-thread');
    var key = draftKey(anchor, threadId, isTask ? 'task' : 'line');
    // Restoring never disturbs what is already open: the reviewer did not ask
    // for this box, so it must not close the one they are typing in.
    if (focus !== false) {
      closeForms();
      closeTaskForms();
      closeProseForms();
    }
    // AFTER the close pass, so an empty same-key box has already gone and
    // this is only ever asked about one that survived (or one in a pane the
    // close pass does not reach).
    if (reuseOpenForm(key, focus)) return;
    var blocked = askBlockedReason();
    if (isTask) {
      var wrap = document.createElement('div');
      wrap.className = 'rv-task-form';
      wrap.innerHTML = '<form class="rv-form">' +
        warnHtml(blocked) +
        '<textarea rows="3" required></textarea>' +
        '<div class="rv-form-actions">' +
        actionRowHtml() +
        '</div></form>';
      anchorEl.insertAdjacentElement('afterend', wrap);
      // Placeholders are set as PROPERTIES on every form this island builds,
      // never interpolated into the markup string: one of them carries a file
      // path off a draft key, and keeping the rule uniform means no call site
      // has to remember which one that is.
      wrap.querySelector('textarea').placeholder = 'Reply on this thread…';
      wireAskForm(wrap.querySelector('form'), anchor, threadId, wrap, 'task');
      if (focus !== false) wrap.querySelector('textarea').focus();
      return;
    }
    var tr = anchorEl.closest('tr');
    var row = document.createElement('tr');
    // The class is what tells every other handler this row is a form: the
    // side-by-side rebuild skips it, closeForms() finds it, and the stylesheet
    // pins it. Without it the row was invisible to all three.
    row.className = 'rv-form-row';
    row.innerHTML = '<td colspan="6"><form class="rv-form">' +
      warnHtml(blocked) +
      '<textarea rows="3" required></textarea>' +
      '<div class="rv-form-actions">' +
      actionRowHtml() +
      '</div>' +
      '</form></td>';
    // Insert after the row's existing threads so the form sits at the bottom.
    var after = tr;
    while (after.nextElementSibling && after.nextElementSibling.classList.contains('rv-thread-row')) {
      after = after.nextElementSibling;
    }
    after.insertAdjacentElement('afterend', row);
    var form = row.querySelector('form');
    form.querySelector('textarea').placeholder = threadId
      ? 'Reply on this thread…'
      : 'Ask the agent about this line';
    // The key is the one computed at the top of this function — this branch
    // is the non-task one, so it is already the 'line' key. A second
    // declaration here shadowed nothing (same scope, same value) but read as
    // if the two could diverge.
    bindDraft(form, key);
    revealAncestors(row);
    row.querySelector('.rv-cancel').addEventListener('click', function () { discardForm(row); });
    // Which of the two submit buttons was used decides the intent. e.submitter
    // is not universal, so remember the last click as well.
    var lastClicked = null;
    form.addEventListener('click', function (e) {
      var b = e.target.closest('button[type=submit]');
      if (b) lastClicked = b;
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = form.querySelector('textarea').value.trim();
      if (!text) return;
      var btnEl = e.submitter || lastClicked || form.querySelector('button[type=submit]');
      var intent = intentOf(btnEl);
      var label = btnEl.textContent;
      var a = anchor;
      btnEl.disabled = true;
      btnEl.textContent = 'Saving…';
      fetch('/tasks/' + TASK + '/review/comment', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          file: a.file, side: a.side, line: a.line, content: text, intent: intent,
          threadId: threadId || undefined,
          anchorSnippet: snippetFor(a)
        })
      }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
        .then(function (res) {
          if (!res.ok) throw new Error(res.body && res.body.error || 'request failed');
          if (res.body && res.body.unblockError) return noteUnblockFailed(form, res.body.unblockError, key);
          dropDraft(key);
          row.remove();
          closeForms();
          return refresh().then(function (stillPending) {
            // An ask needs the fast cadence; a comment just sits there until unblock.
            if (stillPending) schedule(true);
          });
        })
        .catch(function (err) {
          btnEl.disabled = false;
          btnEl.textContent = label;
          var msg = form.querySelector('.rv-err') || document.createElement('div');
          msg.className = 'rv-err rv-state rv-state-failed';
          msg.textContent = 'Could not send: ' + err.message + ' (your comment may still be saved — reload to check)';
          form.appendChild(msg);
        });
    });
    if (focus !== false) form.querySelector('textarea').focus();
  }

  // ---- Prose anchors -------------------------------------------------------
  // Any line of the agent's prose (report sections, follow-ups, raised items)
  // takes the same Ask/Comment pair a diff line has. Server-rendered containers
  // carry data-rv-prose="<pseudo-file>"; the island splits them into blocks
  // (paragraph / list item / heading), derives each block's stable line as a
  // content hash, and gives it the hover "+" the diff gutter has.

  // figcaption is here so a SCREENSHOT is askable: the caption is the only
  // text a picture has, and anchoring on it gives an image the same anchored
  // "+" a paragraph gets, with the caption as the quote the agent receives.
  // The tag list is PROSE_BLOCK_TAGS, shared with the anchors the daemon serves
  // to Lazy Teams (src/review/prose-blocks.ts), so the two cannot drift.
  var PROSE_BLOCK_SEL = '${PROSE_BLOCK_TAGS.join(', ')}';

  // Mirrors proseAnchorReviewerWhere() / truncateQuote() in TS.
  function proseWhere(f) {
    if (f.indexOf('(followup:') === 0) return 'on a raised item';
    if (f.indexOf('(raised:') === 0) return 'on a raised item';
    return 'on the report';
  }
  function truncQuote(s) {
    var t = s.replace(/\\s+/g, ' ').trim();
    return t.length > 120 ? t.slice(0, 117) + '…' : t;
  }

  function closeProseForms() {
    var open = document.querySelectorAll('.rv-prose-form');
    for (var i = 0; i < open.length; i++) {
      if (!formHasText(open[i])) open[i].remove();
    }
  }

  function annotateProse() {
    var containers = document.querySelectorAll('[data-rv-prose]');
    for (var i = 0; i < containers.length; i++) {
      var box = containers[i];
      var file = box.getAttribute('data-rv-prose');
      var kind = box.getAttribute('data-rv-prose-kind') || '';
      var candidates = box.querySelectorAll(PROSE_BLOCK_SEL);
      var leaves = [];
      for (var j = 0; j < candidates.length; j++) {
        // Leaf blocks only: an <li> holding a nested list would swallow the
        // anchors of every item inside it.
        if (!candidates[j].querySelector(PROSE_BLOCK_SEL)) leaves.push(candidates[j]);
      }
      // A plain-text card (follow-up body, raised item) is one block itself.
      if (!leaves.length) leaves = [box];
      for (var k = 0; k < leaves.length; k++) {
        var el = leaves[k];
        if (el.dataset.line) continue;
        var text = (el.textContent || '').trim();
        if (!text) continue;
        el.classList.add('rv-prose-block');
        el.dataset.file = file;
        el.dataset.side = 'new';
        el.dataset.line = String(proseAnchorLine(kind, text));
        el.rvProseText = text;
        var add = document.createElement('button');
        add.type = 'button';
        add.className = 'rv-prose-add';
        add.title = 'Ask or comment on this line';
        add.setAttribute('aria-label', 'Ask or comment on this line');
        add.textContent = '+';
        el.appendChild(add);
      }
    }
  }

  function findProseBlock(file, line) {
    return document.querySelector(
      '.rv-prose-block[data-file="' + String(file).replace(/"/g, '\\\\"') + '"][data-line="' + line + '"]'
    );
  }

  // The same reply form the diff rows get — both intents, same endpoints: an
  // Ask goes through the ask path now, a Comment queues for the next unblock.
  // options.placeholder names what the box is about — the presented surfaces
  // (a rendered document, a diagram, a screenshot) reuse this form and say so.
  // options.snippet is the quote stored with the comment when the host is not
  // an annotated prose block. options.focus === false means the island is
  // restoring a saved draft rather than answering a click.
  function openProseForm(hostEl, anchor, threadId, options) {
    options = options || {};
    var key = draftKey(anchor, threadId, options.surface || 'prose', options.control);
    if (options.focus !== false) {
      closeForms();
      closeTaskForms();
      closeProseForms();
    }
    // The same one-box-per-key rule the diff rows and task threads get, for
    // the same reason — and this is the surface it matters most on, since
    // report paragraphs, presentation summaries and raised-item bodies are
    // where most commenting happens, and applyFragment / the live-update
    // morph both call restoreDrafts, so "a box is already open here" is the
    // ordinary case rather than the exception.
    if (reuseOpenForm(key, options.focus)) return null;
    var blocked = askBlockedReason();
    var wrap = document.createElement('div');
    wrap.className = 'rv-prose-form';
    // The placeholder is set as a PROPERTY below, never interpolated into this
    // markup: it carries a file path off a draft key, and a path containing a
    // double quote (legal in git, and task branches are agent-writable) would
    // close the attribute and make the rest of it markup. Assigning the
    // property leaves no markup context for it to escape from — the strongest
    // form of the fix, rather than one more escape call to remember.
    wrap.innerHTML = '<form class="rv-form">' +
      warnHtml(blocked) +
      '<textarea rows="3" required></textarea>' +
      '<div class="rv-form-actions">' +
      actionRowHtml() +
      '</div></form>';
    hostEl.insertAdjacentElement('afterend', wrap);
    var form = wrap.querySelector('form');
    form.querySelector('textarea').placeholder = threadId
      ? 'Reply on this thread…'
      : (options.placeholder || 'Ask or comment on this line of the report');
    // The key is computed at the top of this function, before the reuse
    // check that needs it.
    bindDraft(form, key);
    revealAncestors(wrap);
    form.querySelector('.rv-cancel').addEventListener('click', function () { discardForm(wrap); });
    var lastClicked = null;
    form.addEventListener('click', function (e) {
      var b = e.target.closest('button[type=submit]');
      if (b) lastClicked = b;
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = form.querySelector('textarea').value.trim();
      if (!text) return;
      var btnEl = e.submitter || lastClicked || form.querySelector('button[type=submit]');
      var intent = intentOf(btnEl);
      var label = btnEl.textContent;
      btnEl.disabled = true;
      btnEl.textContent = 'Saving…';
      var block = findProseBlock(anchor.file, anchor.line);
      fetch('/tasks/' + TASK + '/review/comment', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          file: anchor.file, side: anchor.side || 'new', line: anchor.line, content: text, intent: intent,
          threadId: threadId || undefined,
          anchorSnippet: threadId
            ? undefined
            : (block && block.rvProseText) || options.snippet || undefined
        })
      }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
        .then(function (res) {
          if (!res.ok) throw new Error(res.body && res.body.error || 'request failed');
          if (res.body && res.body.unblockError) return noteUnblockFailed(form, res.body.unblockError, key);
          dropDraft(key);
          wrap.remove();
          return refresh().then(function (stillPending) {
            if (stillPending) schedule(true);
          });
        })
        .catch(function (err) {
          btnEl.disabled = false;
          btnEl.textContent = label;
          var msg = form.querySelector('.rv-err') || document.createElement('div');
          msg.className = 'rv-err rv-state rv-state-failed';
          msg.textContent = 'Could not send: ' + err.message + ' (your comment may still be saved — reload to check)';
          form.appendChild(msg);
        });
    });
    if (options.focus !== false) form.querySelector('textarea').focus();
    return wrap;
  }

  // Attach every prose thread under the block whose hash still matches; a
  // thread whose text has changed (the agent reported again) parks in the
  // #rv-prose-orphans container with its quote, and never disappears.
  function renderProseThreads(threads) {
    var old = document.querySelectorAll('.rv-prose-thread-wrap');
    for (var i = 0; i < old.length; i++) old[i].remove();
    var orphanBox = document.getElementById('rv-prose-orphans');
    for (var j = 0; j < threads.length; j++) {
      var t = threads[j];
      if (!isProseFile(t.file)) continue;
      var wrap = document.createElement('div');
      wrap.className = 'rv-prose-thread-wrap';
      wrap.innerHTML = renderThread(t, false, true);
      var block = findProseBlock(t.file, t.line);
      if (block) {
        if (block.tagName === 'LI') {
          block.appendChild(wrap);
        } else {
          var after = block;
          while (after.nextElementSibling && after.nextElementSibling.classList.contains('rv-prose-thread-wrap')) {
            after = after.nextElementSibling;
          }
          after.insertAdjacentElement('afterend', wrap);
        }
      } else if (orphanBox) {
        var q = '';
        for (var m = 0; m < t.messages.length; m++) {
          if (t.messages[m].anchor_snippet) { q = t.messages[m].anchor_snippet; break; }
        }
        if (q) wrap.insertAdjacentHTML('afterbegin', '<blockquote class="rv-prose-quote">' + esc(q) + '</blockquote>');
        orphanBox.appendChild(wrap);
      }
    }
    if (orphanBox) orphanBox.hidden = !orphanBox.querySelector('.rv-prose-thread-wrap');
  }

  // ---- asking about a PRESENTED surface ------------------------------------
  //
  // A rendered document, a diagram, a screenshot: things the reviewer looks at
  // where there is no line to click, because the lines are what the
  // presentation replaced. Each such surface carries one
  // [data-rv-present-ask] button whose value is the placeholder for the box it
  // opens; the anchor is the button's own (file, side, line) when the renderer
  // knew one, otherwise the nearest annotated element inside or around it.
  //
  // They ship hidden — a page with no comment machinery must not show a button
  // that could not do anything — and this island, which IS that machinery,
  // unhides them.
  function unhidePresentAsk() {
    var btns = document.querySelectorAll('[data-rv-present-ask]');
    for (var i = 0; i < btns.length; i++) btns[i].hidden = false;
  }

  // Anchor for a presented block, best first — and it always finds one, because
  // "there is nowhere to attach this" is exactly the dead end this whole
  // affordance exists to remove:
  //   1. an anchor the renderer stamped on the button (it knew the line);
  //   2. an annotated element inside the block (a mermaid fence in the report
  //      prose is an anchored <pre>);
  //   3. the enclosing presented pane's own document anchor, or the first
  //      addressable line of the file card it sits in;
  //   4. failing all that, the task-level conversation — a question about a
  //      picture is still a question, and it must not be swallowed.
  // WHICH presented control this is. A document's header button and a diagram
  // rendered inside that document both resolve to the line the document starts
  // on, so the anchor alone would give them one key and one draft — the same
  // clobbering the surface prefix exists to stop, one level down.
  function presentControlId(btn) {
    var diagram = btn.closest('[data-lz-mermaid]');
    if (diagram) return diagram.getAttribute('data-lz-mermaid');
    if (btn.classList.contains('rv-md-ask')) return 'doc';
    return btn.getAttribute('data-rv-present-id') || 'ctl';
  }

  function presentAskAnchor(btn) {
    if (btn.dataset.file && btn.dataset.line) return anchorOf(btn);
    var host = btn.closest('.lz-mermaid, [data-rv-present-host]') || btn.parentNode;
    var own = host && host.querySelector ? host.querySelector('[data-file][data-line]') : null;
    if (own) return anchorOf(own);
    var up = btn.closest('[data-file][data-line]');
    if (up) return anchorOf(up);
    var pane = btn.closest('.rv-md');
    var paneAsk = pane ? pane.querySelector('.rv-md-ask[data-file][data-line]') : null;
    if (paneAsk) return anchorOf(paneAsk);
    var section = btn.closest('section.rv-file');
    var line = section ? section.querySelector(ANCHOR_SEL) : null;
    if (line) return anchorOf(line);
    return { file: TASK_ANCHOR_FILE, side: 'new', line: TASK_ANCHOR_LINE };
  }

  document.addEventListener('click', function (ev) {
    var btn = ev.target.closest ? ev.target.closest('[data-rv-present-ask]') : null;
    if (!btn) return;
    ev.preventDefault();
    var anchor = presentAskAnchor(btn);
    if (!anchor) return;
    // The box opens under the presented block itself — the reviewer never
    // leaves what they are looking at, and the escape hatch to Source is
    // still right there for a line-precise comment.
    // After the whole widget for a diagram — a box between the toolbar and the
    // picture would push the picture off screen, and the point is to ask about
    // what you are looking at while you look at it.
    var host = btn.closest('.lz-mermaid, .rv-md-head, [data-rv-present-host]') || btn;
    openProseForm(host, anchor, '', {
      surface: 'present',
      control: presentControlId(btn),
      placeholder: btn.getAttribute('data-rv-present-ask') || 'Ask or comment on this',
      snippet: btn.dataset.rvPresentQuote || undefined,
    });
  });

  unhidePresentAsk();

  // Prose "+" and Reply buttons live all over the page, so listen on document.
  document.addEventListener('click', function (ev) {
    var btn = ev.target.closest('.rv-prose-add, .rv-prose-reply');
    if (!btn) return;
    ev.preventDefault();
    var threadId = btn.classList.contains('rv-prose-reply') ? btn.dataset.thread : '';
    var anchorEl = btn.closest('[data-file][data-line]');
    if (!anchorEl) return;
    var host = btn.classList.contains('rv-prose-reply')
      ? (btn.closest('.rv-prose-thread-wrap') || anchorEl)
      : anchorEl;
    openProseForm(host, anchorOf(anchorEl), threadId);
  });

  // ---- putting the saved drafts back on screen -----------------------------

  function openFormsByKey() {
    var out = {};
    var forms = document.querySelectorAll('form.rv-form[data-rv-draft-key]');
    for (var i = 0; i < forms.length; i++) {
      // Only a box ON SCREEN counts as already open — see isOnScreen.
      // Counting one the page is not showing made restoreDrafts skip that
      // key, so the words never came back where the reviewer was: first for
      // a hidden Presented/Raw pane, then (when the tab-body carve-out was
      // briefly folded into this predicate) for a box stranded on a cached
      // tab, which left a task-level Ask with no box at all on the very tab
      // that hosts it. Not-shown means place it on a host here instead; the
      // stale copy is dropped when that box is built.
      if (!isOnScreen(forms[i])) continue;
      out[forms[i].dataset.rvDraftKey] = forms[i];
    }
    return out;
  }

  function taskThreadEl(threadId) {
    var threads = document.querySelectorAll('.rv-task-thread');
    for (var i = 0; i < threads.length; i++) {
      var reply = threads[i].querySelector('.rv-task-reply');
      if (!threadId || (reply && reply.dataset.thread === threadId)) return threads[i];
    }
    return null;
  }

  // The presented control this draft was opened from — matched on the ANCHOR
  // it carries, so a diagram question comes back on the diagram and never on
  // the source row that happens to share its line.
  function presentHostFor(a, control) {
    var btns = document.querySelectorAll('[data-rv-present-ask]');
    for (var i = 0; i < btns.length; i++) {
      var btn = btns[i];
      // The control first: it is what identifies the BOX. The anchor is
      // checked too, so a diagram whose fence moved does not silently take
      // over a draft written about a different line.
      if (control && presentControlId(btn) !== control) continue;
      if (btn.dataset.file && btn.dataset.line) {
        if (btn.dataset.file !== a.file || btn.dataset.side !== a.side) continue;
        if (parseInt(btn.dataset.line, 10) !== a.line) continue;
      } else if (!control) {
        continue;
      }
      // VISIBLE ONLY — see hostForAnchor below.
      if (!btn.getClientRects().length) continue;
      return btn.closest('.lz-mermaid, .rv-md-head, [data-rv-present-host]') || btn;
    }
    return null;
  }

  // Where a saved draft's box belongs now — decided by the SURFACE it was
  // opened on, not by the anchor alone.
  //
  // ONLY A VISIBLE HOST COUNTS. The page holds copies of the same line in panes
  // it is not showing (Presented vs Raw, a file's rendered document vs its
  // source), and re-opening a box inside one of those is indistinguishable, from
  // where the reviewer sits, from the loss this whole feature exists to stop:
  // their words are "restored" somewhere they cannot see. Returning null sends
  // the draft to the box above the diff instead, which is always visible and
  // says where the words belong.
  //
  // The alternative — flipping the view to reveal the pane — was rejected: it
  // changes what the reviewer chose to look at, on a timer (the poll), and
  // moving the page under someone is the class of surprise this task removes.
  function hostForAnchor(a, threadId, surface, control) {
    if (surface === 'present') {
      var present = presentHostFor(a, control);
      return present ? { kind: 'present', el: present } : null;
    }
    if (surface === 'prose' || isProseFile(a.file)) {
      var block = findProseBlock(a.file, a.line);
      return block && block.getClientRects().length ? { kind: 'prose', el: block } : null;
    }
    if (a.file === TASK_ANCHOR_FILE && a.line === TASK_ANCHOR_LINE) {
      var thread = taskThreadEl(threadId);
      return thread && thread.getClientRects().length ? { kind: 'task', el: thread } : null;
    }
    var anchors = document.querySelectorAll(ANCHOR_SEL);
    for (var i = 0; i < anchors.length; i++) {
      var el = anchors[i];
      if (el.dataset.file !== a.file || el.dataset.side !== a.side) continue;
      if (parseInt(el.dataset.line, 10) !== a.line) continue;
      if (el.getClientRects().length) return { kind: 'line', el: el };
    }
    return null;
  }

  // Re-open every saved draft that is not already on screen. Called at load
  // (so a reload comes back with the words in the box) and after every
  // re-render that could have taken a box with it.
  //
  // A draft whose anchor is NOT on this page — a file the agent has since
  // rewritten, a tab showing something else — is left in the store untouched.
  // Words the reviewer typed are never dropped because the page cannot
  // currently show where they belong.
  function restoreDrafts() {
    // An orphan entry whose box has gone (sent, or cancelled) is stale chrome.
    var stale = document.querySelectorAll('.rv-draft-orphan');
    for (var s = 0; s < stale.length; s++) {
      if (!stale[s].querySelector('form')) stale[s].remove();
    }
    var open = openFormsByKey();
    for (var key in LINE_DRAFTS) {
      if (!Object.prototype.hasOwnProperty.call(LINE_DRAFTS, key)) continue;
      var text = LINE_DRAFTS[key];
      if (!text) continue;
      if (open[key]) {
        var ta = open[key].querySelector('textarea');
        if (ta && !ta.value) ta.value = text;
        continue;
      }
      // ONE BAD RECORD COSTS ONE BOX, never the island. Everything below reads
      // a stored key and touches the DOM, and this runs at init: an exception
      // here would stop the rest of the island from being wired at all — no
      // comment boxes, no autosave, no restores — so a single unparseable or
      // unplaceable draft would take away the very machinery that keeps typing
      // safe. Per-draft, so the next one still gets its box.
      try {
        var parsed = parseDraftKey(key);
        if (!parsed) continue;
        var host = hostForAnchor(parsed.anchor, parsed.threadId, parsed.surface, parsed.control);
        // A host stranded on a cached tab is not a host: placing there would
        // build a box the reviewer cannot see, on a tab they are not on.
        // (hostForAnchor's own getClientRects test catches this in a browser;
        // stating it here keeps the rule true where layout is not computed,
        // and says out loud which case is being excluded.)
        if (host && isOffTab(host.el)) host = null;
        if (!host) {
          // Nowhere on this tab hosts the anchor. If a box for it already
          // exists ANYWHERE — typically sitting on the tab the reviewer just
          // stepped away from — leave it exactly there: it is not lost, and
          // building an orphan entry on a tab nobody is looking at helps no
          // one while churning one per poll. Orphan only when the words have
          // no box at all.
          if (formsForKey(key).length) continue;
          orphanDraft(parsed, text);
          continue;
        }
        if (host.kind === 'prose' || host.kind === 'present') {
          openProseForm(host.el, parsed.anchor, parsed.threadId, {
            focus: false,
            surface: parsed.surface,
            control: parsed.control,
          });
        } else {
          openCommentForm(host.el, parsed.anchor, parsed.threadId, false);
        }
      } catch (err) {
        // Never silent: the words are still on the task, and whoever is looking
        // at the console needs to know which draft could not be shown.
        if (window.console) console.warn('could not restore review draft', key, err);
      }
    }
    var box = document.getElementById('rv-draft-orphans');
    if (box) box.hidden = !box.querySelector('form');
  }

  // A draft whose line is not on screen — it sits inside a context gap nobody
  // has expanded, or in a view this tab is not showing. Keeping the words and
  // showing nothing would be losing them as far as the reviewer is concerned,
  // so the box is re-opened HERE, above the diff, saying where it belongs. It
  // is a working box: the anchor rides with it, so it can still be sent.
  function orphanDraft(parsed, text) {
    var box = document.getElementById('rv-draft-orphans');
    if (!box) return;
    var entry = document.createElement('div');
    entry.className = 'rv-draft-orphan';
    box.appendChild(entry);
    var label = document.createElement('p');
    label.className = 'rv-hint';
    label.textContent = isProseFile(parsed.anchor.file)
      ? 'An unsent comment on ' + proseWhere(parsed.anchor.file) + ' — the passage it was written on is not on screen.'
      : 'An unsent comment on ' + parsed.anchor.file + ':' + parsed.anchor.line +
        ' — that line is not on screen. It may be inside a collapsed file or a' +
        ' context gap, or in a view this tab is not showing (Files: Presented /' +
        ' Source, Changes: Presented / Raw). You can still send it from here.';
    entry.appendChild(label);
    box.hidden = false;
    openProseForm(label, parsed.anchor, parsed.threadId, {
      focus: false,
      surface: parsed.surface,
      control: parsed.control,
      placeholder: 'Ask or comment on ' + parsed.anchor.file,
    });
  }

  // Init: neither of these may be the reason the island does not exist. A
  // broken report block or a broken stored draft has to cost that block or that
  // box — a dead island means no comment boxes and no autosave, which is lost
  // typing by a longer route.
  try {
    annotateProse();
  } catch (err) {
    if (window.console) console.warn('could not annotate report prose', err);
  }
  try {
    restoreDrafts();
  } catch (err) {
    if (window.console) console.warn('could not restore review drafts', err);
  }
  // Raised-dialog bodies are fetched after load; re-run so new [data-rv-prose]
  // nodes get the same hover "+" (idempotent: dataset.line skips annotated ones).
  window.lzAnnotateProse = annotateProse;
  // A tab reached by an in-place switch (task-tabs.ts's applyFragment) is a
  // fresh body this script never saw: half-typed comment boxes from
  // LINE_DRAFTS would not reappear until the next 10s poll, and present-ask
  // buttons would stay hidden until one. Both are idempotent (restoreDrafts
  // skips a key whose box is already open; unhidePresentAsk only ever sets
  // hidden = false), so calling them again on a fresh body is safe.
  window.lzRestoreDrafts = function () {
    restoreDrafts();
    unhidePresentAsk();
  };
  // --------------------------------------------------------------------------

  function retryFormHtml(commentId) {
    return '<form class="rv-retry" method="post" action="/tasks/' + TASK + '/review/comment/' +
      encodeURIComponent(commentId) + '/retry"><button type="submit">Re-send to agent</button></form>';
  }

  function withdrawFormHtml(commentId) {
    return '<form class="rv-withdraw" method="post" action="/tasks/' + TASK + '/review/comment/' +
      encodeURIComponent(commentId) + '/withdraw"><button type="submit">Withdraw</button></form>';
  }

  // Mirrors withdrawRefusalReason() on the server. The refusals are re-stated
  // here rather than shipped in the poll payload so a stale poll can never
  // offer a Withdraw button the daemon will refuse; the daemon is still the
  // only thing that decides, and its wording is what the reviewer sees on the
  // rendered page and after a POST.
  // Returns null when the message may be withdrawn, or the reason it may not.
  // Only ever called on the reviewer's own messages.
  function withdrawRefusal(m) {
    if (m.intent === 'comment') {
      return m.delivery_state === 'delivered'
        ? 'This comment was already delivered to the agent — it cannot be withdrawn. Say so in your next unblock message instead.'
        : null;
    }
    if (m.ask_state === 'pending') {
      return 'This question has already been sent to the agent and may be answered at any moment — it cannot be withdrawn. Wait for the answer, then say so in the thread.';
    }
    if (m.ask_state !== 'failed') {
      return 'The agent has already answered this question — the conversation happened, so it cannot be withdrawn.';
    }
    return null;
  }

  function promoteHtml(t) {
    var p = t.promote;
    if (!p) return '';
    if (p.promotedTaskId) {
      // Code-or-id: freshly minted codes are unique, so the code is a safe
      // URL segment when the promotion stamped one (server twin: taskPath).
      var seg = p.promotedTaskCode ? encodeURIComponent(p.promotedTaskCode) : encodeURIComponent(p.promotedTaskId);
      return '<div class="rv-state rv-state-hint">Promoted to <a href="/tasks/' + seg +
        '">' + esc(p.promotedTaskCode || p.promotedTaskId.slice(0, 8)) + '</a>.</div>';
    }
    return '<details class="rv-promote"><summary>Promote to a task</summary>' +
      '<form method="post" action="/tasks/' + esc(TASK) + '/review/thread/' + encodeURIComponent(t.threadId) + '/promote">' +
      '<label><span class="rv-tab-lead">Goal</span>' +
      '<input type="text" name="goal" value="' + esc(p.goal) + '" required></label>' +
      '<label><span class="rv-tab-lead">Code</span>' +
      '<input type="text" name="code" value="' + esc(p.code) + '" placeholder="optional"></label>' +
      '<fieldset class="rv-promote-relation"><legend>Where it goes</legend>' +
      '<label><input type="radio" name="relation" value="subtask" checked> Subtask of this task</label>' +
      '<label><input type="radio" name="relation" value="peer"> Sibling of this task</label></fieldset>' +
      '<label><span class="rv-tab-lead">Prompt — edit before creating</span>' +
      '<textarea name="prompt" rows="12" required>' + esc(p.prompt) + '</textarea></label>' +
      '<div class="rv-form-actions"><button type="submit">Create task</button>' +
      '<span class="rv-hint">Created in the backlog — nothing starts until you start it.</span></div>' +
      '</form></details>';
  }

  function renderThread(t, taskLevel, prose) {
    var attrs = taskLevel
      ? ' class="rv-thread rv-task-thread" data-file="' + esc(TASK_ANCHOR_FILE) + '" data-side="new" data-line="' + TASK_ANCHOR_LINE + '"'
      : prose
        ? ' class="rv-thread rv-prose-thread" data-file="' + esc(t.file) + '" data-side="new" data-line="' + esc(t.line) + '"'
        : ' class="rv-thread"';
    var replyClass = taskLevel ? 'rv-reply rv-task-reply' : (prose ? 'rv-prose-reply' : 'rv-reply');
    var h = '<div' + attrs + '>';
    for (var i = 0; i < t.messages.length; i++) {
      var m = t.messages[i];
      var who = m.role === 'agent' ? 'agent' : (m.intent === 'comment' ? 'you (comment)' : 'you (ask)');
      var gone = m.withdrawn_at != null;
      h += '<div class="rv-msg rv-msg-' + esc(m.role) + (gone ? ' rv-msg-withdrawn' : '') + '">' +
        '<div class="rv-msg-head">' + who + '</div>' +
        '<div class="rv-msg-body">' + esc(m.content) + '</div>';
      if (gone) {
        h += '<div class="rv-state rv-state-withdrawn">withdrawn — never sent to the agent</div>';
      } else {
        if (m.ask_state === 'pending') h += '<div class="rv-state rv-state-pending">waiting for the agent…</div>';
        if (m.ask_state === 'failed') {
          h += '<div class="rv-state rv-state-failed">not sent: ' + esc(m.ask_error || 'unknown error') +
            ' (your question is saved)</div>' + retryFormHtml(m.id);
        }
        if (m.delivery_state === 'pending_delivery') h += '<div class="rv-state rv-state-queued">Pending — rides the next unblock</div>';
        if (m.delivery_state === 'delivered') {
          // Mirrors deliveredLabel() on the server — one wording, two renderers.
          h += '<div class="rv-state rv-state-delivered">Delivered' +
            (m.delivered_turn ? ' in turn ' + esc(m.delivered_turn) : '') +
            (m.delivered_at ? ' (' + relTime(m.delivered_at) + ')' : '') + '</div>';
        }
        if (m.role === 'human') {
          var why = withdrawRefusal(m);
          h += why === null
            ? withdrawFormHtml(m.id)
            : '<div class="rv-state rv-state-hint rv-withdraw-why">' + esc(why) + '</div>';
        }
      }
      h += '</div>';
    }
    h += '<button type="button" class="' + replyClass + '" data-thread="' + esc(t.threadId) + '">Reply</button>' +
      promoteHtml(t) + '</div>';
    return h;
  }

  function renderTaskThreads(threads) {
    var boxes = document.querySelectorAll('[data-rv-task-threads]');
    // Asks filed with an earlier review are moved out of the live list, never
    // dropped — mirrors currentReviewHtml() server-side.
    var current = [], filed = [];
    for (var t = 0; t < threads.length; t++) {
      (threads[t].filed ? filed : current).push(threads[t]);
    }
    var html = !current.length
      ? '<div class="rv-hint">No open questions — ask about the task below.</div>'
      : current.map(function (t) { return renderThread(t, true); }).join('');
    if (filed.length) {
      html += '<details class="lz-review-asks-filed"><summary>Filed asks (' + filed.length +
        ') — answered and submitted with an earlier review</summary>' +
        filed.map(function (t) { return renderThread(t, true); }).join('') + '</details>';
    }
    for (var i = 0; i < boxes.length; i++) {
      // NOT while the reviewer is typing in it. This container is rebuilt
      // wholesale on every poll — every ~2s while the task is working, which is
      // exactly when someone is writing a question about it — and rebuilding it
      // takes the open box, the caret and the half-finished sentence with it.
      // Same rule closeForms() follows: a box with words in it is never closed
      // behind the reviewer's back. The threads refresh on the next poll after
      // they send or cancel; nothing is lost by waiting for that.
      if (boxes[i].querySelector('form.rv-form') && formHasText(boxes[i])) continue;
      boxes[i].innerHTML = html;
    }
    // The heading counts the OPEN list, so it is re-rendered with it — a
    // count that disagrees with the threads under it reads as "nothing
    // actually cleared", which is the doubt this whole change removes.
    var heads = document.querySelectorAll('[data-rv-asks-count]');
    for (var h = 0; h < heads.length; h++) {
      heads[h].textContent = 'Asks (' + current.length + ')';
    }
  }

  // The queued list lives on Current review (and any leftover [data-rv-queued]
  // box). One list — the second copy next to a long diff is gone.
  function renderQueued(queued) {
    var boxes = document.querySelectorAll('[data-rv-queued]');
    var n = queued.length;
    var head = n === 0
      ? 'No comments queued for delivery.'
      : n + ' comment' + (n === 1 ? '' : 's') + ' queued — they will be sent with your next unblock.';
    var html = '<div class="' + (n ? '' : 'rv-hint') + '">' + head + '</div>';
    if (n) {
      html += '<ul class="rv-queued-list">';
      for (var i = 0; i < n; i++) {
        var c = queued[i];
        // Task-level replies have no diff row to jump to, and prose-anchored
        // comments show where + quote instead — see queuedHtml().
        var where = c.file === TASK_ANCHOR_FILE && c.line === TASK_ANCHOR_LINE
          ? '<span class="rv-queued-where">on the task-level conversation</span>'
          : isProseFile(c.file)
          ? '<span class="rv-queued-where">' + esc(proseWhere(c.file)) + ': <q>' +
            esc(truncQuote(c.anchor_snippet || '')) + '</q></span>'
          : '<a class="rv-queued-where" href="#' + domId(c.file, c.side, c.line) + '"><code>' +
            esc(c.file) + '</code>:' + esc(c.line) + ' (' + esc(c.side) + ')</a>';
        html += '<li class="rv-queued-item">' + where +
          '<div class="rv-msg-body">' + esc(c.content) + '</div></li>';
      }
      html += '</ul>';
    }
    for (var j = 0; j < boxes.length; j++) {
      boxes[j].className = n ? 'rv-pending-box' : '';
      boxes[j].innerHTML = html;
    }
  }

  function relTime(ts) {
    if (!ts) return 'never';
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return s + 's ago';
    var m = Math.round(s / 60);
    if (m < 60) return m + 'm ago';
    var h = Math.round(m / 60);
    if (h < 48) return h + 'h ago';
    return Math.round(h / 24) + 'd ago';
  }

  function setBarItem(name, text, visible) {
    if (!bar) return;
    var el = bar.querySelector('[data-rv-sb="' + name + '"]');
    if (!el) return;
    el.textContent = text;
    if (visible !== undefined) el.hidden = !visible;
  }
${STATUS_BAR_LABELS_JS}

  // Must match busyUnblockAcceptReason() in this module — the island flips
  // Unblock / Accept from the same poll that refreshes the status bar, so a
  // page opened while blocked cannot keep offering clicks the daemon 409s.
  function busyUnblockAcceptReason(status) {
    if (status === 'working') {
      return 'The agent is working — the actions that change this task come back here once it pauses.';
    }
    if (status === 'pairing') {
      return 'Someone is pairing on this task — the actions that change it come back here once the session ends.';
    }
    return '';
  }

  function renderActionBusy(status) {
    var reason = busyUnblockAcceptReason(status);
    var busy = reason !== '';
    var boxes = document.querySelectorAll('[data-rv-actions]');
    for (var i = 0; i < boxes.length; i++) {
      var box = boxes[i];
      box.dataset.rvBusy = busy ? '1' : '0';
      var note = box.querySelector('[data-rv-busy-reason]');
      if (note) {
        note.textContent = reason;
        note.hidden = !busy;
      }
    }
    // Hidden, never disabled: a greyed-out button cannot say why it is off,
    // so the reason is the visible line above and the verb simply is not
    // offered. Document-wide because Current review's Reject / Sync sit
    // beside the actions box, not inside it.
    var gates = document.querySelectorAll('[data-rv-busy-gate]');
    for (var j = 0; j < gates.length; j++) {
      gates[j].hidden = busy;
      gates[j].disabled = false;
    }
  }

  function renderStatus(data) {
    var st = data.state;
    if (bar && st) {
      setBarItem('status', 'status: ' + st.status);
      setBarItem('turns', st.turns + (st.turns === 1 ? ' turn' : ' turns'));
      setBarItem('activity', 'active ' + relTime(st.lastActiveAt));
      bar.dataset.rvAskable = st.askable ? '1' : '0';
      bar.dataset.rvAskReason = st.askUnavailable || '';
      bar.dataset.rvUnblockReason = st.unblockUnavailable || '';
      refreshActionGates();
      setBarItem('ask', !st.askable
        ? 'nothing recorded yet — asks are saved, not sent'
        : st.askRoute === 'record'
          ? 'answered from the task record'
          : 'agent can answer');
    }
    // Unblock / Accept live on [data-rv-actions], independent of the bar —
    // flip them whenever the poll carries a status, even if the bar is gone.
    if (st) renderActionBusy(st.status);
    if (bar) {
      // Same wording AND the same hide-at-a-never-used-zero rule the server
      // rendered — a counter that reappeared with different words on the first
      // poll is the regression these two shared helpers exist to prevent.
      setBarItem('queued', queuedBarLabel(data.pendingDelivery), data.pendingDelivery > 0 || data.everQueued);
      setBarItem('asks', asksBarLabel(data.pending), data.pending > 0 || data.everAsked);
    }
  }

  function refresh() {
    // Nothing here for a poll to update: no diff root, no report/prose, and
    // none of the OTHER things this same fetch paints — the Current review
    // tab's task-level Asks (renderTaskThreads → [data-rv-task-threads])
    // and its Unblock/Accept busy gate (renderStatus → renderActionBusy →
    // [data-rv-actions], which has to flip within seconds of a Review
    // launch). Missing Current review here once meant a reply POST closed
    // its form and the reply never appeared until the next full reload —
    // intermittent, since a Changes body cached earlier in the session made
    // getElementById('rv-changes') succeed anyway.
    //
    // #rv-statusbar is deliberately NOT one of these checks: statusBarHtml
    // is always on the page (task-page.ts renders it unconditionally,
    // outside the tab body), so a "skip when there's no bar" term can never
    // be true and would defeat this guard entirely — that shipped once and
    // silently polled every tab regardless of the checks above it, because
    // an AND chain is only as strict as its least selective term. bar STILL
    // gets updated whenever the poll runs for one of the reasons above; a
    // tab with only the bar and none of them goes back to the same "no
    // poll" behavior it had before this whole task started.
    //
    // Before this script stopped returning early on tabs with none of the
    // above, the poll never started there either (removing that early
    // return is what made Turns/Commits/Journal/Stats/Services/Shell/
    // backlog-Summary poll at all — see the task's own report). Skip the
    // round trip only on THOSE tabs; keep ticking so the next check picks up
    // the moment an in-place switch lands a real target, no reload needed.
    // Each marker is looked for where it is actually LIVE, not anywhere in
    // the document: tab bodies are cached rather than destroyed and the
    // raised-item dialog keeps its last-fetched content after closing (see
    // isOffTab/isInClosedDialog above), so a plain document.querySelector
    // answers "has this session ever rendered or fetched one", which is not
    // the question. Landing carries a [data-rv-prose] container and landing
    // is the default entry at /tasks/<id>, so the whole-document form was
    // true from the first render on and the guard only ever fired on a
    // direct deep-link into a bare tab — not the case it was written for,
    // and not the case its comment described.
    if (
      !anyOnLiveTab('#rv-changes, #rv-root') &&
      !anyOnLiveTab('[data-rv-prose]') &&
      !anyOnLiveTab('[data-rv-task-threads]') &&
      !anyOnLiveTab('[data-rv-actions]')
    ) {
      return Promise.resolve(false);
    }
    return fetch('/api/review/' + TASK + '/threads')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var byAnchor = {};
        data.threads.forEach(function (t) {
          var k = t.file + ' ' + t.side + ' ' + t.line;
          (byAnchor[k] = byAnchor[k] || []).push(t);
        });
        var focused = captureDraftFocus();
        var root = currentRoot();
        var existing = root.querySelectorAll('tr.rv-thread-row');
        for (var i = 0; i < existing.length; i++) existing[i].remove();
        var anchors = root.querySelectorAll(ANCHOR_SEL);
        // In side-by-side one row hosts two anchors, so remember where the last
        // thread for a row went — otherwise the right pane's threads would be
        // spliced in ahead of the left pane's on every poll.
        var tail = new Map();
        for (var j = 0; j < anchors.length; j++) {
          var el = anchors[j];
          var k = el.dataset.file + ' ' + el.dataset.side + ' ' + el.dataset.line;
          var list = byAnchor[k] || [];
          if (!list.length) continue;
          var host = el.closest('tr');
          var after = tail.get(host) || host;
          list.forEach(function (t) {
            var row = document.createElement('tr');
            row.className = 'rv-thread-row';
            row.dataset.thread = t.threadId;
            row.dataset.file = t.file;
            row.dataset.side = t.side;
            row.dataset.line = t.line;
            row.innerHTML = '<td colspan="6">' + renderThread(t) + '</td>';
            after.insertAdjacentElement('afterend', row);
            after = row;
          });
          tail.set(host, after);
        }
        renderQueued(data.queued || []);
        renderTaskThreads(data.taskThreads || []);
        renderProseThreads(data.threads || []);
        renderStatus(data);
        // Those re-render whole containers, so a box the reviewer is typing
        // into can have gone with them. The words did not: put every saved
        // draft back, and the caret back where it was — restoring the text but
        // not the cursor stops a sentence halfway with no explanation.
        restoreDrafts();
        restoreDraftFocus(focused);
        // Presented surfaces can arrive with a tab body swapped in after load;
        // their ask buttons ship hidden and are this island's to unhide.
        unhidePresentAsk();
        // Fast while an ask is pending OR the task is busy — the Unblock /
        // Accept gate has to flip within a few seconds of a Review launch,
        // not wait for the slow cadence.
        var st = data.state;
        var taskBusy = st && (st.status === 'working' || st.status === 'pairing');
        return data.pending > 0 || !!taskBusy;
      });
  }

  // Polling, not push: the status bar and Unblock / Accept busy gate have to
  // stay honest while the reviewer reads a long diff, and an ask can take
  // minutes (the daemon's own timeout is 10). Fast while something is in
  // flight (pending ask or working/pairing), slow otherwise. Live push for
  // the whole dashboard is a separate piece of work.
  var timer = null;
  function schedule(fast) {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(poll, fast ? 3000 : 10000);
  }
  function poll() {
    timer = null;
    refresh().then(function (stillPending) {
      schedule(stillPending);
    }).catch(function () { schedule(false); });
  }
  poll();

  // Switching layout swaps the whole <tbody>, and the body that goes away takes
  // its thread rows with it. Re-render them against the layout that is now on
  // screen rather than waiting up to 10s for the next poll to notice.
  // \`rv:layout\` bubbles (diffViewScript dispatches it with bubbles: true), so
  // \`document\` catches it from whichever Changes body is live right now —
  // the same staleness reason as the click listener above.
  document.addEventListener('rv:layout', function () {
    // Immediately, not on the next poll: the reviewer is looking at the box
    // that just went away, and a 10-second gap reads as "my typing is gone".
    var focused = captureDraftFocus();
    restoreDrafts();
    restoreDraftFocus(focused);
    refresh().catch(function () { /* the next poll will retry */ });
  });

  // Task-level ask from a leftover .rv-task-ask-form (noscript / tests). The
  // Current review Ask dialog uses data-lz-action-form and waits on the run.
  (function () {
    document.addEventListener('submit', function (ev) {
      var form = ev.target.closest ? ev.target.closest('.rv-task-ask-form') : null;
      if (!form || form.matches('[data-lz-action-form]')) return;
      ev.preventDefault();
      var text = form.querySelector('textarea').value.trim();
      if (!text) return;
      var btn = form.querySelector('button[type=submit]');
      var label = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Saving…';
      fetch('/tasks/' + TASK + '/review/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: text })
      }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
        .then(function (res) {
          if (!res.ok) throw new Error(res.body && res.body.error || 'request failed');
          form.querySelector('textarea').value = '';
          return refresh().then(function (stillPending) {
            if (stillPending) schedule(true);
          });
        })
        .catch(function (err) {
          btn.disabled = false;
          btn.textContent = label;
          alert('Could not send: ' + err.message + ' (your question may still be saved — reload to check)');
        });
    });
  })();

  // Carry whatever is in a feedback box into an accept form, and copy raised
  // resolutions onto Unblock / Accept. The action dialog calls this on submit
  // (window.lzCopyRaisedFields) because those forms are cloned into the dialog
  // after this island runs.
  function copyRaisedFields(targetForm) {
    var section = document.querySelector('.rv-raised');
    if (!section || !targetForm) return;
    // Drop previous copies so a second submit does not duplicate.
    var old = targetForm.querySelectorAll('[data-rv-raised-copy]');
    for (var i = 0; i < old.length; i++) old[i].remove();
    var fields = section.querySelectorAll('[data-rv-raised-field]');
    for (var j = 0; j < fields.length; j++) {
      var src = fields[j];
      if (!src.name) continue;
      // Skip empty action selects — an unanswered item must not pretend to be resolved.
      if (src.tagName === 'SELECT' && !src.value) continue;
      if (src.tagName === 'TEXTAREA' && !String(src.value || '').trim()) continue;
      var clone = document.createElement('input');
      clone.type = 'hidden';
      clone.name = src.name;
      clone.value = src.value;
      clone.setAttribute('data-rv-raised-copy', '1');
      targetForm.appendChild(clone);
    }
  }
  window.lzCopyRaisedFields = function (form) {
    var hidden = form && form.querySelector('input[name="feedback"]');
    var box = document.querySelector('[data-rv-draft="feedback"]')
      || document.querySelector('[data-rv-sync="feedback"]');
    if (hidden && box) hidden.value = box.value;
    copyRaisedFields(form);
  };

  // Carry whatever is in the one feedback box into the accept form, so a
  // refused accept re-renders with those words still there.
  (function () {
    var forms = document.querySelectorAll('.rv-accept-form');
    for (var i = 0; i < forms.length; i++) {
      forms[i].addEventListener('submit', function (ev) {
        window.lzCopyRaisedFields(ev.currentTarget);
      });
    }
  })();

  // Same for unblock: optional raised resolutions ride with the feedback.
  (function () {
    var forms = document.querySelectorAll('form[action$="/unblock"]');
    for (var i = 0; i < forms.length; i++) {
      forms[i].addEventListener('submit', function (ev) {
        window.lzCopyRaisedFields(ev.currentTarget);
      });
    }
  })();

  // Autosave of the review in progress lives in review-draft-script.ts, which
  // is emitted just before this island and shared with the review-session page.
  // It has already bound every [data-rv-draft] textarea.

  // Collapse and "viewed" for files live in the SHARED viewable-section
  // island (src/server/viewed-cards.ts, emitted as viewedStateScript below):
  // a file in the diff and a markdown card on this page are one affordance, so
  // they are one implementation. On THIS page that island is handed the ticks
  // stored on the task and saves them through the review draft instead of
  // localStorage, so half a review read in one tab and continued in another
  // shows the same ticks. What makes a tick honest is unchanged by where it is
  // kept: it is still the content hash, so a file the agent has since changed
  // comes back unviewed.

  // The ⛔/✅ decision posts as a plain form and works with JS off. All the
  // island adds is skipping the page reload, which would otherwise discard
  // feedback the reviewer had already typed. There is no state to synchronise:
  // one control, one stored answer, patched in place from the response.
  (function () {
    document.addEventListener('submit', function (ev) {
      var form = ev.target.closest ? ev.target.closest('.rv-decide') : null;
      if (!form) return;
      ev.preventDefault();
      var pressed = ev.submitter || form.querySelector('button[name=approved]');
      var body = new URLSearchParams();
      body.set('file', form.querySelector('input[name=file]').value);
      body.set('approved', pressed ? pressed.value : '0');
      fetch(form.action, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: body.toString(),
      })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
        .then(function (res) {
          if (!res.ok) throw new Error((res.body && res.body.error) || 'request failed');
          applyDecisions(res.body.violations || []);
          // Announce the decision that was just made (not the whole standing
          // set): the navigation island ticks Viewed on an approved file.
          document.dispatchEvent(new CustomEvent('rv:decided', {
            detail: { file: body.get('file'), approved: body.get('approved') === '1' },
          }));
        })
        .catch(function () {
          // Fall back to the real form post so the decision is never silently
          // dropped — the reload costs the typed feedback, losing the decision
          // would cost more.
          form.submit();
        });
    });

    function applyDecisions(violations) {
      var outstanding = [];
      for (var i = 0; i < violations.length; i++) {
        var v = violations[i];
        var approved = v.status === 'approved';
        if (!approved) outstanding.push(v.file);

        var forms = document.querySelectorAll('[data-rv-decide]');
        for (var j = 0; j < forms.length; j++) {
          if (forms[j].getAttribute('data-rv-decide') !== v.file) continue;
          forms[j].setAttribute('data-approved', approved ? '1' : '0');
          var state = forms[j].querySelector('.rv-decide-state');
          if (state) {
            state.textContent = approved
              ? '✅ protected — change accepted'
              : '⛔ protected — change will be reverted';
          }
          var btns = forms[j].querySelectorAll('.rv-decide-btn');
          for (var k = 0; k < btns.length; k++) {
            var on = (btns[k].value === '1') === approved;
            btns[k].classList.toggle('rv-decide-on', on);
            btns[k].setAttribute('aria-pressed', on ? 'true' : 'false');
          }
        }

        var rows = document.querySelectorAll('[data-rv-summary]');
        for (var m = 0; m < rows.length; m++) {
          if (rows[m].getAttribute('data-rv-summary') !== v.file) continue;
          rows[m].setAttribute('data-approved', approved ? '1' : '0');
          var rowState = rows[m].querySelector('.rv-violation-state');
          if (rowState) rowState.textContent = approved ? 'accepted' : 'will be reverted';
        }
      }

      var box = document.querySelector('.rv-violations');
      if (!box) return;
      var head = box.querySelector('strong');
      var hint = box.querySelector('.rv-hint');
      var total = violations.length;
      var plural = total === 1 ? '' : 's';
      if (outstanding.length) {
        box.removeAttribute('data-resolved');
        if (head) head.textContent = outstanding.length + ' of ' + total + ' protected file' + plural + ' not yet accepted';
        if (hint) hint.textContent = 'Open each file to decide. Unblock reverts every rejected file to its base commit; accept refuses while any is still rejected.';
      } else {
        box.setAttribute('data-resolved', '1');
        if (head) head.textContent = 'All ' + total + ' protected file' + plural + ' accepted';
        if (hint) hint.textContent = 'Unblock keeps these changes; accept can merge them.';
      }
    }
  })();
})();
</script>`;
}

/**
 * The review queue's sortable columns, in render order — and the complete set
 * of fields `?sort=` accepts on `/review`.
 *
 * `last_active` deliberately spells its field the way the task list does, so a
 * `?sort=-last_active` means the same thing on both pages. `kind` only drives
 * the wording of the "sorted by …" note under the heading.
 */
const REVIEW_QUEUE_COLUMNS = [
  { field: 'task', label: 'Task', kind: 'text' },
  { field: 'type', label: 'Type', kind: 'text' },
  { field: 'goal', label: 'Goal', kind: 'text' },
  { field: 'last_active', label: 'Last activity', kind: 'time' },
  { field: 'subtasks', label: 'Subtasks', kind: 'count' },
] as const satisfies readonly (SortColumn & { kind: SortColumnKind })[];

export type ReviewQueueSortField = (typeof REVIEW_QUEUE_COLUMNS)[number]['field'];

/**
 * Newest activity first — the order the task list's blocked filter uses, and
 * the one that puts what you were last looking at on top.
 */
export const DEFAULT_REVIEW_QUEUE_SORT: SortConfig<ReviewQueueSortField> = {
  field: 'last_active',
  direction: 'desc',
};

const REVIEW_QUEUE_SORT_FIELDS: readonly ReviewQueueSortField[] = REVIEW_QUEUE_COLUMNS.map(
  (c) => c.field,
);

/** Parse `/review?sort=…`, falling back to {@link DEFAULT_REVIEW_QUEUE_SORT}. */
export function parseReviewQueueSort(sort: string | null): SortConfig<ReviewQueueSortField> {
  return parseSortParam(sort, REVIEW_QUEUE_SORT_FIELDS, DEFAULT_REVIEW_QUEUE_SORT);
}

/** The label a queue row shows for a task: its code, else a short id. */
function queueLabel(entry: ReviewQueueEntry): string {
  return entry.code ?? entry.id.substring(0, 8);
}

/**
 * Order the queue. Returns a new array — the caller's is left alone.
 *
 * Every field breaks ties the same way (most recently updated, then label), so
 * two tasks with the same type — or the same subtask count — never swap places
 * between two renders of the same data.
 */
export function sortReviewQueue(
  entries: ReviewQueueEntry[],
  config: SortConfig<ReviewQueueSortField> = DEFAULT_REVIEW_QUEUE_SORT,
): ReviewQueueEntry[] {
  const dir = config.direction === 'desc' ? -1 : 1;
  return [...entries].sort((a, b) => {
    let cmp = 0;
    switch (config.field) {
      case 'task':
        cmp = queueLabel(a).localeCompare(queueLabel(b));
        break;
      case 'type':
        cmp = a.type.localeCompare(b.type);
        break;
      case 'goal':
        cmp = a.goal.localeCompare(b.goal);
        break;
      case 'last_active': {
        // A task whose agent never ran sinks to the bottom whichever way the
        // column points: it has no activity to rank, and floating it above
        // tasks that do is never what "oldest first" was asking for.
        const at = a.lastActiveAt;
        const bt = b.lastActiveAt;
        if (at === null || bt === null) {
          if (at !== null || bt !== null) return at === null ? 1 : -1;
          break;
        }
        cmp = at - bt;
        break;
      }
      case 'subtasks':
        cmp = a.descendantCount - b.descendantCount;
        break;
    }
    return (cmp * dir) || (b.updatedAt - a.updatedAt) || queueLabel(a).localeCompare(queueLabel(b));
  });
}

export function reviewQueueHtml(
  entries: ReviewQueueEntry[],
  sortParam: string | null = null,
  /** Codes shared by more than one task — those rows link by id instead. */
  duplicatedCodes?: ReadonlySet<string>,
): string {
  // The page parses and sorts rather than trusting a pre-sorted list, so the
  // arrow in a column header can never disagree with the rows underneath it.
  const sort = parseReviewQueueSort(sortParam);
  const ordered = sortReviewQueue(entries, sort);

  const rows = ordered
    .map((e) => {
      const pending = e.pendingAsks > 0
        ? `<span class="rv-badge rv-pending">${e.pendingAsks} awaiting agent</span>`
        : '';
      const queued = e.pendingComments > 0
        ? `<span class="rv-badge rv-pending">${e.pendingComments} comment${e.pendingComments === 1 ? '' : 's'} to deliver</span>`
        : '';
      const comments = e.commentCount > 0 ? `<span class="rv-badge">${e.commentCount} comments</span>` : '';
      const noSession = e.hasSession ? '' : '<span class="rv-badge">no session</span>';
      const subtasks = e.descendantCount > 0 ? String(e.descendantCount) : '-';
      return `<tr>
        <td><a href="${taskPath({ id: e.id, code: e.code }, duplicatedCodes)}">${escapeHtml(queueLabel(e))}</a></td>
        <td>${escapeHtml(e.type)}</td>
        <td>${escapeHtml(e.goal)}</td>
        <td class="rv-queue-when">${escapeHtml(relativeTime(e.lastActiveAt))}</td>
        <td class="rv-queue-count">${subtasks}</td>
        <td>${comments} ${queued} ${pending} ${noSession}</td>
      </tr>`;
    })
    .join('\n');

  const activeColumn = REVIEW_QUEUE_COLUMNS.find((c) => c.field === sort.field)!;
  const orderNote = `<p class="rv-queue-order">Sorted by <strong>${escapeHtml(activeColumn.label.toLowerCase())}</strong>, ${orderPhrase(activeColumn.kind, sort.direction)} — click a column to re-sort.</p>`;
  const headers = sortHeadersHtml(REVIEW_QUEUE_COLUMNS, sort, (param) => `/review?sort=${param}`);

  const body = entries.length
    ? `${orderNote}<table class="rv-queue"><thead><tr>${headers}<th></th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="empty-state">Nothing awaiting review.</p>';

  return layoutHtml('Review queue', `<h1>Review queue</h1>${body}`);
}

export interface Thread {
  threadId: string;
  file: string;
  side: string;
  line: number;
  messages: ReviewComment[];
}

/** Threads anchored to the task as a whole (Ask tab), not to a diff line. */
export function taskLevelThreads(comments: ReviewComment[]): Thread[] {
  return groupThreads(comments).filter((t) => isTaskLevelReviewAnchor(t.file, t.line));
}

/** Group a task's review comments into threads, oldest thread first. */
export function groupThreads(comments: ReviewComment[]): Thread[] {
  const byThread = new Map<string, Thread>();
  for (const c of comments) {
    let t = byThread.get(c.thread_id);
    if (!t) {
      t = { threadId: c.thread_id, file: c.file, side: c.side, line: c.line, messages: [] };
      byThread.set(c.thread_id, t);
    }
    t.messages.push(c);
  }
  return [...byThread.values()];
}

/**
 * Live task state for the sticky status bar and the ask guidance.
 *
 * Assembled by the route handler (it needs Storage) rather than derived from
 * the Task alone, because the two things a reviewer actually wants to know
 * while reading a long diff — how many turns have run and when the agent last
 * did anything — live on the session, not the task.
 */
export interface ReviewLiveState {
  status: string;
  turns: number;
  lastActiveAt: number | null;
  /** True when a question posted right now would be answered at all. */
  askable: boolean;
  /** Why it would not be, in the reviewer's words; null when askable. */
  askUnavailable: string | null;
  /**
   * How it would be answered: the live agent, or the task's stored record.
   *
   * Optional because a hand-built state (a display test, an older cached poll
   * payload) may not carry it. Absent reads as the live route — the page then
   * simply says nothing about provenance, which is right: the RULE is
   * resolveAskAvailability and the ANSWER carries its own provenance, so a
   * missing hint here can never make a record answer look live.
   */
  askRoute?: AskRoute | null;
  /** Where a record-derived answer comes from; null on the live route. */
  askProvenance?: string | null;
  /**
   * Why Unblock would be refused right now, in the reviewer's words; null when
   * it would be taken. Optional for the same reason as askRoute. The rule is
   * unblockUnavailableReason (review-actions.ts).
   */
  unblockUnavailable?: string | null;
}

/**
 * The status bar's one-line answer to "can I ask this task anything?".
 *
 * Mirrored verbatim by the poll island (see renderStatus) — the bar must not
 * change its words on the first refresh.
 */
export function askBarLabel(state: Pick<ReviewLiveState, 'askable' | 'askRoute'>): string {
  if (!state.askable) return 'nothing recorded yet — asks are saved, not sent';
  return state.askRoute === 'record' ? 'answered from the task record' : 'agent can answer';
}

/**
 * State for a task we know nothing more about than its status.
 *
 * Deliberately OPTIMISTIC about the session and the record: this fallback is
 * used where Storage was never consulted, and guessing "the session has ended"
 * from no evidence would tell the reviewer the answer comes from the record
 * when it may well come from the live agent.
 */
function fallbackState(task: Task): ReviewLiveState {
  const availability = resolveAskAvailability({
    status: task.status,
    liveSession: true,
    resumableAgentSession: true,
    worktreeExists: true,
    hasRecord: true,
  });
  return {
    status: task.status,
    turns: 0,
    lastActiveAt: null,
    askable: availability.unavailable === null,
    askUnavailable: availability.unavailable,
    askRoute: availability.route,
    askProvenance: availability.provenance,
    unblockUnavailable: unblockUnavailableReason(task.status),
  };
}

/**
 * The Withdraw control under one of the reviewer's own messages, or the reason
 * there is none.
 *
 * A plain form, like retry, so a comment can be taken back with scripting off.
 * When withdrawal is refused, the daemon's own wording is shown as a hint
 * rather than a disabled button that explains nothing — the reviewer's question
 * is always "why can't I take this back", and this answers it in place.
 * Refusals are only rendered on messages the reviewer might plausibly want to
 * withdraw, so a delivered comment says so but an ordinary agent reply is silent.
 */
function withdrawControlHtml(taskId: string, m: ReviewComment): string {
  if (m.role !== 'human' || isWithdrawn(m)) return '';
  const refusal = withdrawRefusalReason(m);
  if (refusal) {
    return `<div class="rv-state rv-state-hint rv-withdraw-why">${escapeHtml(refusal)}</div>`;
  }
  return (
    `<form class="rv-withdraw" method="post" action="/tasks/${escapeHtml(taskId)}/review/comment/${encodeURIComponent(m.id)}/withdraw">` +
    `<button type="submit">Withdraw</button></form>`
  );
}

/** The one-line status under a message: what happened to it, or what will. */
function messageStateHtml(taskId: string, m: ReviewComment): string {
  // Withdrawal is terminal and outranks every other state line: the message was
  // never sent, so "queued" or "not sent — re-send?" would both be wrong now.
  if (isWithdrawn(m)) {
    return '<div class="rv-state rv-state-withdrawn">withdrawn — never sent to the agent</div>';
  }
  if (m.ask_state === 'pending') {
    return '<div class="rv-state rv-state-pending">waiting for the agent…</div>';
  }
  if (m.ask_state === 'failed') {
    // The retry is a plain form, not a fetch: re-sending a question the
    // reviewer already typed must not depend on JavaScript being alive.
    return (
      `<div class="rv-state rv-state-failed">not sent: ${escapeHtml(m.ask_error ?? 'unknown error')} (your question is saved)</div>` +
      `<form class="rv-retry" method="post" action="/tasks/${escapeHtml(taskId)}/review/comment/${encodeURIComponent(m.id)}/retry">` +
      `<button type="submit">Re-send to agent</button></form>`
    );
  }
  if (m.delivery_state === 'pending_delivery') {
    return '<div class="rv-state rv-state-queued">Pending — rides the next unblock</div>';
  }
  if (m.delivery_state === 'delivered') {
    return `<div class="rv-state rv-state-delivered">${deliveredLabel(m.delivered_turn, m.delivered_at)}</div>`;
  }
  return '';
}

/**
 * "Delivered in turn N (3m ago)" — the one delivered wording, shared by
 * comments and raised items so the two cannot drift. Records that predate the
 * turn stamp (or were materialized outside a turn launch, e.g. at accept)
 * degrade to "Delivered (3m ago)" rather than inventing a turn number.
 */
function deliveredLabel(turn: number | null | undefined, at: number | null | undefined): string {
  const when = at != null ? ` (${escapeHtml(relativeTime(at))})` : '';
  return turn != null
    ? `Delivered in turn ${escapeHtml(String(turn))}${when}`
    : `Delivered${when}`;
}

/** Who wrote it, and — for the reviewer — which intent they chose. */
function messageAuthor(m: ReviewComment): string {
  if (m.role === 'agent') return 'agent';
  return m.intent === 'comment' ? 'you (comment)' : 'you (ask)';
}

/**
 * "Promote to a task" under a task-level discussion.
 *
 * A discussion is where the work a task did NOT do usually gets named — the
 * reviewer asks why something is the way it is, the answer explains, and the
 * next task is sitting there in plain text with nobody to write it down. This
 * writes it down, seeded with the whole exchange and editable before anything
 * is created.
 *
 * A plain form, like Retry and Withdraw, so it works with scripting off. The
 * created task is a BACKLOG task: the web UI never auto-starts work.
 */
function promoteDiscussionHtml(
  task: Task,
  t: Thread,
  duplicatedCodes?: ReadonlySet<string>,
): string {
  const seed = discussionPromoteSeed(task, t);
  if (!seed) return '';
  if (seed.promotedTaskId) {
    // The badge labels the task created at promote time; the href resolves by
    // code-or-id like every other task link.
    const label = seed.promotedTaskCode ?? seed.promotedTaskId.slice(0, 8);
    return `<div class="rv-state rv-state-hint">Promoted to ` +
      `<a href="${taskPath({ id: seed.promotedTaskId, code: seed.promotedTaskCode ?? null })}">${escapeHtml(label)}</a>.</div>`;
  }
  return `<details class="rv-promote">
      <summary>Promote to a task</summary>
      <!-- The POST target is the DUP-AWARE segment: a code two tasks share
           resolves to the resolver's winner, so promoting from this thread
           would create the task off a different task (or 404). This is a
           write, which is why it is the one that must not guess. -->
      <form method="post" action="/tasks/${escapeHtml(taskPathSegment(task, duplicatedCodes))}/review/thread/${encodeURIComponent(t.threadId)}/promote">
        <label><span class="rv-tab-lead">Goal</span>
          <input type="text" name="goal" value="${escapeHtml(seed.goal)}" required></label>
        <label><span class="rv-tab-lead">Code</span>
          <input type="text" name="code" value="${escapeHtml(seed.code)}" placeholder="optional"></label>
        <fieldset class="rv-promote-relation">
          <legend>Where it goes</legend>
          <label><input type="radio" name="relation" value="subtask" checked> Subtask of this task</label>
          <label><input type="radio" name="relation" value="peer"> Sibling of this task</label>
        </fieldset>
        <label><span class="rv-tab-lead">Prompt — edit before creating</span>
          <textarea name="prompt" rows="12" required>${escapeHtml(seed.prompt)}</textarea></label>
        <div class="rv-form-actions">
          <button type="submit">Create task</button>
          <span class="rv-hint">Created in the backlog — nothing starts until you start it.</span>
        </div>
      </form>
    </details>`;
}

/**
 * What the Promote control needs to render, for one discussion — or null when
 * there is nothing to promote yet. The rule lives in
 * src/review/promote-discussion.ts, shared with the `reviewComments` RPC.
 */
export function discussionPromoteSeed(task: Task, t: Thread): DiscussionPromoteSeed | null {
  return seedDiscussionPromotion(task, t.threadId, t.messages);
}

export function threadHtml(
  taskId: string,
  t: Thread,
  options: {
    taskLevel?: boolean;
    prose?: boolean;
    markdown?: RenderMarkdownOptions;
    /** Offer "Promote to a task" on this thread. Task-level discussions only. */
    promoteFor?: Task;
    /**
     * Codes shared by more than one task — the Promote form's POST target
     * falls back to the id for those. Both callers that pass `promoteFor`
     * already hold the set.
     */
    duplicatedCodes?: ReadonlySet<string>;
  } = {},
): string {
  const msgs = t.messages
    .map(
      (m) => `<div class="rv-msg rv-msg-${escapeHtml(m.role)}${isWithdrawn(m) ? ' rv-msg-withdrawn' : ''}">
        <div class="rv-msg-head">${messageAuthor(m)}</div>
        <div class="rv-msg-body turn-content">${renderMarkdown(m.content, options.markdown)}</div>${messageStateHtml(taskId, m)}${withdrawControlHtml(taskId, m)}
      </div>`,
    )
    .join('\n');
  // A prose thread's Reply button gets its own class (not rv-reply): those are
  // handled by the diff-table listener, and a prose thread lives outside it.
  const replyClass = options.taskLevel
    ? 'rv-reply rv-task-reply'
    : options.prose
      ? 'rv-prose-reply'
      : 'rv-reply';
  const anchorAttrs = options.taskLevel
    ? ` data-file="${escapeHtml(TASK_LEVEL_REVIEW_ANCHOR.file)}" data-side="${escapeHtml(TASK_LEVEL_REVIEW_ANCHOR.side)}" data-line="${TASK_LEVEL_REVIEW_ANCHOR.line}"`
    : options.prose
      ? ` data-file="${escapeHtml(t.file)}" data-side="new" data-line="${t.line}"`
      : '';
  const threadClass = options.taskLevel ? ' rv-task-thread' : options.prose ? ' rv-prose-thread' : '';
  const promote = options.promoteFor
    ? promoteDiscussionHtml(options.promoteFor, t, options.duplicatedCodes)
    : '';
  return `<div class="rv-thread${threadClass}"${anchorAttrs}>` +
    `${msgs}<button type="button" class="${replyClass}" data-thread="${escapeHtml(t.threadId)}">Reply</button>${promote}</div>`;
}

/**
 * Human comments still waiting to ride the next unblock turn, oldest first.
 *
 * Delegates to the shared predicate the daemon uses to build the unblock
 * prompt, so what the page lists as queued is exactly what will be delivered —
 * withdrawn comments included in neither.
 */
export function pendingDeliveryComments(comments: ReviewComment[]): ReviewComment[] {
  return comments.filter(isPendingDelivery);
}

/**
 * Everything the next unblock will carry, in full.
 *
 * Deliberately NOT truncated: this list is the reviewer's only record of what
 * they have already said before they commit to sending it, and a comment cut
 * off at 120 characters is exactly the one they would want to re-read. Each
 * entry links back to the diff row it was written against.
 */
/** The quoted line in the queued list, capped so one long block stays a label. */
function truncateQuote(s: string): string {
  const text = s.replace(/\s+/g, ' ').trim();
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

function queuedHtml(queued: ReviewComment[], markdown?: RenderMarkdownOptions): string {
  if (queued.length === 0) {
    return '<div class="rv-hint">No comments queued for delivery.</div>';
  }
  const items = queued
    .map((c) => {
      // Neither a task-level reply nor a prose-anchored comment has a diff row
      // to link back to: say where each came from instead of linking to an
      // anchor that does not exist on the page — and for prose, quote the line
      // rather than showing a pseudo-file:hash "link".
      const where = isTaskLevelReviewAnchor(c.file, c.line)
        ? '<span class="rv-queued-where">on the task-level conversation</span>'
        : isProseReviewAnchor(c.file)
        ? `<span class="rv-queued-where">${escapeHtml(proseAnchorReviewerWhere(c.file))}: <q>${escapeHtml(truncateQuote(c.anchor_snippet ?? ''))}</q></span>`
        : `<a class="rv-queued-where" href="#${escapeHtml(anchorDomId({ file: c.file, side: c.side, line: c.line }))}"><code>${escapeHtml(c.file)}</code>:${c.line} (${escapeHtml(c.side)})</a>`;
      return `<li class="rv-queued-item">
        ${where}
        <div class="rv-msg-body turn-content">${renderMarkdown(c.content, markdown)}</div>
      </li>`;
    })
    .join('\n');
  return `<div>${queued.length} comment${queued.length === 1 ? '' : 's'} queued — they will be sent with your next unblock.</div>
    <ul class="rv-queued-list">${items}</ul>`;
}

/**
 * Raised items — ONE card list for blocking and non-blocking alike, blocking
 * first, at the same visual weight as the protected-file violation summary.
 *
 * There used to be two blocks here: raised items (gating) above the diff and
 * follow-ups (never gating) below it. They are one entity now
 * (docs/design/raised-items-unified.md), so they are one list, and the only
 * thing `blocking` changes is the order, the per-row tag, and the copy — a
 * reviewer reads what gates accept first and what is merely proposed after,
 * without having to hold two vocabularies.
 *
 * Each open row is a real `/raised/:id` permalink. The Raised tab intercepts
 * those into a dialog (src/server/raised-dialog.ts); the decide form lives in
 * that panel, not in the list. Undo of a pending decision still POSTs to
 * `/tasks/:id/review/raised/unresolve` from the list.
 */
/**
 * "Decided by <who>" under a resolved row.
 *
 * The reviewer is looking at decisions that gate this task's merge; on a team
 * the one thing the row cannot leave out is which member made each of them.
 * One spelling, shared with every other surface (src/actor-ref.ts) — and
 * nothing at all for a record written before per-person attribution existed.
 */
function decidedByHint(item: RaisedItem): string {
  const who = attributionLabel(item.resolved_by, item.resolved_by_email, item.resolved_by_name);
  return who ? `<p class="rv-hint">Decided by ${escapeHtml(who)}</p>` : '';
}

export function raisedItemsSummary(
  taskId: string,
  items: RaisedItem[],
  /** Codes shared by more than one task — promoted-task links fall back to the id for those. */
  options?: { duplicatedCodes?: ReadonlySet<string> },
): string {
  const open = items
    .filter((i) => i.status === 'open')
    // Blocking first: these are the ones standing between the reviewer and a
    // merge. Stable within each group, so the agent's own order survives.
    .sort((a, b) => Number(b.blocking) - Number(a.blocking));
  const openBlocking = open.filter((i) => i.blocking).length;
  const openNonBlocking = open.length - openBlocking;
  const undoable = items.filter((i) => i.status !== 'open' && i.comment_delivered_at == null);
  // Delivered resolutions stay on the page — compact, undo-free — so the
  // reviewer can always tell a decision that reached the agent from one that
  // is still riding the next unblock. They used to be filtered out entirely,
  // which read as the decision having vanished.
  const delivered = items.filter((i) => i.status !== 'open' && i.comment_delivered_at != null);
  if (open.length === 0 && undoable.length === 0 && delivered.length === 0) return '';

  // Badges come from src/server/raised-badges.ts — the one vocabulary. This
  // list used to spell its own: `gates accept` in a `tag-blocking` class no
  // stylesheet defined, a bare `FYI`, and the raw stored status on a resolved
  // row. Three unstyled strings that read as debug output, which is exactly how
  // they were received.
  const openRows = open
    .map((item) => {
      const id = escapeHtml(item.id);
      const title = escapeHtml(raisedDisplayTitle(item));
      return `<li class="rv-raised-item lz-raised-row" data-raised-id="${id}" data-blocking="${item.blocking ? '1' : '0'}">
        <div class="rv-raised-head">
          ${raisedGateBadgeHtml(item.blocking, 'full')}
          <a class="lz-raised-open" href="/raised/${id}">${title}</a>
        </div>
      </li>`;
    })
    .join('');

  const pendingRows = undoable
    .map((item) => {
      const id = escapeHtml(item.id);
      const title = escapeHtml(raisedDisplayTitle(item));
      const note = item.resolution
        ? `<p class="rv-hint">Resolution: ${escapeHtml(item.resolution)}</p>`
        : '';
      const by = decidedByHint(item);
      return `<li class="rv-raised-item rv-raised-pending lz-raised-row" data-raised-id="${id}" data-blocking="${item.blocking ? '1' : '0'}">
        <div class="rv-raised-head">
          ${raisedGateBadgeHtml(item.blocking)}
          ${raisedDecisionBadgeHtml(item.status, {
            promotedTaskId: item.promoted_task_id,
            promotedTaskCode: item.promoted_task_code ?? null,
            duplicatedCodes: options?.duplicatedCodes,
          })}
          <a class="lz-raised-open" href="/raised/${id}">${title}</a>
        </div>
        ${note}
        ${by}
        <p class="rv-state rv-state-queued">Pending — rides the next unblock (or accept). Undo until then. For a promotion, the new task is created then too.</p>
        <form class="rv-raised-undo" method="post" action="/tasks/${escapeHtml(taskId)}/review/raised/unresolve">
          <input type="hidden" name="id" value="${id}">
          <button type="submit">Undo</button>
        </form>
      </li>`;
    })
    .join('');

  // Delivered decisions: one compact line each, no undo — the agent has the
  // comment, so the only honest affordance is the record of what was said and
  // which turn carried it.
  const deliveredRows = delivered
    .map((item) => {
      const title = escapeHtml(raisedDisplayTitle(item));
      return `<li class="rv-raised-item rv-raised-delivered lz-raised-row" data-raised-id="${escapeHtml(item.id)}">
        <div class="rv-raised-head">
          ${raisedGateBadgeHtml(item.blocking)}
          ${raisedDecisionBadgeHtml(item.status, {
            promotedTaskId: item.promoted_task_id,
            promotedTaskCode: item.promoted_task_code ?? null,
            duplicatedCodes: options?.duplicatedCodes,
          })}
          <a class="lz-raised-open" href="/raised/${escapeHtml(item.id)}">${title}</a>
        </div>
        ${decidedByHint(item)}
        <span class="rv-state rv-state-delivered">${deliveredLabel(item.delivered_turn, item.comment_delivered_at)}</span>
      </li>`;
    })
    .join('');

  // The counts lead with the same glyphs the rows below carry, so the heading
  // and the list read as one thing rather than as a sentence above some tags.
  const headParts: string[] = [];
  if (openBlocking > 0) {
    headParts.push(`${raisedGateVocabulary(true).emoji} ${openBlocking} open blocking raised item${openBlocking === 1 ? '' : 's'} — accept refuses until each is responded to, promoted, dismissed, or acknowledged`);
  }
  if (openNonBlocking > 0) {
    headParts.push(`${raisedGateVocabulary(false).emoji} ${openNonBlocking} open FYI — optional; ${openNonBlocking === 1 ? 'it does' : 'they do'} not block accept`);
  }
  if (undoable.length > 0) {
    headParts.push(`${undoable.length} resolved, pending — ride${undoable.length === 1 ? 's' : ''} the next unblock`);
  }
  if (delivered.length > 0) {
    headParts.push(`${delivered.length} delivered`);
  }
  const head = headParts.join(' · ');
  const hint = open.length > 0
    ? 'Open an item to respond, promote, dismiss or acknowledge. Promote to subtask creates a child; promote to peer creates a sibling — never auto-starts. Undo a pending decision until the next unblock.'
    : undoable.length > 0
      ? 'Undo a decision here to reopen the item before the comment is delivered.'
      : 'These decisions already reached the agent.';
  return `<div class="rv-raised rv-violations">
      <strong>${escapeHtml(head)}</strong>
      <p class="rv-hint">${escapeHtml(hint)}</p>
      <ul class="rv-violation-list rv-raised-list">${openRows}${pendingRows}${deliveredRows}</ul>
    </div>`;
}

// Reviewer-facing labels for a resolved raised item's stored status used to
// live here as a local map. They are in src/raised/vocabulary.ts now, with the
// gate words and the emoji, so every surface says the same thing.

export interface AgentReportHtmlOptions {
  /** Which tab this card is for — selects and ranks sections. */
  surface?: ReportSurface;
  markdown?: RenderMarkdownOptions;
  /** Landing: say so when the agent wrote `implementation` but not `behavior_change`. */
  showNoBehaviorNotice?: boolean;
}

/**
 * Agent report — structured TurnReport when present, else last agent turn prose.
 *
 * INVARIANT (narrowed 2026-09, engineer-approved): storage keeps agent order;
 * this renderer applies src/review/report-policy.ts so a reviewer sees what
 * the product does before how it was done. Agent order is preserved within a
 * tier. `surface` emits a subset (Landing vs Changes).
 *
 * The report is ALWAYS shown in full (for the sections this surface keeps).
 */
export function agentReportHtml(
  taskId: string,
  turn: Turn | null,
  report: TurnReport | null = null,
  options: AgentReportHtmlOptions = {},
): string {
  const markdown = options.markdown;
  const surface = options.surface ?? 'full';
  // The report names the turn it came from; that name is the only route from
  // this page to that turn's own page, so it is a LINK. It said "Turn #7" in
  // plain text before, and the turn page was reachable from here only if the
  // "since you last looked" card happened to list the same turn.
  const seqLink = (sequence: number): string =>
    // taskId is the ESCAPED path segment (taskPathSegment) — interpolate raw.
    `<a href="/tasks/${escapeHtml(taskId)}/turns/${sequence}" title="Open turn #${sequence} in its chunk">Turn #${sequence}</a>`;

  if (report && report.sections.length > 0) {
    const visible = sectionsForSurface(report.sections, surface);
    const notice =
      options.showNoBehaviorNotice && reportDeclaresNoBehavior(report.sections)
        ? `<p class="rv-hint">Agent declared no behavioral change.</p>`
        : '';
    if (visible.length === 0 && !notice) {
      if (surface !== 'full') return '';
    }
    const sectionsHtml = visible
      .map((s) => {
        const label = REPORT_SECTION_LABELS[s.kind] ?? s.kind;
        return `<section class="rv-report-section" data-kind="${escapeHtml(s.kind)}">
          <h3 class="rv-report-section-title">${escapeHtml(label)}</h3>
          <div class="rv-agent-report-body turn-content" data-rv-prose="${escapeHtml(PROSE_REPORT_FILE)}" data-rv-prose-kind="${escapeHtml(s.kind)}">${renderMarkdown(s.body, markdown)}</div>
        </section>`;
      })
      .join('');
    if (!sectionsHtml && !notice) return '';
    // This line is the one the report quoted verbatim: `a1249791, 3bc4fb1e` as
    // bare unclickable `<code>`, directly under a card full of links. The ids
    // are the ONLY thing the report carries about those items — no title, no
    // gate — so the honest fix is to spend them on the link itself and count
    // them, rather than print truncations a reader can neither read nor use.
    const raisedCount = report.raised_item_ids?.length ?? 0;
    const raised = raisedCount
      ? `<p class="rv-hint">References ${report.raised_item_ids!
          .map((id, i) => `<a href="/raised/${escapeHtml(id)}">raised item ${i + 1}</a>`)
          .join(', ')}</p>`
      : '';
    const seqHint = report.turn_sequence != null
      ? seqLink(report.turn_sequence)
      : turn
        ? seqLink(turn.sequence)
        : 'structured report';
    // WHEN, without a click. "What changed for you" answered *what* and left
    // the reviewer opening the turn to find out *when* — so the turn's own
    // timestamp (the report's own, when the turn is not to hand) rides in the
    // card head, relative for scanning and exact in the tooltip.
    const whenAt = turn?.timestamp ?? report.created_at;
    const whenInfo = whenAt ? ` <span class="rv-hint">· ${timestampHtml(whenAt)}</span>` : '';
    const launchSegment = turn ? formatTurnLaunchLabels(turn) : '';
    const launchInfo = launchSegment
      ? ` <span class="turn-launch">${escapeHtml(launchSegment)}</span>`
      : '';
    const modelWarning = turn ? formatTurnModelWarning(turn) : undefined;
    const warningInfo = modelWarning
      ? ` <span class="turn-model-warning">${escapeHtml(modelWarning)}</span>`
      : '';
    const head =
      surface === 'landing'
        ? '<strong>What changed for you</strong>'
        : surface === 'changes'
          ? '<strong>How it was done</strong>'
          : '<strong>Agent report</strong>';
    return viewedCardHtml({
      key: surface === 'full' ? 'agent-report' : `agent-report-${surface}`,
      content: (visible.length ? visible : report.sections).map((s) => `${s.kind}\n${s.body}`).join('\n---\n')
        + (notice ? '\nno-behavior' : ''),
      headHtml: `${head} <span class="rv-hint">${seqHint}</span>${whenInfo}${launchInfo}${warningInfo}`,
      bodyHtml: `${notice}${raised}${sectionsHtml}`,
      sectionClass: 'rv-agent-report rv-structured-report',
    });
  }

  if (surface === 'changes') return '';
  if (!turn) return '';
  const raw = turnText(turn);
  if (!raw.trim()) return '';
  return viewedCardHtml({
    key: 'agent-report',
    content: raw,
    headHtml: `<strong>Agent report</strong> <span class="rv-hint">${seqLink(turn.sequence)} · ${timestampHtml(turn.timestamp)}</span>`,
    bodyHtml: `<div class="rv-agent-report-body turn-content" data-rv-prose="${escapeHtml(PROSE_REPORT_FILE)}">${renderMarkdown(raw, markdown)}</div>`,
    sectionClass: 'rv-agent-report',
  });
}

/**
 * The protected-file summary above the actions.
 *
 * REPORTS state, never changes it. Approving a change you have not looked at is
 * exactly the mistake this surface should not make easy, so each row links to
 * the file's diff and the decision is made down there, next to the code.
 */
function violationSummary(
  taskId: string,
  violations: FileViolation[],
  filesInDiff: Set<string>,
  fileDecisions: FileDecision[] = [],
): string {
  if (violations.length === 0) return '';
  const reasons = new Map(
    fileDecisions
      .filter((d) => d.scope === 'protected')
      .map((d) => [d.target, d.reason]),
  );
  const outstanding = violations.filter((v) => v.status !== 'approved');
  const rows = violations
    .map((v) => {
      const approved = v.status === 'approved';
      const reason = reasons.get(v.file);
      const reasonHtml = reason
        ? `<div class="rv-hint rv-justify-reason">Agent keep reason: ${escapeHtml(reason)}</div>`
        : '';
      // THE ONE EXCEPTION to "this summary does not change state": a violated
      // file with no section in the diff has no file box to hold its control,
      // and with no control anywhere the reviewer is stuck — accept refuses on
      // it forever. It gets its control here, and it is still the only one.
      const body = filesInDiff.has(v.file)
        ? `<a href="#${escapeHtml(fileSectionId(v.file))}"><code>${escapeHtml(v.file)}</code></a>` +
          `<span class="rv-violation-state">${approved ? 'accepted' : 'not yet accepted'}</span>`
        : `<code>${escapeHtml(v.file)}</code> <span class="rv-hint">(not in this diff)</span>` +
          violationDecision(taskId, v.file, v.status);
      return `<li class="rv-violation-item" data-approved="${approved ? '1' : '0'}" data-rv-summary="${escapeHtml(v.file)}">
        <span class="rv-violation-mark" aria-hidden="true"></span>
        ${body}
        ${reasonHtml}
      </li>`;
    })
    .join('');
  const head = outstanding.length
    ? `${outstanding.length} of ${violations.length} protected file${violations.length === 1 ? '' : 's'} not yet accepted`
    : `All ${violations.length} protected file${violations.length === 1 ? '' : 's'} accepted`;
  const hint = outstanding.length
    ? 'Open each file to decide. Accept refuses until every one is accepted; unblocking the agent again changes nothing about them.'
    : 'All decided — accept can merge them.';
  return `<div class="rv-violations"${outstanding.length ? '' : ' data-resolved="1"'}>
      <strong>${escapeHtml(head)}</strong>
      <p class="rv-hint">${escapeHtml(hint)}</p>
      <ul class="rv-violation-list">${rows}</ul>
    </div>`;
}



/**
 * Maintained-group skip reasons from structured file decisions (when present).
 *
 * Rendered as a labelled viewable card, not loose prose: the reasons are the
 * agent's words, and without a header saying whose words and about what, the
 * block reads as orphan text the reviewer cannot place. Exported for the
 * markup unit test.
 */
export function maintainDecisionsHtml(fileDecisions: FileDecision[]): string {
  const skips = fileDecisions.filter((d) => d.scope === 'maintain');
  if (skips.length === 0) return '';
  const rows = skips
    .map(
      (d) =>
        `<li class="rv-maintain-item"><strong>${escapeHtml(d.target)}</strong>: ${escapeHtml(d.reason)}</li>`,
    )
    .join('');
  return viewedCardHtml({
    key: 'maintain-skips',
    // The tick clears when the decisions change: hash what the agent said.
    content: skips.map((d) => `${d.target}\n${d.reason}`).join('\n---\n'),
    headHtml:
      `<strong>Maintained files the agent chose not to update</strong> ` +
      `<span class="rv-hint">${skips.length} group${skips.length === 1 ? '' : 's'} skipped</span>`,
    bodyHtml: `<p class="rv-hint">This project's lazy.toml names file groups (docs, changelog, …) that are expected to be kept up to date as work happens. The agent judged that these groups needed no update this turn, and gave a reason for each.</p>
      <ul class="rv-maintain-list">${rows}</ul>`,
    sectionClass: 'rv-maintain-decisions',
  });
}

/**
 * Parse `raised_action[<id>]` / `raised_response[<id>]` form fields into the
 * resolution array accept/unblock expect. Empty actions are skipped so a
 * partial decide-and-accept does not invent blank resolutions.
 */
export function parseRaisedResolutionsFromForm(form: FormData): RaisedItemResolution[] {
  const resolutions: RaisedItemResolution[] = [];
  for (const [key, value] of form.entries()) {
    const match = /^raised_action\[(.+)\]$/.exec(key);
    if (!match) continue;
    const id = match[1];
    const action = String(value ?? '').trim();
    if (!(ACTIVE_RAISED_ACTIONS as readonly string[]).includes(action)) continue;
    const responseRaw = form.get(`raised_response[${id}]`);
    const response = responseRaw != null ? String(responseRaw).trim() : '';
    resolutions.push({
      id,
      action: action as ActiveRaisedResolveAction,
      ...(response ? { response } : {}),
    });
  }
  return resolutions;
}

/**
 * What the reviewer had typed when an action failed.
 *
 * CLAUDE.md's first invariant is that human feedback is never lost. A refused
 * accept re-renders the page, and without this the unblock feedback and the
 * accept reason the reviewer had already written would be blanked by that
 * re-render — punishing them for an accept the DAEMON refused.
 */
export interface ReviewDraft {
  reason?: string;
  feedback?: string;
  /**
   * Task-level ask textarea on the Ask tab. Declared but not populated until
   * review-state-persist lands (which persists client-side draft state).
   */
  ask?: string;
  /**
   * Protected files already marked ✅, carried through a refused-accept retry
   * so the passphrase POST submits exactly what the first accept submitted.
   */
  approvedFiles?: string[];
}

/**
 * Hidden fields that ride every accept POST, including a passphrase retry.
 * A conflict task's stored ✅ is not implied by a bare accept — the retry
 * must name the same files the first submit named.
 */
function approvedFilesHiddenInputs(files: readonly string[] | undefined): string {
  if (!files?.length) return '';
  return files
    .map((f) => `<input type="hidden" name="approved_files" value="${escapeHtml(f)}">`)
    .join('');
}

function uniqueApprovedFiles(...lists: Array<readonly string[] | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const f of list ?? []) {
      if (!seen.has(f)) {
        seen.add(f);
        out.push(f);
      }
    }
  }
  return out;
}

/**
 * The remedy panel: what to do about a refused accept.
 *
 * Everything here is composed by the DAEMON and merely rendered — the reason
 * slug decides which in-page affordance to offer, and the command is printed
 * exactly as it arrived. A reason this page has no affordance for still shows
 * `next` and the command, so a refusal added later degrades to correct advice
 * rather than to silence.
 */
export function remedyPanelHtml(taskId: string, remedy: AcceptRemedy, draft: ReviewDraft): string {
  const action = escapeHtml(`/tasks/${taskId}/review/accept`);
  // Carried through every remedy form so a second failure still cannot eat the
  // reviewer's words — or drop the approved files the first accept named.
  const carriedFiles = uniqueApprovedFiles(draft.approvedFiles, remedy.files);
  const carried =
    `<input type="hidden" name="reason" value="${escapeHtml(draft.reason ?? '')}">` +
    `<input type="hidden" name="feedback" value="${escapeHtml(draft.feedback ?? '')}">` +
    approvedFilesHiddenInputs(carriedFiles);

  const files = remedy.files?.length
    ? `<ul class="rv-remedy-files">${remedy.files.map((f) => `<li><code>${escapeHtml(f)}</code></li>`).join('')}</ul>`
    : '';

  let uiForm = '';
  if (remedy.uiAction === 'passphrase') {
    // Typed here, verified by the daemon, kept nowhere: no autofill, no
    // storage, and it is never echoed back into the re-rendered page.
    uiForm = `<form class="rv-remedy-form" method="post" action="${action}">
        <label>Approval passphrase
          <input type="password" name="passphrase" required autocomplete="off"
                 spellcheck="false" placeholder="Approval passphrase">
        </label>
        ${carried}
        <div class="rv-form-actions"><button type="submit" class="rv-primary">Approve and accept</button></div>
      </form>`;
  } else if (remedy.uiAction === 'sync') {
    // The review route, not the generic /actions/sync: only this handler reads
    // the carried draft back, and it returns the reviewer to the review page.
    uiForm = `<form class="rv-remedy-form" method="post" action="${escapeHtml(`/tasks/${taskId}/review/sync`)}">
        ${carried}
        <div class="rv-form-actions"><button type="submit">Sync with parent</button></div>
      </form>`;
  }

  const commandHint = uiForm
    ? 'Or run this in the project directory:'
    : 'Run this in the project directory:';
  const command = remedy.command
    ? `<p class="rv-hint">${commandHint}</p>
       <pre class="rv-remedy-cmd"><code>${escapeHtml(remedy.command)}</code></pre>`
    : '';

  return `<div class="rv-remedy" data-rv-remedy="${escapeHtml(remedy.reason)}">
      <strong>What to do next</strong>
      <p>${escapeHtml(remedy.next)}</p>
      ${files}
      ${uiForm}
      ${command}
    </div>`;
}

/**
 * Server-rendered prose threads (comments/asks anchored to a line of the
 * agent's report, a follow-up, or a raised item), each led by the quoted text.
 *
 * This is the no-JS rendering AND the reattachment fallback: with scripting on,
 * the island's first poll removes these wraps and re-inserts each thread
 * directly under the block whose content hash still matches; a thread whose
 * text has changed since (the agent reported again) comes back here, quote
 * intact — a conversation must never vanish because its anchor moved.
 */
export function proseThreadsFallbackHtml(taskId: string, threads: Thread[]): string {
  const prose = threads.filter((t) => isProseReviewAnchor(t.file));
  if (prose.length === 0) {
    // The island still needs the container to park detached threads in.
    return '<div id="rv-prose-orphans" class="rv-prose-threads" hidden></div>';
  }
  const items = prose
    .map((t) => {
      const quote = t.messages.find((m) => m.anchor_snippet)?.anchor_snippet ?? '';
      return `<div class="rv-prose-thread-wrap">${
        quote ? `<blockquote class="rv-prose-quote">${escapeHtml(quote)}</blockquote>` : ''
      }${threadHtml(taskId, t, { prose: true })}</div>`;
    })
    .join('\n');
  return `<div id="rv-prose-orphans" class="rv-prose-threads">
      <h2>Conversations on the report</h2>
      ${items}
    </div>`;
}

function taskLevelConversationHtml(task: Task, comments: ReviewComment[], duplicatedCodes?: ReadonlySet<string>): string {
  const taskId = taskPathSegment(task, duplicatedCodes);
  const threads = taskLevelThreads(comments);
  const current = threads.filter(askThreadIsCurrent);
  const filed = threads.filter((t) => !askThreadIsCurrent(t));
  // Same split as Current review and as the poll island: questions submitted
  // with an earlier review are collapsed, not removed.
  const head = current.length === 0
    ? '<div class="rv-hint">No open questions — ask about the task below.</div>'
    : current.map((t) => threadHtml(taskId, t, { taskLevel: true, promoteFor: task, duplicatedCodes })).join('\n');
  if (filed.length === 0) return head;
  return head + `\n<details class="lz-review-asks-filed">` +
    `<summary>Filed asks (${filed.length}) — answered and submitted with an earlier review</summary>` +
    filed.map((t) => threadHtml(taskId, t, { taskLevel: true, promoteFor: task, duplicatedCodes })).join('\n') +
    `</details>`;
}

/**
 * Unblock / Ask / Accept / Submit — buttons that open the shared action
 * dialog. The forms live in `<template>`s so opening one never reflows the
 * page (the old in-card tabs and `<details>` expanders jerked the layout).
 *
 * Current review renders this once (the second copy next to a long diff is
 * gone). Pass `{ extras: false }` there: queued comments and ask threads
 * already have their own sections on that tab, with withdraw and §6 links,
 * so repeating them inside the dialog would be a second list of the same
 * messages.
 */
/**
 * Why Unblock / Accept must stay closed on Current review.
 * Null when those verbs may be offered. Mirrored word-for-word in
 * reviewScript's busyUnblockAcceptReason so a live poll flips the same
 * gate without a reload — a title-only tooltip is not enough (the reason
 * must be visible copy), and a first-paint-only gate is not enough (a page
 * opened while blocked kept clickable Unblock through an in-flight review).
 */
/**
 * Attributes for a verb the busy gate hides. HIDDEN rather than disabled: a
 * greyed-out button cannot tell anyone why it is off, so the reason is the
 * visible `data-rv-busy-reason` line and the verb is simply not offered. The
 * island un-hides it from the same poll that clears that line.
 */
export function busyGateAttributes(busyReason: string | null): string {
  return busyReason ? 'data-rv-busy-gate hidden' : 'data-rv-busy-gate';
}

export function busyUnblockAcceptReason(status: string): string | null {
  if (status === 'working') {
    return 'The agent is working — the actions that change this task come back here once it pauses.';
  }
  if (status === 'pairing') {
    return 'Someone is pairing on this task — the actions that change it come back here once the session ends.';
  }
  return null;
}

/**
 * The Ask dialog's row: [Ask agent] [Add comment] [Unblock] [Cancel] over ONE
 * textarea — the same row every inline review box offers.
 *
 * The three verbs are three existing routes, chosen by the pressed button's
 * `formaction` (the dialog island honours it; so does a plain JS-off POST):
 * Ask → /review/ask, Add comment → /comments/add (a task comment, exactly
 * `lazy comment`: stored, no turn), Unblock → /review/unblock (`lazy unblock`).
 * All three read the textarea's `content` field. An action the task cannot
 * take now is left out of the row and its reason is written into it as text:
 * a disabled button cannot say why it is off.
 */
export function askDialogActionsHtml(seg: string, live: ReviewLiveState): string {
  const gate = (reason: string | null | undefined): string => (reason ? ' hidden' : '');
  const segAttr = escapeHtml(seg);
  const unblockReason = live.unblockUnavailable ?? unblockUnavailableReason(live.status);
  // A gated Unblock carries NO target at all, not merely `disabled`: the
  // JS-off copy of this form must never hold a POST the daemon would refuse
  // (the silent-refusal class current-review.test.ts pins).
  const unblockTarget = unblockReason ? '' : ` formaction="/tasks/${segAttr}/review/unblock"`;
  return `<div class="rv-form-actions">
            <button type="submit" data-intent="ask"${gate(live.askUnavailable)}>Ask agent</button>
            <button type="submit" data-intent="comment" formaction="/tasks/${segAttr}/comments/add">Add comment</button>
            <button type="submit" data-intent="unblock"${unblockTarget}${gate(unblockReason)}>Unblock</button>
            <button type="button" class="rv-cancel" data-lz-action-dismiss>Cancel</button>
            ${unblockReason ? `<span class="rv-hint rv-gate-reason">Unblock: ${escapeHtml(unblockReason)}</span>` : ''}
          </div>`;
}

export function actionsHtml(
  task: Task,
  queued: ReviewComment[],
  comments: ReviewComment[],
  live: ReviewLiveState,
  draft: ReviewDraft = {},
  options: {
    extras?: boolean;
    approvedFiles?: readonly string[];
    fileViolations?: readonly FileViolation[];
    /** Current review: Submit sits on the same row as Unblock / Ask / Accept. */
    showSubmit?: boolean;
    submitPreflight?: TaskSubmitPreflight | null;
    /** Codes shared by more than one task — this form's action falls back to the id. */
    duplicatedCodes?: ReadonlySet<string>;
    /**
     * Every comment the next Unblock carries — review comments AND task
     * comments. Defaults to `queued.length` for a caller holding only the former.
     */
    queuedCount?: number;
    /**
     * Human feedback accept refuses on (src/task/queued-feedback.ts). Non-zero
     * adds the explicit "merge without delivering them" box to Accept.
     */
    queuedFeedback?: number;
  } = {},
): string {
  const extras = options.extras !== false;
  const where = extras ? ' below' : '';
  const seg = taskPathSegment(task, options.duplicatedCodes);
  const queuedCount = options.queuedCount ?? queued.length;
  const unblockLabel = queuedCount
    ? `<strong>Unblock</strong> — resumes the agent, carrying the ${queuedCount} queued comment${queuedCount === 1 ? '' : 's'}${where}`
    : '<strong>Unblock</strong> — resumes the agent to change code';
  const queuedFeedback = options.queuedFeedback ?? 0;
  const allowQueuedBox = queuedFeedback > 0
    ? `<label class="rv-hint"><input type="checkbox" name="allow_queued_comments" value="1">
            Merge without delivering the ${queuedFeedback} queued comment${queuedFeedback === 1 ? '' : 's'} — the agent will never read ${queuedFeedback === 1 ? 'it' : 'them'}</label>`
    : '';

  // INVARIANT: never offer Unblock / Accept while the task is working or
  // pairing — the daemon 409s ("still working"), and a stale Current-review
  // page after `lazy review` used to look like a silent refusal. Ask stays
  // available: a non-askable state still saves the question for later (see
  // askUnavailableReason), and the form shows why it will not send now.
  // The reason is VISIBLE copy (data-rv-busy-reason), not only a title
  // tooltip, and the buttons are HIDDEN rather than disabled (a greyed-out
  // button cannot say why). They keep data-lz-action-open so the island can
  // show them again from the same poll that refreshes the status bar.
  const busyReason = busyUnblockAcceptReason(task.status);
  const busyGateAttrs = busyGateAttributes(busyReason);

  // Two different things, never both: the question cannot be answered at all
  // (a task that never ran), or it will be answered from the stored record
  // instead of by the live agent. The second is not a warning — it is the
  // provenance of the answer the reviewer is about to get, and it must be on
  // the page before they type, not discovered afterwards.
  const askWarn = live.askUnavailable
    ? `<div class="rv-warn">${escapeHtml(live.askUnavailable)}</div>`
    : live.askRoute === 'record' && live.askProvenance
      ? `<div class="rv-note" data-rv-ask-provenance>${escapeHtml(live.askProvenance)}</div>`
      : '';
  const askHint =
    '<span class="rv-hint">Reflective mode — the agent answers without changing code.</span>';

  const queuedExtras = extras
    ? `<div class="rv-tabpanel-extras"><div${queued.length ? ' class="rv-pending-box"' : ''} data-rv-queued>${queuedHtml(queued)}</div></div>`
    : '';
  const askExtras = extras
    ? `<div class="rv-tabpanel-extras">
          ${askWarn}
          <div class="rv-task-threads" data-rv-task-threads>${taskLevelConversationHtml(task, comments, options.duplicatedCodes)}</div>
        </div>`
    : (askWarn ? `<div class="rv-tabpanel-extras">${askWarn}</div>` : '');

  const unblockForm = `
        <form method="post" action="/tasks/${seg}/review/unblock" class="lz-action-form" data-lz-action-form>
          <label><span class="rv-tab-lead">${unblockLabel}</span>
            <textarea name="message" rows="6" required data-rv-sync="feedback" data-rv-draft="feedback" placeholder="What should the agent do next?">${escapeHtml(draft.feedback ?? '')}</textarea>
          </label>
          <div class="rv-form-actions">
            <button type="submit" data-lz-unblock-submit>Unblock</button>
            <span class="rv-draft-state" data-rv-draft-state aria-live="polite"></span>
          </div>
        </form>`;
  const askForm = `
        <form method="post" action="/tasks/${seg}/review/ask" class="lz-action-form" data-lz-action-form>
          ${askWarn}
          <label><span class="rv-tab-lead"><strong>Ask about this task</strong> — the agent answers, without changing code</span>
            <textarea name="content" rows="6" required data-rv-sync="ask" placeholder="Ask a question about the work — approach, scope, trade-offs…">${escapeHtml(draft.ask ?? '')}</textarea>
          </label>
          ${askDialogActionsHtml(seg, live)}
          ${askHint}
        </form>`;
  const acceptForm = `
        <form class="rv-accept-form lz-action-form" method="post" action="/tasks/${seg}/review/accept" data-lz-action-form>
          <label><span class="rv-tab-lead"><strong>Accept</strong> — merge this work into the parent</span>
            <textarea name="reason" rows="6" data-rv-draft="acceptReason" placeholder="Reason (optional)">${escapeHtml(draft.reason ?? '')}</textarea>
          </label>
          <!-- Filled by lzCopyRaisedFields from the last-saved feedback draft
               on submit, so a refused accept can hand the reviewer's unblock
               text back to them. -->
          <input type="hidden" name="feedback" value="${escapeHtml(draft.feedback ?? '')}">
          ${approvedFilesHiddenInputs(uniqueApprovedFiles(options.approvedFiles, draft.approvedFiles))}
          ${allowQueuedBox}
          <div class="rv-form-actions"><button type="submit" class="rv-primary">Accept</button></div>
        </form>`;

  // Templates always mount (even while busy) so a poll that clears the gate
  // can open Unblock / Accept without a reload. Hard-omitting them on first
  // paint was the other half of the silent-refusal bug: a page that started
  // busy could never recover client-side.
  return `<div class="rv-actions" data-rv-actions data-rv-busy="${busyReason ? '1' : '0'}">
      <div class="lz-action-buttons">
      ${actionDialogButtonHtml({
        verb: 'unblock',
        label: 'Unblock',
        reenableable: true,
        extraAttrs: busyGateAttrs,
      })}
      ${actionDialogButtonHtml({ verb: 'ask', label: 'Ask' })}
      ${actionDialogButtonHtml({
        verb: 'accept',
        label: 'Accept',
        primary: true,
        reenableable: true,
        extraAttrs: busyGateAttrs,
      })}
      ${options.showSubmit ? submitActionHtml(seg, options.submitPreflight) : ''}
      </div>
      <div class="rv-warn" data-rv-busy-reason${busyReason ? '' : ' hidden'} aria-live="polite">${escapeHtml(busyReason ?? '')}</div>
      ${actionDialogTemplateHtml('unblock', unblockForm, { noscript: !busyReason })}
      ${actionDialogTemplateHtml('ask', askForm)}
      ${actionDialogTemplateHtml('accept', acceptForm, { noscript: !busyReason })}
      ${queuedExtras}
      ${askExtras}
    </div>`;
}

export interface StatusBarOptions {
  /**
   * Direct children, for the cluster line. OMITTED means the caller has not
   * loaded them, and the bar renders no cluster line at all — an empty ARRAY is
   * a cluster with genuinely no children yet, which does render "0/0" exactly as
   * `lazy show` does.
   */
  children?: Task[];
  /** Has anything ever been queued on this review? See the zero rule below. */
  everQueued?: boolean;
  /** Has the reviewer ever asked this task anything? */
  everAsked?: boolean;
  /** Codes shared by more than one task — the task-detail link falls back to the id. */
  duplicatedCodes?: ReadonlySet<string>;
}

/**
 * The sticky bar. Fixed to the bottom so it survives scrolling through a long
 * diff, and refreshed by the same poll that refreshes the threads AND the
 * Unblock / Accept busy gate — the reviewer should never have to guess
 * whether the agent has moved on, or click a greyed button with no reason.
 *
 * Its two comment counters are about this REVIEW, never about a work queue:
 * comments waiting to ride the next unblock, and asks the agent has not
 * answered. Their wording lives in ./status-bar-labels so the island's rewrite
 * cannot spell them differently.
 */
export function statusBarHtml(
  task: Task,
  state: ReviewLiveState,
  queued: number,
  pendingAsks: number,
  options: StatusBarOptions = {},
): string {
  const label = task.code ?? task.id.substring(0, 8);
  const seg = taskPathSegment(task, options.duplicatedCodes);
  // A counter nothing has ever put a number in is clutter, not information:
  // "0 comments queued" on a task nobody has commented on is the permanent
  // zero the engineer read as a broken work queue. Once the reviewer has
  // queued or asked ANYTHING, the counter stays visible even at zero, so they
  // can watch it drain — the island applies the same rule on every poll.
  const showQueued = queued > 0 || (options.everQueued ?? false);
  const showAsks = pendingAsks > 0 || (options.everAsked ?? false);
  // `children` omitted means the caller does not KNOW them — render no cluster
  // line rather than a 0/0 derived from a list that was never loaded.
  const cluster = options.children ? clusterProgressBarHtml(task, options.children) : '';
  return `<div class="rv-statusbar" id="rv-statusbar"
      data-rv-askable="${state.askable ? '1' : '0'}"
      data-rv-ask-reason="${escapeHtml(state.askUnavailable ?? '')}"
      data-rv-unblock-reason="${escapeHtml(state.unblockUnavailable ?? '')}">
      <a href="/review">← queue</a>
      <strong>${escapeHtml(label)}</strong>
      <span data-rv-sb="status">status: ${escapeHtml(state.status)}</span>
      <span class="rv-sb-sep">·</span>
      <span data-rv-sb="turns">${state.turns} turn${state.turns === 1 ? '' : 's'}</span>
      <span data-rv-sb="activity">active ${escapeHtml(relativeTime(state.lastActiveAt))}</span>
      ${cluster ? `<span class="rv-sb-sep">·</span>${cluster}` : ''}
      <span class="rv-sb-sep">·</span>
      <span class="rv-sb-sep">·</span>
      <span data-rv-sb="viewed"></span>
      <span class="rv-sb-sep">·</span>
      <span data-rv-sb="queued" title="${escapeHtml(QUEUED_BAR_TITLE)}"${showQueued ? '' : ' hidden'}>${escapeHtml(queuedBarLabel(queued))}</span>
      <span data-rv-sb="asks" title="${escapeHtml(ASKS_BAR_TITLE)}"${showAsks ? '' : ' hidden'}>${escapeHtml(asksBarLabel(pendingAsks))}</span>
      <span class="rv-sb-ask" data-rv-sb="ask">${askBarLabel(state)}</span>
      ${reviewNavControlsHtml()}
      <a href="${taskPath(task, options.duplicatedCodes)}">task detail</a>
    </div>`;
}

// `relativeTime` lives in ./timestamps now — one relative-time ladder for every
// web surface, next to the relative+absolute `<time>` renderer that wraps it.
// Re-exported here because this module's name is where callers already look.
export { relativeTime };

/**
 * How many threads sit on lines of one file.
 *
 * A rendered document has no line rows to hang them off, so the rendered pane
 * says how many comments are waiting in the raw one rather than letting them
 * disappear behind a view toggle.
 */
function countThreadsInFile(byAnchor: Map<string, RenderedThread[]>, path: string): number {
  let n = 0;
  for (const [key, threads] of byAnchor) {
    // anchorKey is `${file} ${side} ${line}`; the side/line tail is fixed-shape.
    if (key.startsWith(`${path} `)) n += threads.length;
  }
  return n;
}

export function reviewTaskHtml(
  task: Task,
  diffText: string,
  comments: ReviewComment[],
  notice?: { text: string; error?: boolean },
  state?: ReviewLiveState,
  /**
   * File permission violations from the task's violation turn, in the order
   * the daemon recorded them. Empty for the ordinary case where the agent
   * stayed inside its allowed paths.
   */
  fileViolations: FileViolation[] = [],
  /**
   * The remedy for a refused accept, and the text the reviewer had typed when
   * it was refused. Both come from the failing POST — the page itself never
   * infers a remedy. Also carries the report-first blocks: open raised items,
   * last agent turn, and open raised items.
   */
  extras: {
    remedy?: AcceptRemedy;
    draft?: ReviewDraft;
    raisedItems?: RaisedItem[];
    lastAgentTurn?: Turn | null;
    turnReport?: TurnReport | null;
    fileDecisions?: FileDecision[];
    /** When set, maintained globs split out of residual "Other changes". */
    isMaintainedPath?: (path: string) => boolean;
    /**
     * Which sections this reviewer has already ticked, as viewed-key → content
     * hash, from the task's stored review draft. Server-side so the ticks are
     * the same in a second tab and on a second machine; still hash-keyed so a
     * file the agent has since changed comes back unviewed.
     */
    viewedFiles?: Record<string, string>;
    /**
     * Half-typed line/prose comment boxes from this reviewer's stored draft,
     * anchor key → text. Seeded into the island so a reload (or a second tab)
     * comes back with the words still in the box.
     */
    lineDrafts?: Record<string, string>;
    /** Declared [serve] services with liveness, or null when unresolvable. */
    serve?: ProbedServeState | null;
    /** Whether a web shell can be opened into the task's container, and why not
     * when it can't. Absent/null renders no shell control. */
    shell?: ShellAvailability | null;
    /** Start container / Start services buttons; absent renders neither. */
    controls?: ServicesCardControls;
    /** "Since you last looked" — what moved after the reviewer's last
     * intervention. Absent renders no card (a task with no session). */
    activity?: ReviewActivity | null;
    /**
     * Full text of the Markdown files in this diff, fetched by the caller (the
     * read is async; this renderer is not). Absent, Markdown files simply
     * render as ordinary line diffs.
     */
    markdownSources?: MarkdownSources;
    /**
     * The request's timing collector, so each block below is measured as its
     * own phase (`render.changes`, `render.threads`, …). Absent — every direct
     * caller outside the route, i.e. the unit tests — the render is simply not
     * measured and behaves identically.
     */
    timings?: RenderTimings;
    /**
     * Direct children of a hub, already split. The Changes block lists them
     * minimally; the later Subtasks tab owns the grouped 301-row UI. Absent
     * or both-empty leaves the Changes block byte-identical to today.
     */
    hubChildren?: { accepted: Task[]; inProgress: Task[] };
    /**
     * The task's review regions and the `?region=` filter in force. Absent, or
     * fewer than two regions, leaves the Changes block byte-identical to what
     * it was before regions existed.
     */
    regions?: {
      rows: RegionSummary[];
      active: string | null;
      notes: string[];
      /** The first carve is still running, so `rows` is empty for that reason. */
      computing?: boolean;
    };
    /**
     * When set, return only that slice — no page chrome, no layout, no
     * scripts — so the tabbed task page can relocate today's blocks without
     * a second renderer. Absent keeps the full assembled page for unit tests.
     */
    embed?: 'changes' | 'review';
    /** Task-code (and any other) linkify tables from the route. Symbols are merged in. */
    markdown?: RenderMarkdownOptions;
    /** Per-line unit attribution for the subtask-blame gutter, by path. */
    lineAttribution?: Map<string, import('../regions').FileLineAttribution>;
    /** Codes shared by more than one task — this page's task links fall back to the id. */
    duplicatedCodes?: ReadonlySet<string>;
  } = {},
): string {
  const timings = extras.timings ?? unmeasured();
  // Task links read the task's code (id when the code is duplicated) so the
  // Changes tab's URLs read like every other task URL.
  const seg = taskPathSegment(task, extras.duplicatedCodes);
  // The SECOND parse of this diff text on a review page render: the route
  // already parsed it to find the Markdown files it had to read. Measured here
  // so the duplication is a number in the header rather than a thing you have
  // to read the code to know about.
  const files = timings.measureSync('diff_parse', () => parseUnifiedDiff(diffText));
  timings.count('diff_files', files.length);
  const symbols = timings.measureSync('symbols', () => buildSymbolTable(files, seg));
  const markdown: RenderMarkdownOptions = {
    ...extras.markdown,
    linkify: [
      ...(extras.markdown?.linkify ?? []),
      ...(symbols.size > 0 ? [{ lookup: symbols, className: 'lz-sym-link' }] : []),
    ],
  };
  const violationsByPath = new Map(fileViolations.map((v) => [v.file, v.status]));
  const fileDecisions = extras.fileDecisions ?? [];
  const threadsPhase = timings.begin('threads');
  const threads = groupThreads(comments);
  const byAnchor = new Map<string, RenderedThread[]>();
  for (const t of threads) {
    const key = anchorKey({ file: t.file, side: t.side as 'old' | 'new', line: t.line });
    const list = byAnchor.get(key) ?? [];
    list.push({ threadId: t.threadId, html: threadHtml(seg, t, { markdown }) });
    byAnchor.set(key, list);
  }
  timings.count('threads', threads.length);
  threadsPhase.end();

  const label = task.code ?? task.id.substring(0, 8);
  const noticeHtml = notice
    ? `<div class="rv-notice${notice.error ? ' rv-notice-err' : ''}">${escapeHtml(notice.text)}</div>`
    : '';

  // Orphan threads: a comment whose anchor no longer appears in the diff (the
  // agent rewrote that line). It must never vanish — render it above the diff.
  //
  // Its own phase because the anchor index below walks EVERY line of EVERY hunk
  // in the diff — work proportional to the whole diff, done even on a page with
  // no comments at all, which is precisely the sort of cost that was invisible.
  const orphansPhase = timings.begin('orphans');
  const anchored = new Set<string>();
  for (const f of files) {
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (l.newLine !== null) anchored.add(`${f.path} new ${l.newLine}`);
        if (l.oldLine !== null) anchored.add(`${f.path} old ${l.oldLine}`);
      }
    }
  }
  const orphans = threads.filter(
    (t) =>
      !isTaskLevelReviewAnchor(t.file, t.line) &&
      !isProseReviewAnchor(t.file) &&
      !anchored.has(`${t.file} ${t.side} ${t.line}`),
  );
  const orphanHtml = orphans.length
    ? `<h2>Comments whose lines are no longer in the diff</h2>` +
      orphans
        .map(
          (t) =>
            `<div class="rv-notice"><div class="rv-msg-head">${escapeHtml(t.file)}:${t.line} (${escapeHtml(t.side)})</div>${threadHtml(seg, t, { markdown })}</div>`,
        )
        .join('\n')
    : '';
  orphansPhase.end();

  const queued = pendingDeliveryComments(comments);
  const pendingAsks = comments.filter((c) => c.ask_state === 'pending').length;
  const live = state ?? fallbackState(task);
  // No `children` here on purpose: this entry point only ever has the hub
  // split the Changes block needs (accepted + in progress), and deriving cluster
  // progress from a PARTIAL child list would print a k/n that disagrees with
  // `lazy show`. Omitted means "unknown", which renders no cluster line; the
  // merged task page passes the full list.
  const barOptions: StatusBarOptions = {
    everQueued: hasAnyQueuedComment(comments),
    everAsked: hasAnyAsk(comments),
    duplicatedCodes: extras.duplicatedCodes,
  };
  const draft = extras.draft ?? {};
  const approvedFiles = fileViolations
    .filter((v) => v.status === 'approved')
    .map((v) => v.file);
  const actions = actionsHtml(task, queued, comments, live, draft, {
    approvedFiles,
    fileViolations,
    duplicatedCodes: extras.duplicatedCodes,
  });
  const remedyHtml = extras.remedy ? remedyPanelHtml(seg, extras.remedy, draft) : '';

  // Screenshots the agent declared come FIRST — before raised items and the
  // report. A picture of the thing that was built is the fastest possible
  // answer to "what did this task do", so nothing outranks it.
  const screenshotsHtml = screenshotsCardHtml(
    seg,
    extras.turnReport?.presentation?.screenshots,
  );

  // Report-first order (structural-agent-questions): screenshots → open raised
  // → agent report → how to verify → untriaged follow-ups → violations →
  // actions → diff.
  // how_to_verify sections leave the report card for their own structured
  // block (review-verify.ts); the rest keep their agent-chosen order.
  const raisedHtml = raisedItemsSummary(seg, extras.raisedItems ?? [], {
    duplicatedCodes: extras.duplicatedCodes,
  });
  const reportHtml = timings.measureSync('report', () => agentReportHtml(
    seg,
    extras.lastAgentTurn ?? null,
    stripVerifySections(extras.turnReport ?? null),
    { surface: extras.embed === 'changes' ? 'changes' : 'full', markdown },
  ));
  // Run opens a shell into the container, which the Run itself starts if it is
  // down; the card only states the reason when no container can be entered at all.
  const verifyHtml = timings.measureSync('verify', () => verifyReportBlockHtml(
    extras.turnReport ?? null,
    extras.shell ?? null,
  ));
  const maintainHtml = maintainDecisionsHtml(fileDecisions);

  const diffOptions = {
    violations: violationsByPath,
    taskId: seg,
    isMaintainedPath: extras.isMaintainedPath,
    allowExpand: true,
    // The subtask-blame gutter. Passed to BOTH renders (raw and presented) via
    // the shared options, so a presented page cannot annotate half the diff.
    ...(extras.lineAttribution ? { lineAttribution: extras.lineAttribution } : {}),
  };
  // The only surface that can serve expanded context: the daemon reads it from
  // this task's worktree at the same refs the diff itself was rendered from.
  const expandUrl = `/api/review/${seg}/file-lines`;
  // Markdown files are presented as documents in the raw-files pane. Not inside
  // the agent's presentation: a snippet there is a line range, and a range of a
  // rendered document is not a thing this renders.
  const presentedPanes = timings.measureSync('markdown_panes', () => {
    const panes = new Map<string, string>();
    for (const file of files) {
      const source = extras.markdownSources?.get(file.path);
      if (!source) continue;
      const threadCount = countThreadsInFile(byAnchor, file.path);
      const pane = renderMarkdownFile(file, source, { threadCount });
      if (pane) panes.set(file.path, pane);
    }
    return panes;
  });
  // The Changes block: one row of HTML per line of the diff. On a large hub
  // this is expected to be the single biggest phase on the page, which is the
  // hypothesis this instrumentation exists to confirm or refute.
  const hasPresentation =
    extras.turnReport?.presentation != null &&
    extras.turnReport.presentation.groups.length > 0;
  // Presented already stamps the canonical file id on the first card of
  // each path. A second copy in the (usually hidden) Raw pane would make
  // getElementById land on the wrong one — the accept-checklist hash and
  // "Full file" links both use that id. Raw still carries data-file-section
  // so JS can find it after switching views.
  const rawDiffHtml = timings.measureSync('changes', () =>
    renderReviewDiff(files, byAnchor, {
      ...diffOptions,
      presentedPanes,
      assignSectionId: !hasPresentation,
    }),
  );
  // Note it renders the SAME files a second time when the agent declared a
  // presentation, so a presented page pays for the Changes block twice.
  const presentedHtml = hasPresentation
    ? timings.measureSync('presentation', () =>
        renderPresentedChanges(extras.turnReport!.presentation!, files, byAnchor, {
          ...diffOptions,
          markdown,
          // A cap the walkthrough was refused for is recorded on the same
          // report row it is read from, so the residual block can say the
          // walkthrough was cut short rather than merely incomplete.
          ...(extras.turnReport!.presentation_cap_refusal
            ? { capRefusal: extras.turnReport!.presentation_cap_refusal }
            : {}),
        }),
      )
    : '';

  const changesToolbar = hasPresentation ? changesViewOptionsHtml() : '';
  const changesScripts = hasPresentation
    ? `${changesViewScript()}\n${diffViewScript('#rv-changes', expandUrl)}`
    : diffViewScript('#rv-root', expandUrl);

  const activityCardHtml = extras.activity
    ? timings.measureSync('activity_card', () => reviewActivityCardHtml(extras.activity!, seg))
    : '';

  const changesBlock =
    `${orphanHtml}` +
    `${maintainHtml}` +
    `${violationSummary(seg, fileViolations, new Set(files.map((f) => f.path)), fileDecisions)}` +
    // Unsent comment boxes whose line is not on screen are re-opened here,
    // above the diff, rather than kept invisible — see restoreDrafts().
    `<div id="rv-draft-orphans" class="rv-draft-orphans" hidden></div>` +
    `<h2>Changes</h2>` +
    `${regionsCardHtml(regionsStripOptions(seg, extras.regions))}` +
    `${hubChildrenHtml(seg, extras.hubChildren)}${changesToolbar}` +
    `${diffViewOptionsHtml({ presented: presentedPanes.size > 0 })}` +
    `<div id="rv-changes">` +
    `${hasPresentation ? `<div id="rv-presented" class="rv-changes-presented">${presentedHtml}</div>` : ''}` +
    `<div id="rv-root" class="rv-changes-raw">${rawDiffHtml}</div>` +
    `</div>` +
    `${changesScripts}`;

  const reviewBlock =
    `${noticeHtml}` +
    `${remedyHtml}` +
    `${proseThreadsFallbackHtml(seg, threads)}` +
    `${actions}` +
    `${statusBarHtml(task, live, queued.length, pendingAsks, barOptions)}`;

  if (extras.embed === 'changes') {
    return timings.measureSync('assemble', () => {
      const body = `${reportHtml}${changesBlock}`;
      return body.trim() ? body : emptyTab('No changes to show yet.');
    });
  }
  if (extras.embed === 'review') return timings.measureSync('assemble', () => reviewBlock);

  // `assemble` is the interpolation itself: the blocks above are already built,
  // so this phase is the cost of concatenating them — which on a multi-megabyte
  // page is not free, and is a different thing from building any one block.
  const content = timings.measureSync('assemble', () => `
    <h1>Review: ${escapeHtml(label)}</h1>
    <p>${escapeHtml(task.goal)}</p>
    <p><a href="/review">← queue</a> · <a href="${taskPath(task, extras.duplicatedCodes)}">task detail</a> · <a href="${taskPath(task, extras.duplicatedCodes)}/edit">edit task</a></p>
    ${extras.shell ? `<div class="action-links">${shellPanelHtml(seg, extras.shell)}</div>` : ''}
    ${noticeHtml}
    ${activityCardHtml}
    ${remedyHtml}
    ${screenshotsHtml}
    ${raisedHtml}
    ${reportHtml}
    ${verifyHtml}
    ${servicesCardHtml(task, extras.serve ?? null, extras.controls)}
    ${proseThreadsFallbackHtml(seg, threads)}
    ${maintainHtml}
    ${violationSummary(seg, fileViolations, new Set(files.map((f) => f.path)), fileDecisions)}
    ${actions}
    ${orphanHtml}
    <div id="rv-draft-orphans" class="rv-draft-orphans" hidden></div>
    <h2>Changes</h2>
    ${regionsCardHtml(regionsStripOptions(seg, extras.regions))}
    ${hubChildrenHtml(seg, extras.hubChildren)}${changesToolbar}
    ${diffViewOptionsHtml({ presented: presentedPanes.size > 0 })}
    <div id="rv-changes">
      ${hasPresentation ? `<div id="rv-presented" class="rv-changes-presented">${presentedHtml}</div>` : ''}
      <div id="rv-root" class="rv-changes-raw">${rawDiffHtml}</div>
    </div>
    ${statusBarHtml(task, live, queued.length, pendingAsks, barOptions)}
    ${changesScripts}
    ${verifyCopyScript()}
    ${extras.shell ? verifyRunScript() : ''}
    ${reviewDraftScript(seg)}
    ${viewedStateScript(task.id, { serverState: extras.viewedFiles ?? {} })}
    ${reviewNavigationScript()}
    ${screenshotLightboxScript()}
    ${reviewScript(seg, { lineDrafts: extras.lineDrafts ?? {} })}
    ${extras.shell?.available ? shellClientScript() : ''}
  `);
  return timings.measureSync('layout', () => layoutHtml(`Review ${label}`, content));
}

function emptyTab(message: string): string {
  return `<p class="lz-empty-tab">${escapeHtml(message)}</p>`;
}

/**
 * The Changes block used to list accepted / in-progress children here.
 * Slice 2 absorbs that list into the grouped Subtasks tab, so Changes
 * now links there. Returning '' when both groups are empty keeps a leaf
 * task's Changes HTML byte-identical.
 */
function hubChildrenHtml(
  taskId: string,
  groups: { accepted: Task[]; inProgress: Task[] } | undefined,
): string {
  if (!groups) return '';
  const n = groups.accepted.length + groups.inProgress.length;
  if (n === 0) return '';
  return (
    `<section class="rv-hub-children">` +
    `<p class="rv-hint"><a href="/tasks/${escapeHtml(taskId)}/subtasks">Subtasks</a>` +
    ` lists every child, grouped by status.</p>` +
    `</section>\n    `
  );
}

/**
 * Shape returned by GET /api/review/:id/threads (consumed by the island).
 * `pending` counts asks in flight — the island polls fast while it is > 0.
 * `pendingDelivery` counts queued comments, which need no polling: nothing is
 * happening to them until the reviewer unblocks. `queued` carries those
 * comments in full so the Current review list can re-render without a
 * reload, and `state` feeds the sticky status bar.
 */
export function threadsJson(comments: ReviewComment[], state?: ReviewLiveState, task?: Task) {
  const threads = groupThreads(comments);
  const pending = comments.filter((c) => c.ask_state === 'pending').length;
  const queued = pendingDeliveryComments(comments);
  return {
    threads,
    // `filed` is decided HERE, not in the island: the poll re-renders the same
    // list the server rendered, so the two must split current from filed with
    // one rule (`askThreadIsCurrent`).
    taskThreads: taskLevelThreads(comments).map((t) => ({
      ...t,
      filed: !askThreadIsCurrent(t),
      // The promote seed is computed HERE, not in the island: what a promoted
      // task SAYS is a rule (src/review/promote-discussion.ts), and a browser
      // re-deriving it is how the poll-rendered form would come to disagree
      // with the server-rendered one. The island only lays this out.
      promote: task ? discussionPromoteSeed(task, t) : null,
    })),
    pending,
    pendingDelivery: queued.length,
    // The bar hides a counter nothing has ever put a number in; the island
    // needs the same two facts the server render used, or the first poll would
    // resurrect the permanent zero.
    everQueued: hasAnyQueuedComment(comments),
    everAsked: hasAnyAsk(comments),
    queued: queued.map((c) => ({
      id: c.id,
      file: c.file,
      side: c.side,
      line: c.line,
      content: c.content,
      // For prose-anchored comments: the island renders the quote in place of
      // a file:line link, exactly as queuedHtml() does server-side.
      anchor_snippet: c.anchor_snippet ?? null,
    })),
    state,
  };
}

export type { ReviewActions };
