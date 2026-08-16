/**
 * Shared JSONL persistence for wait intervals, used by every Storage backend.
 *
 * A wait interval is one stretch of time an agent sat BLOCKED on another task
 * (see {@link WaitInterval}). Records live in
 * `<storagePath>/waits/intervals.jsonl`, append-only and newline-delimited.
 *
 * The file is EVENT-structured, not row-structured: a wait writes one `start`
 * line when it begins and one `end` line when it settles, folded back together
 * on read. That is what makes a crash readable — an interval whose `end` line
 * never arrived reads back with `ended_at: null` instead of vanishing (or, with
 * a rewrite-in-place design, corrupting the whole file). Whole-line appends of a
 * few hundred bytes are atomic on local filesystems, so concurrent writers do
 * not interleave partial lines.
 *
 * Kept out of the individual backend classes — same reasoning as
 * `src/storage/trace-spans.ts` — so the three implementations stay one-liners
 * delegating here with their own storage path.
 */
import { join } from 'path';
import { mkdir, appendFile, readFile, stat, writeFile, rename } from 'fs/promises';
import type { WaitInterval, WaitOutcome } from '../types';

/** Fields known when a wait begins. The rest are filled by the end record. */
export type WaitIntervalStart = Omit<WaitInterval, 'ended_at' | 'outcome'>;

/**
 * Retention bounds (bytes of the intervals JSONL).
 *
 * A wait record is ~250 bytes and one interval is two of them, so 8 MB retains
 * on the order of 16,000 waits — far more history than any report needs. Pruning
 * runs only once the file passes 2× the target, so the cost on a normal append
 * is a single `stat`.
 *
 * Pruning drops WHOLE intervals, oldest first: dropping half an interval would
 * leave a dangling `end` line that folds into a phantom zero-start record.
 */
export const WAIT_PRUNE_TRIGGER_BYTES = 16 * 1024 * 1024;
export const WAIT_PRUNE_TARGET_BYTES = 8 * 1024 * 1024;

/** Overridable bounds — production uses the defaults; tests inject small ones. */
export interface WaitRetentionBounds {
  triggerBytes: number;
  targetBytes: number;
}

const DEFAULT_BOUNDS: WaitRetentionBounds = {
  triggerBytes: WAIT_PRUNE_TRIGGER_BYTES,
  targetBytes: WAIT_PRUNE_TARGET_BYTES,
};

/** Filter for {@link readWaitIntervalsJsonl}. */
export interface WaitIntervalFilter {
  taskId?: string;
  sessionId?: string;
}

type WaitEvent =
  | ({ kind: 'start' } & WaitIntervalStart)
  | { kind: 'end'; id: string; ended_at: string; outcome: WaitOutcome };

function waitsDir(storagePath: string): string {
  return join(storagePath, 'waits');
}

function intervalsFile(storagePath: string): string {
  return join(waitsDir(storagePath), 'intervals.jsonl');
}

async function appendEvent(
  storagePath: string,
  event: WaitEvent,
  bounds: WaitRetentionBounds,
): Promise<void> {
  await mkdir(waitsDir(storagePath), { recursive: true });
  await appendFile(intervalsFile(storagePath), JSON.stringify(event) + '\n', 'utf-8');
  await pruneIntervalsJsonl(storagePath, bounds);
}

/** Record the start of a wait. */
export async function appendWaitStartJsonl(
  storagePath: string,
  start: WaitIntervalStart,
  bounds: WaitRetentionBounds = DEFAULT_BOUNDS,
): Promise<void> {
  await appendEvent(storagePath, { kind: 'start', ...start }, bounds);
}

/**
 * Record the settling of a wait. A `end` whose `start` is unknown (pruned away,
 * or written by a daemon whose store was reset) folds to nothing on read — it is
 * dropped rather than materialized as an interval with no beginning.
 */
export async function appendWaitEndJsonl(
  storagePath: string,
  id: string,
  endedAt: string,
  outcome: WaitOutcome,
  bounds: WaitRetentionBounds = DEFAULT_BOUNDS,
): Promise<void> {
  await appendEvent(storagePath, { kind: 'end', id, ended_at: endedAt, outcome }, bounds);
}

/**
 * Read wait intervals in start order, folding each `start`/`end` pair.
 *
 * An interval with no `end` record comes back with `ended_at: null` and
 * `outcome: null` — that is the documented "died mid-wait" shape, not an error.
 * A missing file yields an empty list (nothing has waited yet).
 */
export async function readWaitIntervalsJsonl(
  storagePath: string,
  filter?: WaitIntervalFilter,
): Promise<WaitInterval[]> {
  let raw: string;
  try {
    raw = await readFile(intervalsFile(storagePath), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(
      `Failed to read wait intervals at ${intervalsFile(storagePath)}: ${(err as Error).message}`,
    );
  }

  const order: string[] = [];
  const byId = new Map<string, WaitInterval>();
  for (const event of parseEvents(raw)) {
    if (event.kind === 'start') {
      const { kind, ...start } = event;
      void kind;
      if (!byId.has(start.id)) order.push(start.id);
      byId.set(start.id, { ...start, ended_at: null, outcome: null });
    } else {
      const existing = byId.get(event.id);
      // An end with no start is dropped: see the doc comment above.
      if (!existing) continue;
      existing.ended_at = event.ended_at;
      existing.outcome = event.outcome;
    }
  }

  const out: WaitInterval[] = [];
  for (const id of order) {
    const interval = byId.get(id)!;
    if (filter?.taskId && interval.task_id !== filter.taskId) continue;
    if (filter?.sessionId && interval.session_id !== filter.sessionId) continue;
    out.push(interval);
  }
  return out;
}

function parseEvents(raw: string): WaitEvent[] {
  const out: WaitEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as WaitEvent);
    } catch {
      // A torn final line (crash mid-append) is skipped rather than fatal —
      // partial accounting data must never break the readout.
      continue;
    }
  }
  return out;
}

/**
 * Drop the oldest whole intervals once the store passes the trigger, bringing it
 * back under the target. The rewrite is atomic (temp file + rename): a crash
 * mid-prune leaves the previous complete file rather than a truncated one.
 */
async function pruneIntervalsJsonl(
  storagePath: string,
  bounds: WaitRetentionBounds,
): Promise<void> {
  const file = intervalsFile(storagePath);
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error(`Failed to stat wait intervals at ${file}: ${(err as Error).message}`);
  }
  if (size <= bounds.triggerBytes) return;

  const raw = await readFile(file, 'utf-8');

  interface Group { lines: string[]; bytes: number; seq: number }
  const groups = new Map<string, Group>();
  let seq = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let event: WaitEvent;
    try {
      event = JSON.parse(line) as WaitEvent;
    } catch {
      continue; // torn line — drop it as part of the rewrite
    }
    let g = groups.get(event.id);
    if (!g) {
      g = { lines: [], bytes: 0, seq: seq++ };
      groups.set(event.id, g);
    }
    g.lines.push(line);
    g.bytes += Buffer.byteLength(line, 'utf-8') + 1;
  }

  // Keep the newest intervals (highest first-seen sequence) up to the target.
  const ordered = [...groups.values()].sort((a, b) => b.seq - a.seq);
  const kept: Group[] = [];
  let total = 0;
  for (const g of ordered) {
    if (total + g.bytes > bounds.targetBytes) break;
    kept.push(g);
    total += g.bytes;
  }

  // Restore append order so the file stays chronological.
  kept.sort((a, b) => a.seq - b.seq);
  const out = kept.flatMap(g => g.lines).join('\n') + (kept.length ? '\n' : '');

  const tmp = `${file}.tmp`;
  await writeFile(tmp, out, 'utf-8');
  await rename(tmp, file);
}
