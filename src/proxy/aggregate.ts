/**
 * Aggregation over the proxy audit trail.
 *
 * Pure functions over `ProxyAuditRecord[]` — no storage, no I/O, no rendering —
 * so the same rollup can back the `lazy stats tokens` CLI readout today and an API or
 * MCP surface later without duplicating the arithmetic.
 *
 * Attribution comes from the `x-lazy-role` / `x-lazy-task-id` headers the proxy
 * records per request (see src/utils/role-target.ts). Records that carry neither
 * are grouped under `(unattributed)` rather than dropped: traffic we cannot
 * attribute is a fact worth seeing, not one worth hiding.
 */

import type { ProxyAuditRecord } from '../storage/types';

/** Label used for records with no role / task / model on them. */
export const UNATTRIBUTED = '(unattributed)';

export interface TokenTotals {
  /** Audit records counted. */
  requests: number;
  /** How many of them actually carried usage (the rest bill nothing we can see). */
  withUsage: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** Sum of all four counters — what "total tokens" means for ranking. */
  totalTokens: number;
}

/** One row of a breakdown: totals for a single role / task / model. */
export interface TokenGroup extends TokenTotals {
  key: string;
}

export interface TokenReport {
  totals: TokenTotals;
  byRole: TokenGroup[];
  byTask: TokenGroup[];
  byModel: TokenGroup[];
  /** Timestamp (unix ms) of the oldest / newest record counted, or null if none. */
  firstTs: number | null;
  lastTs: number | null;
}

function emptyTotals(): TokenTotals {
  return {
    requests: 0,
    withUsage: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalTokens: 0,
  };
}

function add(target: TokenTotals, record: ProxyAuditRecord): void {
  target.requests++;
  const u = record.usage;
  if (!u) return;
  target.withUsage++;
  const input = u.inputTokens ?? 0;
  const output = u.outputTokens ?? 0;
  const cacheWrite = u.cacheCreationInputTokens ?? 0;
  const cacheRead = u.cacheReadInputTokens ?? 0;
  target.inputTokens += input;
  target.outputTokens += output;
  target.cacheCreationInputTokens += cacheWrite;
  target.cacheReadInputTokens += cacheRead;
  target.totalTokens += input + output + cacheWrite + cacheRead;
}

/** Sort by total tokens desc, then request count desc, then key for stability. */
function rank(groups: Map<string, TokenGroup>): TokenGroup[] {
  return [...groups.values()].sort(
    (a, b) =>
      b.totalTokens - a.totalTokens ||
      b.requests - a.requests ||
      a.key.localeCompare(b.key),
  );
}

function bucket(
  groups: Map<string, TokenGroup>,
  key: string,
  record: ProxyAuditRecord,
): void {
  let group = groups.get(key);
  if (!group) {
    group = { key, ...emptyTotals() };
    groups.set(key, group);
  }
  add(group, record);
}

export interface AggregateOptions {
  /** Only count records with `ts >= sinceMs`. */
  sinceMs?: number;
  /** Only count records whose role matches exactly. */
  role?: string;
  /** Only count records whose taskId starts with this (short-id friendly). */
  taskId?: string;
}

/**
 * Roll up audit records into overall totals plus per-role, per-task and
 * per-model breakdowns, each ranked by total tokens.
 */
export function aggregateUsage(
  records: ProxyAuditRecord[],
  options: AggregateOptions = {},
): TokenReport {
  const totals = emptyTotals();
  const byRole = new Map<string, TokenGroup>();
  const byTask = new Map<string, TokenGroup>();
  const byModel = new Map<string, TokenGroup>();
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  for (const record of records) {
    if (options.sinceMs !== undefined && record.ts < options.sinceMs) continue;
    if (options.role !== undefined && (record.role ?? '') !== options.role) continue;
    if (options.taskId !== undefined && !(record.taskId ?? '').startsWith(options.taskId)) continue;

    add(totals, record);
    bucket(byRole, record.role || UNATTRIBUTED, record);
    bucket(byTask, record.taskId || UNATTRIBUTED, record);
    bucket(byModel, record.model || UNATTRIBUTED, record);

    if (firstTs === null || record.ts < firstTs) firstTs = record.ts;
    if (lastTs === null || record.ts > lastTs) lastTs = record.ts;
  }

  return {
    totals,
    byRole: rank(byRole),
    byTask: rank(byTask),
    byModel: rank(byModel),
    firstTs,
    lastTs,
  };
}
