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

/** Empty when there is nothing to say — pausing off, or armed with readings, nothing paused and no overage status reported. */
export function usagePauseBannerHtml(state: UsagePauseState | null, now: number = Date.now()): string {
  if (!state) return '';
  const lines: string[] = [];
  if (state.storeError) {
    lines.push(`<li><span class="tag tag-warning">readings unreadable</span> ${escapeHtml(describeReadingsStoreError(state.storeError))}</li>`);
  }
  for (const v of state.paused) {
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
    lines.push(`<li><span class="tag tag-warning">armed, no reading</span> ${escapeHtml(describeNoReading(c))}</li>`);
  }
  if (lines.length === 0) return '';
  const held = state.held.length > 0
    ? ` ${state.held.length} task${state.held.length === 1 ? ' is' : 's are'} waiting for the reset.`
    : '';
  return `
    <div class="detail-section" id="usage-pause-status">
      <h2>Usage pause</h2>
      <ul class="usage-pause-lines">${lines.join('')}</ul>
      <p class="text-muted">Turns already running continue.${escapeHtml(held)} Full diagnosis: <code>lazy doctor</code>.</p>
    </div>
  `;
}
