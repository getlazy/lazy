/**
 * Process-level per-task serialization for lifecycle mutations.
 *
 * The daemon serves RPCs concurrently (Bun.serve invokes the request handler
 * per connection with no serialization), so two clients acting on the SAME task
 * at the same moment — e.g. a human running `lazy accept` while the builder also
 * accepts — interleave at every `await` inside the orchestration. The accept
 * flow is a long check-then-act sequence (preflight → merge → fast-forward →
 * endSession → status transition → cleanup); its preflight guards
 * (`task.status`, `sess.outcome === 'accepted'`) are a TOCTOU that both callers
 * clear before either commits its terminal transition. The result is a double
 * merge and racing status writes that can leave a task `blocked` while its merge
 * has already been applied.
 *
 * This mutex makes the whole mutation run atomically with respect to other
 * lifecycle mutations on the same task. The loser of a concurrent accept then
 * re-runs preflight AFTER the winner has committed, observes the accepted
 * session outcome, and returns a clean deterministic "already accepted" — the
 * merge runs exactly once.
 *
 * Keyed on the CANONICAL full task id (resolved by the caller), so two accepts
 * that name the same task by different forms (code vs short id vs full id) still
 * serialize against each other.
 *
 * NOTE: this is in-process only. It does not coordinate across separate daemon
 * processes or daemon-less CLI invocations on the same repo; those rely on the
 * file-based StorageLock and the preflight guards. In normal operation a single
 * daemon owns all lifecycle mutations for a repo, which is the case this guards.
 */

import { TaskMutex } from '../utils/task-mutex';

const lifecycleMutex = new TaskMutex();

/**
 * Run `fn` while holding the lifecycle lock for `canonicalTaskId`.
 * Operations on the same task id run sequentially (FIFO); operations on
 * different tasks run concurrently.
 */
export function withTaskLifecycleLock<T>(canonicalTaskId: string, fn: () => Promise<T>): Promise<T> {
  return lifecycleMutex.withLock(canonicalTaskId, fn);
}
