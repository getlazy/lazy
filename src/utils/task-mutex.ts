/**
 * Per-key async mutex for serializing concurrent operations on the same resource.
 *
 * The StorageLock (file-based) handles inter-process exclusion but is re-entrant
 * within a single process — concurrent async operations in the same process can
 * interleave at await points. This mutex serializes those operations per key
 * (typically a task ID) so that e.g. two concurrent atomicWriteTask calls on the
 * same task directory run sequentially.
 *
 * Implementation: maintains a Map of key → tail Promise. Each new operation
 * chains onto the current tail, creating a FIFO queue per key. When the queue
 * drains (no waiters), the entry is removed to prevent memory leaks.
 */

export class TaskMutex {
  private readonly queues = new Map<string, Promise<void>>();

  /**
   * Run `fn` while holding the mutex for `key`.
   * Operations on different keys run concurrently.
   * Operations on the same key run sequentially in FIFO order.
   */
  /**
   * Is an operation currently holding (or queued for) the mutex on `key`?
   *
   * The queue entry exists for exactly as long as some operation is running or
   * waiting, so this is the process's honest answer to "does anything own this
   * resource right now". Used by owner-liveness checks that must tell a live
   * operation from the wreckage of a dead one.
   */
  isLocked(key: string): boolean {
    return this.queues.has(key);
  }

  /**
   * Run `fn` under the mutex for `key`, but only if the mutex is free RIGHT NOW.
   *
   * Returns `{ ran: false }` immediately when another operation owns the key.
   * Callers that must not hang behind a long operation — a human trying to
   * escape a task while an accept may be merging it — use this to refuse with
   * an explanation instead of blocking for minutes.
   */
  async tryWithLock<T>(key: string, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
    if (this.queues.has(key)) return { ran: false };
    return { ran: true, value: await this.withLock(key, fn) };
  }

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    // Capture the current tail — we'll wait for it before running
    const prev = this.queues.get(key) ?? Promise.resolve();

    // Create a deferred that resolves when our operation completes
    let resolve!: () => void;
    const gate = new Promise<void>((r) => {
      resolve = r;
    });

    // Chain ourselves onto the queue BEFORE awaiting, so subsequent
    // callers will wait for us
    this.queues.set(key, gate);

    // Wait for the previous operation to finish
    await prev;

    try {
      return await fn();
    } finally {
      // Clean up if we're still the tail (no one queued after us)
      if (this.queues.get(key) === gate) {
        this.queues.delete(key);
      }
      resolve();
    }
  }
}
