/**
 * Settings page chrome — Memories and Doctor tabs — plus the Doctor report.
 *
 * Memories is the existing memory index, wrapped here so the nav can say
 * Settings without the listing becoming a second implementation. Doctor
 * renders a snapshot the daemon already produced (`doctor.report`); the GET
 * never runs the sweep.
 *
 * Run and each remedy flag open a dialog that narrates steps as they happen
 * (the same live-steps idea as task-page actions). Without JS the same POST
 * streams an HTML page. Destructive flags show the dry-run list and require
 * a confirm click inside the dialog before they act.
 */

import { layoutHtml, layoutOpenHtml, layoutCloseHtml } from './templates';
import { escapeHtml } from './review-diff';
import type { DoctorCheckResult, StoredDoctorReport } from '../doctor';
import {
  DOCTOR_REMEDY_FLAGS,
  isDestructiveRemedy,
  remedyTitle,
  type DoctorRemedyFlag,
  type DoctorRemedyPreview,
  type DoctorRemedyProgressEvent,
  type DoctorRemedyResult,
} from '../doctor/remedies';

export type SettingsSection = 'memory' | 'doctor';

export function settingsTabsHtml(section: SettingsSection): string {
  const tab = (id: SettingsSection, href: string, label: string) =>
    `<a href="${escapeHtml(href)}" class="lz-tab${section === id ? ' lz-tab-current' : ''}"${section === id ? ' aria-current="page"' : ''}>${escapeHtml(label)}</a>`;
  return `<nav class="lz-tabs lz-settings-tabs" aria-label="Settings">
    ${tab('memory', '/settings/memory', 'Memories')}
    ${tab('doctor', '/settings/doctor', 'Doctor')}
  </nav>`;
}

export function settingsPageHtml(
  title: string,
  section: SettingsSection,
  bodyHtml: string,
  options?: { extraHtml?: string },
): string {
  return layoutHtml(title, `
    <h1>Settings</h1>
    <p class="text-muted lz-settings-intro">Project memory and installation health. Doctor runs the same checks as <code>lazy doctor</code>.</p>
    ${settingsTabsHtml(section)}
    ${bodyHtml}
    ${options?.extraHtml ?? ''}
  `);
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function statusLabel(status: DoctorCheckResult['status']): string {
  if (status === 'ok') return 'ok';
  if (status === 'warning') return 'warning';
  return 'error';
}

function isKnownFlag(flag: string): flag is DoctorRemedyFlag {
  return (DOCTOR_REMEDY_FLAGS as readonly string[]).includes(flag);
}

function remedyButtonHtml(flag: DoctorRemedyFlag, label: string): string {
  const destructive = isDestructiveRemedy(flag);
  return `<form method="post" action="/settings/doctor/remedy/${encodeURIComponent(flag)}" class="lz-doctor-remedy-form">
    <button type="submit" class="btn btn-sm${destructive ? '' : ' btn-primary'}"
            data-lz-doctor-remedy="${escapeHtml(flag)}"
            data-lz-destructive="${destructive ? '1' : '0'}">${escapeHtml(label)}</button>
  </form>`;
}

function checkCardHtml(check: DoctorCheckResult): string {
  const flag = check.remedyFlag && isKnownFlag(check.remedyFlag) ? check.remedyFlag : null;
  const remedyBtn = flag && check.status !== 'ok'
    ? remedyButtonHtml(flag, `Run ${escapeHtml(flag)}`)
    : '';
  const docs = check.docs
    ? `<p class="lz-doctor-docs"><a href="${escapeHtml(check.docs)}" rel="noreferrer">Documentation</a></p>`
    : '';
  const detail = check.detail
    ? `<p class="lz-doctor-detail">${escapeHtml(check.detail)}</p>`
    : '';
  const remedy = check.remedy && !flag
    ? `<p class="lz-doctor-remedy">${escapeHtml(check.remedy)}</p>`
    : '';
  return `<article class="lz-doctor-check lz-doctor-${check.status}" id="doctor-check-${escapeHtml(check.id)}">
    <div class="lz-doctor-check-head">
      <span class="lz-doctor-status">${escapeHtml(statusLabel(check.status))}</span>
      <h3>${escapeHtml(check.title)}</h3>
    </div>
    ${detail}${docs}${remedy}${remedyBtn}
  </article>`;
}

function remediesPanelHtml(): string {
  const items = DOCTOR_REMEDY_FLAGS.map((flag) => {
    const destructive = isDestructiveRemedy(flag);
    return `<li class="lz-doctor-remedy-item">
      <div>
        <strong>${escapeHtml(remedyTitle(flag))}</strong>
        <p class="hint"><code>lazy doctor --${escapeHtml(flag)}</code>${destructive ? ' — lists what it would remove, then asks' : ''}</p>
      </div>
      ${remedyButtonHtml(flag, destructive ? 'Preview' : 'Run')}
    </li>`;
  }).join('\n');
  return `<section class="lz-doctor-remedies" id="doctor-remedies">
    <h2>Remedies</h2>
    <p class="text-muted">Each flag lists what it would touch before it acts. Anything that removes disk, containers or stored content opens as a Preview and asks again inside the dialog.</p>
    <ul class="lz-doctor-remedy-list">${items}</ul>
  </section>`;
}

function reportHtml(stored: StoredDoctorReport | null): string {
  if (!stored) {
    return `<div class="empty-state" id="doctor-empty">Doctor has not run on this machine yet. Run it to see the same health report <code>lazy doctor</code> prints.</div>`;
  }
  const { report } = stored;
  const summary = `${report.errorCount} error${report.errorCount === 1 ? '' : 's'}, ${report.warningCount} warning${report.warningCount === 1 ? '' : 's'}`;
  const notes = report.notes.length
    ? `<ul class="lz-doctor-notes">${report.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`
    : '';
  const missing = report.missingRuns.length
    ? `<section class="lz-doctor-missing">
        <h2>Missing runs</h2>
        <ul>${report.missingRuns.map((r) =>
          `<li><code>${escapeHtml(r.taskCode)}</code> — ${escapeHtml(r.explanation)}</li>`).join('')}</ul>
      </section>`
    : '';
  return `<div class="lz-doctor-report" id="doctor-report" data-ran-at="${escapeHtml(report.ranAt)}">
    <p class="text-muted" id="doctor-ran-at">Last run ${escapeHtml(formatWhen(report.ranAt))} · ${escapeHtml(summary)}</p>
    <div class="lz-doctor-checks">${report.checks.map(checkCardHtml).join('\n')}</div>
    ${notes}${missing}
  </div>`;
}

export function settingsDoctorHtml(
  stored: StoredDoctorReport | null,
  options: { unavailable?: boolean; notice?: { text: string; error?: boolean } } = {},
): string {
  const notice = options.notice
    ? `<div class="msg-notice${options.notice.error ? ' msg-notice-error' : ''}" id="doctor-notice">${escapeHtml(options.notice.text)}</div>`
    : '';
  const runForm = options.unavailable
    ? `<p class="msg-notice msg-notice-error">Doctor actions are not available from this server.</p>`
    : `<form method="post" action="/settings/doctor/run" class="lz-doctor-run-form">
        <button type="submit" class="btn btn-primary" id="doctor-run" data-lz-doctor-run>Run doctor</button>
        <span class="hint">Reads the last report on this page; Run is what actually probes docker and git.</span>
      </form>`;
  return settingsPageHtml('Settings — Doctor', 'doctor', `
    ${notice}
    <section class="lz-doctor-head">
      <h2>Doctor</h2>
      ${runForm}
    </section>
    ${reportHtml(stored)}
    ${options.unavailable ? '' : remediesPanelHtml()}
  `, { extraHtml: doctorDialogHtml() + doctorDialogScript() });
}

function doctorDialogHtml(): string {
  return `<dialog class="rv-dialog lz-doctor-dialog" id="lz-doctor-dialog">
    <form method="dialog" class="lz-raised-dialog-close">
      <button type="submit" class="rv-nav-btn" aria-label="Close">Close</button>
    </form>
    <div class="lz-doctor-dialog-body">
      <h2 id="lz-doctor-dialog-title">Doctor</h2>
      <div id="lz-doctor-dialog-preview" hidden></div>
      <ol class="lz-doctor-steps" id="lz-doctor-dialog-steps"></ol>
      <p class="lz-doctor-dialog-error" id="lz-doctor-dialog-error" hidden></p>
      <form method="post" id="lz-doctor-dialog-confirm" hidden>
        <p>This will act on the list above.</p>
        <button type="submit" class="btn btn-primary" id="lz-doctor-dialog-confirm-btn">Confirm and run</button>
      </form>
    </div>
  </dialog>`;
}

/**
 * Intercept Run / remedy POSTs into the dialog. The same forms still POST a
 * full page when JS is off. The dialog header asks the server for NDJSON
 * steps so we can paint them live — close on success, stay open on failure.
 */
export function doctorDialogScript(): string {
  return `<script>
(function () {
  var dialog = document.getElementById('lz-doctor-dialog');
  if (!dialog || !dialog.showModal) return;
  var titleEl = document.getElementById('lz-doctor-dialog-title');
  var stepsEl = document.getElementById('lz-doctor-dialog-steps');
  var previewEl = document.getElementById('lz-doctor-dialog-preview');
  var errorEl = document.getElementById('lz-doctor-dialog-error');
  var confirmForm = document.getElementById('lz-doctor-dialog-confirm');

  function reset() {
    stepsEl.innerHTML = '';
    previewEl.innerHTML = '';
    previewEl.hidden = true;
    errorEl.hidden = true;
    errorEl.textContent = '';
    confirmForm.hidden = true;
    confirmForm.removeAttribute('data-flag');
  }
  function open(title) {
    reset();
    titleEl.textContent = title;
    if (!dialog.open) dialog.showModal();
  }
  function addStep(label, state, detail) {
    var li = document.createElement('li');
    li.className = 'lz-doctor-step lz-doctor-step-' + (state || 'start');
    li.textContent = label + (state === 'ok' || state === 'done' ? ' — done' : state === 'error' ? ' — failed' : '…');
    if (detail) {
      var span = document.createElement('span');
      span.className = 'hint';
      span.textContent = ' ' + detail;
      li.appendChild(span);
    }
    stepsEl.appendChild(li);
  }
  function fail(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }
  function escapeHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function showPreview(p) {
    previewEl.hidden = false;
    var html = '';
    if (p.empty) html = '<p>' + escapeHtml(p.emptyMessage) + '</p>';
    else {
      html = '<ul>' + (p.items || []).map(function (i) { return '<li>' + escapeHtml(i) + '</li>'; }).join('') + '</ul>';
      (p.notes || []).forEach(function (n) { html += '<p class="hint">' + escapeHtml(n) + '</p>'; });
    }
    previewEl.innerHTML = html;
    if (!p.empty && p.destructive) {
      confirmForm.hidden = false;
      confirmForm.setAttribute('data-flag', p.flag);
    }
  }

  async function readEvents(res) {
    var text = await res.text();
    var events = [];
    text.split('\\n').forEach(function (line) {
      line = line.trim();
      if (!line) return;
      try { events.push(JSON.parse(line)); } catch (e) { /* skip non-JSON */ }
    });
    return events;
  }

  async function post(url, body) {
    var res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-Lazy-Doctor-Dialog': '1', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body || ''
    });
    var events = await readEvents(res);
    var lastError = null;
    var shouldReload = false;
    events.forEach(function (ev) {
      if (ev.kind === 'step') addStep(ev.label, ev.state, ev.detail);
      else if (ev.kind === 'preview') showPreview(ev);
      else if (ev.kind === 'error') { lastError = ev.message; fail(ev.message); }
      else if (ev.kind === 'report') shouldReload = true;
      else if (ev.kind === 'result') shouldReload = ev.result && !ev.result.failed;
    });
    if (!res.ok && !lastError) fail(res.status + ' ' + res.statusText);
    if (shouldReload && res.ok) {
      setTimeout(function () { dialog.close(); location.reload(); }, 400);
    }
  }

  document.addEventListener('click', function (e) {
    var run = e.target.closest && e.target.closest('[data-lz-doctor-run]');
    if (run) {
      e.preventDefault();
      open('Running doctor');
      addStep('Running health checks', 'start');
      post('/settings/doctor/run');
      return;
    }
    var rem = e.target.closest && e.target.closest('[data-lz-doctor-remedy]');
    if (rem) {
      e.preventDefault();
      var flag = rem.getAttribute('data-lz-doctor-remedy');
      open(rem.textContent.trim() || flag);
      post('/settings/doctor/remedy/' + encodeURIComponent(flag));
    }
  });

  confirmForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var flag = confirmForm.getAttribute('data-flag');
    if (!flag) return;
    confirmForm.hidden = true;
    addStep('Applying', 'start');
    post('/settings/doctor/remedy/' + encodeURIComponent(flag), 'confirm=1');
  });
})();
  </script>`;
}

export function doctorStreamOpenHtml(title: string): string {
  return layoutOpenHtml(title) + `
    <div class="breadcrumb"><a href="/settings/doctor">Doctor</a> &rsaquo; Running</div>
    <h1>${escapeHtml(title)}</h1>
    <div class="lz-doctor-progress-log" id="doctor-progress">`;
}

export function doctorProgressLineHtml(event: DoctorRemedyProgressEvent): string {
  const verb = event.state === 'start' ? '…'
    : event.state === 'done' || event.state === 'ok' ? ' — done'
    : event.state === 'error' ? ' — failed'
    : '';
  const detail = event.detail ? ` — ${escapeHtml(event.detail)}` : '';
  return `<p class="lz-doctor-progress lz-doctor-progress-${event.state}">${escapeHtml(event.label)}${verb}${detail}</p>`;
}

export function doctorStreamCloseHtml(options: {
  error?: string;
  result?: DoctorRemedyResult;
  preview?: DoctorRemedyPreview;
}): string {
  let body = '';
  if (options.error) {
    body = `<div class="msg-notice msg-notice-error">${escapeHtml(options.error)}</div>`;
  } else if (options.preview) {
    const items = options.preview.empty
      ? `<p>${escapeHtml(options.preview.emptyMessage)}</p>`
      : `<ul>${options.preview.items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`;
    const notes = options.preview.notes.map((n) => `<p class="hint">${escapeHtml(n)}</p>`).join('');
    const confirm = !options.preview.empty
      ? `<form method="post" action="/settings/doctor/remedy/${encodeURIComponent(options.preview.flag)}">
           <input type="hidden" name="confirm" value="1">
           <button class="btn btn-primary" type="submit">Confirm and run</button>
         </form>`
      : '';
    body = `${items}${notes}${confirm}`;
  } else if (options.result) {
    body = `<div class="msg-notice${options.result.failed ? ' msg-notice-error' : ''}">${escapeHtml(options.result.message)}</div>
      <ul>${options.result.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`;
  }
  return `</div>
    ${body}
    <p><a class="btn btn-primary" href="/settings/doctor">Back to Doctor</a></p>
    ${layoutCloseHtml()}`;
}

export function doctorDialogEventLine(event: Record<string, unknown>): string {
  return JSON.stringify(event) + '\n';
}
