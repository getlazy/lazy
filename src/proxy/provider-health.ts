/**
 * "Is it the provider or is it us?" — per provider/endpoint over the last
 * hour: requests, failures by kind, and the last failure.
 *
 * Folded from the SAME audit records every other proxy view reads (fed live
 * from the audit queue, seeded once from the audit log after a restart). Held
 * in memory only and bounded by the window — nothing new is stored.
 *
 * Only failures that are the PROVIDER's (or the network's) are counted: lazy's
 * own refusals (a missing credential, an unknown session token) and a client
 * that hung up are not provider health, and counting them would point the
 * finger at the wrong party.
 */

import type { ProxyAuditRecord } from '../storage/types';
import { CLIENT_ABORT_MESSAGE } from './upstream-timeout';
import { LAZY_REFUSAL_PREFIXES } from './activity';
import { classifyFetchFailure, providerName, upstreamHost } from './upstream-failure';

/** Default window: one hour. */
export const PROVIDER_HEALTH_WINDOW_MS = 60 * 60 * 1000;

/** Failure buckets a person asks about. */
export type ProviderFailureKind = 'reset' | 'timeout' | 'connect' | 'server_error' | 'overloaded' | 'rate_limited' | 'other';

export const PROVIDER_FAILURE_KINDS: readonly ProviderFailureKind[] =
  ['reset', 'timeout', 'connect', 'server_error', 'overloaded', 'rate_limited', 'other'];

/** One provider/endpoint's health over the window. */
export interface ProviderHealth {
  /** Anthropic, OpenAI, Cursor, `endpoint <name>`, or the host. */
  provider: string;
  /** Host (and port) the requests went to. */
  host: string;
  requests: number;
  failures: Record<ProviderFailureKind, number>;
  /** When the latest failure happened (unix ms). */
  lastFailureAt: number | null;
  lastFailure: string | null;
}

interface Event {
  id: string;
  ts: number;
  provider: string;
  host: string;
  kind: ProviderFailureKind | null;
  error: string | null;
}

/** The failure bucket of one record, null for a success, undefined when it is not the provider's to answer for. */
export function providerFailureKind(r: ProxyAuditRecord): ProviderFailureKind | null | undefined {
  // lazy's own refusals and client aborts are not provider health.
  if (r.authDenial || r.refusedCredential) return undefined;
  if (r.error === CLIENT_ABORT_MESSAGE) return undefined;
  // lazy's own answers that carry a status (a transient credential 503, "every
  // tier full" 429, a path 403) are not the provider's either.
  if (r.error && LAZY_REFUSAL_PREFIXES.some((p) => r.error!.startsWith(`${p}:`))) return undefined;
  // A thrown or broken upstream request (before OR after the response began).
  if (r.failure || r.status === null) {
    if (!r.failure && r.error === null) return undefined;
    const kind = r.failure?.kind ?? classifyFetchFailure(new Error(r.error ?? '')).kind;
    if (kind === 'reset' || kind === 'timeout') return kind;
    if (kind === 'refused' || kind === 'dns' || kind === 'tls') return 'connect';
    return 'other';
  }
  if (r.status === 529) return 'overloaded';
  if (r.status === 429) return 'rate_limited';
  if (r.status >= 500) return 'server_error';
  return null;
}

/** Rolling window of provider outcomes. */
export class ProviderHealthTracker {
  private events: Event[] = [];
  private readonly ids = new Set<string>();

  constructor(private readonly windowMs = PROVIDER_HEALTH_WINDOW_MS) {}

  /** Events held (tests: proves the window bounds memory). */
  get size(): number {
    return this.events.length;
  }

  /** Fold one audit record in. Idempotent by record id. */
  observe(r: ProxyAuditRecord, now = Date.now()): void {
    // Pruned here too, not only on read: a daemon nobody asks still observes
    // every request, and must stay bounded by the window.
    if (this.events.length > 0 && this.events[0]!.ts < now - this.windowMs) this.prune(now);
    if (r.ts < now - this.windowMs || this.ids.has(r.id)) return;
    const kind = providerFailureKind(r);
    if (kind === undefined) return;
    this.ids.add(r.id);
    this.events.push({
      id: r.id,
      ts: r.ts,
      // One derivation for every record, success or failure, so a provider's
      // successes and failures always land in the same row.
      provider: providerName(r.upstream, r.servedByEndpoint ?? r.endpointName),
      host: upstreamHost(r.upstream),
      kind,
      error: kind ? r.error ?? `HTTP ${r.status}` : null,
    });
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    const kept: Event[] = [];
    for (const e of this.events) {
      if (e.ts >= cutoff) kept.push(e);
      else this.ids.delete(e.id);
    }
    this.events = kept;
  }

  /** One row per provider+host, most failures first. */
  summary(now = Date.now()): ProviderHealth[] {
    this.prune(now);
    return summarizeEvents(this.events);
  }

  resetForTest(): void {
    this.events = [];
    this.ids.clear();
  }
}

function summarizeEvents(events: readonly Event[]): ProviderHealth[] {
  const rows = new Map<string, ProviderHealth>();
  for (const e of events) {
    const key = `${e.provider}\u0000${e.host}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        provider: e.provider, host: e.host, requests: 0,
        failures: Object.fromEntries(PROVIDER_FAILURE_KINDS.map((k) => [k, 0])) as Record<ProviderFailureKind, number>,
        lastFailureAt: null, lastFailure: null,
      };
      rows.set(key, row);
    }
    row.requests++;
    if (e.kind) {
      row.failures[e.kind]++;
      if (row.lastFailureAt === null || e.ts >= row.lastFailureAt) {
        row.lastFailureAt = e.ts;
        row.lastFailure = e.error;
      }
    }
  }
  const failed = (h: ProviderHealth) => totalFailures(h);
  return [...rows.values()].sort((a, b) => failed(b) - failed(a) || b.requests - a.requests);
}

/** Every failure in a row. */
export function totalFailures(h: ProviderHealth): number {
  return PROVIDER_FAILURE_KINDS.reduce((n, k) => n + h.failures[k], 0);
}

/** Pure form for a one-off list of records (tests, offline readers). */
export function summarizeProviderHealth(records: readonly ProxyAuditRecord[], now = Date.now(), windowMs = PROVIDER_HEALTH_WINDOW_MS): ProviderHealth[] {
  const t = new ProviderHealthTracker(windowMs);
  for (const r of records) t.observe(r, now);
  return t.summary(now);
}

/** The daemon's live view, fed by the proxy's audit queue. */
export const daemonProviderHealth = new ProviderHealthTracker();

/** Human-readable failure counts: "3 reset, 1 overloaded (529)". */
export function describeFailureCounts(h: ProviderHealth): string {
  const labels: Record<ProviderFailureKind, string> = {
    reset: 'reset', timeout: 'timeout', connect: 'connect', server_error: '5xx',
    overloaded: '529 overloaded', rate_limited: '429 rate-limited', other: 'other',
  };
  const parts = PROVIDER_FAILURE_KINDS.filter((k) => h.failures[k] > 0).map((k) => `${h.failures[k]} ${labels[k]}`);
  return parts.length ? parts.join(', ') : 'no failures';
}

/**
 * The daemon's provider health, with the recent audit log folded in first
 * (idempotent by record id) so the hour survives a daemon restart.
 */
export function daemonProviderHealthWith(recentRecords: readonly ProxyAuditRecord[], now = Date.now()): ProviderHealth[] {
  for (const r of recentRecords) daemonProviderHealth.observe(r, now);
  return daemonProviderHealth.summary(now);
}
