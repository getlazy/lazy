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
import {
  askUnavailableReason,
  isPendingDelivery,
  isWithdrawn,
  withdrawRefusalReason,
  type ReviewActions,
  type ReviewQueueEntry,
} from './review-actions';
import type { AcceptRemedy, FileViolation, ReviewComment } from '../types';
import type { Task } from '../storage';


/**
 * The island. It only enhances what already exists server-side:
 * - clicking a gutter "+" opens a form offering BOTH intents — "Ask agent"
 *   (dispatched now, read-only) and "Add comment" (batched into the next
 *   unblock) — warning first when the task cannot answer right now;
 * - submitting posts JSON and re-renders threads, the queued list and the
 *   status bar from the API;
 * - the accept form is moved into a modal dialog so the unblock box gets the
 *   full width;
 * - the two mirrored feedback boxes (top and bottom) are kept in sync;
 * - polling keeps the status bar honest: fast while an ask is in flight,
 *   slow otherwise.
 * With JS off, the diff, every thread, the queued list, the retry buttons and
 * both action blocks still render and still work as plain form POSTs.
 */
function reviewScript(taskId: string): string {
  return `<script>
(function () {
  var TASK = ${JSON.stringify(taskId)};
  var root = document.getElementById('rv-root');
  var bar = document.getElementById('rv-statusbar');
  if (!root) return;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

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

  function closeForms() {
    var open = root.querySelectorAll('tr.rv-form-row');
    for (var i = 0; i < open.length; i++) open[i].remove();
  }

  root.addEventListener('click', function (ev) {
    var btn = ev.target.closest('.rv-add-comment, .rv-reply');
    if (!btn) return;
    ev.preventDefault();
    var anchorEl = anchorElement(btn);
    if (!anchorEl) return;
    var anchor = anchorOf(anchorEl);
    // The row the form hangs under: the anchor's own row in unified, the shared
    // split row in side-by-side.
    var tr = anchorEl.closest('tr');
    var threadId = btn.classList.contains('rv-reply') ? btn.dataset.thread : '';
    closeForms();
    var blocked = askBlockedReason();
    var row = document.createElement('tr');
    row.className = 'rv-form-row';
    row.innerHTML = '<td colspan="6"><form class="rv-form">' +
      (blocked ? '<div class="rv-warn">' + esc(blocked) + '</div>' : '') +
      '<textarea rows="3" required placeholder="' +
        (threadId ? 'Reply on this thread…' : 'Ask the agent about this line') + '"></textarea>' +
      '<div class="rv-form-actions">' +
      '<button type="submit" data-intent="ask">Ask agent</button>' +
      '<button type="submit" data-intent="comment">Add comment</button>' +
      '<button type="button" class="rv-cancel">Cancel</button>' +
      '<span class="rv-hint">Ask = answered now, read-only. Comment = batched into your next unblock.</span>' +
      '</div>' +
      '</form></td>';
    // Insert after the row's existing threads so the form sits at the bottom.
    var after = tr;
    while (after.nextElementSibling && after.nextElementSibling.classList.contains('rv-thread-row')) {
      after = after.nextElementSibling;
    }
    after.insertAdjacentElement('afterend', row);
    var form = row.querySelector('form');
    row.querySelector('.rv-cancel').addEventListener('click', closeForms);
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
      var intent = btnEl.dataset.intent === 'comment' ? 'comment' : 'ask';
      var label = btnEl.textContent;
      var a = anchor;
      btnEl.disabled = true;
      btnEl.textContent = 'Saving…';
      fetch('/review/' + TASK + '/comment', {
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
    form.querySelector('textarea').focus();
  });

  function retryFormHtml(commentId) {
    return '<form class="rv-retry" method="post" action="/review/' + TASK + '/comment/' +
      encodeURIComponent(commentId) + '/retry"><button type="submit">Re-send to agent</button></form>';
  }

  function withdrawFormHtml(commentId) {
    return '<form class="rv-withdraw" method="post" action="/review/' + TASK + '/comment/' +
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

  function renderThread(t) {
    var h = '<div class="rv-thread">';
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
        if (m.delivery_state === 'pending_delivery') h += '<div class="rv-state rv-state-queued">queued — will be sent with your next unblock</div>';
        if (m.delivery_state === 'delivered') h += '<div class="rv-state rv-state-delivered">delivered in turn ' + esc(m.delivered_turn || '?') + '</div>';
        if (m.role === 'human') {
          var why = withdrawRefusal(m);
          h += why === null
            ? withdrawFormHtml(m.id)
            : '<div class="rv-state rv-state-hint rv-withdraw-why">' + esc(why) + '</div>';
        }
      }
      h += '</div>';
    }
    h += '<button type="button" class="rv-reply" data-thread="' + esc(t.threadId) + '">Reply</button></div>';
    return h;
  }

  // The queued list is mirrored in every actions block (top and bottom), so a
  // reviewer never has to scroll back to see what the next unblock will carry.
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
        html += '<li class="rv-queued-item">' +
          '<a class="rv-queued-where" href="#' + domId(c.file, c.side, c.line) + '"><code>' +
          esc(c.file) + '</code>:' + esc(c.line) + ' (' + esc(c.side) + ')</a>' +
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

  function setBarItem(name, text) {
    if (!bar) return;
    var el = bar.querySelector('[data-rv-sb="' + name + '"]');
    if (el) el.textContent = text;
  }

  function renderStatus(data) {
    if (!bar) return;
    var st = data.state;
    if (st) {
      setBarItem('status', 'status: ' + st.status);
      setBarItem('turns', st.turns + (st.turns === 1 ? ' turn' : ' turns'));
      setBarItem('activity', 'active ' + relTime(st.lastActiveAt));
      bar.dataset.rvAskable = st.askable ? '1' : '0';
      bar.dataset.rvAskReason = st.askUnavailable || '';
      setBarItem('ask', st.askable ? 'agent can answer' : 'agent busy — asks are saved, not sent');
    }
    setBarItem('queued', data.pendingDelivery + ' queued');
    setBarItem('asks', data.pending + ' awaiting agent');
  }

  function refresh() {
    return fetch('/api/review/' + TASK + '/threads')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var byAnchor = {};
        data.threads.forEach(function (t) {
          var k = t.file + ' ' + t.side + ' ' + t.line;
          (byAnchor[k] = byAnchor[k] || []).push(t);
        });
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
        renderStatus(data);
        return data.pending > 0;
      });
  }

  // Polling, not push: the status bar has to stay honest while the reviewer
  // reads a long diff, and an ask can take minutes (the daemon's own timeout is
  // 10). Fast while something is in flight, slow otherwise. Live push for the
  // whole dashboard is a separate piece of work.
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
  root.addEventListener('rv:layout', function () {
    refresh().catch(function () { /* the next poll will retry */ });
  });

  // Accept moves into a modal dialog, which frees the whole width for the
  // feedback box. Server-side it is a plain inline form (so it works with JS
  // off); here the FIRST copy is moved into the dialog and the rest — the
  // mirrored block at the bottom — are dropped, because a form may exist only
  // once.
  (function () {
    var forms = document.querySelectorAll('.rv-accept-form');
    var dlg = document.createElement('dialog');
    if (!forms.length || typeof dlg.showModal !== 'function') return;
    dlg.className = 'rv-dialog';
    dlg.id = 'rv-accept-dialog';
    document.body.appendChild(dlg);
    dlg.appendChild(forms[0]);
    for (var i = 1; i < forms.length; i++) forms[i].remove();
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'rv-cancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', function () { dlg.close(); });
    // Before the submit button, so the footer reads "Cancel  Accept" with the
    // primary action last — the same order as the rest of the surface.
    var footer = forms[0].querySelector('.rv-form-actions');
    footer.insertBefore(cancel, footer.firstChild);
    var openers = document.querySelectorAll('.rv-accept-open');
    for (var j = 0; j < openers.length; j++) {
      openers[j].hidden = false;
      openers[j].addEventListener('click', function () {
        dlg.showModal();
        var ta = forms[0].querySelector('textarea');
        if (ta) ta.focus();
      });
    }
  })();

  // Carry whatever is in the feedback box into the accept form, so a refused
  // accept re-renders with those words still there. Never-lose-human-feedback
  // applies to text the reviewer has typed but not yet sent.
  (function () {
    var accept = document.querySelector('.rv-accept-form');
    if (!accept) return;
    accept.addEventListener('submit', function () {
      var hidden = accept.querySelector('input[name="feedback"]');
      var box = document.querySelector('[data-rv-sync="feedback"]');
      if (hidden && box) hidden.value = box.value;
    });
  })();

  // Keep the mirrored feedback boxes in sync so scrolling to the other copy
  // never loses what was already typed.
  (function () {
    var boxes = document.querySelectorAll('[data-rv-sync="feedback"]');
    for (var i = 0; i < boxes.length; i++) {
      boxes[i].addEventListener('input', function (e) {
        for (var j = 0; j < boxes.length; j++) {
          if (boxes[j] !== e.target) boxes[j].value = e.target.value;
        }
      });
    }
  })();

  // Collapse and "viewed" are per-reviewer view state, so they live in
  // localStorage rather than in the task: they are about who has read what on
  // this machine, not about the work itself, and nothing downstream consumes
  // them. The key carries the file's content hash, so a tick survives later
  // review rounds but disappears the moment the agent changes that file — a
  // tick that outlived its change would assert the file had been read when it
  // had not.
  (function () {
    var KEY = 'lazy:reviewed:' + TASK;
    var files = document.querySelectorAll('.rv-file');
    if (!files.length) return;

    function load() {
      try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; }
    }
    function save(state) {
      try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* private mode: view state is not worth failing over */ }
    }

    var state = load();

    function setViewed(section, viewed) {
      var file = section.dataset.file;
      var hash = section.dataset.contentHash;
      section.dataset.viewed = viewed ? '1' : '0';
      section.dataset.collapsed = viewed ? '1' : '0';
      var box = section.querySelector('.rv-viewed-box');
      if (box) box.checked = viewed;
      var toggle = section.querySelector('.rv-file-toggle');
      if (toggle) toggle.setAttribute('aria-expanded', viewed ? 'false' : 'true');
      if (viewed) state[file] = hash; else delete state[file];
      save(state);
      updateCount();
    }

    function updateCount() {
      var el = document.querySelector('[data-rv-sb="viewed"]');
      if (!el) return;
      var seen = 0;
      for (var i = 0; i < files.length; i++) if (files[i].dataset.viewed === '1') seen++;
      el.textContent = seen + '/' + files.length + ' files viewed';
    }

    for (var i = 0; i < files.length; i++) {
      var section = files[i];
      var toggle = section.querySelector('.rv-file-toggle');
      var label = section.querySelector('.rv-viewed');
      if (label) label.hidden = false;
      // A stored hash that no longer matches means the file changed since it
      // was ticked, so it comes back unviewed and expanded.
      var remembered = state[section.dataset.file];
      if (remembered && remembered === section.dataset.contentHash) {
        section.dataset.viewed = '1';
        section.dataset.collapsed = '1';
        var box = section.querySelector('.rv-viewed-box');
        if (box) box.checked = true;
        if (toggle) toggle.setAttribute('aria-expanded', 'false');
      } else if (remembered) {
        delete state[section.dataset.file];
      }
    }
    save(state);
    updateCount();

    // Collapsing itself is handled by the shared diff script; this only owns
    // the tick and what it remembers.
    document.addEventListener('change', function (ev) {
      var box = ev.target.closest ? ev.target.closest('.rv-viewed-box') : null;
      if (!box) return;
      setViewed(box.closest('.rv-file'), box.checked);
    });
  })();

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

export function reviewQueueHtml(entries: ReviewQueueEntry[]): string {
  const rows = entries
    .map((e) => {
      const label = e.code ?? e.id.substring(0, 8);
      const pending = e.pendingAsks > 0
        ? `<span class="rv-badge rv-pending">${e.pendingAsks} awaiting agent</span>`
        : '';
      const queued = e.pendingComments > 0
        ? `<span class="rv-badge rv-pending">${e.pendingComments} comment${e.pendingComments === 1 ? '' : 's'} to deliver</span>`
        : '';
      const comments = e.commentCount > 0 ? `<span class="rv-badge">${e.commentCount} comments</span>` : '';
      const noSession = e.hasSession ? '' : '<span class="rv-badge">no session</span>';
      return `<tr>
        <td><a href="/review/${escapeHtml(e.id)}">${escapeHtml(label)}</a></td>
        <td>${escapeHtml(e.type)}</td>
        <td>${escapeHtml(e.goal)}</td>
        <td>${comments} ${queued} ${pending} ${noSession}</td>
      </tr>`;
    })
    .join('\n');

  const body = entries.length
    ? `<table class="rv-queue"><thead><tr><th>Task</th><th>Type</th><th>Goal</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="empty-state">Nothing awaiting review.</p>';

  return layoutHtml('Review queue', `<h1>Review queue</h1>${body}`);
}

interface Thread {
  threadId: string;
  file: string;
  side: string;
  line: number;
  messages: ReviewComment[];
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
  /** True when a question posted right now would reach the agent. */
  askable: boolean;
  /** Why it would not, in the reviewer's words; null when askable. */
  askUnavailable: string | null;
}

/** State for a task we know nothing more about than its status. */
function fallbackState(task: Task): ReviewLiveState {
  return {
    status: task.status,
    turns: 0,
    lastActiveAt: null,
    askable: askUnavailableReason(task.status) === null,
    askUnavailable: askUnavailableReason(task.status),
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
    `<form class="rv-withdraw" method="post" action="/review/${escapeHtml(taskId)}/comment/${encodeURIComponent(m.id)}/withdraw">` +
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
      `<form class="rv-retry" method="post" action="/review/${escapeHtml(taskId)}/comment/${encodeURIComponent(m.id)}/retry">` +
      `<button type="submit">Re-send to agent</button></form>`
    );
  }
  if (m.delivery_state === 'pending_delivery') {
    return '<div class="rv-state rv-state-queued">queued — will be sent with your next unblock</div>';
  }
  if (m.delivery_state === 'delivered') {
    return `<div class="rv-state rv-state-delivered">delivered in turn ${escapeHtml(String(m.delivered_turn ?? '?'))}</div>`;
  }
  return '';
}

/** Who wrote it, and — for the reviewer — which intent they chose. */
function messageAuthor(m: ReviewComment): string {
  if (m.role === 'agent') return 'agent';
  return m.intent === 'comment' ? 'you (comment)' : 'you (ask)';
}

function threadHtml(taskId: string, t: Thread): string {
  const msgs = t.messages
    .map(
      (m) => `<div class="rv-msg rv-msg-${escapeHtml(m.role)}${isWithdrawn(m) ? ' rv-msg-withdrawn' : ''}">
        <div class="rv-msg-head">${messageAuthor(m)}</div>
        <div class="rv-msg-body">${escapeHtml(m.content)}</div>${messageStateHtml(taskId, m)}${withdrawControlHtml(taskId, m)}
      </div>`,
    )
    .join('\n');
  return `<div class="rv-thread">${msgs}<button type="button" class="rv-reply" data-thread="${escapeHtml(t.threadId)}">Reply</button></div>`;
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
function queuedHtml(queued: ReviewComment[]): string {
  if (queued.length === 0) {
    return '<div class="rv-hint">No comments queued for delivery.</div>';
  }
  const items = queued
    .map((c) => {
      const href = `#${escapeHtml(anchorDomId({ file: c.file, side: c.side, line: c.line }))}`;
      return `<li class="rv-queued-item">
        <a class="rv-queued-where" href="${href}"><code>${escapeHtml(c.file)}</code>:${c.line} (${escapeHtml(c.side)})</a>
        <div class="rv-msg-body">${escapeHtml(c.content)}</div>
      </li>`;
    })
    .join('\n');
  return `<div>${queued.length} comment${queued.length === 1 ? '' : 's'} queued — they will be sent with your next unblock.</div>
    <ul class="rv-queued-list">${items}</ul>`;
}

/**
 * The queued list + unblock + accept, rendered identically above and below the
 * diff so the reviewer never has to scroll back to act on what they just read.
 *
 * Both copies are complete, independently working forms — with JS off there are
 * simply two accept forms and two feedback boxes, and either one posts. With JS
 * on, the island moves accept into a dialog and keeps the two feedback boxes in
 * sync. No ids are used inside, because this block exists twice on the page.
 */
/**
 * The protected-file summary above the actions.
 *
 * REPORTS state, never changes it. Approving a change you have not looked at is
 * exactly the mistake this surface should not make easy, so each row links to
 * the file's diff and the decision is made down there, next to the code.
 */
function violationSummary(taskId: string, violations: FileViolation[], filesInDiff: Set<string>): string {
  if (violations.length === 0) return '';
  const outstanding = violations.filter((v) => v.status !== 'approved');
  const rows = violations
    .map((v) => {
      const approved = v.status === 'approved';
      // THE ONE EXCEPTION to "this summary does not change state": a violated
      // file with no section in the diff has no file box to hold its control,
      // and with no control anywhere the reviewer is stuck — accept refuses on
      // it forever. It gets its control here, and it is still the only one.
      const body = filesInDiff.has(v.file)
        ? `<a href="#${escapeHtml(fileSectionId(v.file))}"><code>${escapeHtml(v.file)}</code></a>` +
          `<span class="rv-violation-state">${approved ? 'accepted' : 'will be reverted'}</span>`
        : `<code>${escapeHtml(v.file)}</code> <span class="rv-hint">(not in this diff)</span>` +
          violationDecision(taskId, v.file, v.status);
      return `<li class="rv-violation-item" data-approved="${approved ? '1' : '0'}" data-rv-summary="${escapeHtml(v.file)}">
        <span class="rv-violation-mark" aria-hidden="true"></span>
        ${body}
      </li>`;
    })
    .join('');
  const head = outstanding.length
    ? `${outstanding.length} of ${violations.length} protected file${violations.length === 1 ? '' : 's'} not yet accepted`
    : `All ${violations.length} protected file${violations.length === 1 ? '' : 's'} accepted`;
  const hint = outstanding.length
    ? 'Open each file to decide. Unblock reverts every rejected file to its base commit; accept refuses while any is still rejected.'
    : 'Unblock keeps these changes; accept can merge them.';
  return `<div class="rv-violations"${outstanding.length ? '' : ' data-resolved="1"'}>
      <strong>${escapeHtml(head)}</strong>
      <p class="rv-hint">${escapeHtml(hint)}</p>
      <ul class="rv-violation-list">${rows}</ul>
    </div>`;
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
function remedyPanelHtml(taskId: string, remedy: AcceptRemedy, draft: ReviewDraft): string {
  const action = escapeHtml(`/review/${taskId}/accept`);
  // Carried through every remedy form so a second failure still cannot eat the
  // reviewer's words.
  const carried =
    `<input type="hidden" name="reason" value="${escapeHtml(draft.reason ?? '')}">` +
    `<input type="hidden" name="feedback" value="${escapeHtml(draft.feedback ?? '')}">`;

  const files = remedy.files?.length
    ? `<ul class="rv-remedy-files">${remedy.files.map((f) => `<li><code>${escapeHtml(f)}</code></li>`).join('')}</ul>`
    : '';

  const command = remedy.command
    ? `<p class="rv-hint">Run this in the project directory:</p>
       <pre class="rv-remedy-cmd"><code>${escapeHtml(remedy.command)}</code></pre>`
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
    uiForm = `<form class="rv-remedy-form" method="post" action="${escapeHtml(`/review/${taskId}/sync`)}">
        ${carried}
        <div class="rv-form-actions"><button type="submit">Sync with parent</button></div>
      </form>`;
  }

  return `<div class="rv-remedy" data-rv-remedy="${escapeHtml(remedy.reason)}">
      <strong>What to do next</strong>
      <p>${escapeHtml(remedy.next)}</p>
      ${files}
      ${uiForm}
      ${command}
    </div>`;
}

function actionsHtml(task: Task, queued: ReviewComment[], draft: ReviewDraft = {}): string {
  const unblockLabel = queued.length
    ? `<strong>Unblock with feedback</strong> — resumes the agent, carrying the ${queued.length} queued comment${queued.length === 1 ? '' : 's'} above`
    : '<strong>Unblock with feedback</strong> — resumes the agent to change code';

  return `<div class="rv-actions">
      <div${queued.length ? ' class="rv-pending-box"' : ''} data-rv-queued>${queuedHtml(queued)}</div>
      <form method="post" action="/review/${escapeHtml(task.id)}/unblock">
        <label>${unblockLabel}
          <textarea name="message" rows="6" required data-rv-sync="feedback" placeholder="What should the agent do next?">${escapeHtml(draft.feedback ?? '')}</textarea>
        </label>
        <div class="rv-form-actions">
          <button type="submit">Unblock</button>
          <button type="button" class="rv-accept-open" hidden>Accept…</button>
        </div>
      </form>
      <form class="rv-accept-form" method="post" action="/review/${escapeHtml(task.id)}/accept">
        <label><strong>Accept</strong> — merge this work into the parent
          <textarea name="reason" rows="3" placeholder="Reason (optional)">${escapeHtml(draft.reason ?? '')}</textarea>
        </label>
        <!-- Filled by the island from the feedback box on submit, so a refused
             accept can hand the reviewer's unblock text back to them. -->
        <input type="hidden" name="feedback" value="${escapeHtml(draft.feedback ?? '')}">
        <div class="rv-form-actions"><button type="submit" class="rv-primary">Accept</button></div>
      </form>
    </div>`;
}

/**
 * The sticky bar. Fixed to the bottom so it survives scrolling through a long
 * diff, and refreshed by the same poll that refreshes the threads — the
 * reviewer should never have to guess whether the agent has moved on.
 */
function statusBarHtml(task: Task, state: ReviewLiveState, queued: number, pendingAsks: number): string {
  const label = task.code ?? task.id.substring(0, 8);
  return `<div class="rv-statusbar" id="rv-statusbar"
      data-rv-askable="${state.askable ? '1' : '0'}"
      data-rv-ask-reason="${escapeHtml(state.askUnavailable ?? '')}">
      <a href="/review">← queue</a>
      <strong>${escapeHtml(label)}</strong>
      <span data-rv-sb="status">status: ${escapeHtml(state.status)}</span>
      <span class="rv-sb-sep">·</span>
      <span data-rv-sb="turns">${state.turns} turn${state.turns === 1 ? '' : 's'}</span>
      <span data-rv-sb="activity">active ${escapeHtml(relativeTime(state.lastActiveAt))}</span>
      <span class="rv-sb-sep">·</span>
      <span class="rv-sb-sep">·</span>
      <span data-rv-sb="viewed"></span>
      <span class="rv-sb-sep">·</span>
      <span data-rv-sb="queued">${queued} queued</span>
      <span data-rv-sb="asks">${pendingAsks} awaiting agent</span>
      <span class="rv-sb-ask" data-rv-sb="ask">${state.askable ? 'agent can answer' : 'agent busy — asks are saved, not sent'}</span>
      <a href="/tasks/${escapeHtml(task.id)}">task detail</a>
    </div>`;
}

/** Compact "3m ago" for the status bar. Mirrored by relTime() in the island. */
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
   * infers a remedy.
   */
  extras: { remedy?: AcceptRemedy; draft?: ReviewDraft } = {},
): string {
  const files = parseUnifiedDiff(diffText);
  const violationsByPath = new Map(fileViolations.map((v) => [v.file, v.status]));
  const threads = groupThreads(comments);
  const byAnchor = new Map<string, RenderedThread[]>();
  for (const t of threads) {
    const key = anchorKey({ file: t.file, side: t.side as 'old' | 'new', line: t.line });
    const list = byAnchor.get(key) ?? [];
    list.push({ threadId: t.threadId, html: threadHtml(task.id, t) });
    byAnchor.set(key, list);
  }

  const label = task.code ?? task.id.substring(0, 8);
  const noticeHtml = notice
    ? `<div class="rv-notice${notice.error ? ' rv-notice-err' : ''}">${escapeHtml(notice.text)}</div>`
    : '';

  // Orphan threads: a comment whose anchor no longer appears in the diff (the
  // agent rewrote that line). It must never vanish — render it above the diff.
  const anchored = new Set<string>();
  for (const f of files) {
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (l.newLine !== null) anchored.add(`${f.path} new ${l.newLine}`);
        if (l.oldLine !== null) anchored.add(`${f.path} old ${l.oldLine}`);
      }
    }
  }
  const orphans = threads.filter((t) => !anchored.has(`${t.file} ${t.side} ${t.line}`));
  const orphanHtml = orphans.length
    ? `<h2>Comments whose lines are no longer in the diff</h2>` +
      orphans
        .map(
          (t) =>
            `<div class="rv-notice"><div class="rv-msg-head">${escapeHtml(t.file)}:${t.line} (${escapeHtml(t.side)})</div>${threadHtml(task.id, t)}</div>`,
        )
        .join('\n')
    : '';

  const queued = pendingDeliveryComments(comments);
  const pendingAsks = comments.filter((c) => c.ask_state === 'pending').length;
  const live = state ?? fallbackState(task);
  const draft = extras.draft ?? {};
  const actions = actionsHtml(task, queued, draft);
  const remedyHtml = extras.remedy ? remedyPanelHtml(task.id, extras.remedy, draft) : '';

  const content = `
    <h1>Review: ${escapeHtml(label)}</h1>
    <p>${escapeHtml(task.goal)}</p>
    <p><a href="/review">← queue</a> · <a href="/tasks/${escapeHtml(task.id)}">task detail</a></p>
    ${noticeHtml}
    ${remedyHtml}
    ${violationSummary(task.id, fileViolations, new Set(files.map((f) => f.path)))}
    ${actions}
    ${orphanHtml}
    <h2>Diff</h2>
    ${diffViewOptionsHtml()}
    <div id="rv-root">${renderReviewDiff(files, byAnchor, { violations: violationsByPath, taskId: task.id })}</div>
    ${actions}
    ${statusBarHtml(task, live, queued.length, pendingAsks)}
    ${diffViewScript('#rv-root')}
    ${reviewScript(task.id)}
  `;
  return layoutHtml(`Review ${label}`, content);
}

/**
 * Shape returned by GET /api/review/:id/threads (consumed by the island).
 * `pending` counts asks in flight — the island polls fast while it is > 0.
 * `pendingDelivery` counts queued comments, which need no polling: nothing is
 * happening to them until the reviewer unblocks. `queued` carries those
 * comments in full so both mirrored action blocks can re-render without a
 * reload, and `state` feeds the sticky status bar.
 */
export function threadsJson(comments: ReviewComment[], state?: ReviewLiveState) {
  const threads = groupThreads(comments);
  const pending = comments.filter((c) => c.ask_state === 'pending').length;
  const queued = pendingDeliveryComments(comments);
  return {
    threads,
    pending,
    pendingDelivery: queued.length,
    queued: queued.map((c) => ({
      id: c.id,
      file: c.file,
      side: c.side,
      line: c.line,
      content: c.content,
    })),
    state,
  };
}

export type { ReviewActions };
