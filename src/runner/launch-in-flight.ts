/**
 * Which task launches this daemon process is in the middle of.
 *
 * A launch is not instantaneous: `launchSupervisor` resolves the container
 * image FIRST — and on a fresh host that means BUILDING the agent image, which
 * takes minutes — and only then runs the container. The task is already
 * `working` for all of it, and the session's run name is stamped only after
 * the launch returns. The reconciler's other guards cannot see this window:
 * the worktree lock is re-entrant on pid and the reconcile loop shares the
 * daemon process that holds it, and the grace period is 30 seconds.
 *
 * MEASURED, not hypothetical: the fleet demo's first turn inside a fresh
 * microVM built the runner image for about two minutes; at one minute the
 * reconciler found no container, recorded "Container disappeared (no exit
 * code)" and parked the task `interrupted` — then the build finished and the
 * container started anyway, running a real turn against a task the UI showed
 * as interrupted, and the human's Restart reused that container.
 *
 * Process-local ON PURPOSE. A launch is this process's own awaited call; if
 * the daemon dies mid-launch there is nothing in flight any more, and the next
 * daemon reconciling the task as "no container" is the right answer. Keyed by
 * task id AND run name, because the reconciler knows both and a caller may
 * lack the task id.
 */

const inFlight = new Set<string>();

function keysFor(runName: string, taskId?: string): string[] {
  return taskId ? [`run:${runName}`, `task:${taskId}`] : [`run:${runName}`];
}

/** Run `fn` with the launch registered for its whole duration, success or failure. */
export async function withLaunchInFlight<T>(runName: string, taskId: string | undefined, fn: () => Promise<T>): Promise<T> {
  const keys = keysFor(runName, taskId);
  for (const k of keys) inFlight.add(k);
  try {
    return await fn();
  } finally {
    for (const k of keys) inFlight.delete(k);
  }
}

/** Is a launch for this run name or task id still in progress in this process? */
export function launchInFlight(runName: string, taskId?: string): boolean {
  return keysFor(runName, taskId).some(k => inFlight.has(k));
}

/** Test seam: mark a launch as in progress without running one. Pair with {@link endLaunch}. */
export function beginLaunch(runName: string, taskId?: string): void {
  for (const k of keysFor(runName, taskId)) inFlight.add(k);
}

/** Test seam: the counterpart of {@link beginLaunch}. */
export function endLaunch(runName: string, taskId?: string): void {
  for (const k of keysFor(runName, taskId)) inFlight.delete(k);
}
