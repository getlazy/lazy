/**
 * Latency rollup over the proxy audit trail.
 *
 * Pure functions over `ProxyAuditRecord[]`, like aggregate.ts. A slow provider
 * is invisible in token totals, so this answers the other question: how long
 * did requests take to start answering (TTFB, TTFT) and to finish (TTLT), and
 * how fast did tokens flow once they started.
 *
 * Only records that actually measured a quantity contribute to it — a record
 * from before the latency fields existed, or an error, adds to `requests` and
 * to nothing else, so an old trail never drags a percentile toward zero.
 */

import type { ProxyAuditRecord } from '../storage/types';
import { UNATTRIBUTED } from './aggregate';
import { outputTokensPerSecond } from '../task/turn-latency';

export interface Percentiles {
  /** Samples behind the numbers. */
  n: number;
  p50: number;
  p90: number;
}

export interface LatencyGroup {
  key: string;
  requests: number;
  /** Request start → response headers, ms (the record's `durationMs`). */
  ttfb: Percentiles | null;
  /** Request start → first content token, ms. */
  ttft: Percentiles | null;
  /** Request start → last byte, ms. */
  ttlt: Percentiles | null;
  /** Output tokens per second over the whole request (TTLT). */
  tokensPerSecond: Percentiles | null;
}

/** Failed requests of one group, split by why. */
export interface ErrorBreakdown {
  total: number;
  rateLimited: number;
  serverError: number;
  timeout: number;
  cancelled: number;
  other: number;
}

/**
 * One endpoint × model (× tier) row of `lazy stats audit --summary`. The tier
 * is the TIERED PROFILE's tier that served the request (its 0-based position
 * in the profile's `tiers` list), never the record's model-family guess.
 */
export interface EndpointModelSummary extends LatencyGroup {
  endpoint: string;
  model: string;
  /** 0-based position of the serving tier in its tiered profile, or null on an untiered profile. */
  tierIndex: number | null;
  /** The tiered profile that tier belongs to, or null on an untiered profile. */
  tierProfile: string | null;
  errors: ErrorBreakdown;
  inputTokens: number;
  outputTokens: number;
}

export interface LatencyReport {
  byEndpointModel: EndpointModelSummary[];
  byModel: LatencyGroup[];
  byEndpoint: LatencyGroup[];
  byTier: LatencyGroup[];
}

export interface LatencyOptions {
  sinceMs?: number;
  role?: string;
  taskId?: string;
  taskIds?: string[];
}

/** Nearest-rank percentile of an ascending-sorted, non-empty array. */
function nearestRank(sorted: number[], p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function percentiles(values: number[]): Percentiles | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, p50: nearestRank(sorted, 50), p90: nearestRank(sorted, 90) };
}

/** Tokens/s of one record: the single definition in turn-latency (output over TTLT). */
export function tokensPerSecond(record: ProxyAuditRecord): number | null {
  return outputTokensPerSecond(record.usage?.outputTokens, record.ttltMs);
}

interface Samples {
  requests: number;
  ttfb: number[];
  ttft: number[];
  ttlt: number[];
  tps: number[];
}

function sampleInto(groups: Map<string, Samples>, key: string, record: ProxyAuditRecord): void {
  let g = groups.get(key);
  if (!g) {
    g = { requests: 0, ttfb: [], ttft: [], ttlt: [], tps: [] };
    groups.set(key, g);
  }
  g.requests++;
  if (typeof record.durationMs === 'number' && record.status !== null) g.ttfb.push(record.durationMs);
  if (typeof record.ttftMs === 'number') g.ttft.push(record.ttftMs);
  if (typeof record.ttltMs === 'number') g.ttlt.push(record.ttltMs);
  const tps = tokensPerSecond(record);
  if (tps !== null) g.tps.push(tps);
}

function finish(groups: Map<string, Samples>): LatencyGroup[] {
  return [...groups]
    .map(([key, g]) => ({
      key,
      requests: g.requests,
      ttfb: percentiles(g.ttfb),
      ttft: percentiles(g.ttft),
      ttlt: percentiles(g.ttlt),
      tokensPerSecond: percentiles(g.tps),
    }))
    .sort((a, b) => b.requests - a.requests || a.key.localeCompare(b.key));
}

function originOf(upstream: string | null | undefined): string {
  if (!upstream) return UNATTRIBUTED;
  try {
    return new URL(upstream).origin;
  } catch {
    return upstream;
  }
}

export function latencyReport(records: ProxyAuditRecord[], options: LatencyOptions = {}): LatencyReport {
  const byModel = new Map<string, Samples>();
  const byEndpoint = new Map<string, Samples>();
  const byTier = new Map<string, Samples>();
  const matching: ProxyAuditRecord[] = [];
  for (const record of records) {
    if (options.sinceMs !== undefined && record.ts < options.sinceMs) continue;
    if (options.role !== undefined && (record.role ?? '') !== options.role) continue;
    if (options.taskId !== undefined && !(record.taskId ?? '').startsWith(options.taskId)) continue;
    if (options.taskIds !== undefined) {
      const id = record.taskId ?? '';
      if (!id || !options.taskIds.some((prefix) => id.startsWith(prefix))) continue;
    }
    matching.push(record);
    // Errors, count_tokens and cursor passthrough carry no stream timing: keep
    // them out of every group rather than listing a row of dashes per model.
    if (record.status === null) continue;
    if (record.endpoint !== 'messages' && record.endpoint !== 'chat_completions' && record.endpoint !== 'responses') continue;
    if (record.status >= 400) continue;
    sampleInto(byModel, record.model || UNATTRIBUTED, record);
    sampleInto(byEndpoint, endpointOf(record), record);
    sampleInto(byTier, record.tier || UNATTRIBUTED, record);
  }
  return { byEndpointModel: summarizeByEndpointModel(matching), byModel: finish(byModel), byEndpoint: finish(byEndpoint), byTier: finish(byTier) };
}

/** The endpoint a request went to: the named `[endpoints.<name>]`, else the upstream's origin. */
export function endpointOf(record: ProxyAuditRecord): string {
  return record.servedByEndpoint || originOf(record.upstream);
}

function isTimedEndpoint(record: ProxyAuditRecord): boolean {
  return record.endpoint === 'messages' || record.endpoint === 'chat_completions' || record.endpoint === 'responses';
}

/**
 * A stream the client cancelled or that broke mid-way: the proxy answered 2xx
 * but recorded an explicit `ttltMs: null` (absent means a record that predates
 * the field, which is not evidence of anything).
 */
function isCancelledStream(record: ProxyAuditRecord): boolean {
  return record.status !== null && record.status < 400 && !record.error && record.ttltMs === null;
}

function classifyError(record: ProxyAuditRecord, errors: ErrorBreakdown): void {
  errors.total++;
  const text = record.error ?? '';
  if (record.status === 429) errors.rateLimited++;
  else if (record.status !== null && record.status >= 500) errors.serverError++;
  else if (/time(d)?[ -]?out/i.test(text)) errors.timeout++;
  else if (isCancelledStream(record)) errors.cancelled++;
  else if (/cancel|abort/i.test(text)) errors.cancelled++;
  else errors.other++;
}

/** Short "3 (429×2 5xx×1)" form of an error breakdown; '0' when there are none. */
export function formatErrors(e: ErrorBreakdown): string {
  if (e.total === 0) return '0';
  const parts: string[] = [];
  if (e.rateLimited) parts.push(`429×${e.rateLimited}`);
  if (e.serverError) parts.push(`5xx×${e.serverError}`);
  if (e.timeout) parts.push(`timeout×${e.timeout}`);
  if (e.cancelled) parts.push(`cancelled×${e.cancelled}`);
  if (e.other) parts.push(`other×${e.other}`);
  return `${e.total} (${parts.join(' ')})`;
}

/**
 * Roll already-filtered records up per endpoint × model × tier. Unlike the
 * latency groups above, failed requests are counted (and broken down) here —
 * a provider that errors half the time must not look healthy — while timing
 * percentiles still come only from successful, timed requests.
 */
export function summarizeByEndpointModel(records: ProxyAuditRecord[]): EndpointModelSummary[] {
  const samples = new Map<string, Samples>();
  const meta = new Map<string, { endpoint: string; model: string; tierIndex: number | null; tierProfile: string | null; errors: ErrorBreakdown; inTok: number; outTok: number }>();
  for (const record of records) {
    if (!isTimedEndpoint(record)) continue;
    const endpoint = endpointOf(record);
    const model = record.model || UNATTRIBUTED;
    const tierIndex = typeof record.tierIndex === 'number' ? record.tierIndex : null;
    const tierProfile = tierIndex !== null ? record.tierProfile || null : null;
    const key = JSON.stringify([endpoint, model, tierProfile, tierIndex]);
    let m = meta.get(key);
    if (!m) {
      m = { endpoint, model, tierIndex, tierProfile, errors: { total: 0, rateLimited: 0, serverError: 0, timeout: 0, cancelled: 0, other: 0 }, inTok: 0, outTok: 0 };
      meta.set(key, m);
    }
    const failed = record.status === null || record.status >= 400 || (record.error !== null && record.error !== undefined) || isCancelledStream(record);
    if (failed) {
      classifyError(record, m.errors);
      let g = samples.get(key);
      if (!g) {
        g = { requests: 0, ttfb: [], ttft: [], ttlt: [], tps: [] };
        samples.set(key, g);
      }
      g.requests++;
      continue;
    }
    sampleInto(samples, key, record);
    m.inTok += record.usage?.inputTokens ?? 0;
    m.outTok += record.usage?.outputTokens ?? 0;
  }
  return finish(samples).map((g) => {
    const m = meta.get(g.key)!;
    return { ...g, key: [m.endpoint, m.model, tierLabel(m.tierIndex, m.tierProfile)].filter(Boolean).join(' · '), endpoint: m.endpoint, model: m.model, tierIndex: m.tierIndex, tierProfile: m.tierProfile, errors: m.errors, inputTokens: m.inTok, outputTokens: m.outTok };
  });
}

/** "tiered tier 1" for profile `tiered`'s first tier (1-based for people), null when untiered. */
export function tierLabel(tierIndex: number | null, profile: string | null = null): string | null {
  if (tierIndex === null) return null;
  return profile ? `${profile} tier ${tierIndex + 1}` : `tier ${tierIndex + 1}`;
}
