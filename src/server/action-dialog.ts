/**
 * Task-page action dialog — one chrome, every verb.
 *
 * Buttons carry `data-lz-action-open="<verb>"`. The form for that verb lives
 * in a `<template data-lz-action-template="<verb>">`. A click clones the
 * template into the shared `<dialog>`, `showModal()`, and on submit POSTs with
 * {@link ACTION_DIALOG_HEADER} so the route starts an {@link beginActionRun}
 * instead of blocking until a 303. Progress events (the same ones the CLI
 * prints) fill the step list. Success closes the dialog and navigates;
 * failure leaves it open with the failed step. A protection-gate refusal
 * puts the passphrase field under that failed step (CLI command secondary)
 * instead of repeating the refusal text.
 *
 * Without JS the templates are inert and the POST URLs still work: a form
 * POST with no header is the existing 303 path. The engineer complaint was
 * layout-jerking `<details>` expanders and a three-tab control that sat still
 * after click — both go away here.
 *
 * Page-level (not inside a swapped tab body) so an in-place tab switch does
 * not drop the dialog node; templates live next to their buttons.
 */

import { ACTION_DIALOG_HEADER } from './action-run';
import { escapeHtml, scriptJson } from './escape';

/** Empty dialog chrome; body is filled from a template on open. */
export function actionDialogChromeHtml(): string {
  // Without JS the open-buttons do nothing and the forms live in <noscript>
  // next to each template (see actionDialogTemplateHtml). Hide the dead
  // buttons so the stacked forms are the only affordance.
  return `<noscript><style>[data-lz-action-open]{display:none!important}</style></noscript>
    <dialog class="rv-dialog lz-action-dialog" id="lz-action-dialog">
    <form method="dialog" class="lz-action-dialog-close">
      <button type="submit" class="rv-nav-btn" data-lz-action-cancel aria-label="Close">Close</button>
    </form>
    <h2 class="lz-action-dialog-title" id="lz-action-dialog-title"></h2>
    <div class="lz-action-dialog-body" id="lz-action-dialog-body"></div>
    <ol class="lz-action-steps" id="lz-action-steps" hidden></ol>
    <p class="lz-action-error" id="lz-action-error" hidden></p>
    <div class="lz-action-remedy" id="lz-action-remedy" hidden></div>
  </dialog>`;
}

/**
 * A button that opens the shared dialog onto `verb`'s template.
 *
 * `disabledReason` draws a disabled button with a title — same predicate
 * the POST route will refuse, so the page never offers a click the daemon
 * would 409. With `reenableable: true` the button keeps `data-lz-action-open`
 * so a live poll can clear `disabled` later without rewriting the markup
 * (Current review's Unblock / Accept busy gate). `extraAttrs` is raw
 * attribute text (already escaped) appended to the button.
 */
export function actionDialogButtonHtml(opts: {
  verb: string;
  label: string;
  title?: string;
  disabledReason?: string | null;
  primary?: boolean;
  extraClass?: string;
  /** Keep data-lz-action-open while disabled so JS can re-enable in place. */
  reenableable?: boolean;
  /** Extra attribute text, e.g. `data-rv-busy-gate`. Caller escapes values. */
  extraAttrs?: string;
}): string {
  const cls = [
    'btn',
    opts.primary ? 'btn-primary' : '',
    opts.extraClass ?? '',
  ].filter(Boolean).join(' ');
  const extra = opts.extraAttrs ? ` ${opts.extraAttrs}` : '';
  // Hard-disabled: no open hook — the verb is unavailable for this page load
  // (Sync while working, etc.). Soft-disabled (`reenableable`) keeps the hook
  // so a status poll can flip the button without a reload.
  if (opts.disabledReason && !opts.reenableable) {
    return `<button type="button" class="${escapeAttr(cls)}" disabled title="${escapeAttr(opts.disabledReason)}"${extra}>${escapeHtml(opts.label)}</button>`;
  }
  const titleText = opts.disabledReason ?? opts.title;
  const title = titleText ? ` title="${escapeAttr(titleText)}"` : '';
  const disabled = opts.disabledReason ? ' disabled' : '';
  return `<button type="button" class="${escapeAttr(cls)}" data-lz-action-open="${escapeAttr(opts.verb)}" data-lz-action-title="${escapeAttr(opts.title ?? opts.label)}"${title}${disabled}${extra}>${escapeHtml(opts.label)}</button>`;
}

/**
 * Wrap a verb's form so the dialog script can clone it on open.
 *
 * A `<noscript>` copy sits beside the template so Unblock / Accept / Stop
 * still POST as plain forms when scripting is off — `<template>` content is
 * inert in the document, and the engineer invariant is that those verbs work
 * without JS. With JS the noscript block is not in the DOM.
 *
 * Pass `noscript: false` when the verb must not be offered without JS for
 * this paint (Current review's Unblock / Accept while busy) — the
 * `<template>` still mounts so a live poll can re-enable the dialog.
 */
export function actionDialogTemplateHtml(
  verb: string,
  formHtml: string,
  opts?: { noscript?: boolean },
): string {
  const template = `<template data-lz-action-template="${escapeAttr(verb)}">${formHtml}</template>`;
  if (opts?.noscript === false) return template;
  return `${template}<noscript>${formHtml}</noscript>`;
}

function escapeAttr(str: string): string {
  return escapeHtml(str);
}

/**
 * Page-level island: open the shared dialog from a button, POST through the
 * run registry, follow steps over WebSocket (poll as fallback), close on
 * success, stay open on failure.
 */
export function actionDialogScript(): string {
  const header = ACTION_DIALOG_HEADER;
  return `<script>
(function () {
  var HEADER = ${scriptJson(header)};
  var dialog, body, titleEl, stepsEl, errorEl, remedyEl;
  var running = false;
  var pollTimer = null;
  var ws = null;
  var lastFormData = null;
  var lastFormAction = '';

  function els() {
    dialog = document.getElementById('lz-action-dialog');
    body = document.getElementById('lz-action-dialog-body');
    titleEl = document.getElementById('lz-action-dialog-title');
    stepsEl = document.getElementById('lz-action-steps');
    errorEl = document.getElementById('lz-action-error');
    remedyEl = document.getElementById('lz-action-remedy');
  }

  function setRunning(on) {
    running = on;
    // Close stays enabled for the whole run: a review can take minutes, and
    // dismissing must not cancel it — only the client follow stops. Never
    // disable the method=dialog Close for "busy".
    if (dialog) dialog.classList.toggle('lz-action-running', on);
  }

  function clearFollow() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (ws) {
      try { ws.close(); } catch (e) { /* already closed */ }
      ws = null;
    }
  }

  function showError(text) {
    if (!errorEl) return;
    errorEl.hidden = false;
    errorEl.textContent = text || 'The action failed.';
  }

  function hideError() {
    if (!errorEl) return;
    errorEl.hidden = true;
    errorEl.textContent = '';
  }

  function hideRemedy() {
    if (!remedyEl) return;
    remedyEl.hidden = true;
    remedyEl.innerHTML = '';
  }

  function hideBodyForms() {
    if (!body) return;
    var forms = body.querySelectorAll('form');
    for (var i = 0; i < forms.length; i++) forms[i].hidden = true;
    if (dialog) dialog.classList.add('lz-action-form-hidden');
  }

  function showBodyForms() {
    if (!body) return;
    var forms = body.querySelectorAll('form');
    for (var i = 0; i < forms.length; i++) forms[i].hidden = false;
    if (dialog) dialog.classList.remove('lz-action-form-hidden');
  }

  function renderPassphraseRemedy(remedy) {
    if (!remedyEl) return;
    var action = lastFormAction || '';
    var html = '<form method="post" action="' + escapeText(action) + '" class="lz-action-form lz-action-passphrase" data-lz-action-form>';
    if (lastFormData) {
      lastFormData.forEach(function (value, key) {
        if (key === 'passphrase') return;
        html += '<input type="hidden" name="' + escapeText(key) + '" value="' + escapeText(String(value)) + '">';
      });
    }
    html += '<label>Approval passphrase<input type="password" name="passphrase" required autocomplete="off" spellcheck="false" placeholder="Approval passphrase"></label>';
    html += '<div class="rv-form-actions"><button type="submit" class="rv-primary">Approve and accept</button></div>';
    html += '</form>';
    if (remedy.command) {
      html += '<p class="rv-hint">Or run this in the project directory:</p>';
      html += '<pre class="rv-remedy-cmd"><code>' + escapeText(remedy.command) + '</code></pre>';
    }
    remedyEl.innerHTML = html;
    remedyEl.hidden = false;
    var focus = remedyEl.querySelector('input[type=password]');
    if (focus && focus.focus) focus.focus();
  }

  function describeEvent(e) {
    if (!e || e.kind === 'activity') return '';
    if (e.kind === 'plan') {
      var n = (e.phases && e.phases.length) || 0;
      return (e.operation || '') + (e.target ? ' ' + e.target : '') + ': ' + n + ' phases';
    }
    var pos = (e.total > 0 && e.index > 0) ? '[' + e.index + '/' + e.total + '] ' : '';
    var elapsed = e.elapsedMs !== undefined ? ' (' + formatMs(e.elapsedMs) + ')' : '';
    var detail = e.detail ? ' — ' + e.detail : '';
    if (e.state === 'start') return pos + e.label + '…';
    if (e.state === 'progress') return pos + e.label + '…' + detail;
    if (e.state === 'done') return pos + e.label + ' — done' + elapsed + detail;
    if (e.state === 'skipped') return pos + e.label + ' — skipped' + detail;
    if (e.state === 'failed') return pos + e.label + ' — FAILED' + elapsed + detail;
    return pos + (e.label || '');
  }

  function formatMs(ms) {
    if (ms < 1000) return ms + 'ms';
    var s = ms / 1000;
    if (s < 60) return s.toFixed(1) + 's';
    var m = Math.floor(s / 60);
    var rem = Math.floor(s % 60);
    return m + 'm' + String(rem).padStart(2, '0') + 's';
  }

  function mark(state) {
    if (state === 'done') return '✓';
    if (state === 'failed') return '✗';
    if (state === 'skipped') return '–';
    if (state === 'start' || state === 'progress') return '·';
    return ' ';
  }

  function renderEvents(events) {
    if (!stepsEl) return;
    var plan = [];
    var byId = {};
    var prelude = [];
    for (var i = 0; i < (events || []).length; i++) {
      var e = events[i];
      if (!e) continue;
      if (e.kind === 'plan') {
        plan = e.phases || [];
        continue;
      }
      if (e.kind !== 'phase') continue;
      byId[e.id] = e;
      if ((!e.index || e.index === 0) && plan.every(function (p) { return p.id !== e.id; })) {
        if (prelude.every(function (p) { return p.id !== e.id; })) prelude.push(e);
      }
    }
    var rows = prelude.concat(plan);
    if (rows.length === 0 && events && events.length) {
      // No plan announced — list every phase event in order, latest per id.
      var seen = [];
      for (var j = 0; j < events.length; j++) {
        if (events[j].kind === 'phase' && seen.indexOf(events[j].id) === -1) seen.push(events[j].id);
      }
      rows = seen.map(function (id) { return byId[id] || { id: id, label: id }; });
    }
    if (rows.length === 0) {
      stepsEl.hidden = true;
      stepsEl.innerHTML = '';
      return;
    }
    stepsEl.hidden = false;
    var html = '';
    for (var k = 0; k < rows.length; k++) {
      var row = rows[k];
      var ev = byId[row.id];
      var state = ev ? ev.state : '';
      var text = ev ? describeEvent(ev) : (row.label || row.id);
      html += '<li class="lz-action-step" data-state="' + (state || 'pending') + '">' +
        '<span class="lz-action-step-mark" aria-hidden="true">' + mark(state) + '</span> ' +
        '<span class="lz-action-step-text">' + escapeText(text) + '</span></li>';
    }
    stepsEl.innerHTML = html;
  }

  function escapeText(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function onSettled(snap) {
    clearFollow();
    setRunning(false);
    renderEvents(snap.events || []);
    if (snap.status === 'done') {
      // Close even when there is no redirect — otherwise a successful
      // no-redirect settle leaves the dialog open with no way out except
      // a full page refresh (Close used to stay disabled while running).
      if (dialog && dialog.open) dialog.close();
      if (snap.redirect) location.assign(snap.redirect);
      return;
    }
    if (snap.status === 'failed') {
      var remedy = snap.remedy;
      if (remedy && remedy.uiAction === 'passphrase') {
        // The failed step already carries the gate text. Showing it again in
        // #lz-action-error is the double-refusal the engineer hit. The
        // passphrase field is the primary affordance; the CLI command is
        // secondary, composed by the daemon with every --approve-file.
        renderPassphraseRemedy(remedy);
        return;
      }
      showError(snap.error || 'The action failed.');
    }
  }

  // taskSeg is the ALREADY-ESCAPED path segment — the value the server stamps
  // into data-lz-task-id (taskPathSegment), or a raw id escaped once by the
  // caller. Escaping it a second time here re-escaped the percent signs, so
  // the poll and its websocket 404'd and the dialog said "Lost the action"
  // while the accept/unblock/sync was in fact still running. runId is a RAW
  // value and is escaped exactly once, here.
  // (The literal double-escaped spelling is deliberately not written out: this
  // script is embedded in the task page, and task-code-url-escaping.test.ts
  // asserts that signature appears nowhere in the rendered HTML.)
  function followRun(taskSeg, runId) {
    clearFollow();
    var pollUrl = '/tasks/' + taskSeg + '/action-runs/' + encodeURIComponent(runId);
    var wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') +
      location.host + pollUrl + '/ws';

    function poll() {
      fetch(pollUrl, { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('run gone')); })
        .then(function (snap) {
          renderEvents(snap.events || []);
          if (snap.status === 'running') {
            pollTimer = setTimeout(poll, 400);
            return;
          }
          onSettled(snap);
        })
        .catch(function (err) {
          setRunning(false);
          showError(err.message || 'Lost the action.');
        });
    }

    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      poll();
      return;
    }
    var events = [];
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === 'progress' && msg.event) {
        events.push(msg.event);
        renderEvents(events);
        return;
      }
      if (msg.type === 'done') {
        onSettled({ status: 'done', redirect: msg.redirect, events: events });
        return;
      }
      if (msg.type === 'failed') {
        onSettled({ status: 'failed', error: msg.error, events: events, remedy: msg.remedy });
        return;
      }
      if (msg.type === 'error') {
        setRunning(false);
        showError(msg.message || 'The action stream failed.');
      }
    };
    ws.onerror = function () {
      // Socket failed to open or dropped mid-run — the poll is the backstop
      // (and what e2e uses when it does not speak WebSocket).
      if (ws) { try { ws.close(); } catch (e) { /* */ } ws = null; }
      poll();
    };
  }

  function openAction(verb, title, opener) {
    els();
    if (!dialog || !dialog.showModal || !body) return;
    var tmpl = document.querySelector('[data-lz-action-template="' + verb + '"]');
    if (!tmpl) return;
    clearFollow();
    setRunning(false);
    hideError();
    hideRemedy();
    lastFormData = null;
    lastFormAction = '';
    if (dialog) dialog.classList.remove('lz-action-form-hidden');
    if (stepsEl) { stepsEl.hidden = true; stepsEl.innerHTML = ''; }
    if (titleEl) titleEl.textContent = title || verb;
    body.innerHTML = '';
    body.appendChild(tmpl.content.cloneNode(true));
    if (!dialog.open) dialog.showModal();
    var focus = body.querySelector('textarea, input:not([type=hidden])');
    if (focus && focus.focus) focus.focus();
    if (opener) opener.setAttribute('aria-expanded', 'true');
  }

  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-lz-action-open]') : null;
    if (!btn || btn.disabled) return;
    e.preventDefault();
    openAction(btn.getAttribute('data-lz-action-open'), btn.getAttribute('data-lz-action-title') || btn.textContent, btn);
  });

  // Dismiss (Close / ESC) is always allowed. A live run keeps going on the
  // server; we only drop the client follow so a later redirect cannot yank
  // the page the human already left. Failure still keeps the dialog open
  // until they dismiss — that path never auto-closes.
  document.addEventListener('close', function (e) {
    if (e.target !== dialog) return;
    clearFollow();
    setRunning(false);
    var openers = document.querySelectorAll('[data-lz-action-open][aria-expanded="true"]');
    for (var i = 0; i < openers.length; i++) openers[i].removeAttribute('aria-expanded');
  }, true);

  // A Cancel inside a dialog form closes the dialog; the words stay in the
  // template's autosaved draft, not in this clone.
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-lz-action-dismiss]') : null;
    if (!btn) return;
    e.preventDefault();
    els();
    if (dialog && dialog.open) dialog.close();
  });

  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || !form.matches || !form.matches('form[data-lz-action-form]')) return;
    els();
    var inDialog = dialog && dialog.contains(form);
    // Page-level forms (New task) opt in with data-lz-action-when="<checkbox>":
    // only intercept when that box is ticked, so Create-without-start stays a
    // plain POST and Start now gets the live phase list. "always" means the
    // whole submit is phased (Link).
    if (!inDialog) {
      var when = form.getAttribute('data-lz-action-when');
      if (!when) return;
      if (when !== 'always') {
        var gate = form.elements.namedItem ? form.elements.namedItem(when) : null;
        if (!gate || !gate.checked) return;
      }
    }
    e.preventDefault();
    if (!inDialog && dialog && dialog.showModal) {
      clearFollow();
      hideError();
      hideRemedy();
      if (titleEl) titleEl.textContent = form.getAttribute('data-lz-action-title') || 'Starting…';
      if (body) body.innerHTML = '';
      if (dialog) dialog.classList.remove('lz-action-form-hidden');
      if (!dialog.open) dialog.showModal();
    }
    if (running) return;
    if (window.lzCopyRaisedFields) window.lzCopyRaisedFields(form);
    // Clone BEFORE hideRemedy: the passphrase retry form lives in that slot.
    lastFormData = new FormData(form);
    // A form offering several verbs over one textarea (the Ask dialog's
    // Ask / Add comment / Unblock) routes by the pressed button's formaction,
    // exactly as a JS-off POST of the same form would.
    var submitter = e.submitter && e.submitter.form === form ? e.submitter : null;
    lastFormAction = submitter && submitter.hasAttribute('formaction') ? submitter.formAction : form.action;
    hideError();
    hideRemedy();
    var submit = submitter || form.querySelector('[type=submit]');
    if (submit) submit.disabled = true;
    setRunning(true);
    hideBodyForms();
    if (stepsEl) {
      stepsEl.hidden = false;
      stepsEl.innerHTML = '<li class="lz-action-step" data-state="start"><span class="lz-action-step-mark">·</span> <span class="lz-action-step-text">Starting…</span></li>';
    }
    var taskPage = document.querySelector('[data-lz-task-page]');
    var taskId = taskPage ? (taskPage.getAttribute('data-lz-task-id') || '') : '';
    var headers = { 'Accept': 'application/json' };
    headers[HEADER] = '1';
    fetch(lastFormAction, {
      method: 'POST',
      body: lastFormData,
      credentials: 'same-origin',
      headers: headers,
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; });
    }).then(function (res) {
      if (!res.ok) {
        setRunning(false);
        showBodyForms();
        // A create+start that already wrote the task must not re-enable the
        // form — a second click would create another one.
        if (res.body && res.body.taskId) {
          showError((res.body.error || res.body.message) || 'The task was created.');
          location.assign(res.body.redirect || ('/tasks/' + encodeURIComponent(res.body.taskId)));
          return;
        }
        if (submit) submit.disabled = false;
        showError((res.body && (res.body.error || res.body.message)) || ('Request failed (' + res.status + ')'));
        return;
      }
      var runId = res.body && res.body.runId;
      if (!runId) {
        setRunning(false);
        showBodyForms();
        if (submit) submit.disabled = false;
        showError('The server did not start an action run.');
        return;
      }
      // taskId is the stamped segment (already escaped); res.body.taskId is
      // a RAW id from the daemon, so it is escaped once here — followRun takes
      // an escaped segment from either source.
      followRun(res.body.taskId ? encodeURIComponent(res.body.taskId) : taskId, runId);
    }).catch(function (err) {
      setRunning(false);
      showBodyForms();
      var when = form.getAttribute && form.getAttribute('data-lz-action-when');
      if (when) {
        // The POST may have created the task before the response dropped.
        // Leave the button disabled; refresh to try again after checking Tasks.
        showError((err.message || 'Could not start the action.') +
          ' If a task was created, do not submit again — open the Tasks list.');
        return;
      }
      if (submit) submit.disabled = false;
      showError(err.message || 'Could not start the action.');
    });
  });

  els();
})();
</script>`;
}
