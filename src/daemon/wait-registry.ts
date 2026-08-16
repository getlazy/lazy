/**
 * Daemon-side registry of in-flight BLOCKING lazy-tool calls.
 *
 * When an agent decomposes its work into subtasks, it drives them with blocking
 * lazy tools — `lazy_wait` (long-poll until a subtask finishes its turn) and
 * `lazy_ask` (resume a subtask's agent and wait for its answer). For that whole
 * duration the parent agent is doing nothing at all, yet every read surface
 * showed it as `working(agent)`, indistinguishable from an agent thinking hard.
 *
 * The daemon does not have to guess at this and does not have to read a single
 * byte of agent output: every agent tool call authenticates with a per-session
 * MCP token, so `handleMcpToolCall` knows exactly WHICH task is blocking, on
 * WHAT, and for how long. This module turns that into two things:
 *
 *   1. A live marker in the task's protocol dir (`waiting.json`) that every read
 *      surface folds into `working(waiting on <task>)`.
 *   2. A durable interval in Storage, so duration/economics reports can subtract
 *      waited time from an agent's wall-clock instead of billing an agent for
 *      the hours its subtasks took.
 *
 * INVARIANT — bookkeeping must never break the call it observes. Every failure
 * in here is caught and logged: a wait that cannot be recorded still waits, and
 * an agent must never lose `lazy_wait` because an observability write failed.
 *
 * CLEARING: `endWait` runs from the caller's `finally`, so it fires when the
 * call SETTLES — including when the MCP client already disconnected and the
 * daemon finished the work anyway (complete-anyway semantics). Clearing only on
 * successful response delivery would leave a permanent `waiting` marker on
 * exactly the calls most likely to strand.
 */

import { randomUUID } from 'crypto';
import type { Storage } from '../storage/interface';
import type { WaitOutcome } from '../types';
import { protocolDir, writeWaitingFile, clearWaitingFile, type WaitingEntry } from '../protocol';
import { logger } from '../utils/logger';

/** Tools whose whole duration is the caller sitting blocked on another task. */
export const BLOCKING_WAIT_TOOLS: ReadonlySet<string> = new Set(['lazy_wait', 'lazy_ask']);

interface ActiveWait extends WaitingEntry {
  /** True once the durable start record landed — the end record is skipped otherwise. */
  persisted: boolean;
}

/** taskId → waitId → wait. In-memory mirror of every `waiting.json` we own. */
const active = new Map<string, Map<string, ActiveWait>>();

/**
 * Per-task serialization of protocol-file writes. Two concurrent `lazy_wait`
 * calls from the same session are normal (the MCP server dispatches requests
 * concurrently), and their file writes must not interleave or reorder.
 */
const writeChains = new Map<string, Promise<void>>();

function serializeWrite(taskId: string, op: () => Promise<void>): Promise<void> {
  const prev = writeChains.get(taskId) ?? Promise.resolve();
  const next = prev.then(op, op).catch(err => {
    // Observational only — a failed marker write degrades the substate to
    // `working(agent)`, which is what it was before this existed.
    logger.warn(`wait-registry: failed to update waiting marker for ${taskId}: ${(err as Error).message}`);
  });
  writeChains.set(taskId, next);
  return next;
}

/** Push the current in-memory set for a task out to its `waiting.json`. */
async function flush(taskId: string): Promise<void> {
  await serializeWrite(taskId, async () => {
    const waits = active.get(taskId);
    const dir = protocolDir(taskId);
    if (!waits || waits.size === 0) {
      await clearWaitingFile(dir);
      return;
    }
    await writeWaitingFile(dir, {
      version: 1,
      daemon_pid: process.pid,
      waits: [...waits.values()].map(({ persisted, ...entry }) => {
        void persisted;
        return entry;
      }),
    });
  });
}

export interface BeginWaitOptions {
  storage: Storage;
  /** The WAITING task (the authenticated caller), never the task waited on. */
  taskId: string;
  /** MCP tool name, e.g. `lazy_wait`. */
  tool: string;
  /** Tasks being waited on: resolved id plus a human label (code or short id). */
  targets: { id: string; label: string }[];
}

/**
 * Register the start of a blocking call. Returns the wait id to pass to
 * {@link endWait}, or null when nothing was registered (bookkeeping failed) —
 * the caller still runs the tool either way.
 */
export async function beginWait(opts: BeginWaitOptions): Promise<string | null> {
  const { storage, taskId, tool, targets } = opts;
  const id = randomUUID();
  const startedAt = new Date().toISOString();

  const entry: ActiveWait = {
    id,
    tool,
    targets: targets.map(t => t.id),
    labels: targets.map(t => t.label),
    started_at: startedAt,
    persisted: false,
  };

  let waits = active.get(taskId);
  if (!waits) {
    waits = new Map();
    active.set(taskId, waits);
  }
  waits.set(id, entry);

  try {
    // Session/turn attribution: agent turns are only written when the turn ENDS,
    // so the sequence the in-flight turn will receive is the next unused one.
    // Best-effort by construction — see WaitInterval.turn_sequence.
    const session = await storage.getSessionByTaskId(taskId);
    const sessionId = session?.id ?? null;
    const turnSequence = sessionId ? await storage.getNextTurnSequence(sessionId) : null;
    await storage.recordWaitStart({
      id,
      task_id: taskId,
      session_id: sessionId,
      turn_sequence: turnSequence,
      tool,
      waited_on: entry.targets,
      waited_on_labels: entry.labels,
      started_at: startedAt,
    });
    entry.persisted = true;
  } catch (err) {
    logger.warn(`wait-registry: failed to persist wait start for ${taskId}: ${(err as Error).message}`);
  }

  await flush(taskId);
  return id;
}

/**
 * Register that a blocking call has settled. Safe to call with a null id (the
 * begin failed) or an unknown id (already settled) — both are no-ops.
 */
export async function endWait(
  storage: Storage,
  taskId: string,
  id: string | null,
  outcome: WaitOutcome,
): Promise<void> {
  if (!id) return;
  const waits = active.get(taskId);
  const entry = waits?.get(id);
  if (waits) {
    waits.delete(id);
    if (waits.size === 0) active.delete(taskId);
  }

  if (entry?.persisted) {
    try {
      await storage.recordWaitEnd(id, new Date().toISOString(), outcome);
    } catch (err) {
      // The interval stays open in storage. That reads as "died mid-wait",
      // which is a documented state — better than failing the agent's call.
      logger.warn(`wait-registry: failed to persist wait end for ${taskId}: ${(err as Error).message}`);
    }
  }

  await flush(taskId);
}

/**
 * Run a blocking tool call with wait bookkeeping around it.
 *
 * The whole contract lives in the `finally`: the wait is cleared when the call
 * SETTLES, not when its response is delivered. The daemon finishes a call whose
 * MCP client already disconnected, and clearing on delivery would leave a
 * permanent `waiting` marker on exactly those calls.
 */
export async function trackWait<T>(opts: BeginWaitOptions, run: () => Promise<T>): Promise<T> {
  const id = await beginWait(opts);
  let outcome: WaitOutcome = 'completed';
  try {
    return await run();
  } catch (err) {
    outcome = 'error';
    throw err;
  } finally {
    await endWait(opts.storage, opts.taskId, id, outcome);
  }
}

/** In-flight waits for a task — test/diagnostic accessor. */
export function activeWaitsFor(taskId: string): WaitingEntry[] {
  return [...(active.get(taskId)?.values() ?? [])].map(({ persisted, ...entry }) => {
    void persisted;
    return entry;
  });
}

/**
 * Drop all in-memory state and clear every marker this daemon owns. Called on
 * daemon shutdown so a clean stop does not leave markers that readers must fall
 * back to the pid check to disbelieve.
 */
export async function clearAllWaits(): Promise<void> {
  const taskIds = [...active.keys()];
  active.clear();
  await Promise.all(taskIds.map(taskId => flush(taskId)));
}
