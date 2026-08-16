/**
 * Global file-system lock for the storage layer.
 *
 * Provides inter-process locking using a PID-based lock file at
 * <datadir>/.storage-lock, with stale lock detection (checks if the
 * owning process is still alive).
 *
 * Only WRITE operations need this lock. Read operations are safe without
 * it because all file writes use atomic rename (write to temp, rename
 * into place), so readers always see complete file content.
 *
 * INVARIANT: `withLock` provides MUTUAL EXCLUSION in-process, not just
 * across processes. Re-entrancy is scoped to the async execution context
 * (AsyncLocalStorage), so a genuinely nested storage call re-enters without
 * deadlocking, while two INDEPENDENT concurrent operations queue.
 *
 * That distinction is load-bearing. The file lock alone is PID-keyed
 * (`lock.pid === process.pid` → "we already hold it"), so every concurrent
 * operation inside the daemon used to sail straight through it. Storage
 * writes are read-modify-write over a whole task directory
 * (`FileStorage.atomicWriteTask` copies the directory and swaps it), so two
 * interleaved operations did not merely race on one field — the loser's
 * ENTIRE write was reverted, including files it alone had touched. That is
 * how an acknowledged `lazy edit --prompt` was reported as saved (both
 * task.json and prompt-history.json were written) and then silently rolled
 * back by a concurrent `lazy start` whose own writes were built from a
 * pre-edit snapshot of the directory. See CLAUDE.md, "Never Lose Human
 * Feedback": an acknowledged edit must be durable.
 *
 * The raw `acquire()`/`release()` pair keeps the older process-wide depth
 * counter and is the low-level primitive only — it does NOT serialize
 * independent in-process operations. Production code uses `withLock`.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync, openSync, closeSync, constants } from 'fs';
import { join, dirname } from 'path';
import { getDataDir } from '../cli/init';
import { logger } from './logger';
import {
  checkHolder,
  isZombieState,
  looksLikeLazyProcess,
  readProcessIdentity,
  selfIdentity,
  type ProcessIdentity,
  type StartTimeSource,
} from './process-identity';

const LOCK_FILENAME = '.storage-lock';

/** Name of the lock file inside a store directory, for callers that only
 *  want to LOOK at it (doctor) rather than take it. */
export const STORAGE_LOCK_FILENAME = LOCK_FILENAME;

/** Maximum number of attempts to acquire the lock */
const MAX_ATTEMPTS = 50;

/** Base delay between lock acquisition attempts in milliseconds */
const RETRY_DELAY_MS = 100;

/** Maximum jitter added to retry delay to prevent thundering herd */
const RETRY_JITTER_MS = 50;

interface StorageLockFile {
  pid: number;
  acquired_at: string;
  /**
   * Identity of the holder, captured at acquire time, so a later reader can
   * tell "this pid, still the process that took the lock" apart from "this pid,
   * recycled to something else". Optional: lock files written by older lazy
   * versions have neither, and are handled by the backstops in judgeHolder().
   */
  holder_started_at?: string;
  holder_start_source?: StartTimeSource;
  holder_command?: string;
}

// Re-exported so existing callers and tests keep their import site. The zombie
// rule itself lives in process-identity, shared by every pid-based lock.
export { isZombieState };

/**
 * Check if a process is alive AND able to hold the lock.
 *
 * `process.kill(pid, 0)` only tests whether the pid exists in the process
 * table — and a ZOMBIE (defunct) process, terminated but not yet reaped by its
 * parent, still answers it. A zombie holds no resources and will NEVER release
 * the storage lock, so treating it as "alive" deadlocks every future writer
 * forever (observed in the wild: a `lazy pair` child grabbed the lock, died,
 * and was left unreaped — the daemon then 500'd on every storage RPC). So we
 * additionally check the process state and treat a zombie as dead.
 *
 * NOTE: liveness alone is NOT enough to decide whether a lock is still held —
 * see checkHolder() in process-identity, which additionally verifies that the
 * process at that pid is the same one that took the lock. This function answers
 * only the narrow "is anything alive at this pid" question.
 */
export async function isProcessRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return false; // No such process.
  }
  // Exists in the table — distinguish a live process from a zombie.
  const identity = await readProcessIdentity(pid);
  // Identity unavailable — be conservative and assume the holder is alive
  // rather than risk stealing a lock from a genuinely-running process.
  if (!identity) return true;
  return !isZombieState(identity.state);
}

/**
 * This process's own identity, captured once. A process's pid and start time
 * never change, so there is no point paying for the lookup on every acquire.
 */
let selfIdentityPromise: Promise<ProcessIdentity | null> | null = null;
function ownIdentity(): Promise<ProcessIdentity | null> {
  if (!selfIdentityPromise) selfIdentityPromise = selfIdentity();
  return selfIdentityPromise;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface LockHolderDescription {
  /** One-liner naming the holder, appended to the failure's first line. */
  summary: string;
  /** What the reader should actually do about it. */
  advice: string;
}

/**
 * Describe the process currently holding the lock, for the failure message.
 *
 * Reads the lock file for the holder pid/acquired_at and asks the OS for the
 * holder's command line (which, for a lazy daemon, includes the project path it
 * serves). Best-effort: if the lock file is gone or the OS cannot say, it
 * degrades to whatever it could learn so the error is never made worse by this
 * diagnostic. Only called on the terminal acquire failure — not on the hot path
 * — so the sync file read is acceptable.
 *
 * The ADVICE is the part that matters. A holder that cannot plausibly be a
 * lazy process means a recycled pid, not a colliding project: sending that
 * reader off to audit `external_path` (as this message used to do
 * unconditionally) costs real debugging time on a store that was configured
 * correctly all along.
 */
async function describeLockHolder(lockPath: string): Promise<LockHolderDescription> {
  const collisionAdvice =
    `If that holder is a different project's daemon, your storage paths collide: ` +
    `check [storage] external_path in lazy.toml — two projects must not share one store. ` +
    `Run 'lazy daemon list' to see which project each daemon serves.`;

  let pid: number | null = null;
  let acquiredAt: string | null = null;
  let recordedStart: string | null = null;
  let recordedStartSource: StartTimeSource | null = null;
  try {
    const content = readFileSync(lockPath, 'utf-8');
    const lock = JSON.parse(content) as Partial<StorageLockFile>;
    if (typeof lock.pid === 'number') pid = lock.pid;
    if (typeof lock.acquired_at === 'string') acquiredAt = lock.acquired_at;
    if (typeof lock.holder_started_at === 'string') recordedStart = lock.holder_started_at;
    if (lock.holder_start_source) recordedStartSource = lock.holder_start_source;
  } catch {
    // Lock file vanished or is unparseable — the holder may have just released.
    return {
      summary: 'holder unknown (lock file could not be read — the holder may have just released it; retry)',
      advice: `Run 'lazy doctor' to check the store for a stale lock.`,
    };
  }
  if (pid === null) {
    return {
      summary: 'holder unknown (lock file has no pid)',
      advice: `That lock file is malformed and nothing will ever release it. Remove it: rm ${lockPath}`,
    };
  }

  const identity = await readProcessIdentity(pid);
  const command = identity?.command ?? null;

  const parts = [`held by process pid ${pid}`];
  if (acquiredAt) parts.push(`since ${acquiredAt}`);
  if (command) parts.push(`(${command})`);

  // If the holder's recorded identity still matches the process at that pid,
  // this IS the process that took the lock — whatever its command line looks
  // like — so the pid-reuse advice would be a lie. Only an UNVERIFIABLE holder
  // (a lock file from an older lazy, or an OS that would not say) can be
  // diagnosed from the command line alone.
  const identityVerified =
    !!recordedStart &&
    !!recordedStartSource &&
    recordedStartSource === identity?.startedSource &&
    recordedStart.trim().replace(/\s+/g, ' ') === (identity?.started ?? '').trim().replace(/\s+/g, ' ');

  const advice =
    !identityVerified && command && !looksLikeLazyProcess(command)
      ? `That process is NOT a lazy process, so this lock is STALE: a lazy process died without ` +
        `releasing it and the OS recycled its pid. Nothing will ever release it. ` +
        `Clear it with: rm ${lockPath} — or run 'lazy doctor', which detects and offers to clear it.`
      : `${collisionAdvice}\nIf no lazy process is running at all, the lock is stale: ` +
        `run 'lazy doctor' to detect and clear it.`;

  return { summary: parts.join(' '), advice };
}

/** What a probe found sitting on the lock. */
export interface HeldLockReport {
  pid: number;
  /** When the CURRENT holder took the lock (ISO), or null if it did not say. */
  acquiredAt: string | null;
  /** The holder's command line, when the OS would say. */
  command: string | null;
  /** How long the probe watched it before giving this answer. */
  observedForMs: number;
}

interface LockSnapshot {
  pid: number;
  acquiredAt: string | null;
  raw: Partial<StorageLockFile>;
}

function readLockSnapshot(lockPath: string): LockSnapshot | null {
  try {
    const lock = JSON.parse(readFileSync(lockPath, 'utf-8')) as Partial<StorageLockFile>;
    if (typeof lock.pid !== 'number') return null;
    return {
      pid: lock.pid,
      acquiredAt: typeof lock.acquired_at === 'string' ? lock.acquired_at : null,
      raw: lock,
    };
  } catch {
    // Absent, half-written, or unparseable. None of those is "one live holder
    // sitting on the lock", which is the only thing this probe reports.
    return null;
  }
}

async function holderIsAlive(snapshot: LockSnapshot): Promise<boolean> {
  const verdict = await checkHolder({
    pid: snapshot.pid,
    started: typeof snapshot.raw.holder_started_at === 'string' ? snapshot.raw.holder_started_at : null,
    startedSource: snapshot.raw.holder_start_source ?? null,
    acquiredAt: snapshot.acquiredAt,
  });
  return verdict.alive;
}

/**
 * LOOK at the storage lock without queueing behind it.
 *
 * `acquire()` answers "can I have it", and answers slowly on purpose: a busy
 * store is normal and retrying is the right behaviour for a command that has
 * work to do. `lazy doctor` has a different question — "is anything sitting on
 * this store, and should I therefore skip the checks that would block" — and it
 * must answer that in bounded time even when the answer is yes. Blocking is the
 * one thing a diagnostic may not do.
 *
 * Returns non-null only for the case doctor cares about: ONE live holder,
 * unchanged for the whole observation window. Everything else is null, and each
 * for a reason:
 *   - no lock file / unreadable → nothing to report (a wedge on an unreadable
 *     file is `checkStorageLock`'s case, not this one).
 *   - the holder's identity does not verify → the lock is STALE, which is again
 *     `checkStorageLock`'s case; it offers to remove it.
 *   - the pid or acquired_at CHANGED during the window → the store is being
 *     handed from one acquire to the next, i.e. somebody is making progress.
 *     That is a healthy busy daemon, which must never be reported as a problem.
 *
 * The window is what makes a healthy daemon safe: FileStorage takes the lock
 * per operation, so an ordinary write holds it for milliseconds and is gone
 * before the first poll.
 */
export async function probeHeldStorageLock(
  lockPath: string,
  opts?: { windowMs?: number; pollMs?: number },
): Promise<HeldLockReport | null> {
  const windowMs = opts?.windowMs ?? 1_500;
  const pollMs = opts?.pollMs ?? 250;

  const first = readLockSnapshot(lockPath);
  if (!first) return null;
  if (!(await holderIsAlive(first))) return null;

  const startedAt = Date.now();
  let last = first;
  while (Date.now() - startedAt < windowMs) {
    await sleep(Math.min(pollMs, Math.max(0, windowMs - (Date.now() - startedAt))));
    const now = readLockSnapshot(lockPath);
    if (!now) return null; // Released.
    if (now.pid !== first.pid || now.acquiredAt !== first.acquiredAt) return null; // Churn.
    last = now;
  }

  // Same holder for the whole window. Re-verify liveness at the end rather than
  // trusting the opening check: a holder that died mid-window leaves a stale
  // lock, and calling that "held" would send the reader after a live process
  // that no longer exists.
  if (!(await holderIsAlive(last))) return null;

  const identity = await readProcessIdentity(last.pid);
  return {
    pid: last.pid,
    acquiredAt: last.acquiredAt,
    command: identity?.command ?? null,
    observedForMs: Date.now() - startedAt,
  };
}

export interface StorageLockOptions {
  /**
   * Give up on acquiring after this long instead of running the default
   * fixed-attempt retry loop.
   *
   * For callers that would rather fail fast than queue — `lazy doctor` opens
   * storage to READ diagnostics, so waiting out a contended store costs it the
   * whole report. Leave unset everywhere else: the default loop is correct for
   * a command that actually has work to do, and shortening it would turn
   * ordinary contention into spurious failures.
   */
  acquireTimeoutMs?: number;
}

/**
 * Storage lock manager.
 *
 * One instance per FileStorage. Uses a file-system lock for inter-process
 * exclusion and a depth counter for intra-process re-entrancy.
 */
export class StorageLock {
  private readonly lockPath: string;
  private readonly acquireTimeoutMs: number | undefined;
  private depth: number = 0;

  /**
   * Every instance in THIS process that currently holds each lock path.
   *
   * The lock FILE is pid-keyed, so a second StorageLock on the same store
   * inside one process takes the "same pid, we already hold it" path in
   * tryAcquire() without writing anything — and used to unlink the file on its
   * own release, deleting a lock a different, still-holding instance had taken.
   * The file then said "free" while this process believed it owned the store,
   * so another process could take it and both would write. The daemon is
   * supposed to be the single writer (getOrCreateStorage memoizes one Storage
   * for exactly that reason), but nothing structurally prevents a second
   * instance, and the lock must not depend on that.
   *
   * Keyed by lock path so unrelated stores in one process (tests, the builder)
   * do not interfere. The file is removed when the LAST in-process holder lets
   * go — which is also what heals a file some earlier release failed to remove.
   */
  private static readonly inProcessHolders = new Map<string, Set<StorageLock>>();

  /** Does any instance in this process currently hold `lockPath`? */
  private static heldInProcess(lockPath: string): boolean {
    return (StorageLock.inProcessHolders.get(lockPath)?.size ?? 0) > 0;
  }

  /**
   * Marks the async execution context of an in-flight `withLock` body, so a
   * nested `withLock` from the SAME operation re-enters instead of queueing
   * behind itself (which would deadlock). Independent operations run in
   * different contexts and see no store, so they queue.
   */
  private readonly holder = new AsyncLocalStorage<true>();

  /** Tail of the in-process FIFO queue of `withLock` waiters. */
  private queue: Promise<void> = Promise.resolve();

  constructor(lazyRoot: string, lockDir?: string, options?: StorageLockOptions) {
    this.lockPath = lockDir
      ? join(lockDir, LOCK_FILENAME)
      : join(lazyRoot, getDataDir(lazyRoot), LOCK_FILENAME);
    this.acquireTimeoutMs = options?.acquireTimeoutMs;
  }

  /**
   * Acquire the storage lock. Blocks (with retry) until acquired.
   *
   * Re-entrant: if the current process already holds the lock,
   * increments the depth counter without touching the file system.
   */
  async acquire(): Promise<void> {
    // Re-entrant: already held by this process in-memory
    if (this.depth > 0) {
      this.depth++;
      return;
    }

    // Two ways to give up. The default is the fixed attempt count every command
    // has always used; `acquireTimeoutMs` is the opt-in fail-fast path for a
    // caller that must not block (see StorageLockOptions).
    const deadline = this.acquireTimeoutMs === undefined ? null : Date.now() + this.acquireTimeoutMs;
    let attempts = 0;
    for (;;) {
      attempts++;
      if (await this.tryAcquire()) {
        this.depth = 1;
        let holders = StorageLock.inProcessHolders.get(this.lockPath);
        if (!holders) {
          holders = new Set();
          StorageLock.inProcessHolders.set(this.lockPath, holders);
        }
        holders.add(this);
        return;
      }
      const exhausted = deadline === null ? attempts >= MAX_ATTEMPTS : Date.now() >= deadline;
      if (exhausted) break;
      // Add random jitter to prevent multiple processes from retrying in lockstep
      const jitter = Math.floor(Math.random() * RETRY_JITTER_MS);
      const delay = RETRY_DELAY_MS + jitter;
      await sleep(deadline === null ? delay : Math.min(delay, Math.max(0, deadline - Date.now())));
    }

    const holder = await describeLockHolder(this.lockPath);
    const gaveUp =
      deadline === null
        ? `after ${attempts} attempts`
        : `after ${this.acquireTimeoutMs}ms (${attempts} attempt${attempts === 1 ? '' : 's'})`;
    throw new Error(
      `Failed to acquire storage lock ${gaveUp}. ` +
        `Lock file: ${this.lockPath} — ${holder.summary}.\n` +
        holder.advice
    );
  }

  /**
   * Release the storage lock. Decrements the depth counter and removes the lock
   * file once no instance in this process holds it any more.
   *
   * "No instance", not "not this one": the file is one shared object and a
   * second instance may still be sitting on it (see inProcessHolders). Removing
   * it under that instance would leave this process writing to a store the file
   * says is free.
   */
  release(): void {
    if (this.depth <= 0) {
      return;
    }

    this.depth--;
    if (this.depth > 0) return;

    const holders = StorageLock.inProcessHolders.get(this.lockPath);
    holders?.delete(this);
    if (holders && holders.size === 0) StorageLock.inProcessHolders.delete(this.lockPath);
    if (holders && holders.size > 0) return; // Somebody else in this process still holds it.

    try {
      unlinkSync(this.lockPath);
    } catch (err) {
      // Already gone is the outcome we wanted — a concurrent release, or a
      // holder in another process that reclaimed this lock as stale.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      // Anything else and the file OUTLIVES the hold it describes. That is not
      // cosmetic: this process will self-acquire the leftover forever on the
      // pid path, every other process queues on it, and `lazy doctor` reads it
      // as a holder that never let go. Nothing above can act on it, so the one
      // thing that must not happen is silence.
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        `Could not remove the storage lock at ${this.lockPath} after releasing it: ${message}. ` +
          `Other processes will queue on that file until it is removed; ` +
          `run 'lazy doctor' if lazy commands start hanging on this store.`,
      );
    }
  }

  /**
   * Run a function while holding the storage lock, with MUTUAL EXCLUSION both
   * across processes (the lock file) and within this one (a FIFO queue).
   * Guarantees the lock is released even if the function throws.
   *
   * Re-entrant only for calls nested inside an already-running body — those
   * run inline rather than queueing behind themselves.
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    // Nested call from within a section this process already holds: run inline.
    if (this.holder.getStore()) {
      return fn();
    }

    // Chain onto the in-process queue BEFORE awaiting, so later callers wait
    // for us. Same pattern as TaskMutex, but for the whole store.
    const prev = this.queue;
    let done!: () => void;
    this.queue = new Promise<void>((resolve) => {
      done = resolve;
    });

    // A rejected predecessor must not poison the queue — every waiter releases
    // its gate in a finally, so `prev` only settles, never stays pending.
    await prev;

    try {
      await this.acquire();
      try {
        return await this.holder.run(true, fn);
      } finally {
        this.release();
      }
    } finally {
      done();
    }
  }

  /**
   * Try to acquire the file-system lock once.
   * Returns true if acquired, false if held by another live process.
   *
   * Uses O_EXCL for atomic create-or-fail to prevent TOCTOU races where
   * two processes both see "no lock file" and both write their own.
   */
  private async tryAcquire(): Promise<boolean> {
    // Precondition: lock directory must exist
    const lockDir = dirname(this.lockPath);
    if (!existsSync(lockDir)) {
      throw new Error(
        `Storage lock directory does not exist: ${lockDir}. Has 'lazy init' been run?`
      );
    }

    // Record WHO we are, not just our pid, so a future reader can tell this
    // lock apart from one whose pid the OS has since recycled.
    const self = await ownIdentity();
    const lockData: StorageLockFile = {
      pid: process.pid,
      acquired_at: new Date().toISOString(),
      ...(self?.started && self.startedSource
        ? { holder_started_at: self.started, holder_start_source: self.startedSource }
        : {}),
      ...(self?.command ? { holder_command: self.command } : {}),
    };
    const lockContent = JSON.stringify(lockData, null, 2) + '\n';

    // Fast path: try atomic create with O_EXCL — fails if file already exists.
    // This eliminates the TOCTOU race in the old check-then-write approach.
    try {
      const fd = openSync(this.lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      try {
        writeFileSync(fd, lockContent, 'utf-8');
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (err: unknown) {
      // EEXIST means the lock file already exists — check if it's stale
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code !== 'EEXIST') {
        return false; // Unexpected error — treat as failed acquisition
      }
    }

    // Lock file exists — check if we own it or if it's stale
    try {
      const content = readFileSync(this.lockPath, 'utf-8');
      const lock: StorageLockFile = JSON.parse(content);

      // The file already carries OUR pid. Two very different situations, and
      // the timestamp must not lie about either:
      //
      //  - another instance in this process is holding it right now → leave the
      //    file exactly as it is. `acquired_at` marks when this process's hold
      //    began, and rewriting it to "now" on every re-entry would reset the
      //    age of a hold that never let go, hiding a genuinely stuck holder
      //    from every reader (`lazy doctor` among them).
      //  - nobody in this process holds it → the file is a LEFTOVER: an earlier
      //    release could not remove it (see release()). Its timestamp describes
      //    a hold that ended, so claim the file with a fresh one rather than
      //    inheriting an age that has nothing to do with us. The rename is
      //    atomic, so a concurrent reader sees the old file or the new one,
      //    never a half-written mix.
      if (lock.pid === process.pid) {
        if (!StorageLock.heldInProcess(this.lockPath)) {
          const tmpPath = `${this.lockPath}.${process.pid}.tmp`;
          try {
            writeFileSync(tmpPath, lockContent, 'utf-8');
            renameSync(tmpPath, this.lockPath);
          } catch (err) {
            // The stale timestamp is a diagnostic wart, not a correctness
            // problem — we hold the lock either way — so this must not fail the
            // acquire. It must not be silent either.
            const message = err instanceof Error ? err.message : String(err);
            logger.warn(`Could not refresh the storage lock at ${this.lockPath}: ${message}`);
            try { unlinkSync(tmpPath); } catch { /* nothing to clean up */ }
          }
        }
        return true;
      }

      // Is the RECORDED HOLDER still there? Not merely "is something alive at
      // that pid" — a recycled pid answers that forever, which is exactly how
      // this lock used to wedge permanently (see process-identity).
      const verdict = await checkHolder({
        pid: lock.pid,
        started: lock.holder_started_at ?? null,
        startedSource: lock.holder_start_source ?? null,
        acquiredAt: lock.acquired_at ?? null,
      });
      if (verdict.alive) {
        return false; // Lock held by a live process
      }

      // Stale lock — the holder is gone (dead, defunct, or its pid recycled).
      // Remove and retry atomically.
      // Another process might also be trying to claim this stale lock,
      // so we remove-then-create with O_EXCL to race safely.
      try {
        unlinkSync(this.lockPath);
      } catch {
        // Someone else already removed it — that's fine, we'll retry next attempt
        return false;
      }

      // Try atomic create again after removing stale lock
      try {
        const fd = openSync(this.lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
        try {
          writeFileSync(fd, lockContent, 'utf-8');
        } finally {
          closeSync(fd);
        }
        return true;
      } catch {
        return false; // Another process got it first — retry on next attempt
      }
    } catch {
      return false;
    }
  }
}
