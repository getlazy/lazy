/**
 * Usage pausing, the POLICY half: given the latest usage-limit reading for a
 * credential, is a new turn on it allowed to start?
 *
 * Pure — no daemon state, no I/O — so the daemon's launch gate, `lazy doctor`
 * and `lazy stats limits` all answer from the same function and cannot
 * disagree about whether a credential is paused.
 *
 * TWO ABSTRACTIONS, deliberately separate:
 *
 *   1. HEADERS → WINDOWS is `usageWindows()` in src/proxy/usage-limits.ts, the
 *      one place a header name is turned into "N% of window W, resets at T".
 *      Nothing here reads a header.
 *   2. WINDOWS → PAUSE is per HARNESS, below: which of a reading's windows
 *      measure a subscription whose overflow costs money. Claude Code first;
 *      Codex is wired to its community-observed headers; a harness with no
 *      source never pauses (and every surface says so rather than implying a
 *      reading of 0%).
 *
 * VERIFIED for Claude by a real capture on 2026-09-24 (the spike's "Seen" table,
 * docs/spikes/usage-limit-signals.md); the Codex headers are still unverified.
 * `usageWindows()` is the one place to correct if a capture ever differs.
 */

import type { UsageLimitReading, UsageWindow } from '../proxy/usage-limits';

/** How one harness's usage signal is read for pausing. */
export interface HarnessUsageSource {
  /** Harness id, as profiles name it (`claude-code`, `codex`, …). */
  harness: string;
  /**
   * The windows of a reading that measure the SUBSCRIPTION — the ones whose
   * overflow is paid overage. Per-minute API-key rate limits refill within a
   * minute and are never a reason to pause.
   */
  pauseWindows(windows: UsageWindow[]): UsageWindow[];
}

const CLAUDE_SUBSCRIPTION: HarnessUsageSource = {
  harness: 'claude-code',
  // `unified-5h`, `unified-7d`, any other `unified-<w>` Anthropic adds, and
  // the overall `unified` status.
  // Seen in a real capture on 2026-09-24 (see the header).
  // The bare `unified` window is the overall status-only one (a `rejected` there pauses).
  pauseWindows: (windows) => windows.filter((w) => w.name === 'unified' || w.name.startsWith('unified-')),
};

const CODEX_SUBSCRIPTION: HarnessUsageSource = {
  harness: 'codex',
  // UNVERIFIED: community-observed `x-codex-*` headers only.
  pauseWindows: (windows) => windows.filter((w) => w.name.startsWith('codex-')),
};

/**
 * Harness → source. A harness that is not here (cursor, pi, qa-agent) has no
 * known usage signal and is never paused.
 */
const SOURCES: ReadonlyMap<string, HarnessUsageSource> = new Map([
  [CLAUDE_SUBSCRIPTION.harness, CLAUDE_SUBSCRIPTION],
  [CODEX_SUBSCRIPTION.harness, CODEX_SUBSCRIPTION],
]);

export function usageSourceFor(harness: string): HarnessUsageSource | null {
  return SOURCES.get(harness) ?? null;
}

/**
 * Every source's windows, for a reading whose harness is not known (a doctor
 * or stats view over a credential rather than a task). A credential carries
 * one provider's headers, so at most one source ever matches a reading.
 */
export function anySourcePauseWindows(windows: UsageWindow[]): UsageWindow[] {
  return [...SOURCES.values()].flatMap((s) => s.pauseWindows(windows));
}

/**
 * How long a tripped window with NO reset time keeps a credential paused.
 *
 * A pause stops the turns whose requests would bring a fresher reading, so a
 * window that never says when it resets could otherwise pause a credential
 * forever. Past this age the reading is treated as stale and the next turn is
 * let through — which is also what refreshes it.
 */
export const STALE_UNTIMED_READING_MS = 30 * 60_000;

/** The configured threshold for one credential: its own entry, else the global one. 0 = off. */
export function thresholdFor(
  config: { threshold_percent: number; credentials: Record<string, number> },
  credential: string,
): number {
  const own = config.credentials[credential];
  return typeof own === 'number' ? own : config.threshold_percent;
}

/** Why a credential is paused — everything a surface needs to explain it. */
export interface UsagePauseVerdict {
  credential: string;
  /** The window that holds the pause (the one that resets LAST). */
  window: string;
  usedPercent: number | null;
  /** The upstream's own status word, when it sent one. */
  status: string | null;
  threshold: number;
  /** Unix ms the pause lifts, or null when the upstream gave no reset time. */
  resetsAt: number | null;
  /** When the reading was taken (unix ms). */
  readingAt: number;
  /**
   * Set when the verdict is not a reading at all: the saved readings cannot be
   * read, so the gate refuses (fails closed) — the line to show, naming the
   * file. No override lifts it; a person fixes the file.
   */
  storeError?: string;
}

/** The window name a store-error verdict carries. */
export const STORE_ERROR_WINDOW = 'saved-readings';

/**
 * One line for saved usage readings lazy cannot read. Every surface and every
 * refusal says exactly this.
 */
export function describeReadingsStoreError(e: { path: string | null; message: string }): string {
  return (
    `saved usage readings unreadable at ${e.path ?? 'the task store'}: pausing cannot engage; ` +
    `move it aside or restore it. Until then lazy refuses every launch the pause would judge, ` +
    `because the reading it cannot see may be over the threshold. (${e.message})`
  );
}

/**
 * Is `credential` paused right now, given its latest reading?
 *
 * A window trips when its used percent is at or past `threshold`, or when the
 * upstream already says `rejected`. A window whose reset time has passed is
 * ignored: the reading predates the reset, so the window is empty now even
 * though no request has confirmed it (no request can, while paused — this is
 * what makes a pause lift by itself).
 *
 * `threshold` ≤ 0 means off. Returns null when not paused.
 */
export function evaluateUsagePause(
  reading: UsageLimitReading | null,
  pauseWindows: (windows: UsageWindow[]) => UsageWindow[],
  threshold: number,
  now: number,
): UsagePauseVerdict | null {
  if (!reading || threshold <= 0) return null;
  const tripped: UsageWindow[] = [];
  for (const w of pauseWindows(reading.windows)) {
    if (w.resetsAt !== null && w.resetsAt <= now) continue;
    if (w.resetsAt === null && now - reading.ts > STALE_UNTIMED_READING_MS) continue;
    const over = w.usedPercent !== null && w.usedPercent >= threshold;
    if (over || w.status === 'rejected') tripped.push(w);
  }
  if (tripped.length === 0) return null;
  // Every tripped window must reset before a turn may start, so the pause
  // lasts until the LATEST reset; an untimed one outlasts them all.
  const holding = tripped.reduce((a, b) =>
    a.resetsAt === null ? a : b.resetsAt === null ? b : a.resetsAt >= b.resetsAt ? a : b);
  return {
    credential: reading.credential,
    window: holding.name,
    usedPercent: holding.usedPercent,
    status: holding.status,
    threshold,
    resetsAt: holding.resetsAt,
    readingAt: reading.ts,
  };
}

/** Plain-language window name: `unified-5h` → `5-hour window`. */
export function windowLabel(name: string): string {
  if (name === 'unified') return 'overall subscription limit';
  const m = /^unified-(\d+)([hd])$/.exec(name);
  if (m) return `${m[1]}-${m[2] === 'h' ? 'hour' : 'day'} window`;
  return `${name} window`;
}

/** One sentence naming the credential, window, reading, threshold and reset. */
export function describeUsagePause(v: UsagePauseVerdict, now: number = Date.now()): string {
  if (v.storeError) return `${v.credential}: ${v.storeError}`;
  const reading = v.usedPercent === null
    ? `is ${v.status ?? 'over its limit'}`
    : `is ${v.usedPercent}% used${v.status === 'rejected' ? ' (the provider already refuses it)' : ''}`;
  const reset = v.resetsAt === null
    ? `The provider sent no reset time; lazy will try again ${Math.round(STALE_UNTIMED_READING_MS / 60_000)} minutes after the reading.`
    : `It resets at ${new Date(v.resetsAt).toISOString()} (in ${formatDuration(v.resetsAt - now)}).`;
  return (
    `${v.credential}: the ${windowLabel(v.window)} ${reading}, at or past the ` +
    `usage-pause threshold of ${v.threshold}% ([usage_pause] in lazy.toml). ${reset}`
  );
}

function formatDuration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 48) return m ? `${h}h ${m}m` : `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * What a credential's latest reading can tell the pause, whatever the
 * threshold:
 *
 *  - `reading` — it carries a subscription window the pause judges, current
 *    (not yet reset, or untimed and recent). Pausing can engage.
 *  - `stale` — it carries such windows, but every one has reset (or is untimed
 *    and too old) since the reading was taken, so today's usage is UNKNOWN.
 *    Pausing still works — the next turn brings a fresh reading — but no
 *    surface may show the old percentage as current.
 *  - `none` — there is no reading, or it has no subscription window with a
 *    percentage (an API key's per-minute limits, a bare status, headers lazy
 *    does not recognise). Pausing
 *    CANNOT engage for this credential, which every surface says loudly.
 */
export type ReadingCoverage = 'reading' | 'stale' | 'none';

export function readingCoverage(
  reading: UsageLimitReading | null,
  pauseWindows: (windows: UsageWindow[]) => UsageWindow[],
  now: number,
): ReadingCoverage {
  if (!reading) return 'none';
  // A percentage is what lets a THRESHOLD act. A status alone (`rejected`)
  // still pauses, but only once the provider already refuses — too late to
  // keep the account out of overage — so it does not count as a reading here.
  const windows = pauseWindows(reading.windows).filter((w) => w.usedPercent !== null);
  if (windows.length === 0) return 'none';
  const current = windows.some((w) =>
    w.resetsAt !== null ? w.resetsAt > now : now - reading.ts <= STALE_UNTIMED_READING_MS);
  return current ? 'reading' : 'stale';
}

/** One credential the pause is armed for, and whether its reading lets it act. */
export interface UsagePauseCoverage {
  credential: string;
  /** `none` = armed, NO READING: pausing cannot engage for this credential. */
  coverage: ReadingCoverage;
  /** When the latest reading was taken (unix ms), or null when there is none. */
  readingAt: number | null;
  /** The last time lazy billed traffic to it (unix ms), or null when unknown. */
  lastSpentAt: number | null;
  /** Paid overage on this credential, from its latest reading, or null when not reported. */
  overage?: OverageStatus | null;
}

/** One line for a credential the pause is armed for but cannot act on. */
export function describeNoReading(c: UsagePauseCoverage): string {
  return (
    `${c.credential}: armed, NO READING — pausing cannot engage. Turns spent on it ` +
    `${c.lastSpentAt ? `(last ${new Date(c.lastSpentAt).toISOString()}) ` : ''}brought back no ` +
    `subscription usage window lazy can read, so [usage_pause] lets every turn on it start. ` +
    `Check \`lazy stats limits\`: if the provider sends usage headers under names lazy does not ` +
    `recognise, pausing cannot protect this credential until lazy learns them.`
  );
}

/**
 * Whether spending past the subscription limit would cost money on a
 * credential — the Claude `anthropic-ratelimit-unified-overage-status` header,
 * seen in a real capture (2026-09-24), with its `-overage-disabled-reason`.
 *
 * A STATEMENT about the credential, never a pause input: `allowed` means paid
 * overage is on and the pause is the only thing keeping turns under the limit;
 * `rejected` means the provider stops at the limit itself. Null when the
 * reading carries no overage status.
 */
export interface OverageStatus {
  status: string;
  reason: string | null;
}

export function overageStatusOf(reading: { headers: Record<string, string> } | null | undefined): OverageStatus | null {
  const status = reading?.headers['anthropic-ratelimit-unified-overage-status'];
  if (!status) return null;
  return { status, reason: reading?.headers['anthropic-ratelimit-unified-overage-disabled-reason'] ?? null };
}

/** One plain line about a credential's overage status. */
export function describeOverage(credential: string, o: OverageStatus): string {
  if (o.status === 'allowed') {
    return `${credential}: overages ENABLED on this credential: the pause is what keeps you under.`;
  }
  if (o.status === 'rejected') {
    return `${credential}: overage is off (${o.reason ?? 'no reason given'}) — the provider stops at the limit itself.`;
  }
  return `${credential}: overage status ${o.status}${o.reason ? ` (${o.reason})` : ''}.`;
}
