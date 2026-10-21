/**
 * Aggregation over the proxy audit trail.
 *
 * Pure functions over `ProxyAuditRecord[]` — no storage, no I/O, no rendering —
 * so the same rollup can back the `lazy stats tokens` CLI readout today and an API or
 * MCP surface later without duplicating the arithmetic.
 *
 * Attribution comes from the per-launch credential grant the proxy resolves
 * (src/proxy/credential-broker.ts); the `x-lazy-role` / `x-lazy-task-id`
 * headers are only a fallback for traffic that presents no grant. Records that carry neither
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
  /**
   * Per upstream ENDPOINT: the named endpoint a tiered profile's request was
   * served by, else the upstream origin — so a tiered chain's spend is seen
   * per endpoint, blended across its models.
   */
  byEndpoint: TokenGroup[];
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
  /**
   * Only count records whose taskId EQUALS one of these (exact, not prefix: a
   * prefix rule filed `fix-a-b` under `fix-a`). Callers pass every form a task
   * answers to (`taskAuditForms`), for a whole subtree in one pass. Applied in
   * addition to `taskId` (a prefix match) when both are given.
   */
  taskIds?: string[];
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
  const byEndpoint = new Map<string, TokenGroup>();
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  const forms = options.taskIds ? new Set(options.taskIds) : null;
  for (const record of records) {
    if (options.sinceMs !== undefined && record.ts < options.sinceMs) continue;
    if (options.role !== undefined && (record.role ?? '') !== options.role) continue;
    if (options.taskId !== undefined && !(record.taskId ?? '').startsWith(options.taskId)) continue;
    if (forms) {
      const id = record.taskId ?? '';
      // Exact match on the task's attribution forms (id, short id, code) — a
      // prefix rule would file a record for `fix-a-b` under task `fix-a`.
      if (!id || !forms.has(id)) continue;
    }

    add(totals, record);
    bucket(byRole, record.role || UNATTRIBUTED, record);
    bucket(byTask, record.taskId || UNATTRIBUTED, record);
    bucket(byModel, record.model || UNATTRIBUTED, record);
    bucket(byEndpoint, record.servedByEndpoint || endpointOrigin(record.upstream), record);

    if (firstTs === null || record.ts < firstTs) firstTs = record.ts;
    if (lastTs === null || record.ts > lastTs) lastTs = record.ts;
  }

  return {
    totals,
    byRole: rank(byRole),
    byTask: rank(byTask),
    byModel: rank(byModel),
    byEndpoint: rank(byEndpoint),
    firstTs,
    lastTs,
  };
}

function endpointOrigin(upstream: string | null | undefined): string {
  if (!upstream) return UNATTRIBUTED;
  try {
    return new URL(upstream).origin;
  } catch {
    // Not a URL (a test double): the raw value still names the upstream.
    return upstream;
  }
}
