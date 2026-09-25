/**
 * The record a usage pause leaves on a task whose DAEMON-started launch it is
 * holding (task metadata `usage_pause_held`). Written and cleared only by
 * src/daemon/usage-pause.ts; read by every surface that explains a pause —
 * `lazy show`, `lazy doctor`, `lazy daemon config get` — so they all read one
 * shape.
 */

import type { UsagePauseVerdict } from './policy';

/** Task metadata key marking a daemon launch the pause is holding. */
export const USAGE_PAUSE_HELD_KEY = 'usage_pause_held';

/** What a hold marker records — everything a surface needs to explain it. */
export interface UsagePauseHold extends UsagePauseVerdict {
  /** Which launch is waiting: `auto-resume`, `auto-delivery (comment)`, `cluster restart`. */
  held: string;
  /** When the hold was first recorded (unix ms). */
  since: number;
}

export function parseUsagePauseHold(raw: string | null | undefined): UsagePauseHold | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as UsagePauseHold;
    return typeof v?.credential === 'string' && typeof v?.held === 'string' ? v : null;
  } catch {
    // Only lazy writes this key, and a marker that no longer parses carries
    // nothing a surface could explain; the next hold or sweep rewrites or
    // clears it.
    return null;
  }
}

/** The hold recorded on a task, if any. */
export function usagePauseHoldOf(task: { metadata?: Record<string, string> | null }): UsagePauseHold | null {
  return parseUsagePauseHold(task.metadata?.[USAGE_PAUSE_HELD_KEY]);
}

/**
 * Task metadata key for a review's AUTO-FIX turn a usage pause is holding: the
 * settled review's claim (its in-flight turn record, JSON), so the reconciler
 * can re-run the same settle once the window resets. Unlike the other held
 * launches, nothing else would retry a fix — a review settles exactly once.
 */
export const USAGE_PAUSE_PENDING_FIX_KEY = 'usage_pause_pending_review_fix';

/**
 * Task metadata key for a START the usage pause is holding: a task's own
 * agent (a cluster driver) asked to start this subtask while the credential it
 * would spend was paused. The start's parameters (JSON), so the reconciler can
 * launch it exactly as asked once the window resets
 * (src/daemon/usage-pause.ts, `processUsagePauseHolds`).
 *
 * Held rather than refused because the driver cannot do anything useful with a
 * refusal: its own turn is still running (the pause never stops a running
 * turn), nothing would ever restart it after the reset, and retrying is exactly
 * the spending the pause exists to stop. A held child is WAITABLE — `lazy_wait`
 * treats it as still running — so the driver waits on it like any other child.
 */
export const USAGE_PAUSE_PENDING_START_KEY = 'usage_pause_pending_start';

export interface UsagePausePendingStart {
  /** When the start was asked for (unix ms). */
  requestedAt: number;
  /** The start's own parameters (StartTaskParams minus task and actor), replayed verbatim. */
  params: Record<string, unknown>;
}

export function usagePausePendingStartOf(
  task: { metadata?: Record<string, string> | null },
): UsagePausePendingStart | null {
  const raw = task.metadata?.[USAGE_PAUSE_PENDING_START_KEY];
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as UsagePausePendingStart;
    return typeof v?.requestedAt === 'number' && v.params && typeof v.params === 'object' ? v : null;
  } catch {
    // Only lazy writes this key; one that no longer parses carries no start
    // lazy could replay, and the reconciler's pass clears it.
    return null;
  }
}

/** A never-started task whose start the usage pause is holding. */
export function isUsagePauseHeldStart(
  task: { status: string; metadata?: Record<string, string> | null },
): boolean {
  return task.status === 'backlog' && !!task.metadata?.[USAGE_PAUSE_PENDING_START_KEY];
}

/**
 * Task metadata key, on a PARENT, naming its subtasks whose held start the
 * daemon has since launched (JSON `{ children: string[] }`). The reconciler
 * wakes the parked parent once for them (src/daemon/usage-pause.ts,
 * `processUsagePauseHolds`) and clears it.
 *
 * Why the parent is woken rather than left waiting: a driver told to keep
 * waiting on a held child re-polls with a full-context model request every
 * wait timeout, for the whole pause — spending exactly the credential the pause
 * is holding. So the held-start answer tells it to END its turn, and this is
 * what brings it back.
 */
export const USAGE_PAUSE_WAKE_KEY = 'usage_pause_wake_parent';

export function usagePauseWakeChildrenOf(task: { metadata?: Record<string, string> | null }): string[] {
  const raw = task.metadata?.[USAGE_PAUSE_WAKE_KEY];
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as { children?: unknown };
    return Array.isArray(v?.children) ? v.children.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    // Only lazy writes this key; one that no longer parses names nobody, and
    // the reconciler's pass clears it.
    return [];
  }
}
