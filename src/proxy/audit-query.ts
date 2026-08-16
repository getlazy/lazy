/**
 * Querying the proxy audit trail.
 *
 * Pure functions over `ProxyAuditRecord[]` — no storage, no I/O, no rendering —
 * so the same filters and the same row projection can back the
 * `lazy stats audit` CLI readout today and the v0.21 dashboard (or an MCP
 * surface) later without either re-deriving what "denied" or "errored" means.
 * `src/proxy/aggregate.ts` is the sibling module for rollups; this one is the
 * record-level view.
 *
 * Predicate semantics are defined ONCE here on purpose. "Was this request
 * denied?" has exactly one answer, and a second surface computing it from
 * `record.enforcement` by hand is how two readouts start disagreeing about a
 * security event.
 */

import type { ProxyAuditRecord, ProxyEnforcementAudit } from '../storage/types';

/** Filters applied to the trail. Every field is optional and ANDed. */
export interface AuditFilters {
  /** Only records with `ts >= sinceMs`. */
  sinceMs?: number;
  /** Only records whose role matches exactly (e.g. agent, builder). */
  role?: string;
  /** Only records whose taskId starts with this (short-id friendly). */
  taskId?: string;
  /** Only records whose model contains this substring (case-insensitive). */
  model?: string;
  /** Only records where the policy engine denied at least one tool_use. */
  denied?: boolean;
  /** Only records the proxy rerouted to a fallback target. */
  reroutes?: boolean;
  /** Only records that failed — a proxy-side error or a non-2xx upstream status. */
  errors?: boolean;
}

/**
 * Denials recorded on this request. `enforcement` is optional on the type and
 * nullable in the store (records written before enforcement existed have no
 * field at all), so normalise to an array rather than making every caller
 * repeat the two-step null check.
 */
export function denialsOf(record: ProxyAuditRecord): ProxyEnforcementAudit[] {
  return record.enforcement ?? [];
}

/**
 * Whether the request failed. Two distinct failure shapes are both failures to
 * a human reading the trail: the proxy never got a response (`error` set,
 * `status` null), or the upstream answered with a non-2xx. A 401 that lands
 * here is the same signal `lazy doctor` reads for an expired credential.
 */
export function isFailure(record: ProxyAuditRecord): boolean {
  if (record.error !== null && record.error !== undefined) return true;
  return record.status !== null && record.status >= 400;
}

/** Apply every filter. Records are returned in input order (chronological). */
export function filterAuditRecords(
  records: ProxyAuditRecord[],
  filters: AuditFilters = {},
): ProxyAuditRecord[] {
  const model = filters.model?.toLowerCase();
  return records.filter((r) => {
    if (filters.sinceMs !== undefined && r.ts < filters.sinceMs) return false;
    if (filters.role !== undefined && (r.role ?? '') !== filters.role) return false;
    if (filters.taskId !== undefined && !(r.taskId ?? '').startsWith(filters.taskId)) return false;
    if (model !== undefined && !(r.model ?? '').toLowerCase().includes(model)) return false;
    if (filters.denied && denialsOf(r).length === 0) return false;
    if (filters.reroutes && r.reroute === null) return false;
    if (filters.errors && !isFailure(r)) return false;
    return true;
  });
}

/** Outcome of resolving a record-id prefix against the trail. */
export interface AuditResolution {
  /** The single matching record, or null when there were zero or many. */
  record: ProxyAuditRecord | null;
  /** How many records matched the prefix. */
  matches: number;
}

/**
 * Resolve a record-id prefix, the way task short-ids resolve everywhere else.
 * Ambiguity is reported rather than silently resolved to the first hit — the
 * caller decides how to surface it.
 */
export function resolveAuditRecord(
  records: ProxyAuditRecord[],
  idPrefix: string,
): AuditResolution {
  const matches = records.filter((r) => r.id.startsWith(idPrefix));
  return { record: matches.length === 1 ? matches[0] : null, matches: matches.length };
}

/**
 * One row of the compact listing — the projection the table renders and the
 * `--json` list emits. Deliberately flat and pre-computed so a second consumer
 * (the dashboard) renders the same columns without re-deriving markers.
 */
export interface AuditRow {
  id: string;
  ts: number;
  role: string | null;
  taskId: string | null;
  model: string | null;
  endpoint: string;
  status: number | null;
  durationMs: number | null;
  /** tool_use blocks carried on the request (intended actions). */
  toolUses: number;
  /** tool_result blocks carried on the request (results of prior actions). */
  toolResults: number;
  /** Total tokens across all four counters, or null when no usage was captured. */
  totalTokens: number | null;
  /** How many tool_uses the policy engine denied on this response. */
  denials: number;
  /** True when this request ran on a fallback target. */
  rerouted: boolean;
  /** True when the request failed (see `isFailure`). */
  failed: boolean;
}

export function toAuditRow(record: ProxyAuditRecord): AuditRow {
  const u = record.usage;
  return {
    id: record.id,
    ts: record.ts,
    role: record.role,
    taskId: record.taskId,
    model: record.model,
    endpoint: record.endpoint,
    status: record.status,
    durationMs: record.durationMs,
    toolUses: record.toolUses?.length ?? 0,
    toolResults: record.toolResults?.length ?? 0,
    totalTokens: u
      ? (u.inputTokens ?? 0) +
        (u.outputTokens ?? 0) +
        (u.cacheCreationInputTokens ?? 0) +
        (u.cacheReadInputTokens ?? 0)
      : null,
    denials: denialsOf(record).length,
    rerouted: record.reroute !== null && record.reroute !== undefined,
    failed: isFailure(record),
  };
}
