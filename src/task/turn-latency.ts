/**
 * Durable per-turn latency rollups: how fast each endpoint × model answered a
 * turn, kept in the store so providers and models can be compared over any
 * period — the proxy audit trail (src/proxy/audit-log.ts) is disposable and
 * rotates away after `[proxy] audit_retention_days`.
 *
 * SHAPE. One rollup per turn, one entry per endpoint × model × tier (a tier
 * is keyed by its tiered PROFILE and position, as `lazy stats audit --summary`
 * keys it — tier 1 of two different profiles is two different things). Each
 * timing (TTFB, TTFT, TTLT — all from request start) and the throughput is a
 * {@link LatencyHistogram}: count, sum, min, max, sum of squares and a compact
 * log-scale bucket run. Histograms MERGE EXACTLY (add the buckets), so any set
 * of turns, tasks or endpoints rolls up to the same answer whatever order it
 * is combined in; per-turn percentiles could not be combined at all.
 *
 * ACCURACY. 40 buckets span each scale with a constant ratio (≈1.35× for
 * time, ≈1.33× for throughput); a percentile is reported as the bucket's
 * geometric midpoint, clamped to the observed min/max, so it is within about
 * ±16% of the true value (sqrt(1.354) − 1). The engineer asked for ±15%-ish,
 * not finer buckets.
 *
 * WHAT COUNTS (classifyAudit). Only inference endpoints (messages,
 * chat_completions, responses) on a task; count_tokens, the cursor passthrough
 * (its wire carries no model or usage) and builder traffic are not
 * requests here — including the builder one-shots that run FOR a task
 * (accept-time summaries, link descriptions) and so carry its id: they are not
 * the task's turns, and nothing would ever close them. A TIERED attempt the proxy refused for capacity and re-sent
 * on the next tier is a RETRY of its tier's entry, never a request or an
 * error — the re-sent request is audited separately and counted once. A
 * request lazy refused itself (`authDenial`) never left the machine and is
 * ignored. Failover attempts inside one request (`reroute.attempts`) add
 * retries to the entry that finally served it.
 *
 * Zero imports beyond types on purpose: FileStorage, the proxy and every
 * surface read it.
 */

import type { ProxyAuditRecord } from '../storage/types';

/**
 * One log-scale histogram. `buckets` is a DENSE run of counts starting at
 * bucket index `first` (-1 is under the scale, n over it) — only the span a
 * turn actually touched, which keeps it to a few dozen bytes.
 */
export interface LatencyHistogram {
  count: number;
  sum: number;
  min: number | null;
  max: number | null;
  /** Sum of squares, for a standard deviation. Stored, not shown by default. */
  sumsq: number;
  first: number | null;
  buckets: number[];
}

export interface LatencyErrors {
  /** HTTP 429. */
  rate_limited: number;
  /** Any other 4xx. */
  client_error: number;
  /** 5xx. */
  server_error: number;
  /** No response at all: the forward failed, timed out or could not connect. */
  network: number;
  /** A 2xx stream the client cancelled or that broke before its end. */
  cancelled: number;
}

export interface LatencyRollupEntry {
  /** The named `[endpoints.<name>]` that served it, else the upstream origin. */
  endpoint: string;
  /** Wire model; `(unattributed)` when the request named none. */
  model: string;
  /** Tier position (0-based) for a tiered profile, else null. */
  tier: number | null;
  /** The tiered profile that tier belongs to; null when untiered (and on entries stored before it was recorded). */
  profile?: string | null;
  /** Requests counted (retries excluded). */
  requests: number;
  errors: LatencyErrors;
  /** Attempts that were re-sent: tier capacity refusals and failover attempts. */
  retries: number;
  tokens: { input: number; output: number; cache_read: number; cache_write: number };
  ttfb: LatencyHistogram;
  ttft: LatencyHistogram;
  ttlt: LatencyHistogram;
  /** Output tokens per second over the whole request (÷ TTLT from request start). */
  tps: LatencyHistogram;
  /** Successful requests whose throughput could not be measured (no output, or TTLT under the floor). */
  tps_unmeasurable: number;
}

/** The running (or closed) rollup of one turn. */
export interface TurnLatencyRollup {
  version: 1;
  /** Oldest / newest request folded in (unix ms). */
  first_ts: number | null;
  last_ts: number | null;
  /** Times consecutive requests moved to a different endpoint × model × tier. */
  tier_switches: number;
  /** Endpoint × model × tier key of the first / last counted request (switch detection across merged deltas). */
  first_key: string | null;
  last_key: string | null;
  entries: LatencyRollupEntry[];
}

/** A closed turn's rollup, as stored. */
export interface TurnLatencyRecord extends TurnLatencyRollup {
  /** Sequence of the agent work turn the rollup belongs to. */
  turn_sequence: number;
  /** When the turn's row was written (unix ms). */
  ended_at: number;
  /** The turn's wall-clock time (ms) — the denominator of the model-wait share. */
  wall_ms: number | null;
}

/** The compact per-turn line stamped on the agent turn row (`Turn.latency`). */
export interface TurnLatencySummary {
  requests: number;
  errors: number;
  retries: number;
  ttft_p50_ms: number | null;
  ttlt_p50_ms: number | null;
  tps_p50: number | null;
  /** Sum of TTLT ÷ the turn's wall clock (see turnWallMs); null when either is not measurable. May exceed 1 when requests ran in parallel. */
  model_wait_share: number | null;
}

// --- Histogram scales ---

interface Scale {
  lo: number;
  hi: number;
  n: number;
}

/** 10 ms … 30 min in 40 buckets (≈1.354× each). Bucket -1 is under, n is over. */
export const TIME_SCALE: Scale = { lo: 10, hi: 30 * 60 * 1000, n: 40 };
/** 0.1 … 10,000 output tokens/s in 40 buckets (≈1.334× each). */
export const TPS_SCALE: Scale = { lo: 0.1, hi: 10_000, n: 40 };

/**
 * TTLT below this is too short to divide by: a response that landed within a
 * millisecond says nothing about generation speed, and dividing by it would
 * put an absurd rate into the histogram. Counted as unmeasurable instead.
 */
export const THROUGHPUT_MIN_DURATION_MS = 1;

/**
 * THE tokens/s definition: output tokens over the whole request (TTLT from
 * request start). Null when either figure is missing or non-positive.
 */
export function outputTokensPerSecond(outputTokens: number | null | undefined, ttltMs: number | null | undefined): number | null {
  if (typeof outputTokens !== 'number' || outputTokens <= 0) return null;
  if (typeof ttltMs !== 'number' || ttltMs < THROUGHPUT_MIN_DURATION_MS) return null;
  return outputTokens / (ttltMs / 1000);
}

function ratio(scale: Scale): number {
  return Math.pow(scale.hi / scale.lo, 1 / scale.n);
}

export function bucketIndex(scale: Scale, value: number): number {
  if (!(value >= scale.lo)) return -1;
  if (value >= scale.hi) return scale.n;
  const i = Math.floor(Math.log(value / scale.lo) / Math.log(ratio(scale)));
  return Math.min(Math.max(i, 0), scale.n - 1);
}

/** Geometric midpoint of a bucket; the open-ended edges answer their bound. */
function bucketMid(scale: Scale, index: number): number {
  if (index < 0) return scale.lo;
  if (index >= scale.n) return scale.hi;
  const r = ratio(scale);
  return scale.lo * Math.pow(r, index + 0.5);
}

export function emptyHistogram(): LatencyHistogram {
  return { count: 0, sum: 0, min: null, max: null, sumsq: 0, first: null, buckets: [] };
}

/** Add `n` to bucket `index`, growing the dense run at either end as needed. */
function addToBucket(h: LatencyHistogram, index: number, n: number): void {
  if (h.first === null) {
    h.first = index;
    h.buckets = [n];
    return;
  }
  if (index < h.first) {
    h.buckets = [...new Array<number>(h.first - index).fill(0), ...h.buckets];
    h.first = index;
  }
  const at = index - h.first;
  while (h.buckets.length <= at) h.buckets.push(0);
  h.buckets[at] += n;
}

/** Keep stored sums short: a float's tail would double the record for no information. */
function tidy(n: number): number {
  return Math.round(n * 100) / 100;
}

export function observe(h: LatencyHistogram, scale: Scale, value: number): void {
  if (!Number.isFinite(value) || value < 0) return;
  // Rounded to the scale's resolution (whole ms; 0.1 tok/s), for the same reason.
  value = scale === TPS_SCALE ? Math.round(value * 10) / 10 : Math.round(value);
  h.count++;
  h.sum = tidy(h.sum + value);
  h.sumsq = tidy(h.sumsq + value * value);
  h.min = h.min === null ? value : Math.min(h.min, value);
  h.max = h.max === null ? value : Math.max(h.max, value);
  addToBucket(h, bucketIndex(scale, value), 1);
}

/** Add `src` into `dst`. Exact: the merged histogram is the histogram of the union. */
export function mergeHistogram(dst: LatencyHistogram, src: LatencyHistogram): void {
  dst.count += src.count;
  dst.sum = tidy(dst.sum + src.sum);
  dst.sumsq = tidy(dst.sumsq + src.sumsq);
  if (src.min !== null) dst.min = dst.min === null ? src.min : Math.min(dst.min, src.min);
  if (src.max !== null) dst.max = dst.max === null ? src.max : Math.max(dst.max, src.max);
  if (src.first === null) return;
  src.buckets.forEach((n, i) => {
    if (n) addToBucket(dst, src.first! + i, n);
  });
}

/** The q-quantile (0..1) estimated from the buckets, or null when empty. */
export function percentile(h: LatencyHistogram, scale: Scale, q: number): number | null {
  if (h.count === 0 || h.first === null) return null;
  const target = Math.max(1, Math.ceil(q * h.count));
  let seen = 0;
  for (let i = 0; i < h.buckets.length; i++) {
    seen += h.buckets[i];
    if (seen >= target) {
      const mid = bucketMid(scale, h.first + i);
      return Math.min(Math.max(mid, h.min ?? mid), h.max ?? mid);
    }
  }
  return h.max;
}

export function mean(h: LatencyHistogram): number | null {
  return h.count > 0 ? h.sum / h.count : null;
}

export function stddev(h: LatencyHistogram): number | null {
  if (h.count < 2) return null;
  const m = h.sum / h.count;
  return Math.sqrt(Math.max(0, h.sumsq / h.count - m * m));
}

// --- Rollups ---

export function emptyRollup(): TurnLatencyRollup {
  return { version: 1, first_ts: null, last_ts: null, tier_switches: 0, first_key: null, last_key: null, entries: [] };
}

function emptyEntry(endpoint: string, model: string, tier: number | null, profile: string | null): LatencyRollupEntry {
  return {
    endpoint,
    model,
    tier,
    profile,
    requests: 0,
    errors: { rate_limited: 0, client_error: 0, server_error: 0, network: 0, cancelled: 0 },
    retries: 0,
    tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    ttfb: emptyHistogram(),
    ttft: emptyHistogram(),
    ttlt: emptyHistogram(),
    tps: emptyHistogram(),
    tps_unmeasurable: 0,
  };
}

function entryKey(endpoint: string, model: string, tier: number | null, profile: string | null): string {
  return profile === null ? JSON.stringify([endpoint, model, tier]) : JSON.stringify([endpoint, model, tier, profile]);
}

function entryFor(rollup: TurnLatencyRollup, endpoint: string, model: string, tier: number | null, profile: string | null): LatencyRollupEntry {
  let e = rollup.entries.find((x) => x.endpoint === endpoint && x.model === model && x.tier === tier && (x.profile ?? null) === profile);
  if (!e) {
    e = emptyEntry(endpoint, model, tier, profile);
    rollup.entries.push(e);
  }
  return e;
}

export function errorTotal(e: LatencyErrors): number {
  return e.rate_limited + e.client_error + e.server_error + e.network + e.cancelled;
}

const INFERENCE_ENDPOINTS = new Set(['messages', 'chat_completions', 'responses']);

/** Marks a tier attempt the proxy refused and re-sent (src/proxy/tier-select.ts). */
const TIER_REFUSED_MARK = 'tier refused';

function originOf(upstream: string): string {
  try {
    return new URL(upstream).origin;
  } catch {
    return upstream || '(unknown)';
  }
}

/**
 * The endpoint a request went to: the named `[endpoints.<name>]`, else the
 * upstream's origin — the same keying as `lazy stats audit`.
 */
export function endpointOfAudit(record: ProxyAuditRecord): string {
  return record.servedByEndpoint || originOf(record.upstream);
}

export type AuditClass = 'ignore' | 'retry' | 'request';

/** Whether, and how, an audited request counts toward a turn's rollup. See the header. */
export function classifyAudit(record: ProxyAuditRecord): AuditClass {
  if (!record.taskId) return 'ignore';
  if (record.role === 'builder') return 'ignore';
  if (record.authDenial) return 'ignore';
  if (!INFERENCE_ENDPOINTS.has(record.endpoint)) return 'ignore';
  if (record.error && record.error.toLowerCase().startsWith(TIER_REFUSED_MARK)) return 'retry';
  return 'request';
}

/** Fold one audited request into a rollup, in place. Pure and synchronous. */
export function foldAudit(rollup: TurnLatencyRollup, record: ProxyAuditRecord): void {
  const cls = classifyAudit(record);
  if (cls === 'ignore') return;
  const endpoint = endpointOfAudit(record);
  const model = record.model || '(unattributed)';
  const tier = typeof record.tierIndex === 'number' ? record.tierIndex : null;
  const profile = tier !== null ? record.tierProfile || null : null;
  const entry = entryFor(rollup, endpoint, model, tier, profile);
  if (cls === 'retry') {
    entry.retries++;
    return;
  }

  rollup.first_ts = rollup.first_ts === null ? record.ts : Math.min(rollup.first_ts, record.ts);
  rollup.last_ts = rollup.last_ts === null ? record.ts : Math.max(rollup.last_ts, record.ts);
  const key = entryKey(endpoint, model, tier, profile);
  if (rollup.last_key !== null && rollup.last_key !== key) rollup.tier_switches++;
  rollup.last_key = key;
  if (rollup.first_key === null) rollup.first_key = key;

  entry.requests++;
  if (record.reroute && record.reroute.attempts > 1) entry.retries += record.reroute.attempts - 1;

  const status = record.status;
  if (status === null) {
    entry.errors.network++;
    return;
  }
  if (status === 429) {
    entry.errors.rate_limited++;
    return;
  }
  if (status >= 500) {
    entry.errors.server_error++;
    return;
  }
  if (status >= 400) {
    entry.errors.client_error++;
    return;
  }
  // A 2xx that recorded an explicit `ttltMs: null` never reached its end: the
  // client cancelled or the stream broke. Absent means a legacy record.
  if (record.error || record.ttltMs === null) {
    entry.errors.cancelled++;
    return;
  }

  const u = record.usage;
  if (u) {
    entry.tokens.input += u.inputTokens ?? 0;
    entry.tokens.output += u.outputTokens ?? 0;
    entry.tokens.cache_read += u.cacheReadInputTokens ?? 0;
    entry.tokens.cache_write += u.cacheCreationInputTokens ?? 0;
  }
  if (typeof record.durationMs === 'number') observe(entry.ttfb, TIME_SCALE, record.durationMs);
  const ttlt = typeof record.ttltMs === 'number' ? record.ttltMs : null;
  // A non-streamed response lands all at once: its first token IS its last.
  const ttft = typeof record.ttftMs === 'number' ? record.ttftMs : record.stream === false ? ttlt : null;
  if (ttft !== null) observe(entry.ttft, TIME_SCALE, ttft);
  if (ttlt !== null) observe(entry.ttlt, TIME_SCALE, ttlt);

  // Throughput over the WHOLE request, never TTLT − TTFT: that is zero for
  // every non-streamed response.
  const rate = outputTokensPerSecond(u?.outputTokens, ttlt);
  if (rate !== null) {
    observe(entry.tps, TPS_SCALE, rate);
  } else {
    entry.tps_unmeasurable++;
  }
}

function mergeEntry(dst: LatencyRollupEntry, src: LatencyRollupEntry): void {
  dst.requests += src.requests;
  dst.retries += src.retries;
  dst.tps_unmeasurable += src.tps_unmeasurable;
  for (const k of Object.keys(dst.errors) as Array<keyof LatencyErrors>) dst.errors[k] += src.errors[k] ?? 0;
  for (const k of Object.keys(dst.tokens) as Array<keyof LatencyRollupEntry['tokens']>) dst.tokens[k] += src.tokens[k] ?? 0;
  mergeHistogram(dst.ttfb, src.ttfb);
  mergeHistogram(dst.ttft, src.ttft);
  mergeHistogram(dst.ttlt, src.ttlt);
  mergeHistogram(dst.tps, src.tps);
}

/**
 * Add `src` into `dst`, in place. Entries with the same endpoint × model × tier
 * merge; `last_key` follows `src` (the later delta), and a switch between the
 * two deltas' boundary is counted.
 */
export function mergeRollup(dst: TurnLatencyRollup, src: TurnLatencyRollup): void {
  for (const e of src.entries) mergeEntry(entryFor(dst, e.endpoint, e.model, e.tier, e.profile ?? null), e);
  if (src.first_ts !== null) dst.first_ts = dst.first_ts === null ? src.first_ts : Math.min(dst.first_ts, src.first_ts);
  if (src.last_ts !== null) dst.last_ts = dst.last_ts === null ? src.last_ts : Math.max(dst.last_ts, src.last_ts);
  dst.tier_switches += src.tier_switches;
  if (src.first_key !== null && dst.last_key !== null && dst.last_key !== src.first_key) {
    dst.tier_switches++;
  }
  if (dst.first_key === null) dst.first_key = src.first_key;
  if (src.last_key !== null) dst.last_key = src.last_key;
}

/** True when a rollup holds nothing worth storing. */
export function isEmptyRollup(r: TurnLatencyRollup): boolean {
  return r.entries.length === 0;
}

// --- Summaries ---

/** Model-wait share: summed TTLT ÷ the turn's wall clock; null when either is unknown or zero. */
export function modelWaitShare(r: TurnLatencyRollup, wallMs: number | null): number | null {
  if (wallMs === null || !(wallMs >= 1)) return null;
  const waited = r.entries.reduce((s, e) => s + e.ttlt.sum, 0);
  const timed = r.entries.reduce((s, e) => s + e.ttlt.count, 0);
  if (timed === 0) return null;
  return waited / wallMs;
}

/** All entries of a rollup merged into one (for a turn's one-line summary). */
export function totalEntry(r: TurnLatencyRollup): LatencyRollupEntry {
  const t = emptyEntry('*', '*', null, null);
  for (const e of r.entries) mergeEntry(t, e);
  return t;
}

export function summarizeTurn(r: TurnLatencyRollup, wallMs: number | null): TurnLatencySummary {
  const t = totalEntry(r);
  return {
    requests: t.requests,
    errors: errorTotal(t.errors),
    retries: t.retries,
    ttft_p50_ms: roundOrNull(percentile(t.ttft, TIME_SCALE, 0.5)),
    ttlt_p50_ms: roundOrNull(percentile(t.ttlt, TIME_SCALE, 0.5)),
    tps_p50: roundOrNull(percentile(t.tps, TPS_SCALE, 0.5), 10),
    model_wait_share: roundOrNull(modelWaitShare(r, wallMs), 100),
  };
}

function roundOrNull(v: number | null, scale = 1): number | null {
  return v === null ? null : Math.round(v * scale) / scale;
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/** `12 model calls · 1 error · p50 TTFT 1.2s · TTLT 8.4s · 41 tok/s · 63% waiting on the model` */
export function formatTurnLatency(s: TurnLatencySummary): string {
  const parts = [`${s.requests} model call${s.requests === 1 ? '' : 's'}`];
  if (s.errors) parts.push(`${s.errors} error${s.errors === 1 ? '' : 's'}`);
  if (s.retries) parts.push(`${s.retries} retr${s.retries === 1 ? 'y' : 'ies'}`);
  if (s.ttft_p50_ms !== null) parts.push(`p50 TTFT ${fmtMs(s.ttft_p50_ms)}`);
  if (s.ttlt_p50_ms !== null) parts.push(`TTLT ${fmtMs(s.ttlt_p50_ms)}`);
  if (s.tps_p50 !== null) parts.push(`${s.tps_p50.toFixed(0)} tok/s`);
  if (s.model_wait_share !== null) parts.push(`${Math.round(s.model_wait_share * 100)}% waiting on the model`);
  return parts.join(' · ');
}

// --- Cross-turn reports (history surfaces) ---

export interface LatencyPercentiles {
  /** Samples behind this column — differs per column (errors have no TTLT; a stream with no content event has no TTFT). */
  n: number;
  p5: number;
  p50: number;
  p95: number;
}

export interface LatencyHistoryRow {
  endpoint: string;
  model: string;
  tier: number | null;
  /** The tiered profile `tier` belongs to, or null. */
  profile: string | null;
  turns: number;
  requests: number;
  errors: LatencyErrors & { total: number };
  retries: number;
  tokens: LatencyRollupEntry['tokens'];
  ttfb: LatencyPercentiles | null;
  ttft: LatencyPercentiles | null;
  ttlt: LatencyPercentiles | null;
  tps: LatencyPercentiles | null;
  tps_unmeasurable: number;
  /** Mean TTLT (ms), from sum ÷ count. */
  ttlt_mean_ms: number | null;
}

export interface LatencyHistoryReport {
  /** Turns whose rollups were read (closed turns plus still-running ones). */
  turns: number;
  /** Earliest / latest request covered. */
  first_ts: number | null;
  last_ts: number | null;
  /** Summed TTLT ÷ summed wall clock over turns that recorded both; null when none. */
  model_wait_share: number | null;
  tier_switches: number;
  rows: LatencyHistoryRow[];
}

function pcts(h: LatencyHistogram, scale: Scale): LatencyPercentiles | null {
  if (h.count === 0) return null;
  return {
    n: h.count,
    p5: percentile(h, scale, 0.05)!,
    p50: percentile(h, scale, 0.5)!,
    p95: percentile(h, scale, 0.95)!,
  };
}

/**
 * Roll many turns up by endpoint × model × tier. A turn is in the window when
 * any of its requests is (`last_ts >= sinceMs`) — rollups are per turn, so
 * the window's edge is a turn, never a request.
 */
export function latencyHistory(
  rollups: Array<TurnLatencyRollup & { wall_ms?: number | null }>,
  opts: { sinceMs?: number } = {},
): LatencyHistoryReport {
  const merged = new Map<string, { entry: LatencyRollupEntry; turns: number }>();
  let turns = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let waited = 0;
  let wall = 0;
  let switches = 0;
  for (const r of rollups) {
    if (opts.sinceMs !== undefined && (r.last_ts === null || r.last_ts < opts.sinceMs)) continue;
    if (isEmptyRollup(r)) continue;
    turns++;
    switches += r.tier_switches;
    if (r.first_ts !== null) firstTs = firstTs === null ? r.first_ts : Math.min(firstTs, r.first_ts);
    if (r.last_ts !== null) lastTs = lastTs === null ? r.last_ts : Math.max(lastTs, r.last_ts);
    const share = modelWaitShare(r, r.wall_ms ?? null);
    if (share !== null) {
      waited += r.entries.reduce((s, e) => s + e.ttlt.sum, 0);
      wall += r.wall_ms!;
    }
    for (const e of r.entries) {
      const k = entryKey(e.endpoint, e.model, e.tier, e.profile ?? null);
      let m = merged.get(k);
      if (!m) {
        m = { entry: emptyEntry(e.endpoint, e.model, e.tier, e.profile ?? null), turns: 0 };
        merged.set(k, m);
      }
      mergeEntry(m.entry, e);
      m.turns++;
    }
  }
  const rows: LatencyHistoryRow[] = [...merged.values()].map(({ entry: e, turns: n }) => ({
    endpoint: e.endpoint,
    model: e.model,
    tier: e.tier,
    profile: e.profile ?? null,
    turns: n,
    requests: e.requests,
    errors: { ...e.errors, total: errorTotal(e.errors) },
    retries: e.retries,
    tokens: e.tokens,
    ttfb: pcts(e.ttfb, TIME_SCALE),
    ttft: pcts(e.ttft, TIME_SCALE),
    ttlt: pcts(e.ttlt, TIME_SCALE),
    tps: pcts(e.tps, TPS_SCALE),
    tps_unmeasurable: e.tps_unmeasurable,
    ttlt_mean_ms: mean(e.ttlt),
  }));
  rows.sort((a, b) => b.requests - a.requests || a.endpoint.localeCompare(b.endpoint) || a.model.localeCompare(b.model));
  return {
    turns,
    first_ts: firstTs,
    last_ts: lastTs,
    model_wait_share: wall > 0 ? waited / wall : null,
    tier_switches: switches,
    rows,
  };
}

/** `1.2s / 3.4s / 9.0s` (p5 / p50 / p95), or `—`. Throughput cells are tok/s. */
export function formatPercentiles(p: LatencyPercentiles | null, kind: 'ms' | 'tps'): string {
  if (!p) return '—';
  const f = kind === 'ms' ? fmtMs : (n: number) => n.toFixed(n < 10 ? 1 : 0);
  return `${f(p.p5)} / ${f(p.p50)} / ${f(p.p95)} (n=${p.n})`;
}

/** `3 (2×429, 1×5xx)`, or `0`. */
export function formatErrorBreakdown(e: LatencyErrors & { total: number }): string {
  if (e.total === 0) return '0';
  const parts: string[] = [];
  if (e.rate_limited) parts.push(`${e.rate_limited}×429`);
  if (e.client_error) parts.push(`${e.client_error}×4xx`);
  if (e.server_error) parts.push(`${e.server_error}×5xx`);
  if (e.network) parts.push(`${e.network}×network`);
  if (e.cancelled) parts.push(`${e.cancelled}×cancelled`);
  return `${e.total} (${parts.join(', ')})`;
}

/**
 * `lunaroute · glm-5.3 · tiered tier 2` — the row label every surface uses,
 * with the tier named as `lazy stats audit --summary` names it.
 */
export function latencyRowLabel(r: { endpoint: string; model: string; tier: number | null; profile?: string | null }): string {
  if (r.tier === null) return `${r.endpoint} · ${r.model}`;
  return `${r.endpoint} · ${r.model} · ${r.profile ? `${r.profile} ` : ''}tier ${r.tier + 1}`;
}

/**
 * A turn's wall clock for the model-wait share: from the row that LAUNCHED
 * the turn to the row that ends it, else the agent's elapsed time. Never the
 * span of its requests — a request left over from earlier would stretch the
 * clock over a human's idle time. Null when neither is known or positive.
 */
export function turnWallMs(launchedAt: number | null, elapsedMs: number | null, endedAt: number): number | null {
  const wall = launchedAt !== null && launchedAt < endedAt ? endedAt - launchedAt : elapsedMs;
  return wall !== null && wall > 0 ? wall : null;
}

/**
 * Which agent rows close the running rollup: a WORK turn's, and an ask's or a
 * separate review's — each is its own launch on the task's grant, and leaving
 * its requests open would bill them to the next work turn. Other rows (nudge,
 * sync, the low-high self-review recorded after its work row) do not.
 */
export function closesLatencyRollup(turnType: string | undefined): boolean {
  return !turnType || turnType === 'work' || turnType === 'ask' || turnType === 'review';
}

/**
 * Starts the error a store throws when a latency delta names no task. Matched
 * by text because it crosses the storage RPC; the recorder drops such a delta
 * rather than retrying it forever.
 */
export const TURN_LATENCY_NO_TASK = 'Cannot record turn latency: no task matches id';

const MAX_ENTRIES = 256;

const ERROR_KEYS: Array<keyof LatencyErrors> = ['rate_limited', 'client_error', 'server_error', 'network', 'cancelled'];
const TOKEN_KEYS: Array<keyof LatencyRollupEntry['tokens']> = ['input', 'output', 'cache_read', 'cache_write'];

/** A counter as it may arrive: a whole number, not negative, not past exact float range. */
function isCount(n: unknown): boolean {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

function isHistogram(h: unknown): boolean {
  if (!h || typeof h !== 'object') return false;
  const x = h as LatencyHistogram;
  const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
  if (![x.count, x.sum, x.sumsq].every(finite)) return false;
  if (!(x.min === null || finite(x.min)) || !(x.max === null || finite(x.max))) return false;
  if (!Array.isArray(x.buckets) || x.buckets.length > TIME_SCALE.n + 2 || !x.buckets.every(finite)) return false;
  if (x.first === null) return x.buckets.length === 0;
  return Number.isInteger(x.first) && x.first >= -1 && x.first + x.buckets.length <= TIME_SCALE.n + 1;
}

/**
 * Why a value that arrived over the wire is not a latency rollup, or null when
 * it is one. Checked at the storage RPC boundary: an absurd bucket offset would
 * otherwise make the merge allocate an unbounded array in the daemon.
 */
export function rollupShapeProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object') return 'delta must be an object';
  const r = value as TurnLatencyRollup;
  if (r.version !== 1) return 'delta.version must be 1';
  if (!Array.isArray(r.entries) || r.entries.length > MAX_ENTRIES) return `delta.entries must be an array of at most ${MAX_ENTRIES}`;
  if (!isCount(r.tier_switches)) return 'delta.tier_switches must be a non-negative integer';
  if (!(r.first_ts === null || isCount(r.first_ts)) || !(r.last_ts === null || isCount(r.last_ts))) return 'delta.first_ts and last_ts must be timestamps or null';
  if (!(r.first_key === null || typeof r.first_key === 'string') || !(r.last_key === null || typeof r.last_key === 'string')) return 'delta.first_key and last_key must be strings or null';
  for (const e of r.entries) {
    if (!e || typeof e !== 'object' || typeof e.endpoint !== 'string' || typeof e.model !== 'string') return 'each entry needs endpoint and model strings';
    if (!(e.tier === null || Number.isInteger(e.tier))) return 'entry.tier must be an integer or null';
    if (!(e.profile === undefined || e.profile === null || typeof e.profile === 'string')) return 'entry.profile must be a string or null';
    if (!e.errors || typeof e.errors !== 'object' || !e.tokens || typeof e.tokens !== 'object') return 'each entry needs errors and tokens';
    for (const [name, n] of [['requests', e.requests], ['retries', e.retries], ['tps_unmeasurable', e.tps_unmeasurable]] as const) {
      if (!isCount(n)) return `entry.${name} must be a non-negative integer`;
    }
    for (const k of ERROR_KEYS) if (!isCount(e.errors[k])) return `entry.errors.${k} must be a non-negative integer`;
    for (const k of TOKEN_KEYS) if (!isCount(e.tokens[k])) return `entry.tokens.${k} must be a non-negative integer`;
    if (![e.ttfb, e.ttft, e.ttlt, e.tps].every(isHistogram)) return 'entry histograms are malformed';
  }
  return null;
}
