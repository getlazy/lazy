/**
 * The dashboard's token-budget box: per credential window, how much is used,
 * what was spent in it and the estimate of what is left; below it, the last
 * seven days of spend by harness. Pure over the daemon's own view
 * (src/daemon/token-budget.ts), so it cannot disagree with `lazy stats budget`.
 * Tokens and percentages only, never money.
 */
import { escapeHtml } from './escape';
import { windowLabel } from '../usage-pause/policy';
import { describeBudgetGap, formatTokens, type TokenBudgetView } from '../usage-pause/budget-view';

export function tokenBudgetBoxHtml(view: TokenBudgetView | null): string {
  if (!view) return '';
  if (view.credentials.length === 0 && view.harnesses.length === 0) return '';
  const windows = view.credentials.flatMap((c) => c.windows.map((w) => {
    const used = w.usedPercent === null ? '?' : `${w.usedPercent}%`;
    const left = w.gap === null && w.leftTokens !== null
      ? `~${formatTokens(w.leftTokens)} tokens left${w.leftTurns !== null ? ` (~${w.leftTurns} typical turns)` : ''}`
      : w.gap ? describeBudgetGap(w.gap) : '';
    const spent = w.spentTokens === null ? '—' : formatTokens(w.spentTokens);
    const reset = w.resetsAt !== null && w.resetSince === null ? new Date(w.resetsAt).toLocaleString() : '—';
    return `<tr data-credential="${escapeHtml(c.credential)}" data-window="${escapeHtml(w.name)}">
      <td>${escapeHtml(c.credential)}${c.paused ? ' <span class="tag tag-warning">paused</span>' : ''}</td>
      <td>${escapeHtml(windowLabel(w.name))}</td>
      <td class="budget-used">${escapeHtml(used)}</td>
      <td>${escapeHtml(spent)}</td>
      <td class="budget-left">${escapeHtml(left)}</td>
      <td>${escapeHtml(reset)}</td>
    </tr>`;
  }));
  const harnesses = view.harnesses.map((h) => `<tr data-harness="${escapeHtml(h.harness)}">
      <td>${escapeHtml(h.harness)}</td>
      <td>${h.turns}</td>
      <td>${escapeHtml(formatTokens(h.tokens))}</td>
      <td>${h.typicalTurnTokens === null ? '—' : escapeHtml(formatTokens(h.typicalTurnTokens))}</td>
      <td>${h.budget === 'percent' ? 'window reading' : 'tokens only — no budget'}</td>
    </tr>`);
  return `
    <div class="detail-section" id="token-budget">
      <h2>Token budget</h2>
      ${windows.length ? `<table class="table budget-windows">
        <thead><tr><th>Credential</th><th>Window</th><th>Used</th><th>Spent in window</th><th>Left (estimate)</th><th>Resets</th></tr></thead>
        <tbody>${windows.join('')}</tbody>
      </table>` : '<p class="text-muted">No usage-limit readings yet — they appear after the next proxied request.</p>'}
      ${harnesses.length ? `<h3>Last 7 days by harness</h3>
      <table class="table budget-harnesses">
        <thead><tr><th>Harness</th><th>Turns</th><th>Tokens</th><th>Typical turn</th><th>Budget</th></tr></thead>
        <tbody>${harnesses.join('')}</tbody>
      </table>` : ''}
      ${view.days.some((d) => d.turns > 0) ? `<h3>Last 7 days by day</h3>
      <table class="table budget-days">
        <thead><tr><th>Day (UTC)</th><th>Turns</th><th>Tokens</th><th>By harness</th></tr></thead>
        <tbody>${view.days.map((d) => `<tr data-day="${escapeHtml(d.date)}">
          <td>${escapeHtml(d.date)}</td><td>${d.turns}</td><td>${escapeHtml(formatTokens(d.tokens))}</td>
          <td>${escapeHtml(Object.entries(d.byHarness).map(([h, n]) => `${h} ${formatTokens(n)}`).join(', '))}</td>
        </tr>`).join('')}</tbody>
      </table>` : ''}
      ${view.tasks.length ? `<h3>Top tasks, last 7 days</h3>
      <table class="table budget-tasks">
        <thead><tr><th>Task</th><th>Turns</th><th>Tokens</th><th>Harnesses</th></tr></thead>
        <tbody>${view.tasks.map((t) => `<tr data-task="${escapeHtml(t.taskId)}">
          <td>${escapeHtml(t.code ?? t.taskId.slice(0, 8))}</td><td>${t.turns}</td><td>${escapeHtml(formatTokens(t.tokens))}</td>
          <td>${escapeHtml(t.harnesses.join(', '))}</td>
        </tr>`).join('')}</tbody>
      </table>` : ''}
      <p class="text-muted">Estimates extrapolate the provider's percentage from tokens lazy saw spent in the window. Full detail: <code>lazy stats budget</code>.</p>
    </div>
  `;
}
