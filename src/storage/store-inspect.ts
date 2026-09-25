/**
 * Read a store directory WITHOUT opening it.
 *
 * One reader today: the handover that moves an existing lazy store from a local
 * daemon onto a Lazy Teams fleet (`public-docs/self-hosting-lazy-teams.md`,
 * "Adopting an existing store"). Teams has to answer three questions before it
 * takes ownership of a directory full of somebody's real work, and every one of
 * them has to be answered from OUTSIDE:
 *
 *   1. Is anything still holding this store? Adoption while the local daemon is
 *      running gives the store two writers.
 *   2. Was it written by a lazy NEWER than the one the fleet runs? A newer
 *      schema read by older code is data loss with a plausible-looking UI.
 *   3. Does it carry actor identities this install cannot attribute? Rows name
 *      a person by email, but an older daemon stamped `user-<rails id>` — one
 *      install's numbering, which the daemon's start-up migration clears. So
 *      every person value is reported, under the old field names and the
 *      current ones alike, and the caller decides.
 *
 * NOTHING HERE OPENS THE STORE. It does not construct a FileStorage, does not
 * take `.storage-lock`, and never writes: a preflight that acquired the lock
 * would be indistinguishable from the second writer it exists to prevent, and a
 * preflight that took a lock on a store it then refuses would wedge it. Every
 * read is a plain file read of a directory the caller named.
 *
 * It is a lazy-side module and not Ruby because the store's layout, its schema
 * version and its lock format are lazy's; the fleet supervisor reaches it
 * through `lazy system store-check`, which is the documented carve-out that
 * lets a supervisor shell out to the CLI (lazy-teams/CLAUDE.md).
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';
import { STORAGE_LOCK_FILENAME } from '../utils/storage-lock';
import {
  checkHolder,
  describeDeadReason,
  readProcessIdentity,
  type StartTimeSource,
} from '../utils/process-identity';

/**
 * The schema version THIS lazy writes and understands. Kept beside the store
 * rather than imported from FileStorage on purpose: importing it would pull the
 * whole storage implementation into a preflight whose entire promise is that it
 * opens nothing. `test/unit/store-inspect.test.ts` asserts the two agree.
 */
export const SUPPORTED_STORE_SCHEMA_VERSION = 1;

export type StoreLockState =
  /** No `.storage-lock` at all. */
  | { state: 'absent' }
  /** A lock whose holder is alive — somebody owns this store right now. */
  | { state: 'held'; pid: number; command: string | null; acquired_at: string | null }
  /** A lock left behind by a process that is gone. Harmless, and it is removed
   *  rather than refused: it is the ONE piece of a store that is never data. */
  | { state: 'stale'; pid: number | null; reason: string }
  /** A lock file that will not parse. Reported, never guessed at. */
  | { state: 'unreadable'; detail: string };

export interface StoreInspection {
  /** The directory that was inspected, as given. */
  path: string;
  /** Does it exist and look like a lazy store (a `tasks/` directory)? */
  is_store: boolean;
  /** `version.json`'s schema_version; null when the file is absent — which is
   *  what a store written before versioning, or a hand-made one, looks like. */
  schema_version: number | null;
  /** Why version.json could not be trusted. Null only when it was absent or
   *  parsed successfully. Adoption must refuse a non-null value. */
  schema_error: string | null;
  /** What this lazy understands. */
  supported_schema_version: number;
  /** schema_version > supported_schema_version: written by a newer lazy. */
  schema_is_newer: boolean;
  lock: StoreLockState;
  /** Number of task directories. The operator's sanity check that they named
   *  the store they meant. */
  task_count: number;
  /** Every distinct actor id found in the store's rows — legacy `user-<n>` ids
   *  and current emails alike — sorted. Empty for a store written by a
   *  single-person install, which stamps no person. */
  actor_user_ids: string[];
  /**
   * Store-relative paths of files the actor-id scan did NOT read, because they
   * are over {@link SCAN_MAX_BYTES} or could not be opened.
   *
   * Reported rather than swallowed. `actor_user_ids` is the input to a refusal
   * whose whole point is that misattribution cannot be detected afterwards, so
   * "I found none" and "I found none in the files I read" are different answers
   * and a caller is entitled to know which one it got.
   */
  unscanned_files: string[];
}

/**
 * Keys that name a PERSON in a stored row. From
 * `docs/design/actor-identity-and-remote-clients.md` §1.1, which lists them by
 * row type; scanned by key name rather than by row type so a new row carrying
 * one is covered the day it is added rather than the day somebody remembers.
 */
const ACTOR_ID_KEYS: ReadonlySet<string> = new Set([
  'actor_user_id',
  'resolved_by_user_id',
  'unresolved_by_user_id',
  'flagged_by_user_id',
  // The CURRENT spellings are scanned too. The start-up migration judges them
  // as well (a stale producer can stamp `user-12` straight into `actor_email`)
  // and clears whatever is not an address, so a scan that skipped them would
  // wave through exactly the ids the first daemon start then destroys.
  'actor_email',
  'resolved_by_email',
  'unresolved_by_email',
  'flagged_by_email',
  'edited_by_email',
]);

/**
 * Region-overlay attribution is an actor OBJECT per field — `{ user_id, label }`
 * in the legacy shape, `{ email, name }` in the current one — so the person is
 * one level down, under either spelling.
 */
const OVERLAY_ACTOR_KEYS: ReadonlySet<string> = new Set(['owner_set_by', 'signed_off_by']);
const OVERLAY_PERSON_FIELDS = ['user_id', 'email'] as const;

/** Every person a parsed store file names, wherever in it the row sits. */
function collectFromJson(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectFromJson(item, into);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (ACTOR_ID_KEYS.has(key) && typeof child === 'string' && child.trim()) {
      into.add(child.trim());
    } else if (OVERLAY_ACTOR_KEYS.has(key) && typeof child === 'object' && child !== null && !Array.isArray(child)) {
      for (const field of OVERLAY_PERSON_FIELDS) {
        const person = (child as Record<string, unknown>)[field];
        if (typeof person === 'string' && person.trim()) into.add(person.trim());
      }
    } else {
      collectFromJson(child, into);
    }
  }
}

/**
 * The ceiling on a single file the actor-id scan will read into memory.
 *
 * Generous on purpose — a task's `turns.json` holds every agent response it
 * ever produced and is the one per-task file that can reach megabytes, and the
 * ids this scan is looking for live in exactly that file. The cap is a memory
 * guard against something pathological, not a sampling policy.
 *
 * Anything skipped is REPORTED (`unscanned_files`), never silently dropped:
 * this scan feeds a refusal whose whole justification is that misattribution
 * cannot be detected after the fact, so a caller must be able to tell "no ids"
 * apart from "no ids in what I read".
 */
const SCAN_MAX_BYTES = 64 * 1024 * 1024;

export async function inspectStore(path: string): Promise<StoreInspection> {
  const supported = SUPPORTED_STORE_SCHEMA_VERSION;
  const base: StoreInspection = {
    path,
    is_store: false,
    schema_version: null,
    schema_error: null,
    supported_schema_version: supported,
    schema_is_newer: false,
    lock: { state: 'absent' },
    task_count: 0,
    actor_user_ids: [],
    unscanned_files: [],
  };

  const tasksPath = join(path, 'tasks');
  try {
    const info = await stat(tasksPath);
    if (!info.isDirectory()) return base;
  } catch {
    // No tasks/ — either the path is wrong or it is not a store. Either way the
    // caller's next line is the same refusal, and it is not this function's job
    // to tell those apart: it reports what it found.
    return base;
  }

  const schema = await readSchemaVersion(path);
  const taskDirs = (await readdir(tasksPath, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.includes('.tmp') && !entry.name.includes('.backup'));

  const actorIds = new Set<string>();
  const unscanned: string[] = [];
  for (const dir of taskDirs) {
    await collectActorIds(join(tasksPath, dir.name), `tasks/${dir.name}`, actorIds, unscanned);
  }

  return {
    ...base,
    is_store: true,
    schema_version: schema.version,
    schema_error: schema.error,
    schema_is_newer: schema.version !== null && schema.version > supported,
    lock: await readLockState(join(path, STORAGE_LOCK_FILENAME)),
    task_count: taskDirs.length,
    actor_user_ids: [...actorIds].sort(),
    unscanned_files: unscanned.sort(),
  };
}

async function readSchemaVersion(path: string): Promise<{ version: number | null; error: string | null }> {
  const versionPath = join(path, 'version.json');
  let raw: string;
  try {
    raw = await readFile(versionPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: null, error: null };
    return { version: null, error: `${versionPath} could not be read: ${(err as Error).message}` };
  }

  try {
    const value = JSON.parse(raw)?.schema_version;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      return { version: null, error: `${versionPath} does not contain a valid schema_version` };
    }
    return { version: value, error: null };
  } catch (err) {
    return { version: null, error: `${versionPath} is not valid JSON: ${(err as Error).message}` };
  }
}

async function collectActorIds(
  taskDir: string,
  relativeDir: string,
  into: Set<string>,
  unscanned: string[],
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(taskDir);
  } catch {
    // The directory itself is unreadable — report the whole of it rather than
    // letting a task's worth of ids go unmentioned.
    unscanned.push(`${relativeDir}/`);
    return;
  }

  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const file = join(taskDir, name);
    try {
      const info = await stat(file);
      if (!info.isFile()) continue;
      if (info.size > SCAN_MAX_BYTES) {
        unscanned.push(`${relativeDir}/${name}`);
        continue;
      }
      const text = await readFile(file, 'utf-8');
      // Parsed, not pattern-matched: overlay actors are objects, and a file that
      // will not parse is one the daemon cannot read either — reported below.
      collectFromJson(JSON.parse(text), into);
    } catch {
      // A file that cannot be read contributes no ids — and says so. It is the
      // silence that would be wrong here, not the failure: the caller is about
      // to decide whether this store names anybody it cannot attribute.
      unscanned.push(`${relativeDir}/${name}`);
    }
  }
}

async function readLockState(lockPath: string): Promise<StoreLockState> {
  let raw: string;
  try {
    raw = await readFile(lockPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' };
    return { state: 'unreadable', detail: `${lockPath} could not be read: ${(err as Error).message}` };
  }

  let parsed: { pid?: unknown; acquired_at?: unknown; holder_started_at?: unknown; holder_start_source?: unknown; holder_command?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { state: 'unreadable', detail: `${lockPath} is not readable JSON: ${(err as Error).message}` };
  }

  const pid = typeof parsed.pid === 'number' ? parsed.pid : null;
  if (pid === null) return { state: 'unreadable', detail: `${lockPath} names no pid` };

  const verdict = await checkHolder({
    pid,
    started: typeof parsed.holder_started_at === 'string' ? parsed.holder_started_at : null,
    startedSource: (parsed.holder_start_source as StartTimeSource | undefined) ?? null,
    acquiredAt: typeof parsed.acquired_at === 'string' ? parsed.acquired_at : null,
  });

  if (!verdict.alive) {
    return { state: 'stale', pid, reason: describeDeadReason(verdict.reason) };
  }

  const identity = await readProcessIdentity(pid);
  return {
    state: 'held',
    pid,
    command: identity?.command ?? (typeof parsed.holder_command === 'string' ? parsed.holder_command : null),
    acquired_at: typeof parsed.acquired_at === 'string' ? parsed.acquired_at : null,
  };
}
