/**
 * The dashboard's usage-pause status line ([usage_pause] in lazy.toml).
 *
 * Two states a person running lazy on a company subscription must be able to
 * see without opening a terminal: a credential that is PAUSED (new turns on it
 * wait for the window to reset), and a credential the pause is ARMED for but
 * cannot act on because lazy has no usable reading for it — the state in which
 * the feature silently did nothing. Small on purpose: one line each, and the
 * full diagnosis stays in `lazy doctor` (the single warning surface).
 *
 * Pure: the daemon hands in its own state (src/daemon/usage-pause.ts,
 * `describeUsagePauseState`), so this line and the launch gate cannot disagree.
 */

import { escapeHtml } from './escape';
import { describeNoReading, describeOverage, describeReadingsStoreError, describeUsagePause } from '../usage-pause/policy';
import type { UsagePauseState } from '../daemon/usage-pause';
import type { TaskUsagePauseView } from './task-actions';
import { timestampHtml } from './timestamps';

/** POST target for a task's allowance: always by full id, never a code a sibling may share. */
function allowanceAction(taskId: string, op: 'allow' | 'clear'): string {
  return `/tasks/${encodeURIComponent(taskId)}/usage-pause/${op}`;
}

/**
 * One-click "Let its next turn through" — the per-task usage-pause allowance
 * (src/daemon/usage-pause.ts, "The per-task allowance"), good for ONE launch.
 * `back: 'dashboard'` returns to this banner; otherwise the task page.
 */
export function usagePauseAllowButtonHtml(taskId: string, back?: 'dashboard'): string {
  return `<form method="post" action="${allowanceAction(taskId, 'allow')}" class="usage-pause-allow">${back ? '<input type="hidden" name="back" value="dashboard">' : ''}<button type="submit" class="btn btn-sm">Let its next turn through</button></form>`;
}

function usagePauseClearButtonHtml(taskId: string, back?: 'dashboard'): string {
  return `<form method="post" action="${allowanceAction(taskId, 'clear')}" class="usage-pause-allow">${back ? '<input type="hidden" name="back" value="dashboard">' : ''}<button type="submit" class="btn btn-sm">Clear</button></form>`;
}

function allowedByHtml(setBy: string | null, setAt: number): string {
  return `Next turn let through the usage pause by ${escapeHtml(setBy ?? 'somebody')} ${timestampHtml(setAt)}.`;
}

/**
 * The Start / Resume / Unblock dialogs' box: sends the launch with the
 * per-task allowance (`usagePausePastOnce`). Rendered only when the task's
 * next turn would be paused — the caller decides from the daemon's verdict.
 */
export function usagePausePastCheckboxHtml(paused: boolean): string {
  if (!paused) return '';
  return `<label class="edit-check"><input type="checkbox" name="past_usage_pause" value="1"> Let this turn through the usage pause</label>`;
}

/**
 * The task page's usage-pause line: why its next turn would be paused (the
 * daemon's own wording) with the one-click allowance, or the pending allowance
 * with a Clear. Empty when the task would start and nothing is pending.
 */
export function taskUsagePauseHtml(taskId: string, view: TaskUsagePauseView | null | undefined): string {
  if (!view) return '';
  if (view.reason && !view.liftable) {
    // No allowance lifts this, so no button — even one already pending would not help.
    return `<div class="rv-warn" id="task-usage-pause"><span class="tag tag-warning">paused</span> This task's next turn would wait: ${escapeHtml(view.reason)} Letting it through does not help here — fix or move aside the readings file.</div>`;
  }
  if (view.allowed) {
    return `<div class="rv-note" id="task-usage-pause"><span class="tag">usage pause</span> ${allowedByHtml(view.allowed.setBy, view.allowed.setAt)} ${usagePauseClearButtonHtml(taskId)}</div>`;
  }
  if (!view.reason) return '';
  return `<div class="rv-warn" id="task-usage-pause"><span class="tag tag-warning">paused</span> This task's next turn would wait: ${escapeHtml(view.reason)} ${usagePauseAllowButtonHtml(taskId)}</div>`;
}

/** Empty when there is nothing to say — pausing off, or armed with readings, nothing paused and no overage status reported. */
export function usagePauseBannerHtml(state: UsagePauseState | null, now: number = Date.now()): string {
  if (!state) return '';
  const lines: string[] = [];
  // Whether anything here holds a turn back (or could fail to): only then is
  // the section headed "Usage pause". An overage status alone is information,
  // and heading it as a pause told people something was paused when nothing was.
  let pauseState = false;
  if (state.storeError) {
    pauseState = true;
    lines.push(`<li><span class="tag tag-warning">readings unreadable</span> ${escapeHtml(describeReadingsStoreError(state.storeError))}</li>`);
  }
  for (const v of state.paused) {
    pauseState = true;
    lines.push(
      `<li><span class="tag tag-warning">paused</span> ${escapeHtml(describeUsagePause(v, now))}</li>`,
    );
  }
  for (const c of state.coverage) {
    // Informational, never a pause: overage ON is what the pause exists to keep
    // you out of; OFF (with the provider's reason) means the provider stops at
    // the limit itself.
    if (c.overage) {
      const tag = c.overage.status === 'allowed'
        ? '<span class="tag tag-warning">overage on</span>'
        : '<span class="tag">overage off</span>';
      lines.push(`<li>${tag} ${escapeHtml(describeOverage(c.credential, c.overage))}</li>`);
    }
    if (c.coverage !== 'none') continue;
    pauseState = true;
    lines.push(`<li><span class="tag tag-warning">armed, no reading</span> ${escapeHtml(describeNoReading(c))}</li>`);
  }
  // Held tasks: each can be let through in one click (their daemon-started
  // launch replays on the next sweep). Pending allowances say who and when.
  const allowedIds = new Set((state.allowed ?? []).map((a) => a.taskId));
  for (const h of state.held) {
    if (allowedIds.has(h.taskId)) continue;
    pauseState = true;
    // Unreadable readings: no allowance lifts the hold, so no button.
    const button = h.hold.storeError ? '' : ` ${usagePauseAllowButtonHtml(h.taskId, 'dashboard')}`;
    lines.push(
      `<li><span class="tag tag-warning">held</span> <a href="/tasks/${encodeURIComponent(h.taskId)}">${escapeHtml(h.task)}</a> — ${escapeHtml(h.hold.held)} waits.${button}</li>`,
    );
  }
  for (const p of state.pausedTasks ?? []) {
    pauseState = true;
    lines.push(
      `<li><span class="tag tag-warning">paused</span> <a href="/tasks/${encodeURIComponent(p.taskId)}">${escapeHtml(p.task)}</a> — its next turn would wait. ${usagePauseAllowButtonHtml(p.taskId, 'dashboard')}</li>`,
    );
  }
  for (const a of state.allowed ?? []) {
    pauseState = true;
    lines.push(
      `<li><span class="tag">let through</span> <a href="/tasks/${encodeURIComponent(a.taskId)}">${escapeHtml(a.task)}</a> — ${allowedByHtml(a.setBy, a.setAt)} ${usagePauseClearButtonHtml(a.taskId, 'dashboard')}</li>`,
    );
  }
  if (lines.length === 0) return '';
  const held = state.held.length > 0
    ? ` ${state.held.length} task${state.held.length === 1 ? ' is' : 's are'} waiting for the reset.`
    : '';
  return `
    <div class="detail-section" id="usage-pause-status">
      <h2>${pauseState ? 'Usage pause' : 'Usage'}</h2>
      <ul class="usage-pause-lines">${lines.join('')}</ul>
      <p class="text-muted">${pauseState ? `Turns already running continue.${escapeHtml(held)} ` : 'Nothing is paused. '}Full diagnosis: <code>lazy doctor</code>.</p>
    </div>
  `;
}
