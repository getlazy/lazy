/**
 * `lazy stats budget` — the token budgets in play: per credential window, what
 * was spent in it and an estimate of what is left; per harness, task and day,
 * what was spent. The daemon's `tokenBudget` answer (src/daemon/token-budget.ts)
 * rendered; this command re-derives nothing. Read-only, like every `stats`
 * subcommand. Never money: tokens and percentages only.
 */
import { parseFlags } from '../helpers';
import { queryTokenBudget } from '../../daemon/rpc-fallback';
import { windowLabel } from '../../usage-pause/policy';
import { describeBudgetGap, formatTokens, type BudgetWindow, type TokenBudgetView } from '../../usage-pause/budget-view';
import { theme, dim } from '../../render/theme';

export function renderBudgetWindow(w: BudgetWindow): string {
  const label = windowLabel(w.name).padEnd(22);
  const used = w.usedPercent === null ? '?' : `${w.usedPercent}%`;
  const parts = [`${label} ${used.padStart(6)} used`];
  if (w.spentTokens !== null) parts.push(`${formatTokens(w.spentTokens)} tokens spent in window`);
  if (w.gap === null && w.leftTokens !== null) {
    parts.push(theme.label(`~${formatTokens(w.leftTokens)} tokens left`) +
      (w.leftTurns !== null ? ` (~${w.leftTurns} typical turns)` : ''));
  } else if (w.gap) {
    parts.push(dim(describeBudgetGap(w.gap)));
  }
  if (w.resetsAt !== null && w.resetSince === null) parts.push(`resets ${new Date(w.resetsAt).toLocaleString()}`);
  return parts.join(dim('  ·  '));
}

export function renderTokenBudget(view: TokenBudgetView): string[] {
  const out: string[] = [];
  out.push(theme.label('Credential windows'));
  if (view.credentials.length === 0) {
    out.push(dim('  No usage-limit readings yet — they appear after the next proxied request.'));
  }
  for (const c of view.credentials) {
    out.push(`  ${theme.label(c.credential)}${c.harness ? dim(` · ${c.harness}`) : ''}${c.paused ? ` ${theme.warning('PAUSED')}` : ''}`);
    if (c.windows.length === 0) out.push(dim('    no usage windows in this reading'));
    for (const w of c.windows) out.push(`    ${renderBudgetWindow(w)}`);
  }
  out.push('', theme.label('By harness (last 7 days)'));
  if (view.harnesses.length === 0) out.push(dim('  (no agent turns)'));
  for (const h of view.harnesses) {
    const typical = h.typicalTurnTokens === null ? 'no recorded usage' : `typical turn ${formatTokens(h.typicalTurnTokens)}`;
    const budget = h.budget === 'percent' ? 'window reading' : 'tokens only — no window reading, no budget shown';
    out.push(`  ${h.harness.padEnd(12)} ${formatTokens(h.tokens).padStart(7)} tokens  ${h.turns} turns` +
      (h.turnsWithUsage < h.turns ? dim(` (${h.turns - h.turnsWithUsage} without usage)`) : '') +
      dim(`  ·  ${typical}  ·  ${budget}`));
  }
  out.push('', theme.label('By day'));
  for (const d of view.days) {
    const split = Object.entries(d.byHarness).map(([h, n]) => `${h} ${formatTokens(n)}`).join(', ');
    out.push(`  ${d.date}  ${formatTokens(d.tokens).padStart(7)} tokens  ${String(d.turns).padStart(3)} turns${split ? dim(`  ·  ${split}`) : ''}`);
  }
  out.push('', theme.label('Top tasks (last 7 days)'));
  if (view.tasks.length === 0) out.push(dim('  (none)'));
  for (const t of view.tasks) {
    out.push(`  ${(t.code ?? t.taskId.slice(0, 8)).padEnd(32)} ${formatTokens(t.tokens).padStart(7)} tokens  ${t.turns} turns  ${dim(t.harnesses.join(', '))}`);
  }
  out.push('', dim('Estimates extrapolate the provider\'s own percentage from the tokens lazy saw spent in the window;'));
  out.push(dim('the provider meters by its own weights, so treat "left" as a planning figure, not a guarantee.'));
  return out;
}

export async function commandBudget(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [{ name: 'json', takesValue: false }], 'stats budget');
  // An unreadable readings store is refused by the daemon with its own message.
  const view = await queryTokenBudget();
  if (parsed.flags.get('json') === true) {
    console.log(JSON.stringify(view, null, 2));
    return;
  }
  for (const line of renderTokenBudget(view)) console.log(line);
}

export function budgetUsage(): void {
  console.log(`Usage: lazy stats budget [--json]

The token budgets in play. For each credential with a usage-limit reading:
every window's percentage used and reset, the tokens lazy saw spent on that
credential inside the window, and from those an estimate of the tokens (and
typical turns) left before the limit. Then spend over the last 7 days by
harness, by day and by task, from each turn's recorded usage.

Only windows the provider reports a percentage for get an estimate (Claude
subscriptions via their 5-hour / 7-day headers, Codex via its own). Harnesses
with no window reading — Cursor, Pi, or anything without those headers — show
spend only; no budget is invented. Tokens and percentages only, never money.

Options:
  --json   Machine-readable: the same view the lazy_usage_limits MCP tool
           carries under "budget".`);
}
