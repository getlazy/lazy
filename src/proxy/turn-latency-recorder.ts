/**
 * Folds every audited proxy request into its task's running-turn latency
 * rollup (src/task/turn-latency.ts), off the request path.
 *
 * IN MEMORY, FLUSHED AS A DELTA. `observe()` is synchronous: it folds the
 * record into a per-task in-memory DELTA and returns — no I/O, no body
 * buffered, nothing the request waits on. The delta is merged into the store
 * (`Storage.mergeOpenTurnLatency`) every {@link TURN_LATENCY_FLUSH_MS}, and
 * at once when a turn's row is about to be written ({@link flushTurnLatency},
 * called by the daemon's agent-turn writer), so the turn closes with
 * everything its requests produced. A crash loses at most one flush interval.
 *
 * Merging a delta rather than saving a whole record is what makes the turn
 * boundary safe: the storage close and a flush are serialised by the store's
 * lock, so each delta lands wholly in one turn. A failed flush keeps its
 * delta and retries on the next tick — nothing is dropped for a transient
 * storage error, and nothing is counted twice, because a write either
 * happened (atomically) or did not.
 */

import type { ProxyAuditRecord } from '../storage/types';
import { TURN_LATENCY_NO_TASK, classifyAudit, emptyRollup, foldAudit, mergeRollup, type TurnLatencyRollup } from '../task/turn-latency';
import { logger } from '../utils/logger';

/** How often buffered deltas reach the store. */
export const TURN_LATENCY_FLUSH_MS = 10_000;

export interface TurnLatencyStore {
  mergeOpenTurnLatency(taskId: string, delta: TurnLatencyRollup): Promise<void>;
}

export class ProxyTurnLatencyRecorder {
  private readonly store: TurnLatencyStore;
  private readonly deltas = new Map<string, TurnLatencyRollup>();
  /** Per-task flush chain, so two flushes of one task never interleave. */
  private readonly chains = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastFailure: string | null = null;

  constructor(store: TurnLatencyStore, opts: { intervalMs?: number } = {}) {
    this.store = store;
    const interval = opts.intervalMs ?? TURN_LATENCY_FLUSH_MS;
    if (interval > 0) {
      this.timer = setInterval(() => void this.flush(), interval);
      // Statistics never keep a process alive on their own.
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  /** Fold one record. Returns immediately. */
  observe(record: ProxyAuditRecord): void {
    if (classifyAudit(record) === 'ignore') return;
    const taskId = record.taskId!;
    let delta = this.deltas.get(taskId);
    if (!delta) {
      delta = emptyRollup();
      this.deltas.set(taskId, delta);
    }
    foldAudit(delta, record);
  }

  /** Push one task's buffered delta to the store. Never throws. */
  flushTask(taskId: string): Promise<void> {
    const previous = this.chains.get(taskId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const delta = this.deltas.get(taskId);
      if (!delta) return;
      this.deltas.delete(taskId);
      try {
        await this.store.mergeOpenTurnLatency(taskId, delta);
        this.lastFailure = null;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes(TURN_LATENCY_NO_TASK)) {
          // No task to file it under — retrying would fail forever. Dropped.
          logger.warn(`[proxy] turn latency for "${taskId}" dropped: ${message}.`);
          return;
        }
        // Put it back IN FRONT of anything folded meanwhile, for the next try.
        const later = this.deltas.get(taskId);
        if (later) mergeRollup(delta, later);
        this.deltas.set(taskId, delta);
        if (message !== this.lastFailure) {
          this.lastFailure = message;
          logger.warn(
            `[proxy] turn latency for task ${taskId.slice(0, 8)} not saved yet: ${message}. ` +
              `Requests are unaffected; it is retried on the next flush.`,
          );
        }
      }
    });
    this.chains.set(taskId, next);
    void next.finally(() => {
      if (this.chains.get(taskId) === next) this.chains.delete(taskId);
    });
    return next;
  }

  /** Flush every task with a buffered delta. */
  async flush(): Promise<void> {
    await Promise.all([...this.deltas.keys()].map((id) => this.flushTask(id)));
  }

  /** Tasks with a delta not yet in the store. */
  pendingTaskIds(): string[] {
    return [...this.deltas.keys()];
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** The daemon's recorder, so the agent-turn writer can flush before a turn closes. */
let active: ProxyTurnLatencyRecorder | null = null;

export function setActiveTurnLatencyRecorder(recorder: ProxyTurnLatencyRecorder | null): void {
  active = recorder;
}

/**
 * Flush EVERY buffered delta before a turn row is written. Resolves whatever
 * happens (a failure is retried by the recorder itself), and does nothing in a
 * process with no proxy.
 *
 * All of them, not just this task's: audit records carry the launch grant's
 * task REFERENCE (usually the task code), which cannot be matched to the
 * session's task UUID here — and a flush is one small merge per busy task.
 */
export async function flushTurnLatency(): Promise<void> {
  if (!active) return;
  await active.flush();
}

export function getActiveTurnLatencyRecorder(): ProxyTurnLatencyRecorder | null {
  return active;
}
