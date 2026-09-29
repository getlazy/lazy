/**
 * THE ONE SHAPE of "what token budget is left": what `lazy stats budget
 * --json` prints, what `lazy_usage_limits` carries under `budget`, what the
 * dashboard's budget box and the Lazy Teams project page render. Design:
 * docs/design/token-budgets.md.
 *
 * Pure. It puts together three things the daemon already has:
 *   - the usage-limit view (src/usage-pause/limits-view.ts), ALREADY NARROWED
 *     to what the caller may see — so a credential the caller may not see has
 *     no reading here, and none of its spend is attributed below;
 *   - the proxy audit trail, the only record that names the CREDENTIAL each
 *     request spent — it answers "tokens spent in this window";
 *   - the per-turn usage in Storage, which names the HARNESS and survives
 *     audit-log rotation — it answers per harness, per task, per day, and
 *     what a typical turn costs.
 *
 * Never money: tokens and percentages only.
 */
import type { ProxyAuditRecord } from '../storage/types';
import type { TokenUsage } from '../types';
import { UNREADABLE_PREFIX, type UsageLimitsView } from './limits-view';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Nominal lookback (seven UTC days, today included) for harness / task / day spend and the typical turn. */
export const BUDGET_LOOKBACK_MS = 7 * DAY;
/**
 * Start of the lookback: midnight UTC of the oldest of the seven daily buckets,
 * so every turn counted in the harness and task totals also lands in a day.
 */
export function budgetLookbackStart(now: number): number {
  const d = new Date(now - 6 * DAY);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Below this many percent used, tokens-per-percent is too noisy to extrapolate from. */
export const MIN_PERCENT_FOR_ESTIMATE = 2;

/** One agent turn's recorded usage, as the daemon reads it out of Storage. */
export interface BudgetTurnInput {
  taskId: string;
  taskCode: string | null;
  /** Harness id (`claude-code`, `codex`, `cursor`, `pi`), or undefined = unknown. */
  agent?: string;
  timestamp: number;
  usage: TokenUsage | null;
  /**
   * The credential this turn spent, when the daemon can say so for certain,
   * else null. Only turns naming a window's own credential are ever counted
   * as that window's spend.
   */
  credential: string | null;
}

/** Why a window has no token estimate — each is said, never papered over with a guess. */
export type BudgetEstimateGap =
  /** The window reports a status but no percentage (nothing to divide by). */
  | 'no-percent'
  /** The window has reset since the reading: nothing is known until the next request. */
  | 'reset'
  /** Lazy cannot tell how long this window is, so it cannot say what "spent in it" means. */
  | 'unknown-window-length'
  /**
   * The (small, rotating) audit trail starts after the window began, and the
   * recorded turns cannot stand in because more than one visible credential
   * meters the same harness: spend in the window is not known.
   */
  | 'trail-shorter-than-window'
  /** Too little of the window is used, or no attributed spend, to extrapolate from. */
  | 'too-little-data';

export interface BudgetWindow {
  name: string;
  usedPercent: number | null;
  resetsAt: number | null;
  resetSince: number | null;
  /** Unix ms the window began, when its length is known. */
  windowStart: number | null;
  /** Tokens the audit trail attributes to this credential since `windowStart` (null: length unknown). */
  spentTokens: number | null;
  /**
   * Where `spentTokens` came from. `audit`: the proxy trail, keyed by this
   * credential and reaching back past the window's start. `turns`: the
   * recorded agent turns of the harness this window meters — used when the
   * trail is too short and this is the only visible credential metering that
   * harness; builder spend is then uncounted, so the estimate errs low.
   * Null when neither can answer.
   */
  spendSource: 'audit' | 'turns' | null;
  /** The same spend by model and by task (top 5 each). */
  byModel: Array<{ key: string; tokens: number }>;
  byTask: Array<{ key: string; tokens: number }>;
  /** spentTokens / usedPercent — null with `gap` set when not estimable. */
  tokensPerPercent: number | null;
  leftPercent: number | null;
  /** (100 − usedPercent) × tokensPerPercent. An ESTIMATE: the provider meters by its own weights. */
  leftTokens: number | null;
  /** leftTokens / typical turn of the harness this window meters. */
  leftTurns: number | null;
  gap: BudgetEstimateGap | null;
}

export interface CredentialBudget {
  credential: string;
  readingTs: number;
  /** Harness whose traffic these windows meter, when the header family says so. */
  harness: string | null;
  paused: boolean;
  windows: BudgetWindow[];
}

export interface HarnessSpend {
  /** Harness id, or `unknown` for turns recorded before the harness was. */
  harness: string;
  turns: number;
  /** Turns in the lookback that recorded usage; the rest are counted, never guessed. */
  turnsWithUsage: number;
  tokens: number;
  /** Median tokens per turn with usage, or null with none. */
  typicalTurnTokens: number | null;
  /**
   * `percent`: some visible credential reports a percentage window for this
   * harness's traffic, so a budget is shown. `tokens-only`: spend is shown and
   * no budget is invented.
   */
  budget: 'percent' | 'tokens-only';
}

export interface DaySpend {
  /** UTC date, YYYY-MM-DD. */
  date: string;
  turns: number;
  tokens: number;
  byHarness: Record<string, number>;
}

export interface TaskSpend {
  taskId: string;
  code: string | null;
  turns: number;
  tokens: number;
  harnesses: string[];
}

export interface TokenBudgetView {
  scope: UsageLimitsView['scope'];
  generatedAt: number;
  lookbackMs: number;
  credentials: CredentialBudget[];
  harnesses: HarnessSpend[];
  days: DaySpend[];
  tasks: TaskSpend[];
  /** Median tokens of every turn with usage in the lookback, any harness. */
  typicalTurnTokens: number | null;
  /** Oldest audit record read, or null for an empty trail — windows older than it are partial. */
  auditTrailSince: number | null;
}

export function turnTokens(u: TokenUsage): number {
  return u.inputTokens + u.outputTokens + u.cacheCreationTokens + u.cacheReadTokens;
}

function recordTokens(r: ProxyAuditRecord): number {
  const u = r.usage;
  return u ? (u.inputTokens ?? 0) + (u.outputTokens ?? 0) +
    (u.cacheCreationInputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) : 0;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * How long a window is, from its name or its reading's own headers. Anthropic
 * names it (`unified-5h`, `unified-7d`); Codex sends
 * `x-<family>-<primary|secondary>-window-minutes`. Anything else: unknown,
 * and the window gets no attributed spend rather than a guessed one.
 */
export function windowLengthMs(name: string, headers: Record<string, string>): number | null {
  const m = /^unified-(\d+)([hd])$/.exec(name);
  if (m) return Number(m[1]) * (m[2] === 'h' ? HOUR : DAY);
  const c = /^(codex(?:-[a-z0-9-]+?)?)-(primary|secondary)$/.exec(name);
  if (c) {
    const minutes = Number(headers[`x-${c[1]}-${c[2]}-window-minutes`]);
    if (Number.isFinite(minutes) && minutes > 0) return minutes * 60_000;
  }
  return null;
}

/** Which harness a window family meters — the header family says it, nothing else is inferred. */
export function windowHarness(name: string): string | null {
  if (name === 'unified' || name.startsWith('unified-')) return 'claude-code';
  if (name.startsWith('codex')) return 'codex';
  return null;
}

function top(map: Map<string, number>, n: number): Array<{ key: string; tokens: number }> {
  return [...map].map(([key, tokens]) => ({ key, tokens }))
    .sort((a, b) => b.tokens - a.tokens || a.key.localeCompare(b.key)).slice(0, n);
}

/**
 * INVARIANT: a budget is only ever an extrapolation of a percentage the
 * provider reported. A window with no percentage, one that has reset, one of
 * unknown length, or one whose spend the audit trail no longer fully holds,
 * gets NO token estimate and says why (`gap`) — a builder planning from an
 * invented "tokens left" would schedule work into a limit that is not there.
 * And harnesses with no percentage window (Cursor, Pi, and Codex without its
 * headers) are shown as spend only.
 */
export function projectTokenBudget(
  limits: UsageLimitsView,
  audit: ProxyAuditRecord[],
  turns: BudgetTurnInput[],
  now: number = Date.now(),
  options: { taskId?: string } = {},
): TokenBudgetView {
  const since = budgetLookbackStart(now);
  const recent = turns.filter((t) => t.timestamp >= since && t.timestamp <= now);
  const harnessOf = (t: BudgetTurnInput) => t.agent ?? 'unknown';

  const perHarness = new Map<string, BudgetTurnInput[]>();
  for (const t of recent) {
    const list = perHarness.get(harnessOf(t)) ?? [];
    list.push(t);
    perHarness.set(harnessOf(t), list);
  }
  const typicalBy = new Map<string, number | null>();
  for (const [h, list] of perHarness) {
    typicalBy.set(h, median(list.filter((t) => t.usage).map((t) => turnTokens(t.usage!))));
  }
  const typicalTurnTokens = median(recent.filter((t) => t.usage).map((t) => turnTokens(t.usage!)));

  const auditTrailSince = audit.length ? audit.reduce((m, r) => Math.min(m, r.ts), Infinity) : null;
  const percentHarnesses = new Set<string>();

  const credentials: CredentialBudget[] = limits.readings.map((r) => {
    const own = audit.filter((a) => a.credential === r.credential);
    const harnesses = new Set(r.windows.map((w) => windowHarness(w.name)).filter((h): h is string => h !== null));
    const harness = harnesses.size === 1 ? [...harnesses][0] : null;
    const windows = r.windows.map((w): BudgetWindow => {
      const len = windowLengthMs(w.name, r.headers);
      const windowStart = len === null ? null
        : w.resetsAt !== null ? w.resetsAt - len : null;
      const wh = windowHarness(w.name);
      const byModel = new Map<string, number>();
      const byTask = new Map<string, number>();
      const add = (map: Map<string, number>, key: string, n: number) => map.set(key, (map.get(key) ?? 0) + n);
      let spent = 0;
      let spendSource: BudgetWindow['spendSource'] = null;
      if (windowStart !== null && auditTrailSince !== null && auditTrailSince <= windowStart) {
        // The trail reaches back past the window's start: exact, and keyed by this credential.
        spendSource = 'audit';
        for (const a of own) {
          if (a.ts < windowStart || a.ts > now) continue;
          const n = recordTokens(a);
          spent += n;
          add(byModel, a.model ?? '(unattributed)', n);
          add(byTask, a.taskId ?? `(${a.role ?? 'unattributed'})`, n);
        }
      } else if (windowStart !== null && wh !== null) {
        // The trail is too short: use the recorded turns of this harness in
        // the window — but only if EVERY one of them names its credential.
        // One whose credential is unknown could be this window's spend or
        // another's, and counting either way would misstate the estimate.
        const inWindow = turns.filter((t) => harnessOf(t) === wh && t.timestamp >= windowStart && t.timestamp <= now);
        if (inWindow.every((t) => t.credential !== null)) {
          spendSource = 'turns';
          for (const t of inWindow) {
            if (t.credential !== r.credential || !t.usage) continue;
            const n = turnTokens(t.usage);
            spent += n;
            add(byTask, t.taskCode ?? t.taskId, n);
          }
        }
      }
      let gap: BudgetEstimateGap | null = null;
      if (w.resetSince !== null) gap = 'reset';
      else if (w.usedPercent === null) gap = 'no-percent';
      else if (windowStart === null) gap = 'unknown-window-length';
      else if (spendSource === null) gap = 'trail-shorter-than-window';
      else if (w.usedPercent < MIN_PERCENT_FOR_ESTIMATE || spent === 0) gap = 'too-little-data';
      if (w.usedPercent !== null && w.resetSince === null && wh) percentHarnesses.add(wh);
      const tokensPerPercent = gap === null ? Math.round(spent / w.usedPercent!) : null;
      const leftPercent = w.usedPercent === null || w.resetSince !== null
        ? null : Math.max(0, Math.round((100 - w.usedPercent) * 10) / 10);
      const leftTokens = tokensPerPercent === null || leftPercent === null ? null : Math.round(leftPercent * tokensPerPercent);
      const typical = (wh ? typicalBy.get(wh) : undefined) ?? typicalTurnTokens;
      return {
        name: w.name,
        usedPercent: w.usedPercent,
        resetsAt: w.resetsAt,
        resetSince: w.resetSince,
        windowStart,
        spentTokens: spendSource === null ? null : spent,
        spendSource,
        byModel: top(byModel, 5),
        byTask: top(byTask, 5),
        tokensPerPercent,
        leftPercent,
        leftTokens,
        leftTurns: leftTokens === null || !typical ? null : Math.floor(leftTokens / typical),
        gap,
      };
    });
    return { credential: r.credential, readingTs: r.ts, harness, paused: r.paused !== null, windows };
  });

  const harnessRows: HarnessSpend[] = [...perHarness].map(([harness, list]) => {
    const withUsage = list.filter((t) => t.usage);
    return {
      harness,
      turns: list.length,
      turnsWithUsage: withUsage.length,
      tokens: withUsage.reduce((n, t) => n + turnTokens(t.usage!), 0),
      typicalTurnTokens: typicalBy.get(harness) ?? null,
      budget: percentHarnesses.has(harness) ? 'percent' as const : 'tokens-only' as const,
    };
  }).sort((a, b) => b.tokens - a.tokens || a.harness.localeCompare(b.harness));

  const dayMap = new Map<string, DaySpend>();
  for (let d = 6; d >= 0; d--) {
    const date = new Date(now - d * DAY).toISOString().slice(0, 10);
    dayMap.set(date, { date, turns: 0, tokens: 0, byHarness: {} });
  }
  const taskMap = new Map<string, TaskSpend>();
  for (const t of recent) {
    const n = t.usage ? turnTokens(t.usage) : 0;
    const day = dayMap.get(new Date(t.timestamp).toISOString().slice(0, 10));
    if (day) {
      day.turns++;
      day.tokens += n;
      day.byHarness[harnessOf(t)] = (day.byHarness[harnessOf(t)] ?? 0) + n;
    }
    if (options.taskId && t.taskId !== options.taskId) continue;
    const row = taskMap.get(t.taskId) ?? { taskId: t.taskId, code: t.taskCode, turns: 0, tokens: 0, harnesses: [] };
    row.turns++;
    row.tokens += n;
    if (!row.harnesses.includes(harnessOf(t))) row.harnesses.push(harnessOf(t));
    taskMap.set(t.taskId, row);
  }

  return {
    scope: limits.scope,
    generatedAt: now,
    lookbackMs: BUDGET_LOOKBACK_MS,
    credentials,
    harnesses: harnessRows,
    days: [...dayMap.values()],
    tasks: [...taskMap.values()].sort((a, b) => b.tokens - a.tokens || a.taskId.localeCompare(b.taskId)).slice(0, 10),
    typicalTurnTokens,
    auditTrailSince,
  };
}

/** Plain words for a gap — the CLI, dashboard and prompt guidance all use these. */
export function describeBudgetGap(gap: BudgetEstimateGap): string {
  switch (gap) {
    case 'no-percent': return 'no percentage reported, so no token estimate';
    case 'reset': return 'window has reset; the next request brings a fresh reading';
    case 'unknown-window-length': return 'window length unknown, so spend in it cannot be counted';
    case 'trail-shorter-than-window': return 'spend in this window is no longer on record, so no estimate';
    case 'too-little-data': return 'too little of the window used to extrapolate from';
  }
}

/** Compact token count: 1234 → 1.2k, 3_400_000 → 3.4M. */
export function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/**
 * A usage-limits view with its `budget` attached — what `lazy stats limits
 * --json` and `lazy_usage_limits` both return, so the two keep one shape.
 *
 * INVARIANT: a budget that cannot be built never takes the readings down with
 * it. Any failure other than the unreadable-readings refusal (which the limits
 * view itself makes, and which must stay loud) yields `budget: null` with the
 * reason in `budgetError`, and the readings and pause state still arrive.
 */
export async function attachBudget<V extends object>(
  view: V,
  load: () => Promise<TokenBudgetView>,
): Promise<V & { budget: TokenBudgetView | null; budgetError?: string }> {
  try {
    return { ...view, budget: await load() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith(UNREADABLE_PREFIX)) throw err;
    return { ...view, budget: null, budgetError: `The token budget could not be built: ${message}` };
  }
}
