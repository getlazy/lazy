/**
 * The records lazy leaves on a task whose RUNNING turn it stopped for spend —
 * because the credential's usage window crossed `[usage_pause]`, or because
 * the task reached its own token cap — and the one wording every surface shows
 * for them (`lazy show`, the task page, Lazy Teams, `lazy doctor`,
 * `lazy_usage_limits`).
 *
 * Pure: no daemon state, no I/O. Written and cleared only by
 * src/daemon/running-turn-stop.ts.
 */

import { windowLabel, type UsagePauseVerdict } from './policy';

/** Task metadata: a turn stopped because its credential's window crossed the threshold. */
export const USAGE_PAUSE_STOPPED_KEY = 'usage_pause_stopped';
/** Task metadata: the task's own token cap (a positive integer, as text). */
export const TOKEN_CAP_KEY = 'token_cap';
/** Task metadata: a turn stopped because the task reached its token cap. */
export const TOKEN_CAP_STOPPED_KEY = 'token_cap_stopped';

/** A turn stopped for usage. Resumes by itself once the window resets. */
export interface UsagePauseStop extends UsagePauseVerdict {
  /** When the turn was stopped (unix ms). */
  stoppedAt: number;
  /** The supervisor command the stopped turn ran under, when known. */
  commandId: string | null;
}

/** A turn stopped at the task's token cap. Never resumes by itself. */
export interface TokenCapStop {
  cap: number;
  spent: number;
  stoppedAt: number;
  commandId: string | null;
}

function parseJson<T>(raw: string | null | undefined, ok: (v: T) => boolean): T | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as T;
    return v && ok(v) ? v : null;
  } catch {
    // Only lazy writes these keys; a record that no longer parses explains
    // nothing, and the next stop or launch rewrites or clears it.
    return null;
  }
}

type WithMetadata = { metadata?: Record<string, string> | null };

export function usagePauseStopOf(task: WithMetadata): UsagePauseStop | null {
  return parseJson<UsagePauseStop>(task.metadata?.[USAGE_PAUSE_STOPPED_KEY], (v) => typeof v.credential === 'string');
}

export function tokenCapStopOf(task: WithMetadata): TokenCapStop | null {
  return parseJson<TokenCapStop>(task.metadata?.[TOKEN_CAP_STOPPED_KEY], (v) => typeof v.cap === 'number');
}

/** The task's token cap, or null when it has none. */
export function tokenCapOf(task: WithMetadata): number | null {
  const raw = task.metadata?.[TOKEN_CAP_KEY];
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * Parse a token count as people write it: `50M`, `1.5m`, `200k`, `2B`,
 * `50000000`, `50_000_000`. `none` / `off` / `0` clear the cap (null).
 * Throws with a message naming the value on anything else.
 */
export function parseTokenCap(value: string | number): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid token cap: ${value}. Use a positive count like 50M, or "none".`);
    return value === 0 ? null : Math.floor(value);
  }
  const s = value.trim().toLowerCase().replace(/[_,]/g, '');
  if (s === 'none' || s === 'off' || s === '0' || s === '') return null;
  const m = /^(\d+(?:\.\d+)?)([kmb])?$/.exec(s);
  if (!m) throw new Error(`Invalid token cap: "${value}". Use a count like 50M, 200k or 50000000, or "none" to clear it.`);
  const mult = m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : m[2] === 'b' ? 1e9 : 1;
  const n = Math.floor(Number(m[1]) * mult);
  if (n <= 0) throw new Error(`Invalid token cap: "${value}". Use a positive count, or "none" to clear it.`);
  return n;
}

/** `50M`, `1.2M`, `350k`, `900`. */
export function formatTokenCount(n: number): string {
  const fmt = (v: number, unit: string) => `${Number(v.toFixed(v >= 100 ? 0 : 1))}${unit}`;
  if (n >= 1e9) return fmt(n / 1e9, 'B');
  if (n >= 1e6) return fmt(n / 1e6, 'M');
  if (n >= 1e3) return fmt(n / 1e3, 'k');
  return String(Math.round(n));
}

/** "Tue 09:00" in UTC, plus the ISO time for anything that wants it exact. */
function resetLabel(ms: number): string {
  const d = new Date(ms);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${day} ${hh}:${mm} UTC`;
}

/** "Paused for usage: 7-day window at 95%, resumes Tue 09:00 UTC". */
export function describeUsagePauseStop(s: UsagePauseStop): string {
  const reading = s.usedPercent === null ? (s.status ?? 'over its limit') : `${s.usedPercent}%`;
  const resumes = s.resetsAt === null ? 'resumes after a fresh reading' : `resumes ${resetLabel(s.resetsAt)}`;
  return `Paused for usage: ${windowLabel(s.window)} at ${reading}, ${resumes}`;
}

/** "Stopped at its token cap (50M of 50M)". */
export function describeTokenCapStop(s: { cap: number; spent: number }): string {
  return `Stopped at its token cap (${formatTokenCount(s.spent)} of ${formatTokenCount(s.cap)})`;
}

/** "12M of 50M token cap". */
export function describeTokenCapSpend(spent: number, cap: number): string {
  return `${formatTokenCount(spent)} of ${formatTokenCount(cap)} token cap`;
}

/**
 * The one line a surface shows for a task stopped for spend, or null. Only
 * while the task still rests where the stop left it — `interrupted` for usage,
 * `blocked` for the cap — so a stale record never labels a later state.
 */
export function runningStopLine(task: WithMetadata & { status: string }): string | null {
  if (task.status === 'interrupted') {
    const u = usagePauseStopOf(task);
    if (u) return describeUsagePauseStop(u);
  }
  if (task.status === 'blocked' || task.status === 'conflict') {
    const c = tokenCapStopOf(task);
    if (c) return describeTokenCapStop(c);
  }
  return null;
}

/**
 * Is `response` the ending of a turn lazy itself stopped for spend? The stop
 * writes an error response (and a dying supervisor may write its own) after it
 * has already parked the task and recorded why; handing that to the crash path
 * would relabel the stop as an agent crash and charge the circuit breaker. So
 * the reconciler's sweeps drop it, exactly as they drop a `lazy stop`'s own.
 * Matched on the stopped turn's command id where the response carries one.
 */
export function isSpendStopResponse(
  task: WithMetadata & { status: string },
  response: { status: string },
  responseCommandId: string | null | undefined,
): boolean {
  if (response.status !== 'error') return false;
  const record = task.status === 'interrupted' ? usagePauseStopOf(task) : tokenCapStopOf(task);
  if (!record) return false;
  return responseCommandId == null || record.commandId === null || responseCommandId === record.commandId;
}
