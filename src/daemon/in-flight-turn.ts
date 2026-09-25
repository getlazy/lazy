/**
 * In-flight turn state — the persisted answer to "is a turn running for this
 * task right now, and who is waiting for its answer?"
 *
 * WHY THIS EXISTS. A task's protocol dir (`~/.lazy/protocol/<taskId>/`) is a
 * single-slot mailbox with no addressing: commands carry no id, and a waiter
 * reading `response.json` gets whatever is in the slot — possibly another
 * command's answer. Several turns are run SYNCHRONOUSLY by the daemon itself
 * (`ask`, `review`, `wrap_up`; the mechanical acceptance gate waits on the
 * response file without a record — see task-lifecycle.ts) because an RPC
 * caller is blocked waiting for a value; every other turn is flushed
 * fire-and-forget by the reconciler. Without a way to say "a synchronous turn
 * owns this task's slot", the reconciler consumed a pre-accept response out
 * from under the accept that was waiting for it.
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

import { randomUUID } from 'crypto';
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
 * Backstop deadline for an ASYNCHRONOUS claim (`ask` / `review`).
 *
 * NOT a ceiling on the turn. Ask and review have no ceiling at all any more —
 * a reviewer that needs forty minutes gets forty minutes, and the guard against
 * one that needs forever is the supervisor's own no-progress watchdog, exactly
 * as it is for a work turn. What bounds the CLAIM instead is liveness: the
 * record carries `run_name`, and the reconciler abandons the turn as soon as
 * that run is gone (see `abandonDeadSyncTurn`).
 *
 * This value exists only for the case liveness cannot cover — a daemon that
 * never ticks again, a runner that can no longer answer "is it running?" — so a
 * record can never pin a task in `working` forever. A day is far past any real
 * turn and far short of "forever".
 */
export const IN_FLIGHT_ASYNC_BACKSTOP_MS = 24 * 60 * 60 * 1000;

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

/**
 * An expired ask/review claim that never settled.
 *
 * INVARIANT: the reconciler must restore `restore_status` and return — never
 * fall through to interrupt + auto-resume. Auto-resume launches a WORK turn,
 * which would run the implementer against a submitted/blocked task the review
 * (or ask) was only visiting.
 *
 * Live records stay with their waiter (the container may still finish). A
 * settled leftover is pickup-grace debris, not this case. A `pre_accept`
 * record is included for legacy only: its waiter (the retired pre-accept turn
 * at accept) no longer exists, so restoring it is the right ending.
 */
export function expiredSyncRestore(
  turn: InFlightTurn | null | undefined,
  now = Date.now(),
): InFlightTurn | null {
  if (!turn) return null;
  if (isInFlightLive(turn, now)) return null;
  if (turn.outcome) return null;
  // pre_accept is included for legacy records only: its waiter (the old
  // pre-accept turn at accept) is retired, so an expired record is restored
  // like any other — falling through would interrupt → auto-resume a work
  // turn on a task that was only ever mid-accept.
  if (turn.owner !== 'ask' && turn.owner !== 'review' && turn.owner !== 'pre_accept') return null;
  return turn;
}

/**
 * This process's claim identity, stamped on every claim it makes
 * (`InFlightTurn.claimed_by_process`). Minted once per process start, never
 * persisted: a restarted daemon is a different claimant by construction.
 */
export const CLAIMING_PROCESS_ID = randomUUID();

/**
 * Was this claim made by THIS process? False for a claim a previous daemon
 * generation made — including every legacy record without the stamp, all of
 * which predate this process.
 */
export function claimMadeByThisProcess(turn: InFlightTurn): boolean {
  return turn.claimed_by_process === CLAIMING_PROCESS_ID;
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
 * Is a synchronous daemon turn (ask / review / wrap-up) in flight for this task?
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

/**
 * The ask/review claim `lazy stop` should end, or null when the ordinary
 * work-turn path applies.
 *
 * `lazy stop` is the operator's one way out of anything they no longer want to
 * wait for, and what is running is not always a work turn. A REVIEW runs in its
 * own ephemeral container that is deliberately never stamped on the session — so
 * the ordinary path stopped the IMPLEMENTER's container, left the reviewer
 * running, and only flipped the status. The claim is the only record of what is
 * actually executing; follow it.
 *
 * THE CLAIM OUTRANKS THE STATUS, which is why this is consulted BEFORE the
 * `working` gate. The two can disagree, and it is exactly that disagreement an
 * operator needs a way out of: an ask or review claim on a task whose status
 * says `blocked` means a turn is running — or has died — on a task that reads as
 * parked. Gating this route on `working` left `teams-raised-cluster-row-one-size`
 * (2026-09-20) with `lazy_review` refusing ("already has a synchronous turn in
 * flight") and `lazy_stop` refusing ("blocked, not working") at the same moment,
 * so the only exit from the wedge was the 24-hour backstop. The daemon now
 * reaches that state on its own too (`sweepPausedSyncClaims`); this is the
 * human's door to the same ending.
 *
 * Safe to run from any status because the ending is status-agnostic:
 * `stopClaimedTurn` restores only FROM `working`, and otherwise leaves the
 * status exactly as it found it — a review is a visitor, not an owner.
 *
 * IT LIVES HERE, not next to `stopTask`, because there are TWO gates on this
 * verb and both must read the same rule. `lazy stop`'s CLI pre-flight refuses
 * before the reason prompt (save first, act second), and while it kept its own
 * `status !== 'working'` copy the daemon's claim route was unreachable from the
 * CLI: the wedge this rule exists to open still answered "blocked, not
 * working". This module is the zero-import home of the in-flight record, so a
 * CLI command can read the rule without importing the daemon.
 *
 * Exported for `test/unit/stop-claimed-turn-routing.test.ts`.
 */
export function stoppableClaimOf(task: Task): InFlightTurn | null {
  const record = task.in_flight_turn;
  if (!isInFlightLive(record) || record!.outcome) return null;
  // Only the ASYNCHRONOUS claims: `wrap_up`/`pre_accept` run inside another
  // call that owns their ending, and stopping one out from under it is not
  // this verb's business.
  if (record!.owner !== 'ask' && record!.owner !== 'review') return null;
  return record!;
}
