/**
 * Shared JSONL persistence for trace spans, used by every Storage backend.
 *
 * Spans are appended to `<storagePath>/traces/spans.jsonl`. Append-only,
 * newline-delimited: each finished span is one line. Whole-line appends of a
 * few hundred bytes are atomic on local filesystems, so the daemon and a CLI
 * process writing concurrently do not interleave partial lines (see the
 * concurrency note in docs/spikes/timings.md).
 *
 * Kept out of the individual backend classes so the three implementations
 * (file/postgres/remote) stay one-liners delegating here with their own
 * storage path — the Storage abstraction owns the API, this owns the format.
 */
import { join } from 'path';
import { mkdir, appendFile, readFile, stat, writeFile, rename } from 'fs/promises';
import type { SpanRecord } from '../tracing/types';

/**
 * Retention bounds. Tracing is always-on, so the store MUST be bounded.
 *
 * These are disk bytes for the spans JSONL under the storage path, and there is
 * one store per repo (one daemon per repo) — disk is cheap, history is useful,
 * so the bounds are generous. A span serializes to ~250–400 bytes and one
 * `lazy start` request is ~7 spans (~2.5 KB), so a 64 MB floor retains on the
 * order of 25,000 recent requests — months of real usage.
 *
 * We prune only when the file crosses 128 MB (2× the target) so the rewrite is
 * amortized: it runs once per ~64 MB written, not on every append. Worst-case
 * on-disk size is bounded by the 128 MB high-water mark plus one batch.
 *
 * Pruning is by WHOLE TRACES, newest first — never by raw line count. Dropping
 * half a trace would leave orphaned spans and a broken tree in `lazy stats timings`.
 */
export const PRUNE_TRIGGER_BYTES = 128 * 1024 * 1024;
export const PRUNE_TARGET_BYTES = 64 * 1024 * 1024;

/**
 * Overridable retention bounds. Production always uses the defaults above;
 * tests inject small values so they can exercise pruning without writing
 * hundreds of megabytes.
 */
export interface RetentionBounds {
  triggerBytes: number;
  targetBytes: number;
}

const DEFAULT_BOUNDS: RetentionBounds = {
  triggerBytes: PRUNE_TRIGGER_BYTES,
  targetBytes: PRUNE_TARGET_BYTES,
};

function tracesDir(storagePath: string): string {
  return join(storagePath, 'traces');
}

function spansFile(storagePath: string): string {
  return join(tracesDir(storagePath), 'spans.jsonl');
}

/**
 * Append finished spans as JSONL lines, then enforce retention. Creates the
 * traces dir on demand.
 */
export async function appendSpansJsonl(
  storagePath: string,
  spans: SpanRecord[],
  bounds: RetentionBounds = DEFAULT_BOUNDS,
): Promise<void> {
  if (spans.length === 0) return;
  await mkdir(tracesDir(storagePath), { recursive: true });
  const lines = spans.map((s) => JSON.stringify(s)).join('\n') + '\n';
  await appendFile(spansFile(storagePath), lines, 'utf-8');
  await pruneSpansJsonl(storagePath, bounds);
}

/**
 * Drop the oldest whole traces when the store grows past the trigger, bringing
 * it back under the target. No-op while the file is small (the common case), so
 * the cost on a normal append is a single `stat`.
 *
 * The rewrite is atomic (temp file + rename): a crash mid-prune leaves the
 * previous complete file in place rather than a truncated one. A span appended
 * concurrently with the rewrite can be lost — acceptable for telemetry, and in
 * practice the daemon is the single writer (see docs/spikes/timings.md).
 */
async function pruneSpansJsonl(storagePath: string, bounds: RetentionBounds): Promise<void> {
  const file = spansFile(storagePath);
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error(`Failed to stat trace spans at ${file}: ${(err as Error).message}`);
  }
  if (size <= bounds.triggerBytes) return;

  const raw = await readFile(file, 'utf-8');

  // Group lines by trace, tracking each trace's recency and byte cost. We keep
  // the raw line (not the parsed record) so rewriting is lossless.
  interface TraceGroup { lines: string[]; bytes: number; newest: number }
  const groups = new Map<string, TraceGroup>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec: SpanRecord;
    try {
      rec = JSON.parse(line) as SpanRecord;
    } catch {
      continue; // torn line — drop it as part of the rewrite
    }
    let g = groups.get(rec.trace_id);
    if (!g) {
      g = { lines: [], bytes: 0, newest: 0 };
      groups.set(rec.trace_id, g);
    }
    g.lines.push(line);
    g.bytes += Buffer.byteLength(line, 'utf-8') + 1;
    if (rec.end_ms > g.newest) g.newest = rec.end_ms;
  }

  // Keep newest traces until we'd exceed the target.
  const ordered = [...groups.values()].sort((a, b) => b.newest - a.newest);
  const kept: TraceGroup[] = [];
  let total = 0;
  for (const g of ordered) {
    if (total + g.bytes > bounds.targetBytes) break;
    kept.push(g);
    total += g.bytes;
  }

  // Restore chronological order so the file stays append-ordered.
  kept.sort((a, b) => a.newest - b.newest);
  const out = kept.flatMap((g) => g.lines).join('\n') + (kept.length ? '\n' : '');

  const tmp = `${file}.tmp`;
  await writeFile(tmp, out, 'utf-8');
  await rename(tmp, file);
}

/**
 * Read persisted spans, newest-appended last. `sinceMs` filters by start time;
 * a missing file yields an empty list (no traces recorded yet is not an error).
 */
export async function readSpansJsonl(storagePath: string, sinceMs?: number): Promise<SpanRecord[]> {
  let raw: string;
  try {
    raw = await readFile(spansFile(storagePath), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`Failed to read trace spans at ${spansFile(storagePath)}: ${(err as Error).message}`);
  }
  const out: SpanRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec: SpanRecord;
    try {
      rec = JSON.parse(line) as SpanRecord;
    } catch {
      // A torn final line (crash mid-append) is skipped rather than fatal —
      // partial trace data must never break the readout.
      continue;
    }
    if (sinceMs != null && rec.start_ms < sinceMs) continue;
    out.push(rec);
  }
  return out;
}
