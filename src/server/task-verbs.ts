/**
 * Which lifecycle verbs the task page may OFFER for a given task state.
 *
 * Lives in the shared port layer (like ./review-actions.ts) because BOTH sides
 * need exactly this predicate and neither may import the other: the template
 * decides which buttons to draw, and the action route refuses a POST for a
 * verb the page should not have offered. Two copies would drift into a page
 * that renders a button the route then 409s — or worse, hides a control the
 * route would happily accept.
 *
 * THE DAEMON REMAINS THE AUTHORITY. Every predicate here mirrors the real gate
 * in src/daemon/task-lifecycle.ts (`stopTask` / `closeTask` / `rejectTask` /
 * `resumeTask`) and src/daemon/task-launcher.ts (`launchTask`); the daemon
 * refuses anything it disagrees with, and when the two disagree the daemon
 * wins. Teams' task page mirrors the same gates in its own presenter
 * (lazy-teams/app/presenters/task_presenter.rb) — keep the three surfaces
 * telling the same story.
 */

import { isTerminalStatus, type TaskStatus } from '../types';

export type TaskLifecycleVerb = 'start' | 'stop' | 'close' | 'reject' | 'resume' | 'reopen';

export const TASK_LIFECYCLE_VERBS: readonly TaskLifecycleVerb[] = [
  'start',
  'stop',
  'close',
  'reject',
  'resume',
  'reopen',
];

/**
 * Verbs whose daemon implementation requires a non-empty reason — the same set
 * the CLI prompts for (`lazy stop` / `lazy close` / `lazy reject`). Reopen is
 * conditional (a reason is required only for a `complete` task) and handled at
 * the route, not here.
 */
export const REASON_REQUIRED_VERBS: ReadonlySet<TaskLifecycleVerb> = new Set([
  'stop',
  'close',
  'reject',
]);

/** Verbs that end a task and therefore get a disclose-and-confirm step. */
export const DESTRUCTIVE_VERBS: ReadonlySet<TaskLifecycleVerb> = new Set(['close', 'reject']);

/**
 * Why this verb cannot be offered right now, or null when it can.
 *
 * `hasOpenSession` means the task has a session whose `ended_at` is unset —
 * the daemon's `rejectTask` and `resumeTask` both require one.
 */
export function taskVerbUnavailableReason(
  verb: TaskLifecycleVerb,
  status: TaskStatus,
  hasOpenSession: boolean,
  /**
   * Does the task carry a live ask/review claim — a turn running (or dead and
   * unreleased) on a task whose status may say otherwise? Read with
   * `stoppableClaimOf`. Optional and defaulting to false so a caller that has
   * only a status keeps the status-only answer.
   */
  hasStoppableClaim = false,
): string | null {
  switch (verb) {
    case 'start':
      // launchTask refuses a task with an active session ("unblock it
      // instead"); only a backlog task has none and a worktree to set up.
      return status === 'backlog'
        ? null
        : `Only a backlog task can be started — this task is ${status}.`;
    case 'stop':
      // stopTask: a WORK turn needs 'working' — but THE CLAIM OUTRANKS THE
      // STATUS, exactly as `stoppableClaimOf` decides it for the daemon and the
      // CLI. A review or ask still claimed on a parked task is a turn running,
      // or one that died and left its record behind, and stopping it is the way
      // out of that wedge. While this mirrored only the status, the page hid a
      // control the route would have accepted — the drift this module's header
      // warns about — and the web surface had no exit at all.
      if (status === 'working') return null;
      // Deliberately NARROWER than the daemon, which would take a claim stop
      // from any status: a PARKED task is what the claim opens. A pairing task
      // is locked (a human is in that session — the same reason the daemon's
      // own paused-claim sweep skips it), and a terminal task's turn is over
      // however its record reads. The page being narrower than the daemon is
      // safe; the page being wider is the bug this table exists to prevent.
      if (hasStoppableClaim && !isTerminalStatus(status) && status !== 'pairing') return null;
      return `Only a running task can be stopped — this task is ${status}.`;
    case 'resume':
      // resumeTask accepts interrupted and blocked (incl. blocked-by-stop),
      // and needs a session to resume.
      if (status !== 'interrupted' && status !== 'blocked') {
        return `Only an interrupted or blocked task can be resumed — this task is ${status}.`;
      }
      if (!hasOpenSession) {
        return 'This task has no agent session to resume.';
      }
      return null;
    case 'close':
      // closeTask: any non-terminal task that is not locked for pairing; a
      // never-started backlog task is closable, and closing a working task
      // stops the runner first.
      if (isTerminalStatus(status)) return `This task is already ${status}.`;
      if (status === 'pairing') return 'This task is locked while someone is pairing on it.';
      return null;
    case 'reject':
      // rejectTask additionally needs an open session ("has no session" /
      // "session already ended" otherwise).
      if (isTerminalStatus(status)) return `This task is already ${status}.`;
      if (status === 'pairing') return 'This task is locked while someone is pairing on it.';
      if (!hasOpenSession) return 'This task has no open agent session to reject.';
      return null;
    case 'reopen':
      // Reopen restores a terminal task to blocked (had a session) or backlog.
      return isTerminalStatus(status)
        ? null
        : 'Only a completed or closed task can be reopened.';
  }
}

/** The verbs the page should draw for this state, in a stable display order. */
export function availableTaskVerbs(
  status: TaskStatus,
  hasOpenSession: boolean,
  hasStoppableClaim = false,
): TaskLifecycleVerb[] {
  return TASK_LIFECYCLE_VERBS.filter(
    (verb) => taskVerbUnavailableReason(verb, status, hasOpenSession, hasStoppableClaim) === null,
  );
}

/**
 * Restructure verbs live next to the lifecycle table and share the same
 * dispatch path (`handleTaskAction`). They are not lifecycle verbs — Reject
 * stays in TASK_LIFECYCLE_VERBS; these change the task's shape.
 */
export type TaskRestructureVerb = 'reparent' | 'redo' | 'clone';

export const TASK_RESTRUCTURE_VERBS: readonly TaskRestructureVerb[] = [
  'reparent',
  'redo',
  'clone',
];

export function restructureVerbUnavailableReason(
  verb: TaskRestructureVerb,
  status: TaskStatus,
): string | null {
  if (status === 'working' || status === 'pairing') {
    return `Task is ${status}. Wait for it to finish or interrupt it first.`;
  }
  if (verb === 'reparent') {
    if (isTerminalStatus(status)) {
      return `Task is ${status}. Reopen it first before reparenting.`;
    }
    return null;
  }
  if (verb === 'redo') {
    if (status === 'complete') return 'This task is already complete (merged). Nothing to redo.';
    if (status === 'abandoned') return 'This task is already closed. Reopen it to work on it again.';
    return null;
  }
  // clone: a working/pairing source is the only refusal above.
  return null;
}

/** Sync and Submit end a review turn; they share the action route. */
export type TaskReviewEndVerb = 'sync' | 'submit';

export const TASK_REVIEW_END_VERBS: readonly TaskReviewEndVerb[] = ['sync', 'submit'];

/**
 * Agent-review verb (`lazy review`). Distinct from Current review (the human
 * accept/unblock tab) and from the review-end verbs above.
 *
 * Mirrors `REVIEWABLE_STATUSES` in src/daemon/task-lifecycle.ts.
 */
export type TaskAgentReviewVerb = 'review';

export const TASK_AGENT_REVIEW_VERBS: readonly TaskAgentReviewVerb[] = ['review'];

const REVIEWABLE_STATUSES = new Set<TaskStatus>([
  'blocked',
  'conflict',
  'submitted',
  'interrupted',
]);

export function agentReviewUnavailableReason(status: TaskStatus): string | null {
  if (REVIEWABLE_STATUSES.has(status)) return null;
  return (
    `A review cannot run while the task is busy, has no work yet, or is already finished ` +
    `— this task is ${status}. Wait until it is paused (blocked, conflict, submitted, or interrupted).`
  );
}

export function reviewEndVerbUnavailableReason(
  verb: TaskReviewEndVerb,
  status: TaskStatus,
  opts: { hasCommits?: boolean; remoteDriver?: boolean } = {},
): string | null {
  if (verb === 'sync') {
    if (status === 'blocked' || status === 'conflict' || status === 'interrupted') return null;
    if (isTerminalStatus(status)) return `This task is already ${status}.`;
    if (status === 'working' || status === 'pairing') {
      return `Task is ${status} — sync is disabled until it is paused.`;
    }
    return `Only a blocked, conflict, or interrupted task can be synced — this task is ${status}.`;
  }
  if (status !== 'blocked' && status !== 'conflict') {
    return `Only a blocked or conflict task can be submitted — this task is ${status}.`;
  }
  if (opts.hasCommits === false) return 'This task has no commits. Nothing to submit.';
  if (opts.remoteDriver === false) return 'Submit needs a remote driver (e.g. github) in lazy.toml.';
  return null;
}

export type TaskPageVerb =
  | TaskLifecycleVerb
  | TaskRestructureVerb
  | TaskReviewEndVerb
  | TaskAgentReviewVerb;

export const TASK_PAGE_VERBS: readonly TaskPageVerb[] = [
  ...TASK_LIFECYCLE_VERBS,
  ...TASK_RESTRUCTURE_VERBS,
  ...TASK_REVIEW_END_VERBS,
  ...TASK_AGENT_REVIEW_VERBS,
];

export function taskPageVerbUnavailableReason(
  verb: TaskPageVerb,
  status: TaskStatus,
  hasOpenSession: boolean,
  opts: { hasCommits?: boolean; remoteDriver?: boolean; hasStoppableClaim?: boolean } = {},
): string | null {
  if ((TASK_LIFECYCLE_VERBS as readonly string[]).includes(verb)) {
    return taskVerbUnavailableReason(
      verb as TaskLifecycleVerb, status, hasOpenSession, opts.hasStoppableClaim === true,
    );
  }
  if ((TASK_RESTRUCTURE_VERBS as readonly string[]).includes(verb)) {
    return restructureVerbUnavailableReason(verb as TaskRestructureVerb, status);
  }
  if ((TASK_AGENT_REVIEW_VERBS as readonly string[]).includes(verb)) {
    return agentReviewUnavailableReason(status);
  }
  return reviewEndVerbUnavailableReason(verb as TaskReviewEndVerb, status, opts);
}
