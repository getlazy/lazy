/**
 * How big the injected memory context is, and what the compact does not cover
 * — the ANSWER every memory surface renders.
 *
 * Two surfaces show it: the daemon dashboard's memory pages (src/server/memory.ts)
 * and Lazy Teams' (over the `memoryStatus` RPC, src/daemon/rpc-memory.ts). Both
 * render from {@link memoryStatusPayload}, including its prose lines, so the two
 * can never disagree about a size, a threshold, or which records the compact
 * misses. A client re-deriving any of it would be a second opinion about what
 * gets injected into every agent's prompt.
 */

import type { MemoryCompact, MemoryRecord } from '../types';
import {
  assembleMemorySection,
  elideMemoryDescription,
  formatBytes,
  isLiveMemory,
  namesRemovedSinceCompact,
  recordsNewerThanCompact,
} from './index';

/** How a description is shortened in an index line — display only, never stored. */
export const INDEX_DESCRIPTION_WIDTH = 80;

/** `YYYY-MM-DD HH:MM` in UTC — the one date spelling the memory surfaces use. */
export function formatMemoryDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/**
 * Doctor-style measurement of the injected context: size vs `[memory] warn_bytes`,
 * whether a compact exists, and how stale it is. Same helpers doctor uses, so
 * the banner and `lazy doctor`'s memory line cannot disagree.
 */
export function memoryContextStatus(
  records: MemoryRecord[],
  compact: MemoryCompact | null,
  warnBytes: number,
): {
  bytes: number;
  warnBytes: number;
  overThreshold: boolean;
  liveCount: number;
  newerCount: number;
  removedCount: number;
  compactSummary: string;
  stale: boolean;
} {
  const liveCount = records.filter(isLiveMemory).length;
  const measured = assembleMemorySection(records, 'builder', { compact, warnBytes }).measured;
  const newer = compact ? recordsNewerThanCompact(records, compact) : [];
  const removed = compact ? namesRemovedSinceCompact(records, compact) : [];
  const stale = compact ? newer.length > 0 || removed.length > 0 : liveCount > 0;
  const compactSummary = compact
    ? `${compact.method} compact generated ${formatMemoryDate(compact.generated_at)}, covering ${compact.covered.length} record(s)`
    : 'No compact — the full record index is injected';
  return {
    bytes: measured.bytes,
    warnBytes: measured.warnBytes,
    overThreshold: measured.overThreshold,
    liveCount,
    newerCount: newer.length,
    removedCount: removed.length,
    compactSummary,
    stale,
  };
}

/** One record the compact does not cover, as an index line shows it. */
export interface MemoryStatusRecordLine {
  name: string;
  type: string;
  description: string;
}

/** What the `memoryStatus` RPC answers, and what the dashboard renders. */
export interface MemoryStatusPayload {
  liveCount: number;
  bytes: number;
  warnBytes: number;
  overThreshold: boolean;
  /** Injected bytes with NO compact — the plain one-line index. */
  plainBytes: number;
  stale: boolean;
  compactSummary: string;
  /**
   * The index page's one-line banner, without the over-threshold marker (a
   * surface renders `overThreshold` as its own badge). Null when there are no
   * live records, where the dashboard shows no banner at all.
   */
  bannerText: string | null;
  /** The compact page's size sentence. */
  sizeLine: string;
  /** Records written or updated since the compact — injected as live index lines. */
  newer: MemoryStatusRecordLine[];
  /** Records removed since the compact — injection flags them as gone. */
  removed: string[];
}

export function memoryStatusPayload(
  records: MemoryRecord[],
  compact: MemoryCompact | null,
  warnBytes: number,
): MemoryStatusPayload {
  const status = memoryContextStatus(records, compact, warnBytes);
  const plainBytes = assembleMemorySection(records, 'builder', { compact: null, warnBytes }).measured.bytes;
  const newer = compact ? recordsNewerThanCompact(records, compact) : [];
  const removed = compact ? namesRemovedSinceCompact(records, compact) : [];

  const size = `${formatBytes(status.bytes)} of ${formatBytes(status.warnBytes)} advisory threshold`;
  const extra = compact && status.newerCount > 0
    ? ` · ${status.newerCount} record(s) written since it are injected as live index lines`
    : '';
  const bannerText = status.liveCount === 0
    ? null
    : `Injected context: ${size}. ${status.compactSummary}${extra}.`;

  const sizeLine = `Injected context: ${formatBytes(status.bytes)} with ${compact ? 'this compact' : 'the full index'}, ` +
    `${formatBytes(plainBytes)} without a compact ` +
    `(advisory threshold ${formatBytes(warnBytes)}).`;

  return {
    liveCount: status.liveCount,
    bytes: status.bytes,
    warnBytes: status.warnBytes,
    overThreshold: status.overThreshold,
    plainBytes,
    stale: status.stale,
    compactSummary: status.compactSummary,
    bannerText,
    sizeLine,
    newer: newer.map((r) => ({
      name: r.name,
      type: r.type,
      description: elideMemoryDescription(r.description, INDEX_DESCRIPTION_WIDTH),
    })),
    removed,
  };
}

/**
 * The one-line outcome of a compact run with its sizes — what the dashboard's
 * stream prints and what Teams shows after a run.
 */
export function compactRunSizeLine(result: {
  saved: MemoryCompact | null;
  rejected: boolean;
  beforeBytes: number;
  afterBytes: number;
  plainBytes: number;
  warnBytes: number;
}): string {
  // A REJECTED run hands back the PREVIOUS compact as `saved`, so "was one
  // written" is `!rejected`, not `saved !== null`.
  return result.saved && !result.rejected
    ? `injected context: ${formatBytes(result.beforeBytes)} → ${formatBytes(result.afterBytes)} (advisory threshold ${formatBytes(result.warnBytes)})`
    : `injected context unchanged at ${formatBytes(result.beforeBytes)} (without a compact it would be ${formatBytes(result.plainBytes)})`;
}
