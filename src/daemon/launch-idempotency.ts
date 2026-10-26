/**
 * Exactly-once turn launches: an optional client-supplied idempotency key on
 * `startTask`, `unblockTask`, `resumeTask`, `askTask` and `reviewAsk`.
 *
 * WHY: a launch can take minutes (image build, container, worktree), and a
 * client that times out cannot tell "already launched" from "failed". Before
 * this, its retry was either refused (the task is `working` — which reads as an
 * error to a person who just watched their request time out) or, once the first
 * turn had finished, ACCEPTED: the same feedback was recorded a second time and
 * a second turn ran on somebody's quota. Reproduced 2026-10-21 by unblocking a
 * task, waiting the turn out and sending the identical unblock again.
 *
 * WHAT A KEY MEANS: the same key on the same task is the same request.
 *   - first time: the launch runs, and its result is recorded under the key;
 *   - again, after it answered: the recorded result comes back with
 *     `idempotentReplay: true`, and nothing runs;
 *   - again, while it is still running in this daemon: the repeat waits for the
 *     original and returns ITS result — never a second launch;
 *   - again, after it FAILED: re-attempted, but only when the failed attempt
 *     wrote no turn. A refusal wrote nothing (or only a withheld-feedback turn,
 *     which `recordFeedbackThenRefuse` already deduplicates), so trying again is
 *     what a client healing a lost credential needs. A failure AFTER a turn was
 *     recorded is replayed as the same error: re-running it would record the
 *     feedback twice. A command run with `failuresAreFinal` (today only
 *     `reviewAsk`, which posts the question before it can fail) replays EVERY
 *     failure and never runs again;
 *   - again, with a DIFFERENT payload: a loud 422. Replaying a result for a
 *     request the caller did not make would be a silent lie;
 *   - again, after the daemon that ran it died mid-launch (or could not write
 *     its outcome): a 409 saying the outcome is unknown, naming the task's
 *     current status. Guessing either way risks a lost turn or a doubled one;
 *   - from a DIFFERENT caller: a separate record — keys are scoped per caller,
 *     so nobody can claim another person's key.
 *
 * A failure counts as "wrote no turn" by construction when the task was busy
 * (working/pairing) at the claim: every launch path refuses that before writing.
 *
 * DURABLE: the record lives in the store (task metadata), not daemon memory,
 * because a client's retry often arrives after a daemon restart. Bounded per
 * task (oldest entries dropped), so it never grows with the task's history.
 *
 * Feedback first still holds: every caller (Lazy Teams' `TaskAction`, the CLI's
 * recovery) has the words saved before the RPC that reaches this module, and
 * the launch path itself saves them before anything fallible it runs.
 */

import { createHash } from 'crypto';
import type { Storage } from '../storage';
import { RpcError } from './rpc-error';
import { CLAIMING_PROCESS_ID } from './in-flight-turn';
import { logger } from '../utils/logger';

/** Task metadata key holding this task's idempotency records. */
export const LAUNCH_IDEMPOTENCY_KEY = 'launch_idempotency';

/** The wire name of the optional parameter. */
export const IDEMPOTENCY_KEY_PARAM = 'idempotencyKey';

/** How many records one task keeps. Retries come within minutes; this is generous. */
const MAX_RECORDS_PER_TASK = 50;

/** A key is an opaque client token; bounded so it cannot bloat the store. */
const MAX_KEY_LENGTH = 200;

/** Params that do not make a repeat a different request. */
const VOLATILE_PARAMS = new Set([IDEMPOTENCY_KEY_PARAM, 'traceparent']);

export const IDEMPOTENT_LAUNCH_COMMANDS = ['startTask', 'unblockTask', 'resumeTask', 'askTask', 'reviewAsk'] as const;
export type IdempotentLaunchCommand = typeof IDEMPOTENT_LAUNCH_COMMANDS[number];

interface LaunchRecord {
  command: string;
  fingerprint: string;
  state: 'launching' | 'done' | 'failed';
  /** The daemon process that claimed it — a `launching` record from another one was cut off. */
  process: string;
  at: string;
  /** Non-withheld turns on the task's session when the attempt began. */
  turnsBefore: number;
  /** The task's status when the attempt began. */
  statusBefore?: string;
  result?: unknown;
  error?: { status: number; message: string; code?: string };
  /** A failed attempt that recorded a turn is final; one that recorded none may be re-attempted. */
  wroteTurns?: boolean;
}

type Records = Record<string, LaunchRecord>;

/** Read and validate the optional key. Absent → undefined; malformed → 400. */
export function optionalIdempotencyKey(params: Record<string, unknown>): string | undefined {
  const raw = params[IDEMPOTENCY_KEY_PARAM];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new RpcError(400, `${IDEMPOTENCY_KEY_PARAM} must be a non-empty string`);
  }
  if (raw.length > MAX_KEY_LENGTH) {
    throw new RpcError(400, `${IDEMPOTENCY_KEY_PARAM} is ${raw.length} characters; at most ${MAX_KEY_LENGTH} are accepted`);
  }
  return raw;
}

/** Who a record belongs to: the person the daemon pinned, else the channel role. */
function callerScope(actor: unknown): string {
  if (actor && typeof actor === 'object') {
    const a = actor as { email?: unknown; role?: unknown };
    if (typeof a.email === 'string' && a.email) return `person:${a.email.toLowerCase()}`;
    if (typeof a.role === 'string') return `role:${a.role}`;
  }
  return typeof actor === 'string' ? `role:${actor}` : 'role:unknown';
}

/** Canonical JSON with sorted keys, so property order never changes a fingerprint. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** What makes two calls the same request: the command and every non-volatile param. */
export function launchFingerprint(command: string, params: Record<string, unknown>, taskId: string): string {
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (!VOLATILE_PARAMS.has(k) && k !== 'taskId') payload[k] = v;
  }
  return createHash('sha256').update(canonical({ command, taskId, payload })).digest('hex');
}

async function readRecords(storage: Storage, taskId: string): Promise<Records> {
  const raw = await storage.getTaskMetadata(taskId, LAUNCH_IDEMPOTENCY_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Records : {};
  } catch (err) {
    // A corrupt record must not wedge every launch on the task. It only ever
    // held dedup state, so starting over loses protection for in-flight keys,
    // never data — and it is said out loud.
    logger.warn(`Ignoring unreadable ${LAUNCH_IDEMPOTENCY_KEY} metadata on ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

async function writeRecords(storage: Storage, taskId: string, records: Records): Promise<void> {
  const entries = Object.entries(records).sort(([, a], [, b]) => a.at.localeCompare(b.at));
  const kept = Object.fromEntries(entries.slice(Math.max(0, entries.length - MAX_RECORDS_PER_TASK)));
  await storage.updateTaskMetadata(taskId, LAUNCH_IDEMPOTENCY_KEY, JSON.stringify(kept));
}

/** Per-task serialisation of the read-modify-write on the record. The daemon is the only writer. */
const taskLocks = new Map<string, Promise<unknown>>();
async function withTaskLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  const prev = taskLocks.get(taskId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  taskLocks.set(taskId, next);
  try {
    return await next;
  } finally {
    if (taskLocks.get(taskId) === next) taskLocks.delete(taskId);
  }
}

/** Launches with a key running in THIS process — a concurrent repeat joins the original. */
const inFlight = new Map<string, Promise<unknown>>();

async function countRecordedTurns(storage: Storage, taskId: string): Promise<number> {
  const session = await storage.getSessionByTaskId(taskId);
  if (!session) return 0;
  const turns = await storage.getSessionTurns(session.id);
  return turns.filter((t) => t.feedback_withheld !== true).length;
}

function mismatch(key: string, record: LaunchRecord, command: string): RpcError {
  return new RpcError(422,
    `Idempotency key '${key}' was already used for a different request on this task ` +
    `(${record.command === command ? 'same command, different parameters' : `it was a ${record.command}`}). ` +
    'A retry must resend exactly the original request; a new request needs a new key.');
}

function replayError(record: LaunchRecord): RpcError {
  const e = record.error!;
  return new RpcError(e.status, e.message, e.code as never);
}

function withReplayMark(result: unknown): unknown {
  return result && typeof result === 'object' && !Array.isArray(result)
    ? { ...(result as Record<string, unknown>), idempotentReplay: true }
    : result;
}

/**
 * Run `launch` at most once per (task, key). With no key it simply runs.
 *
 * `taskRef` is whatever the caller sent (id, prefix or code); it is resolved to
 * the task's id so a retry spelled differently is still the same request. A ref
 * that resolves to nothing runs `launch` unkeyed, which answers the 404 itself.
 */
export async function withLaunchIdempotency<T>(
  storage: Storage,
  command: IdempotentLaunchCommand,
  params: Record<string, unknown>,
  launch: () => Promise<T>,
  options: {
    /**
     * Replay EVERY failure, never re-run one. For a command that writes before
     * it can fail in a way the turn count cannot see — `reviewAsk` posts the
     * question as a comment first — re-running would post it twice. Its own
     * retry path (`reviewRetryAsk`) is how such a question is sent again.
     */
    failuresAreFinal?: boolean;
  } = {},
): Promise<T> {
  const key = optionalIdempotencyKey(params);
  if (key === undefined) return launch();
  const taskRef = typeof params.taskId === 'string' ? params.taskId : '';
  const { task } = await storage.resolveTask(taskRef);
  if (!task) return launch();
  const taskId = task.id;
  const fingerprint = launchFingerprint(command, params, taskId);
  // Records are scoped to the CALLER as well as the key: another member who
  // guessed or reused this key must never be able to claim it and get this
  // caller's launch refused. The actor is pinned by the daemon (applyCallerActor).
  const recordKey = `${callerScope(params.actor)}\u0000${key}`;
  const flightKey = `${taskId}\u0000${recordKey}`;

  type Decision = { kind: 'run'; turnsBefore: number; statusBefore: string | undefined; settleFlight: (p: Promise<unknown>) => void } | { kind: 'join'; promise: Promise<unknown> } | { kind: 'replay'; record: LaunchRecord };
  const decision: Decision = await withTaskLock(taskId, async () => {
    const records = await readRecords(storage, taskId);
    const existing = records[recordKey];
    if (existing && (existing.fingerprint !== fingerprint || existing.command !== command)) {
      throw mismatch(key, existing, command);
    }
    if (existing?.state === 'launching') {
      const running = inFlight.get(flightKey);
      if (running) return { kind: 'join', promise: running };
      // Nothing is running it, so its outcome was never written: either the daemon
      // that claimed it died, or this one could not record the result. Either way
      // the turn may have started, and running it again could start a second.
      const fresh = await storage.getTask(taskId);
      throw new RpcError(409,
        `The original ${command} with this idempotency key never recorded how it ended (a daemon restart, or a failed write), ` +
        `so whether its turn started is unknown. The task is now '${fresh?.status ?? 'unknown'}' — ` +
        'check it before launching again, and use a new key if you do.');
    }
    if (existing?.state === 'done') return { kind: 'replay', record: existing };
    if (existing?.state === 'failed' && (existing.wroteTurns || options.failuresAreFinal)) return { kind: 'replay', record: existing };

    const turnsBefore = await countRecordedTurns(storage, taskId);
    const statusBefore = (await storage.getTask(taskId))?.status;
    records[recordKey] = {
      command, fingerprint, state: 'launching', process: CLAIMING_PROCESS_ID,
      at: new Date().toISOString(), turnsBefore, statusBefore,
    };
    await writeRecords(storage, taskId, records);
    // Registered INSIDE the lock, so a repeat that takes the lock next finds it.
    let settleFlight!: (p: Promise<unknown>) => void;
    const flight = new Promise<unknown>((resolve) => { settleFlight = resolve; });
    // Nobody may ever join; its rejection is the launcher's to report, not an unhandled one.
    flight.catch(() => undefined);
    inFlight.set(flightKey, flight);
    return { kind: 'run', turnsBefore, statusBefore, settleFlight };
  });

  if (decision.kind === 'join') {
    logger.info(`${command} ${taskId.substring(0, 8)}: idempotency key repeated while the original is running — joining it`);
    return withReplayMark(await decision.promise) as T;
  }
  if (decision.kind === 'replay') {
    logger.info(`${command} ${taskId.substring(0, 8)}: idempotency key repeated — returning the original ${decision.record.state === 'done' ? 'result' : 'failure'}`);
    if (decision.record.state === 'failed') throw replayError(decision.record);
    return withReplayMark(decision.record.result) as T;
  }

  const running = launch();
  decision.settleFlight(running);
  try {
    const result = await running;
    await settle(storage, taskId, recordKey, (r) => ({ ...r, state: 'done', result: jsonSafe(result) }));
    return result;
  } catch (err) {
    const status = err instanceof RpcError ? err.status : 500;
    const code = err instanceof RpcError ? err.code : undefined;
    // A launch refused because somebody else owns the task wrote nothing of its
    // own — every launch path refuses a working/pairing task before its first
    // write — but the turn that IS running may record turns meanwhile, which a
    // turn count would wrongly charge to this attempt.
    const refusedBusy = code === 'task_busy' || decision.statusBefore === 'working' || decision.statusBefore === 'pairing';
    const wroteTurns = refusedBusy
      ? false
      : (await countRecordedTurns(storage, taskId).catch(() => decision.turnsBefore + 1)) > decision.turnsBefore;
    await settle(storage, taskId, recordKey, (r) => ({
      ...r, state: 'failed', wroteTurns,
      error: { status, message: err instanceof Error ? err.message : String(err), ...(code ? { code } : {}) },
    }));
    throw err;
  } finally {
    inFlight.delete(flightKey);
  }
}

/** Write the outcome. A failure here is logged, never allowed to mask the launch's own answer. */
async function settle(storage: Storage, taskId: string, recordKey: string, update: (r: LaunchRecord) => LaunchRecord): Promise<void> {
  try {
    await withTaskLock(taskId, async () => {
      const records = await readRecords(storage, taskId);
      const current = records[recordKey];
      if (!current) return;
      records[recordKey] = { ...update(current), at: new Date().toISOString() };
      await writeRecords(storage, taskId, records);
    });
  } catch (err) {
    logger.error(`Could not record the outcome of idempotency key '${recordKey.split('\u0000').pop()}' on ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The result as it will be stored: progress callbacks and the like do not survive JSON. */
function jsonSafe(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}
