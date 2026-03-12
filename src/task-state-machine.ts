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
export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['complete', 'abandoned', 'closed']);

/** Returns true if the given status is a terminal (finished) state. */
export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Task has an active worktree that should not be merged into */
export function isActiveStatus(status: TaskStatus): boolean {
  return status === 'working' || status === 'interrupted' || status === 'pairing' || status === 'merging';
}

/** Task is waiting for human or agent action (includes conflict — permission violations needing review) */
export function isBlockedStatus(status: TaskStatus): boolean {
  return status === 'blocked' || status === 'conflict';
}

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

/**
 * Every valid (from → to) transition in the system.
 *
 * Evidence-based: derived from every call to updateTaskStatus, reopenTask,
 * and closeTask across CLI commands, reconciler, and auto-resume.
 *
 * Key transitions by command/system:
 *   start:       backlog → working
 *   reconciler:  working → blocked (turn completes)
 *                working → conflict (turn completes with violations)
 *                working → interrupted (container stopped/crashed)
 *                pairing → blocked (stale pairing sweep)
 *                blocked → backlog (migration: never-started tasks)
 *   auto-resume: interrupted → working
 *   unblock:     blocked/conflict → working, merging → blocked
 *   accept:      blocked/conflict → merging → complete, merging → blocked (checks fail)
 *   reject:      blocked/interrupted → abandoned
 *   close:       blocked/conflict/interrupted/backlog → closed
 *   pair:        blocked/conflict/interrupted → pairing, pairing → blocked
 *   resume:      interrupted → working
 *   reopen:      complete/abandoned/closed → blocked (with session) or backlog (no session)
 *   zombie:      any non-terminal → zombie (system only), zombie → complete
 */
export const VALID_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  backlog:     ['working', 'closed'],
  working:     ['blocked', 'conflict', 'interrupted'],
  blocked:     ['working', 'merging', 'pairing', 'abandoned', 'closed', 'backlog'],
  conflict:    ['working', 'merging', 'pairing', 'abandoned', 'closed'],
  interrupted: ['working', 'pairing', 'abandoned', 'closed'],
  pairing:     ['blocked'],
  merging:     ['complete', 'blocked'],
  zombie:      ['complete'],
  complete:    ['blocked', 'backlog'],
  abandoned:   ['blocked', 'backlog'],
  closed:      ['blocked', 'backlog'],
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
