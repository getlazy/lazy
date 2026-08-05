/**
 * Centralized task state machine.
 *
 * This module owns task states and transitions. All status classification
 * functions and transition validation live here. Adding a new status means
 * adding one entry to VALID_TRANSITIONS — not hunting through the codebase.
 */

import type { TaskStatus } from './types';

// ---------------------------------------------------------------------------
// Status classification (single source of truth)
// ---------------------------------------------------------------------------

/** Task statuses that represent a finished task. Once a task reaches one of these statuses, its core fields are frozen. */
export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['complete', 'abandoned']);

/** Returns true if the given status is a terminal (finished) state. */
export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Task has an active worktree that should not be merged into */
export function isActiveStatus(status: TaskStatus): boolean {
  return status === 'working' || status === 'interrupted' || status === 'pairing' || status === 'merging';
}

/** Task is waiting for human or agent action (includes conflict and submitted — PR awaiting review) */
export function isBlockedStatus(status: TaskStatus): boolean {
  return status === 'blocked' || status === 'conflict' || status === 'submitted';
}

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

/**
 * Every valid (from → to) transition in the system.
 *
 * Evidence-based: derived from every call to updateTaskStatus, reopenTask,
 * and abandonTask across CLI commands, reconciler, and auto-resume.
 *
 * Key transitions by command/system:
 *   start:       backlog → working (or backlog → queued at the concurrency cap)
 *   drain:       queued → working (reconciler launches a queued task as a slot frees)
 *   reconciler:  working → blocked (turn completes)
 *                working → conflict (turn completes with violations)
 *                working → interrupted (container stopped/crashed)
 *                pairing → blocked (stale pairing sweep)
 *                backlog → blocked (recover task whose branch already has commits)
 *   auto-resume: interrupted → working
 *   unblock:     blocked/conflict → working, merging → blocked
 *   submit:      blocked/conflict → submitted (creates PR, ready for review)
 *   accept:      blocked/conflict/submitted → merging → complete, merging → blocked (checks fail)
 *                working → blocked/conflict/submitted (pre-accept turn ends, task
 *                  restored to the status it had before the accept)
 *                merging → conflict/submitted (merge phase aborts, same restore)
 *
 * INVARIANT (accept restores the TRUE prior status): an accept moves the task
 * through `working` (pre-accept turn) and `merging` (merge phase). When it
 * aborts, the task must return to the status it actually had — a task that was
 * in `conflict` or `submitted` before the accept is NOT blocked, and silently
 * rewriting it to `blocked` loses a real signal (unresolved violations, an open
 * PR awaiting review). That is why `working` and `merging` can reach every
 * blocked-family status rather than `blocked` alone.
 *   remote-sync: working/interrupted → merging → complete (externally merged MR)
 *   abandon:     blocked/conflict/interrupted/submitted/backlog → abandoned
 *   pair:        blocked/conflict/interrupted/submitted → pairing, pairing → blocked
 *   resume:      interrupted → working
 *   reopen:      complete/abandoned → blocked (with session) or backlog (no session)
 *   zombie:      any non-terminal → zombie (system only), zombie → complete
 */
export const VALID_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  backlog:     ['working', 'blocked', 'abandoned', 'queued'],
  queued:      ['working', 'backlog', 'abandoned'],
  working:     ['blocked', 'conflict', 'interrupted', 'merging', 'submitted'],
  blocked:     ['working', 'submitted', 'merging', 'pairing', 'abandoned', 'backlog'],
  conflict:    ['working', 'submitted', 'merging', 'pairing', 'abandoned'],
  interrupted: ['working', 'merging', 'pairing', 'abandoned'],
  submitted:   ['working', 'merging', 'pairing', 'abandoned'],
  pairing:     ['blocked'],
  merging:     ['complete', 'blocked', 'conflict', 'submitted'],
  zombie:      ['complete'],
  complete:    ['blocked', 'backlog'],
  abandoned:   ['blocked', 'backlog'],
};

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

/** Can status transition from `from` to `to`? */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/** What statuses can transition TO this status? (reverse lookup) */
export function transitionsTo(status: TaskStatus): readonly TaskStatus[] {
  const result: TaskStatus[] = [];
  for (const [from, tos] of Object.entries(VALID_TRANSITIONS)) {
    if ((tos as readonly string[]).includes(status)) {
      result.push(from as TaskStatus);
    }
  }
  return result;
}

/** What statuses can this status transition TO? (forward lookup) */
export function transitionsFrom(status: TaskStatus): readonly TaskStatus[] {
  return VALID_TRANSITIONS[status] ?? [];
}

/**
 * Assert a transition is valid, throw with a helpful message if not.
 *
 * The `actor` parameter is required for zombie transitions: only 'system'
 * can transition any non-terminal status to 'zombie'.
 */
export function assertValidTransition(from: TaskStatus, to: TaskStatus, actor?: string): void {
  if (from === to) return; // idempotent — same state is always a no-op

  // System-only: any non-terminal → zombie
  if (to === 'zombie') {
    if (actor !== 'system') {
      throw new Error(`Only system can transition to 'zombie' state.`);
    }
    if (TERMINAL_STATUSES.has(from)) {
      throw new Error(
        `Cannot transition from terminal state '${from}' to 'zombie'.`
      );
    }
    return;
  }

  if (!canTransition(from, to)) {
    const valid = transitionsFrom(from);
    const validList = valid.length > 0 ? valid.join(', ') : '(none — terminal state)';
    throw new Error(
      `Invalid status transition: '${from}' → '${to}'. ` +
      `Valid transitions from '${from}': ${validList}.`
    );
  }
}
