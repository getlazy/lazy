/**
 * `lazy stats limits` — the latest usage-limit reading per credential.
 *
 * The proxy records the rate-limit / utilization headers every model API
 * response carries (src/proxy/usage-limits.ts); the daemon keeps the latest
 * reading per credential and answers the `usageLimits` RPC. This command is
 * only its reader. Read-only, like every `stats` subcommand.
 */
import { parseFlags } from '../helpers';
import { queryTokenBudget, queryUsageLimits, queryUsagePause } from '../../daemon/rpc-fallback';
import { attachBudget } from '../../usage-pause/budget-view';
import { describeNoReading, type UsagePauseCoverage } from '../../daemon/usage-pause';
import {
  describeOverage,
  describeReadingsStoreError,
  describeUsagePause,
  overageStatusOf,
  windowResetSince,
  type UsagePauseVerdict,
} from '../../usage-pause/policy';
import { projectUsageLimits, UsageLimitsUnreadableError } from '../../usage-pause/limits-view';
import { theme, dim } from '../../render/theme';
import type { UsageLimitReading, UsageWindow } from '../../proxy/usage-limits';

function ago(ts: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/**
 * One window line. A window that has reset since its reading (the same
 * `windowResetSince` the pause skips it by) is shown as reset, with the old
 * figure only as history — never as today's usage.
 */
export function renderUsageWindow(w: UsageWindow, readingTs: number, now: number): string {
  const used = w.usedPercent === null ? '?' : `${w.usedPercent}%`;
  const resetSince = windowResetSince(w, readingTs, now);
  if (resetSince !== null) {
    // INVARIANT: a window past its reset is never shown as a current reading —
    // the old percentage would read as "100% used" of a window that is empty now.
    const when = w.resetsAt !== null ? `reset at ${new Date(resetSince).toLocaleString()}` : 'reading aged out';
    return `${w.name.padEnd(16)} ${theme.warning(when)}` +
      dim(` (was ${w.usedPercent === null && w.status ? w.status : `${used} used`}, read ${ago(readingTs, now)}); the next request brings a fresh reading`);
  }
  const parts = [`${w.name.padEnd(16)} ${used.padStart(6)} used`];
  if (w.status) parts.push(w.status);
  if (w.resetsAt !== null) parts.push(`resets ${new Date(w.resetsAt).toLocaleString()}`);
  return parts.join(dim('  ·  '));
}

function renderReading(
  r: UsageLimitReading,
  paused: UsagePauseVerdict | undefined,
  coverage: UsagePauseCoverage | undefined,
  now: number,
): void {
  console.log(
    `${theme.label(r.credential)}  ` +
      dim(`${ago(r.ts, now)} · HTTP ${r.status ?? '-'} · ${r.backend} ${r.upstream}` +
        (r.taskId ? ` · task ${r.taskId}` : '')),
  );
  // Raw headers only when nothing was interpreted; --json always has them.
  if (r.windows.length === 0) {
    for (const [k, v] of Object.entries(r.headers)) console.log(`  ${dim(k)} ${v}`);
  }
  for (const w of r.windows) console.log(`  ${renderUsageWindow(w, r.ts, now)}`);
  if (paused) console.log(`  ${theme.warning('PAUSED:')} new turns on it wait — ${describeUsagePause(paused)}`);
  // Whether spending past 100% would cost money here — said plainly either way.
  const overage = overageStatusOf(r);
  if (overage) {
    const line = describeOverage(r.credential, overage);
    console.log(`  ${overage.status === 'allowed' ? theme.warning('OVERAGE:') : theme.label('Overage:')} ${line}`);
  }
  if (coverage?.coverage === 'none') console.log(`  ${theme.warning('ARMED, NO READING:')} ${describeNoReading(coverage)}`);
}

export async function commandLimits(args: string[]): Promise<void> {
  const parsed = parseFlags(
    args,
    [
      { name: 'json', takesValue: false },
    ],
    'stats limits',
  );
  const { readings } = await queryUsageLimits();
  // Which of them [usage_pause] is holding, and which it is armed for but
  // cannot act on — the daemon's answer, so these lines and the launch gate
  // cannot disagree.
  const pause = await queryUsagePause();
  const { paused, coverage, storeError } = pause;
  if (parsed.flags.get('json') === true) {
    // The same projection lazy_usage_limits returns over MCP — and the same
    // refusal while the saved readings cannot be read.
    let view;
    try {
      view = projectUsageLimits(readings, pause);
    } catch (err) {
      if (!(err instanceof UsageLimitsUnreadableError)) throw err;
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    // With its budget, exactly as lazy_usage_limits returns it (attachBudget).
    console.log(JSON.stringify(await attachBudget(view, queryTokenBudget), null, 2));
    return;
  }
  // Said first: while it stands the readings below may be missing the one that matters.
  if (storeError) console.log(`${theme.warning('SAVED READINGS UNREADABLE:')} ${describeReadingsStoreError(storeError)}\n`);
  const now = Date.now();
  // Armed credentials with no reading at all have no reading to hang the
  // warning on, so they are listed on their own.
  const unread = (coverage ?? []).filter(
    (c) => c.coverage === 'none' && !readings.some((r) => r.credential === c.credential),
  );
  for (const c of unread) {
    console.log(`${theme.label(c.credential)}  ${dim('no reading')}`);
    console.log(`  ${theme.warning('ARMED, NO READING:')} ${describeNoReading(c)}`);
  }
  if (readings.length === 0) {
    if (unread.length === 0 && !storeError) {
      console.log('No usage-limit readings yet. The proxy records them from model API responses;');
      console.log('they appear after the next proxied request.');
    }
    return;
  }
  for (const r of readings) {
    renderReading(
      r,
      paused.find((p) => p.credential === r.credential),
      (coverage ?? []).find((c) => c.credential === r.credential),
      now,
    );
  }
}

export function limitsUsage(): void {
  console.log(`Usage: lazy stats limits [--json]

The latest usage-limit reading per credential, as the lazy proxy saw it on
model API responses: subscription utilization (5-hour and 7-day windows),
API-key rate-limit headroom, and retry-after on refusals. Credentials are
named by who owns them or the variable they come from — never by value.
A credential [usage_pause] in lazy.toml is currently holding is marked PAUSED;
one it is armed for but cannot read a subscription window from is marked
ARMED, NO READING; a window that has reset since its reading is shown as
"reset at <time>" with its old percentage only as history.

Options:
  --json   Machine-readable: { scope, readings, pause, budget } — every reading with
           its raw headers, windows, overage status and pause verdict, plus
           the [usage_pause] thresholds, override, held tasks and coverage
           (which credentials it is armed for with no reading). Refuses, naming
           the file, while lazy cannot read its saved readings. "budget" is
           the view "lazy stats budget" shows (null with "budgetError" when it
           cannot be built)`);
}
