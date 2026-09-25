/**
 * The durable half of an accept: what the human decided, and what is still owed
 * after the merge landed.
 *
 * THE RULE (engineer, 2026-09-22): the git merge is the LAST fallible step of an
 * accept. Nothing that can fail may sit between the merge landing and the task
 * becoming `complete`. Everything an accept does falls into one of three bands:
 *
 *  1. BEFORE the merge — every gate, approval, check, parent push and
 *     description refresh. Any of them may refuse, and a refusal restores the
 *     task's prior status (the only place `abortMergePhase` is legitimate).
 *  2. THE MERGE is the commit point. Right after it, the store transitions the
 *     task: session `accepted`, status `complete`, `[Accepted]` comment with the
 *     original reason and actor. Only store writes sit here.
 *  3. AFTER the transition — fast-forward, parent push, accept tag, reparenting,
 *     parent fidelity, cleanup — is FOLLOW-THROUGH. It is idempotent, recorded
 *     here as pending until done, retried by the daemon, loud when failing, and
 *     never able to move the task out of `complete`.
 *
 * Two records make that crash-safe without reading git as a store:
 *
 *  - {@link ACCEPT_INTENT_KEY}: written at `beginMergePhase` alongside the
 *    in-flight marker. A dead accept (daemon killed before OR after the merge)
 *    is RESUMED from it — never restored to `blocked` — because the human
 *    already said accept.
 *  - {@link ACCEPT_FOLLOWTHROUGH_KEY}: written as the first write of the
 *    transition, cleared when every follow-through step has succeeded.
 */

import type { ActorInput, Task } from '../types';

/** Task metadata key: the persisted accept decision (JSON {@link AcceptIntent}). */
export const ACCEPT_INTENT_KEY = 'accept_intent';

/** Task metadata key: epoch ms before which the sweep will not retry a dead accept. */
export const ACCEPT_RESUME_NEXT_AT_KEY = 'accept_resume_next_at';

/** Task metadata key: count of daemon resume attempts of a dead accept. */
export const ACCEPT_RESUME_ATTEMPTS_KEY = 'accept_resume_attempts';

/**
 * After this many failed automatic resumes the daemon stops retrying on its
 * own, files a system message, and lets the human act (re-accept, or
 * reject/close — the escape reopens once resumes are exhausted, so the task can
 * never wedge the way it did before fix-stranded-merging).
 */
export const MAX_ACCEPT_RESUME_ATTEMPTS = 3;

/** Task metadata key: post-accept follow-through still owed (JSON {@link AcceptFollowThrough}). */
export const ACCEPT_FOLLOWTHROUGH_KEY = 'accept_followthrough';

/** After this many failed follow-through attempts the daemon files a system message. */
export const FOLLOWTHROUGH_MESSAGE_AFTER_ATTEMPTS = 3;

/** Everything needed to re-run an accept the human already authorized. */
export interface AcceptIntent {
  /** The fully composed accept reason (human line + any attached review). */
  reason: string;
  actor: ActorInput;
  approvedFiles?: string[];
  acceptDirtyWorktree?: boolean;
  allowBroken?: boolean;
  allowReviewIssues?: boolean;
  // Deliberately NO callerTaskId: that exemption (merging into a `working`
  // parent) is safe only while the parent's agent is parked inside its own
  // lazy_accept call. A daemon resume happens later, when that agent may be
  // editing the worktree again — so a resume never claims it.
  recordedAt: string;
}

/**
 * Ordered follow-through steps. Each is idempotent. `notify-parent` follows
 * `accept-tag` because the parent's comment names the merge by reading the tag.
 */
export const FOLLOWTHROUGH_STEPS = [
  'reparent',
  'fast-forward',
  'push-parent',
  'close-review',
  'accept-tag',
  'notify-parent',
  'parent-fidelity',
  'cleanup',
] as const;
export type FollowThroughStep = typeof FOLLOWTHROUGH_STEPS[number];

export interface AcceptFollowThrough {
  /** The parent/target branch the work merged into (unresolved spelling). */
  targetBranch: string;
  /** The forge merged it — the local target must be fast-forwarded. */
  viaForge: boolean;
  /** A local merge into a branch that exists on origin — it must be pushed. */
  pushParent: boolean;
  /**
   * A LOCAL merge of a task that has an open PR/MR — typically one a person
   * submitted into an intermediate or unprotected branch. The forge cannot
   * see a local squash as a merge of that PR, so lazy closes it: the work
   * landed, and a PR left open would claim it had not. Absent on records
   * written before this step existed, which is "nothing to close".
   */
  closeReview?: boolean;
  /** Target HEAD right after a LOCAL merge: what the accept tag points at. */
  mergeSha?: string;
  done: FollowThroughStep[];
  attempts: number;
  lastError?: string;
  /** Epoch ms before which the daemon sweep will not retry. */
  nextAttemptAt?: number;
  /** A system message has been filed for this failure. */
  messaged?: boolean;
}

function parseJson<T>(raw: string | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A corrupt record is treated as absent — a resume falls back to a generic
    // reason, and follow-through logs and drops it. Losing it must not wedge
    // the task.
    return null;
  }
}

export function readAcceptIntent(task: Pick<Task, 'metadata'>): AcceptIntent | null {
  return parseJson<AcceptIntent>(task.metadata?.[ACCEPT_INTENT_KEY]);
}

export function readFollowThrough(task: Pick<Task, 'metadata'>): AcceptFollowThrough | null {
  return parseJson<AcceptFollowThrough>(task.metadata?.[ACCEPT_FOLLOWTHROUGH_KEY]);
}

export function readResumeNextAt(task: Pick<Task, 'metadata'>): number {
  const n = Number(task.metadata?.[ACCEPT_RESUME_NEXT_AT_KEY] || 0);
  return Number.isFinite(n) ? n : 0;
}

export function readResumeAttempts(task: Pick<Task, 'metadata'>): number {
  const n = Number(task.metadata?.[ACCEPT_RESUME_ATTEMPTS_KEY] || 0);
  return Number.isFinite(n) ? n : 0;
}

/** Retry backoff for follow-through: 1, 2, 4, … minutes, capped at 30. */
export function followThroughBackoffMs(attempts: number): number {
  return Math.min(30, 2 ** Math.max(0, attempts - 1)) * 60_000;
}
