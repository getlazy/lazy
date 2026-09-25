/**
 * How doctor — the report and the remedies alike — acquires storage.
 *
 * The reason this is not `requireStorage()` is the important part.
 * `requireStorage()` prints and calls `process.exit(1)` (correct for a one-shot
 * command whose whole job needs the store, and invisible to any caller's
 * `catch`). Doctor's job is to REPORT: a store it cannot read must degrade one
 * check to a skip, never take the remaining checks — or a remedy the human has
 * already confirmed — down with it.
 *
 * Lives in `src/doctor/` (not `src/cli/`) so the daemon can import it without
 * crossing the CLI boundary.
 */

import { tryRemoteStorage } from '../preconditions';
import { createStorage } from '../storage';
import type { Storage } from '../storage/interface';

/**
 * How long a doctor storage call may wait for the storage lock before failing.
 *
 * Doctor only ever READS through these handles, and a check it cannot run is a
 * reported skip — so waiting is pure loss. The default retry loop stays exactly
 * as it is for every command that has real work to do; this override is
 * doctor-only on purpose (see StorageLockOptions).
 *
 * Two seconds is well past a healthy write (FileStorage holds the lock for the
 * duration of one operation, milliseconds) and well short of the default loop.
 */
export const DOCTOR_LOCK_TIMEOUT_MS = 2_000;

/**
 * Open storage for a doctor check or remedy.
 *
 * Prefers the daemon (it owns storage) so we never open a second FileStorage
 * that contends on the storage lock; falls back to a direct handle that FAILS
 * FAST rather than queueing. Callers must close only what they own.
 *
 * When `existing` is passed (the daemon's long-lived handle), it is used as-is
 * and never closed.
 */
export async function openDoctorStorage(
  root: string,
  existing?: Storage,
): Promise<{ storage: Storage; ownsStorage: boolean }> {
  if (existing) return { storage: existing, ownsStorage: false };
  const remote = await tryRemoteStorage(root);
  if (remote) return { storage: remote, ownsStorage: false };
  return {
    storage: await createStorage(root, { lockTimeoutMs: DOCTOR_LOCK_TIMEOUT_MS }),
    ownsStorage: true,
  };
}

/**
 * Run `fn` against a doctor storage handle, closing only what we opened.
 *
 * Getting the close wrong closes the DAEMON's handle out from under the rest
 * of the sweep.
 */
export async function withDoctorStorage<T>(
  root: string,
  fn: (storage: Storage) => Promise<T>,
  existing?: Storage,
): Promise<T> {
  const { storage, ownsStorage } = await openDoctorStorage(root, existing);
  try {
    return await fn(storage);
  } finally {
    if (ownsStorage) await storage.close();
  }
}
