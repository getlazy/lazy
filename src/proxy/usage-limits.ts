/**
 * Usage-limit signals — the rate-limit / utilization response headers model
 * APIs send, captured per credential.
 *
 * WHAT IS CAPTURED: only headers whose NAME matches the allowlist below. The
 * proxy never dumps a response's headers wholesale — a response can carry
 * cookies, request ids and organization ids, none of which belong in a log a
 * human pastes into a bug report. Values are additionally length-capped and
 * refused when they look like a secret, as insurance against an upstream
 * that ever puts one under an allowlisted name.
 *
 * WHO IT IS ATTRIBUTED TO: a credential KEY that lazy already resolves and
 * that is never the secret itself — the per-user owner (`user:<id>`), the
 * target credential's label (`credential:<ENV_VAR name>`), or, for traffic
 * that arrived carrying its own credential, the upstream origin
 * (`upstream:<origin>`).
 *
 * The latest reading per credential is held in the daemon's memory by
 * `UsageLimitTracker`, fed from the audit queue's tap, written through to
 * Storage and seeded back from it (and from the bounded audit log) the first
 * time it is read, so a daemon restart does not blank it
 * (src/daemon/usage-readings.ts). No pausing decision is made here; this is
 * the data only.
 *
 * Research and header meanings: docs/spikes/usage-limit-signals.md.
 */

import type { ProxyAuditRecord, StoredUsageLimitReading } from '../storage/types';

/**
 * Header-name allowlist (lower-case, matched against the lower-cased name).
 *
 *  - `anthropic-ratelimit-*` — the documented API-key family (requests/tokens/
 *    input-tokens/output-tokens × limit/remaining/reset) AND the subscription
 *    `anthropic-ratelimit-unified-*` family (5h / 7d utilization, status,
 *    reset, representative claim; overage variants unverified) that Claude
 *    Code's warnings come from.
 *  - `anthropic-priority-*` — documented Priority Tier limits.
 *  - `anthropic-fast-*` — documented fast-mode rate-limit status.
 *  - `retry-after` — sent with 429/529.
 *  - `x-ratelimit-*` — the OpenAI family.
 *  - `x-codex-*` — the ChatGPT-subscription usage headers Codex reads
 *    (primary/secondary used-percent and windows). Unverified until seen.
 */
export const USAGE_LIMIT_HEADER_PATTERNS: readonly RegExp[] = [
  /^anthropic-ratelimit-[a-z0-9-]+$/,
  /^anthropic-priority-[a-z0-9-]+$/,
  /^anthropic-fast-[a-z0-9-]+$/,
  /^retry-after$/,
  /^x-ratelimit-[a-z0-9-]+$/,
  /^x-codex-[a-z0-9-]+$/,
];

/** Longer than any real limit/reset/percent value; anything longer is refused. */
export const USAGE_LIMIT_VALUE_MAX_LENGTH = 128;

/**
 * A value is kept only when it is made of the characters a number, a
 * timestamp, a duration or a short status word needs — and has no run long
 * enough to be a token. That refuses a bearer token, a JWT, a cookie.
 */
const SAFE_VALUE = /^[A-Za-z0-9 .:+\-_,/=%TZ]*$/;
const TOKEN_LIKE_RUN = /[A-Za-z0-9_\-]{41,}/;
/** Well-known credential prefixes (API keys, OAuth tokens, JWTs), whatever their length. */
const SECRET_PREFIX = /(^|[^A-Za-z0-9])(sk-|eyJ)/;

export function isAllowlistedUsageLimitHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return USAGE_LIMIT_HEADER_PATTERNS.some((p) => p.test(lower));
}

function isSafeValue(value: string): boolean {
  return (
    value.length <= USAGE_LIMIT_VALUE_MAX_LENGTH &&
    SAFE_VALUE.test(value) &&
    !TOKEN_LIKE_RUN.test(value) &&
    !SECRET_PREFIX.test(value)
  );
}

/**
 * The allowlisted usage-limit headers of one response, lower-cased names,
 * sorted for a stable record. Null when there are none.
 */
export function captureUsageLimitHeaders(headers: Headers): Record<string, string> | null {
  const out: Record<string, string> = {};
  const names: string[] = [];
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (!isAllowlistedUsageLimitHeader(lower)) return;
    const trimmed = value.trim();
    if (!isSafeValue(trimmed)) return;
    out[lower] = trimmed;
    names.push(lower);
  });
  if (names.length === 0) return null;
  const sorted: Record<string, string> = {};
  for (const n of names.sort()) sorted[n] = out[n];
  return sorted;
}

/**
 * The key a reading is filed under. Built only from things lazy resolves
 * itself — never from the credential value.
 */
export function usageLimitCredentialKey(opts: {
  userId?: string | null;
  credentialLabel?: string | null;
  upstream: string;
}): string {
  if (opts.userId) return `user:${opts.userId}`;
  if (opts.credentialLabel) return `credential:${opts.credentialLabel}`;
  let origin = opts.upstream;
  try {
    origin = new URL(opts.upstream).origin;
  } catch {
    // Not a URL (a test double, a misconfigured upstream): the raw string is
    // still a non-secret identifier, and `upstream` is already scrubbed of
    // credentials at append (redactAuditRecordContent).
  }
  return `upstream:${origin}`;
}

/** The latest usage-limit reading for one credential. */
export interface UsageLimitReading extends StoredUsageLimitReading {
  /** The headers interpreted as usage windows (see `usageWindows`). */
  windows: UsageWindow[];
}

/**
 * Told about every reading the tracker takes and every credential it sees
 * spend — the daemon's durable recorder (src/daemon/usage-readings.ts). Called
 * synchronously from the proxy's audit tap, so it must return at once.
 */
export interface UsageLimitListener {
  reading(reading: UsageLimitReading): void;
  /** Traffic lazy billed to `credential` whose response carried no usage headers. */
  seen(credential: string, ts: number, record: ProxyAuditRecord): void;
}

/** Latest-reading-per-credential view. */
export class UsageLimitTracker {
  private readonly latest = new Map<string, UsageLimitReading>();
  /** Credential → last time lazy billed traffic to it (unix ms), with or without a reading. */
  private readonly spent = new Map<string, number>();
  /** Credential → the upstream origins it was billed on. */
  private readonly spentVia = new Map<string, Set<string>>();
  private listener: UsageLimitListener | null = null;

  /** Attach (or detach, with null) the recorder that keeps readings durable. */
  setListener(listener: UsageLimitListener | null): void {
    this.listener = listener;
  }

  /**
   * Fold one audit record in: its own response's reading and, after a
   * failover, the primary's discarded one. Older readings never overwrite
   * newer ones.
   */
  observe(record: ProxyAuditRecord): void {
    const rr = record.reroute;
    if (rr?.fromUsageLimitHeaders && rr.fromCredential) {
      this.observeReading({
        credential: rr.fromCredential,
        ts: record.ts,
        upstream: rr.fromUpstream,
        backend: record.backend,
        status: rr.fromStatus ?? null,
        taskId: record.taskId,
        model: rr.fromModel,
        headers: rr.fromUsageLimitHeaders,
      });
    }
    const headers = record.usageLimitHeaders;
    if (!headers) {
      // Traffic on a credential LAZY resolved (a per-user owner, or a target
      // credential) that came back with no usage headers. Remembered, because
      // "armed but no reading" is the state in which pausing silently does
      // nothing (src/daemon/usage-pause.ts, `usagePauseCoverage`).
      const lazyCredential = record.credential
        ?? (record.userId ? usageLimitCredentialKey({ userId: record.userId, upstream: record.upstream }) : null);
      if (lazyCredential) this.observeSpend(lazyCredential, record.ts, record);
      return;
    }
    this.observeReading({
      credential:
        record.credential ?? usageLimitCredentialKey({ userId: record.userId, upstream: record.upstream }),
      ts: record.ts,
      upstream: record.upstream,
      backend: record.backend,
      status: record.status,
      taskId: record.taskId,
      model: record.model,
      headers,
    });
  }

  private observeSpend(credential: string, ts: number, record: ProxyAuditRecord | null, upstream?: string): void {
    const before = this.spent.get(credential);
    if (before === undefined || before < ts) this.spent.set(credential, ts);
    // WHERE it was spent, as an origin: a credential spent only on an upstream
    // no usage-sourced harness uses (cursor's, a local ollama's) is never
    // "armed, no reading" (src/daemon/usage-pause.ts, `usagePauseCoverage`).
    const via = upstreamOrigin(record?.upstream ?? upstream);
    if (via) {
      const set = this.spentVia.get(credential) ?? new Set<string>();
      set.add(via);
      this.spentVia.set(credential, set);
    }
    if (record && before === undefined) this.listener?.seen(credential, ts, record);
  }

  /** The upstream origins lazy billed `credential` on (empty when unknown). */
  spentUpstreams(credential: string): string[] {
    return [...(this.spentVia.get(credential) ?? [])];
  }

  /** Record one reading directly (a response that never becomes its own audit record). */
  observeReading(reading: StoredUsageLimitReading): void {
    if (Object.keys(reading.headers).length === 0) return;
    this.observeSpend(reading.credential, reading.ts, null, reading.upstream);
    const existing = this.latest.get(reading.credential);
    if (existing && existing.ts > reading.ts) return;
    const next: UsageLimitReading = {
      ...reading,
      headers: { ...reading.headers },
      windows: usageWindows(reading.headers, reading.ts),
    };
    this.latest.set(reading.credential, next);
    this.listener?.reading(next);
  }

  /**
   * Fold in readings saved to Storage (a daemon restart). Never reported to
   * the listener — they came FROM it.
   *
   * INVARIANT: a record with no headers only marks the credential as having
   * spent — it never displaces a reading, whatever its time or its order in
   * `stored` (the same rule the store applies, src/storage/usage-limit-readings.ts).
   */
  seed(stored: StoredUsageLimitReading[]): void {
    this.quietly(() => {
      for (const r of stored) {
        if (Object.keys(r.headers ?? {}).length > 0) this.observeReading(r);
        this.observeSpend(r.credential, Math.max(r.ts, r.spentAt ?? 0), null, r.upstream);
      }
    });
  }

  /** Run `fn` with the listener detached (a bulk fold the caller reports once itself). */
  quietly(fn: () => void): void {
    const listener = this.listener;
    this.listener = null;
    try {
      fn();
    } finally {
      this.listener = listener;
    }
  }

  /** Readings, most recent first. */
  readings(): UsageLimitReading[] {
    return [...this.latest.values()].sort((a, b) => b.ts - a.ts);
  }

  /** Every credential lazy has billed traffic to, with the last time (unix ms). */
  spentCredentials(): Map<string, number> {
    return new Map(this.spent);
  }

  /** Test-only: forget every reading and spend, as a daemon restart would. */
  resetForTest(): void {
    this.latest.clear();
    this.spent.clear();
    this.spentVia.clear();
  }
}

/**
 * One usage window, normalised across harnesses: how much of it is used, as a
 * percentage, and when it resets. This is the shape the pausing work consumes;
 * see docs/spikes/usage-limit-signals.md for which headers feed each kind.
 */
export interface UsageWindow {
  /** e.g. `unified-5h`, `unified-7d`, `tokens`, `requests`, `codex-primary`. */
  name: string;
  /** 0–100, or null when the headers give no way to compute it. */
  usedPercent: number | null;
  /** Unix ms, or null when unknown / not absolute. */
  resetsAt: number | null;
  /** The upstream's own status word, when it sends one (allowed / allowed_warning / rejected). */
  status: string | null;
}

function num(v: string | undefined): number | null {
  if (v === undefined || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Derive usage windows from one reading's headers. `ts` (the reading's time)
 * anchors relative resets. Unknown headers are simply not interpreted — the raw
 * values stay on the reading.
 *
 * THE ONE HEADER → PERCENT MAPPING. Usage pausing ([usage_pause],
 * src/usage-pause/policy.ts) acts on these windows and reads no header itself.
 * The Claude subscription family (`anthropic-ratelimit-unified-*`) matches a
 * real capture (2026-09-24, docs/spikes/usage-limit-signals.md "Seen"); the
 * Codex family (`x-codex-*`) is still UNVERIFIED, built from public reports. If
 * a real capture differs, correct it here and only here.
 */
export function usageWindows(headers: Record<string, string>, ts: number): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const name of Object.keys(headers)) {
    // Subscription (Claude.ai OAuth): utilization is a 0–1 fraction, reset is epoch seconds.
    let m = /^anthropic-ratelimit-unified-(.+)-utilization$/.exec(name);
    if (m) {
      const w = m[1];
      const frac = num(headers[name]);
      const reset = num(headers[`anthropic-ratelimit-unified-${w}-reset`]);
      windows.push({
        name: `unified-${w}`,
        usedPercent: frac === null ? null : round1(frac * 100),
        resetsAt: reset === null ? null : reset * 1000,
        status: headers[`anthropic-ratelimit-unified-${w}-status`] ?? null,
      });
      continue;
    }
    // Subscription STATUS with no utilization beside it: a per-window
    // `unified-<w>-status`, or the overall `unified-status` (reset in
    // `unified-reset`). A `rejected` here means the provider already refuses the
    // credential, which must pause whether or not a percentage came with it —
    // so it becomes a window of its own, with no percentage. `overage` is not a
    // usage window: its status says whether paid overage is available, and a
    // `rejected` there (overage off) is no reason to stop anything.
    m = /^anthropic-ratelimit-unified-(?:(.+)-)?status$/.exec(name);
    if (m) {
      const w = m[1];
      if (w !== undefined && (w.includes('overage') || headers[`anthropic-ratelimit-unified-${w}-utilization`] !== undefined)) {
        continue;
      }
      const prefix = w === undefined ? 'anthropic-ratelimit-unified' : `anthropic-ratelimit-unified-${w}`;
      const reset = num(headers[`${prefix}-reset`]);
      windows.push({
        name: w === undefined ? 'unified' : `unified-${w}`,
        usedPercent: null,
        resetsAt: reset === null ? null : reset * 1000,
        status: headers[name] ?? null,
      });
      continue;
    }
    // API key: limit/remaining pairs, reset is RFC 3339.
    m = /^anthropic-ratelimit-(requests|tokens|input-tokens|output-tokens)-limit$/.exec(name);
    if (m) {
      const k = m[1];
      const limit = num(headers[name]);
      const remaining = num(headers[`anthropic-ratelimit-${k}-remaining`]);
      const reset = Date.parse(headers[`anthropic-ratelimit-${k}-reset`] ?? '');
      windows.push({
        name: k,
        usedPercent: limit && remaining !== null ? round1(((limit - remaining) / limit) * 100) : null,
        resetsAt: Number.isFinite(reset) ? reset : null,
        status: null,
      });
      continue;
    }
    // OpenAI API: limit/remaining pairs; reset is a duration ("6m0s"), left raw.
    m = /^x-ratelimit-limit-(requests|tokens)$/.exec(name);
    if (m) {
      const k = m[1];
      const limit = num(headers[name]);
      const remaining = num(headers[`x-ratelimit-remaining-${k}`]);
      windows.push({
        name: `openai-${k}`,
        usedPercent: limit && remaining !== null ? round1(((limit - remaining) / limit) * 100) : null,
        resetsAt: null,
        status: null,
      });
      continue;
    }
    // Codex / ChatGPT subscription (unverified): used-percent is already 0–100.
    m = /^x-codex-(primary|secondary)-used-percent$/.exec(name);
    if (m) {
      const k = m[1];
      const used = num(headers[name]);
      const after = num(headers[`x-codex-${k}-reset-after-seconds`]);
      // Seen both ways in the wild: a countdown, or an absolute epoch-seconds reset.
      const at = num(headers[`x-codex-${k}-reset-at`]);
      windows.push({
        name: `codex-${k}`,
        usedPercent: used,
        resetsAt: after !== null ? ts + after * 1000 : at !== null ? at * 1000 : null,
        status: null,
      });
    }
  }
  return windows.sort((x, y) => x.name.localeCompare(y.name));
}

/** Fold a list of audit records into the latest reading per credential. */
export function foldUsageLimits(records: ProxyAuditRecord[]): UsageLimitReading[] {
  const tracker = new UsageLimitTracker();
  for (const r of records) tracker.observe(r);
  return tracker.readings();
}

/**
 * The daemon-wide tracker. Lives in the daemon process: every proxy the daemon
 * constructs feeds it through its audit tap, and the `usageLimits` RPC reads
 * it. It is seeded once per process, on first read, from the readings saved to
 * Storage and from the bounded audit log (src/daemon/usage-readings.ts), so a
 * restarted daemon still answers.
 */
export const daemonUsageLimits = new UsageLimitTracker();

/** An upstream URL's origin, or the raw string when it is not a URL; null when empty. */
export function upstreamOrigin(upstream: string | null | undefined): string | null {
  if (!upstream) return null;
  try {
    return new URL(upstream).origin;
  } catch {
    // A test double or a misconfigured upstream: the raw string still names it.
    return upstream;
  }
}
