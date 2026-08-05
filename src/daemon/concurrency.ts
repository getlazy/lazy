/**
 * Concurrency limits for agent-task and builder containers.
 *
 * Two independently-configurable caps (lazy.toml `[limits]`, default 8 each):
 *  - `max_concurrent_agents`  — concurrently *working* agent-task supervisors.
 *  - `max_concurrent_builders` — concurrent interactive builder containers.
 *
 * Rationale: when many tasks launch at once, Docker struggles (slow launches,
 * probe timeouts — see fix-resume-probe-flip). These caps are operational
 * backpressure, not a scheduler (see spike-night-scheduler for the distinct
 * scheduling concern).
 *
 * Slot model: a slot is held by each agent task that currently has a LIVE
 * supervisor container — tracked as a non-terminal task whose session carries a
 * `container_name` (plus in-flight reservations, below).
 *
 * Why live-container, not just `working`: a supervisor container is NOT torn
 * down when a turn finishes. The PID-1 wrapper restarts the one-shot supervisor,
 * which then blocks in `waitForCommand` with an infinite timeout, polling
 * `command.json` every 500ms (src/protocol/io.ts). A `blocked` task awaiting
 * human review therefore keeps a live, resident container. Since the cap exists
 * precisely to bound Docker load, those lingering containers MUST count —
 * otherwise a backlog of blocked-but-alive containers would blow past the cap
 * while `working` reads 0. `container_name` is cleared when a container is
 * removed (crash cleanup, terminal sweep, stop, or the idle reaper), so it
 * tracks the live set and self-corrects. The idle reaper
 * ({@link selectContainersToReap}, driven by the reconciler) frees these
 * lingering containers after a grace period, or immediately when higher-priority
 * work is queued, so idle containers never hold slots forever.
 *
 * Runtime override: the daemon holds an in-memory override per cap that
 * `lazy daemon config set` mutates over RPC. Overrides are EPHEMERAL — they live
 * only in the running daemon process and are lost on restart, which reverts to
 * lazy.toml. Nothing here writes lazy.toml.
 *
 * Agent enforcement lives in the daemon (that is where launches happen).
 * `tryAdmitAgentSlot` serializes the count→decide→reserve critical section under
 * a process-global mutex so two concurrent launches cannot both grab the last
 * slot, and a short-lived reservation set covers the window between "admitted"
 * and "status flipped to working" in storage.
 *
 * Builder enforcement is fail-fast at the client launch site — an interactive
 * session a human is waiting on must not be silently queued.
 */

import type { ResolvedConfig } from '../config/types';
import type { Storage } from '../storage';
import type { Task, TaskPriority } from '../types';
import { PRIORITY_RANK } from '../types';

/** The two configurable concurrency caps, keyed by their lazy.toml name. */
export type LimitKey = 'max_concurrent_agents' | 'max_concurrent_builders';

export const LIMIT_KEYS: readonly LimitKey[] = [
  'max_concurrent_agents',
  'max_concurrent_builders',
] as const;

// --- Ephemeral overrides (daemon-process memory only) ---

let agentLimitOverride: number | undefined;
let builderLimitOverride: number | undefined;

/** Set (or clear, with `undefined`) the ephemeral override for a cap. */
export function setLimitOverride(key: LimitKey, value: number | undefined): void {
  if (key === 'max_concurrent_agents') agentLimitOverride = value;
  else builderLimitOverride = value;
}

/** The current ephemeral override for a cap, or undefined when none is set. */
export function getLimitOverride(key: LimitKey): number | undefined {
  return key === 'max_concurrent_agents' ? agentLimitOverride : builderLimitOverride;
}

/** Effective agent cap: ephemeral override if set, else the lazy.toml value. */
export function effectiveAgentLimit(config: ResolvedConfig): number {
  return agentLimitOverride ?? config.limits.max_concurrent_agents;
}

/** Effective builder cap: ephemeral override if set, else the lazy.toml value. */
export function effectiveBuilderLimit(config: ResolvedConfig): number {
  return builderLimitOverride ?? config.limits.max_concurrent_builders;
}

/** Test-only: clear all ephemeral overrides and reservations. */
export function resetConcurrencyStateForTest(): void {
  agentLimitOverride = undefined;
  builderLimitOverride = undefined;
  reservedSlots.clear();
}

// --- Agent slot accounting ---

/** Task IDs mid-launch: admitted but not yet flipped to `working` in storage. */
const reservedSlots = new Set<string>();

/** Serialize the count→decide→reserve critical section (daemon is single-process). */
let lockTail: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = lockTail.then(fn, fn);
  // Keep the chain alive regardless of outcome so a rejection never wedges it.
  lockTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Count agent slots in use: distinct tasks that currently hold a LIVE supervisor
 * container (non-terminal + session `container_name` set) OR are reserved
 * mid-launch. This counts blocked-but-alive containers too — see the slot-model
 * note above. Exported for unit testing and for the reconciler drain /
 * `lazy daemon config` reporting.
 */
export async function countActiveAgents(storage: Storage): Promise<number> {
  const tasks = await storage.listTasksWithOptions({ nonTerminalOnly: true });
  const ids = new Set<string>();
  for (const task of tasks) {
    // A queued task never has a container; skip the session lookup for it.
    if (task.status === 'queued') continue;
    const session = await storage.getSessionByTaskId(task.id);
    if (session?.container_name) ids.add(task.id);
  }
  for (const id of reservedSlots) ids.add(id);
  return ids.size;
}

export interface SlotDecision {
  /** True if the task may launch now. */
  admitted: boolean;
  /** Slots in use AFTER this decision (a newly-admitted task is counted). */
  running: number;
  /** The effective cap this decision was made against. */
  limit: number;
}

/**
 * Pure slot decision — exported for unit tests.
 *
 * @param running       Slots in use right now (working + reserved), NOT counting
 *                      this task when it is new.
 * @param limit         The effective cap.
 * @param alreadyRunning True when this task already holds a slot (idempotent
 *                      relaunch of a working/reserved task — never consumes a new
 *                      one, so it is always admitted).
 */
export function decideAgentSlot(
  running: number,
  limit: number,
  alreadyRunning: boolean,
): SlotDecision {
  if (alreadyRunning) return { admitted: true, running, limit };
  if (running >= limit) return { admitted: false, running, limit };
  return { admitted: true, running: running + 1, limit };
}

/**
 * Atomically decide whether `taskId` may launch now and, if so, reserve its slot.
 *
 * Call {@link releaseAgentSlot} once the launch has flipped the task to `working`
 * in storage (or failed). Re-entrant: a task already `working` or reserved is
 * always admitted without consuming a new slot, so an idempotent relaunch of a
 * running task never trips the cap.
 */
export async function tryAdmitAgentSlot(
  storage: Storage,
  taskId: string,
  limit: number,
): Promise<SlotDecision> {
  return withLock(async () => {
    const task = await storage.getTask(taskId);
    const already = task?.status === 'working' || reservedSlots.has(taskId);
    const running = await countActiveAgents(storage);
    const decision = decideAgentSlot(running, limit, already);
    if (decision.admitted && !already) reservedSlots.add(taskId);
    return decision;
  });
}

/** Release a reservation taken by {@link tryAdmitAgentSlot}. Idempotent. */
export function releaseAgentSlot(taskId: string): void {
  reservedSlots.delete(taskId);
}

// --- Queue ordering (pure, reusable) ---

/**
 * Order queued tasks for the drain sweep: highest priority first, ties broken
 * FIFO by `created_at` (oldest first). Pure and total — a stable, deterministic
 * ordering used by both the reconciler drain and the queue-position display.
 *
 * Kept deliberately separate from the reconciler loop so a future scheduler
 * (spike-night-scheduler) can layer time-window logic on the same primitive
 * rather than reimplementing ordering. Does not mutate its input.
 */
export function orderQueuedTasks<T extends Pick<Task, 'priority' | 'created_at'>>(tasks: readonly T[]): T[] {
  return [...tasks].sort((a, b) => {
    const rankDelta = (PRIORITY_RANK[b.priority] ?? 0) - (PRIORITY_RANK[a.priority] ?? 0);
    if (rankDelta !== 0) return rankDelta; // higher priority first
    return a.created_at - b.created_at; // FIFO tie-break (oldest first)
  });
}

/**
 * 1-based queue position of `taskId` within the queued set, plus the total, per
 * {@link orderQueuedTasks}. Returns null when the task is not in the set.
 * Exported for the `lazy active` / lazy_active "queued #N of M" display.
 */
export function queuePosition(
  tasks: readonly Pick<Task, 'id' | 'priority' | 'created_at'>[],
  taskId: string,
): { position: number; total: number } | null {
  const ordered = orderQueuedTasks(tasks);
  const idx = ordered.findIndex((t) => t.id === taskId);
  if (idx === -1) return null;
  return { position: idx + 1, total: ordered.length };
}

// --- Idle-container reaping (pure decision, priority-aware) ---

/** An idle blocked task still holding a live container (a reap candidate). */
export interface ReapCandidate {
  taskId: string;
  priority: TaskPriority;
  /** Epoch ms the container went idle (its last turn completed). */
  idleSinceMs: number;
}

/** A queued task waiting for a slot (drives demand-driven reaping). */
export interface ReapDemand {
  taskId: string;
  priority: TaskPriority;
  created_at: number;
}

/** A task currently running a turn (its slot will free when it finishes). */
export interface ReapWorking {
  taskId: string;
  priority: TaskPriority;
}

export interface ReapDecisionInput {
  /** Idle blocked tasks holding live containers. */
  blocked: readonly ReapCandidate[];
  /** Tasks queued for a slot. */
  queued: readonly ReapDemand[];
  /** Tasks currently working (holding slots that will free later). */
  working: readonly ReapWorking[];
  /** Effective agent cap. */
  limit: number;
  /** Idle grace period in ms (config `[limits] idle_grace_minutes`). */
  graceMs: number;
  /** Current time (epoch ms). */
  nowMs: number;
  /**
   * Whether the runner's idle runs justify unconditional base reaping
   * (`runner.reapsIdleRuns`). When false (host-process), idle runs are exempt
   * from the RAM-bound base reap but still demand-reapable.
   */
  baseReapEnabled: boolean;
}

const rank = (p: TaskPriority): number => PRIORITY_RANK[p] ?? 0;

/**
 * Decide which idle blocked containers to reap this tick. Pure and total —
 * exported for unit testing and kept beside {@link orderQueuedTasks} so a future
 * scheduler can reuse it rather than reimplementing the policy in the loop.
 *
 * Two independent reasons to reap:
 *
 *  1. **Base reap (RAM bound, demand-independent):** an idle container older than
 *     `graceMs` is reaped unconditionally — but only when `baseReapEnabled`
 *     (container runners), since a cheap idle host process needs no RAM cap.
 *
 *  2. **Demand-driven reap (queued work, no free slot):** grace only exists to
 *     keep a warm container for a *likely next turn*; it must never starve
 *     equal-or-higher-priority queued demand. For each queued task that can't be
 *     served by a free slot (highest priority first):
 *       - a strictly-LOWER-priority queued task cannot break a blocked task's
 *         grace (never a reap candidate for it);
 *       - a same-or-higher-priority queued task overrides grace → reap, choosing
 *         the lowest-priority then oldest-idle blocked candidate first;
 *       - EXCEPTION (heuristic): if a strictly-lower-priority task is currently
 *         *working*, its slot will free and — per drain ordering — go to this
 *         higher-priority queued task first, so the blocked task keeps its grace.
 *         (A working task may run long; we accept that risk to avoid needless
 *         cold-starts.) Corollary: a task that blocks while a strictly-higher
 *         task is queued gets no grace — it is reaped immediately.
 *
 * Reaping is applied by the caller via the Runner (`removeRun`) + clearing
 * `container_name`; the existing slot accounting then frees the slot naturally.
 */
export function selectContainersToReap(input: ReapDecisionInput): string[] {
  const { blocked, queued, working, limit, graceMs, nowMs, baseReapEnabled } = input;
  const reap = new Set<string>();

  // Rule 1: base reap — idle past grace, unconditional (container runners only).
  const inGrace: ReapCandidate[] = [];
  for (const c of blocked) {
    if (baseReapEnabled && nowMs - c.idleSinceMs >= graceMs) reap.add(c.taskId);
    else inGrace.push(c);
  }

  if (queued.length === 0) return [...reap];

  // Slots in use after base reaps free their containers.
  const liveAfterBase = working.length + inGrace.length;
  const freeSlots = Math.max(0, limit - liveAfterBase);

  // The drain sweep fills free slots with the highest-priority queued tasks;
  // everything past that needs a slot created by reaping.
  const unmet = orderQueuedTasks(queued).slice(freeSlots);
  if (unmet.length === 0) return [...reap];

  // Exception pool: ranks of strictly-lower-priority working tasks, each of which
  // can reserve one higher-priority queued task (its slot will free and drain to it).
  const reservations = working.map((w) => rank(w.priority)).sort((a, b) => a - b);

  // Candidates: reap lowest-priority, then oldest-idle (longest waiting) first.
  const candidates = [...inGrace].sort((a, b) => {
    const r = rank(a.priority) - rank(b.priority);
    return r !== 0 ? r : a.idleSinceMs - b.idleSinceMs;
  });

  for (const q of unmet) {
    const qRank = rank(q.priority);
    // Heuristic exception: a strictly-lower-priority working slot covers q.
    const resIdx = reservations.findIndex((r) => r < qRank);
    if (resIdx !== -1) {
      reservations.splice(resIdx, 1);
      continue; // grace preserved
    }
    // Reap a blocked candidate q is same-or-higher priority than.
    const candIdx = candidates.findIndex((c) => rank(c.priority) <= qRank);
    if (candIdx !== -1) {
      reap.add(candidates[candIdx].taskId);
      candidates.splice(candIdx, 1);
    }
    // else: only higher-priority blocked containers remain → grace holds for them.
  }

  return [...reap];
}
