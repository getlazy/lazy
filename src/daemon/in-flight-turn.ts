/**
 * In-flight turn state — the persisted answer to "is a turn running for this
 * task right now, and who is waiting for its answer?"
 *
 * WHY THIS EXISTS. A task's protocol dir (`~/.lazy/protocol/<taskId>/`) is a
 * single-slot mailbox with no addressing: commands carry no id, and a waiter
 * reading `response.json` gets whatever is in the slot — possibly another
 * command's answer. Two turns are run SYNCHRONOUSLY by the daemon itself
 * (`ask` and `pre_accept`, see task-lifecycle.ts) because an RPC caller is
 * blocked waiting for a value; every other turn is flushed fire-and-forget by
 * the reconciler. Without a way to say "a synchronous turn owns this task's
 * slot", the reconciler consumed a pre-accept response out from under the
 * accept that was waiting for it.
 *
 * This module replaces the in-memory registry that first plugged that hole
 * (`response-ownership.ts`, deleted). The record lives on the TASK, through
 * Storage, so it is visible to every writer in every process and survives a
 * daemon restart mid-accept.
 *
 * STALENESS IS BOUNDED BY A DEADLINE, NOT BY LIVENESS. "Is the process that
 * claimed this still alive?" is not safely answerable — a recycled pid makes a
 * dead holder look alive forever (the same hazard that wedges the storage
 * lock). A wait, however, always has a deadline, so `expires_at` is set from
 * the waiter's own timeout: past it the record is stale by construction and any
 * reader may take over.
 */

import type { InFlightTurn, Task } from '../types';
import type { Storage } from '../storage/interface';

/**
 * How long a SETTLED record keeps other writers off the task while its waiter
 * picks the outcome up.
 *
 * A settled record is not finished business: the reconciler has recorded the
 * turn and written the outcome, but the waiter has not yet read it and turned
 * it into an RPC result. If auto-resume or auto-deliver were allowed straight
 * back in at that instant, they could launch a new turn on top of a task the
 * accept is still mid-flight on. The grace is short so a waiter that has died
 * cannot wedge the task for long.
 */
export const IN_FLIGHT_SETTLED_GRACE_MS = 60_000;

/**
 * Does this record still speak for the task?
 *
 * Live means: not past its deadline, and — once settled — still inside the
 * pickup grace. Anything else is debris a later writer is free to clear.
 */
export function isInFlightLive(turn: InFlightTurn | null | undefined, now = Date.now()): boolean {
  if (!turn) return false;
  if (turn.expires_at <= now) return false;
  if (turn.outcome) return now - turn.outcome.settled_at < IN_FLIGHT_SETTLED_GRACE_MS;
  return true;
}

/** Convenience read for writers that hold a task record already. */
export function taskTurnInFlight(task: Task | null | undefined, now = Date.now()): boolean {
  return isInFlightLive(task?.in_flight_turn ?? null, now);
}

/**
 * Serializer for settling a task's in-flight turn.
 *
 * Two callers drive the settle: the reconcile tick, and the waiter itself on
 * every poll (so an answer is picked up in ~500ms rather than waiting out the
 * 5s reconcile interval). Both run in the SAME process — the reconcile loop
 * lives in the daemon, and a waiter either runs in the daemon too or in the
 * in-process RPC fallback, where no reconcile loop exists at all. There is
 * therefore no third settler anywhere, and a per-task promise chain is complete
 * exclusion rather than a partial guard.
 *
 * This is NOT a revival of the in-memory ownership registry. It holds no state
 * about who owns what — it is a mutex whose whole content is "one settle at a
 * time"; losing it on a restart loses nothing, because the durable record on
 * the task is what says a turn is in flight.
 */
const settleChains = new Map<string, Promise<unknown>>();

/** Run `fn` with no other settle for `taskId` interleaved with it. */
export function withSettleLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  const prior = settleChains.get(taskId) ?? Promise.resolve();
  // Run after the predecessor SETTLES, either way: a settle that threw must not
  // wedge the chain. Its own caller still sees that rejection.
  const run = prior.then(fn, fn);
  // The chain link is the swallowed form, so a rejection here is never
  // unhandled and never propagates to the next waiter.
  const link = run.then(() => undefined, () => undefined);
  settleChains.set(taskId, link);
  void link.then(() => {
    // Drop the entry once this is still the tail, so the map does not grow one
    // permanent slot per task the daemon has ever seen.
    if (settleChains.get(taskId) === link) settleChains.delete(taskId);
  });
  return run;
}

/**
 * Is a synchronous daemon turn (ask / pre-accept) in flight for this task?
 *
 * Replaces `isResponseOwned` at every writer that must not move a task
 * underneath such a turn: the reconciler, auto-resume (fast and slow lanes) and
 * auto-deliver. Reads through Storage rather than a process-local map, so it is
 * correct across processes and across a daemon restart.
 */
export async function isTurnInFlight(storage: Storage, taskId: string): Promise<boolean> {
  const task = await storage.getTask(taskId);
  return taskTurnInFlight(task);
}
