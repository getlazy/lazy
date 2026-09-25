/**
 * In-memory, per-task tally of the model traffic a turn is generating RIGHT NOW.
 *
 * Nothing durable exists mid-turn: `Turn.usage` and `Session.total_usage` are
 * both written by the reconciler when a turn ENDS, so a counter fed from the
 * task store only ever moves once, at the end. The proxy, however, already sees
 * every model request an agent makes — it parses usage out of both the plain
 * and the streaming response shapes, and tags each record with the task from the
 * `x-lazy-task-id` header. This module taps that stream as it flows, which is
 * exactly what `src/proxy/audit-log.ts` says to do rather than re-reading the
 * file.
 *
 * Three properties this has to have, and how each is met:
 *
 *   - COSTS NOTHING WHEN IDLE. There is no timer and no I/O here. The only work
 *     is one addition on a request the proxy was already forwarding, and it
 *     never touches the daemon→supervisor channel.
 *   - BOUNDED. A ring per task, an LRU over tasks, and evicted entries folded
 *     into an aggregate rather than dropped. A daemon that runs for a month
 *     cannot grow here.
 *   - NEVER DOUBLE-COUNTS. Entries are timestamped and a read sums only those
 *     after the caller's boundary — the last recorded turn. When the turn ends
 *     and its usage lands in `session.total_usage`, the same entries fall behind
 *     the new boundary and the live number drops to zero as the durable one
 *     rises. That is why there is no reset hook in the reconciler: turn-end has
 *     several paths, and a counter needing a call in each would be wrong in
 *     whichever one was forgotten.
 *
 * This is disposable telemetry, not state: it lives only in the daemon process
 * and a restart simply starts the tally over. Nothing is read back from it that
 * a user would lose.
 */

import type { ProxyAuditRecord } from '../storage/types';
import type { AuditSink } from '../proxy/audit';

/** Requests remembered individually per task before the oldest fold into the aggregate. */
const RING_CAPACITY = 512;

/** How many tasks are tracked at once; the least recently touched is dropped. */
const MAX_TASKS = 64;

export interface TaskProgressTotals {
  /** Model API requests counted. */
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Sum of the four counters — what "tokens" means on a progress readout. */
  totalTokens: number;
}

interface Entry extends TaskProgressTotals {
  ts: number;
}

interface TaskRing {
  entries: Entry[];
  /** Insert position; the ring is full once `entries.length === RING_CAPACITY`. */
  next: number;
  /** Everything evicted from the ring, already summed. */
  overflow: TaskProgressTotals;
  /** Timestamp of the newest entry folded into `overflow`, or 0 when empty. */
  overflowUntilTs: number;
  /** Last time this task was written to — the LRU key. */
  touchedAt: number;
}

function emptyTotals(): TaskProgressTotals {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
  };
}

function addInto(target: TaskProgressTotals, source: TaskProgressTotals): void {
  target.requests += source.requests;
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheCreationTokens += source.cacheCreationTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.totalTokens += source.totalTokens;
}

/**
 * The tally itself. One instance per daemon process (see `taskProgress` below);
 * exported as a class so tests can drive one without touching global state.
 */
export class TaskProgressTracker {
  private tasks = new Map<string, TaskRing>();

  /**
   * Count one completed model request. Called from the proxy's audit tee, on
   * the hot path — it must stay allocation-light and must never throw.
   */
  record(record: ProxyAuditRecord): void {
    const taskId = record.taskId;
    // Traffic we cannot attribute to a task is not this module's business —
    // the audit log still has it, and a per-task counter has nowhere to put it.
    if (!taskId) return;

    const usage = record.usage;
    const entry: Entry = {
      ts: record.ts,
      requests: 1,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      cacheCreationTokens: usage?.cacheCreationInputTokens ?? 0,
      cacheReadTokens: usage?.cacheReadInputTokens ?? 0,
      totalTokens: 0,
    };
    entry.totalTokens =
      entry.inputTokens + entry.outputTokens + entry.cacheCreationTokens + entry.cacheReadTokens;

    const ring = this.ringFor(taskId, record.ts);

    if (ring.entries.length < RING_CAPACITY) {
      ring.entries.push(entry);
      return;
    }

    // Full: the slot about to be overwritten is the oldest, so fold it away
    // rather than dropping it. `overflowUntilTs` records how far the aggregate
    // reaches, which is what lets a read decide whether it applies.
    const evicted = ring.entries[ring.next]!;
    addInto(ring.overflow, evicted);
    if (evicted.ts > ring.overflowUntilTs) ring.overflowUntilTs = evicted.ts;
    ring.entries[ring.next] = entry;
    ring.next = (ring.next + 1) % RING_CAPACITY;
  }

  /**
   * Everything counted for this task strictly after `sinceTs` — i.e. the turn
   * currently in flight, when the caller passes the last recorded turn's time.
   *
   * Task ids are matched by prefix in either direction, because the header the
   * proxy records may carry a short id while the caller holds the full one (the
   * same allowance `src/proxy/aggregate.ts` makes).
   *
   * The aggregate of evicted entries is included whole when the boundary falls
   * inside its range. That can only over-count after more than RING_CAPACITY
   * requests in a single turn, and over-counting there is the honest failure:
   * silently under-reporting a very long turn would be worse.
   */
  since(taskId: string, sinceTs: number): TaskProgressTotals {
    const totals = emptyTotals();
    if (!taskId) return totals;

    for (const [key, ring] of this.tasks) {
      if (!idsMatch(key, taskId)) continue;
      for (const entry of ring.entries) {
        if (entry.ts > sinceTs) addInto(totals, entry);
      }
      if (ring.overflow.requests > 0 && sinceTs < ring.overflowUntilTs) {
        addInto(totals, ring.overflow);
      }
    }
    return totals;
  }

  /** Test/diagnostic seam: how many tasks are currently held. */
  get size(): number {
    return this.tasks.size;
  }

  /** Drop everything. Tests only — nothing in production needs to forget. */
  reset(): void {
    this.tasks.clear();
  }

  private ringFor(taskId: string, ts: number): TaskRing {
    const existing = this.tasks.get(taskId);
    if (existing) {
      existing.touchedAt = ts;
      return existing;
    }

    if (this.tasks.size >= MAX_TASKS) this.evictOldest();

    const ring: TaskRing = {
      entries: [],
      next: 0,
      overflow: emptyTotals(),
      overflowUntilTs: 0,
      touchedAt: ts,
    };
    this.tasks.set(taskId, ring);
    return ring;
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTs = Infinity;
    for (const [key, ring] of this.tasks) {
      if (ring.touchedAt < oldestTs) {
        oldestTs = ring.touchedAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) this.tasks.delete(oldestKey);
  }
}

function idsMatch(a: string, b: string): boolean {
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/** The daemon's tally. One per process; inert until the proxy feeds it. */
export const taskProgress = new TaskProgressTracker();

/**
 * Wrap an audit sink so every record it receives is also counted.
 *
 * The wrapper is deliberately transparent: the record is passed through
 * untouched and the real sink's result — including its errors — is what the
 * caller sees. Counting happens first and cannot throw (the tracker only does
 * arithmetic), so a tally can never cost the daemon an audit line.
 */
export function teeTaskProgress(sink: AuditSink, tracker = taskProgress): AuditSink {
  return {
    async append(record: ProxyAuditRecord): Promise<void> {
      tracker.record(record);
      await sink.append(record);
    },
  };
}
