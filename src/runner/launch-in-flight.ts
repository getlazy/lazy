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

// Reference-counted, not a Set: the reconciler registers a dispatched
// auto-resume under the task id for its whole duration, and the runner's own
// launch registers the same task key inside it — the inner release must not
// clear the outer registration.
const inFlight = new Map<string, number>();

function add(k: string): void {
  inFlight.set(k, (inFlight.get(k) ?? 0) + 1);
}

function remove(k: string): void {
  const n = (inFlight.get(k) ?? 0) - 1;
  if (n > 0) inFlight.set(k, n);
  else inFlight.delete(k);
}

function keysFor(runName: string, taskId?: string): string[] {
  return taskId ? [`run:${runName}`, `task:${taskId}`] : [`run:${runName}`];
}

/** Run `fn` with the launch registered for its whole duration, success or failure. */
export async function withLaunchInFlight<T>(runName: string, taskId: string | undefined, fn: () => Promise<T>): Promise<T> {
  const keys = keysFor(runName, taskId);
  for (const k of keys) add(k);
  try {
    return await fn();
  } finally {
    for (const k of keys) remove(k);
  }
}

/** Is a launch for this run name or task id still in progress in this process? */
export function launchInFlight(runName: string, taskId?: string): boolean {
  return keysFor(runName, taskId).some(k => inFlight.has(k));
}

/** Test seam: mark a launch as in progress without running one. Pair with {@link endLaunch}. */
export function beginLaunch(runName: string, taskId?: string): void {
  for (const k of keysFor(runName, taskId)) add(k);
}

/** Test seam: the counterpart of {@link beginLaunch}. */
export function endLaunch(runName: string, taskId?: string): void {
  for (const k of keysFor(runName, taskId)) remove(k);
}

/**
 * Register a launch known only by task id — the reconciler's dispatched
 * auto-resume, whose run name is not resolved until the runner is created.
 * Returns the release; calling it more than once is harmless.
 */
export function beginTaskLaunch(taskId: string): () => void {
  const k = `task:${taskId}`;
  add(k);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    remove(k);
  };
}

/** Is ANY launch in progress in this process? (The machine-integrity canary stays out of a launch's way.) */
export function anyLaunchInFlight(): boolean {
  return inFlight.size > 0;
}
