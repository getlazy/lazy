/**
 * In-flight task-page actions — the dashboard's live narration of one verb.
 *
 * WHY THIS EXISTS
 * A form POST that awaits `acceptTask` (or unblock, stop, …) hits
 * `WEB_REQUEST_DEADLINE_MS` on any accept whose mechanical gate and merge
 * run long, and the page sits still until the 303 lands — the exact "no
 * indication that anything is going on" the engineer reported. Container start already solved
 * this shape: kick the work off, remember it in process memory, let the page
 * follow along. This is that pattern for every task verb, feeding the same
 * {@link ProgressEvent}s the CLI already prints (`src/daemon/progress.ts`).
 *
 * The registry is in-memory and per-process on purpose. It is progress
 * narration for a click happening right now, not state anyone should read
 * back tomorrow. The daemon still owns the act; this only remembers what it
 * has said so far.
 *
 * INVARIANT: nothing here invents a phase. Events are whatever the daemon
 * emitted. A verb with no PhaseReporter produces an empty list and a running
 * / done / failed status — honest silence, not a fake checklist.
 */

import type { ProgressEvent, ProgressEmitter } from '../daemon/progress';
import { acceptRemedyOf, type AcceptRemedy } from '../types/accept-remedy';

export type ActionRunStatus = 'running' | 'done' | 'failed';

export interface ActionRunState {
  id: string;
  taskId: string;
  /** Machine name of the verb, e.g. `accept`, `unblock`, `stop`. */
  operation: string;
  status: ActionRunStatus;
  events: ProgressEvent[];
  /** Failure text, shown verbatim; the daemon's messages are written for humans. */
  error?: string;
  /**
   * Structured accept remedy, when the failure was an AcceptRefusedError.
   * The dialog renders this (passphrase form, complete CLI command) instead of
   * repeating the error text a second time.
   */
  remedy?: AcceptRemedy;
  /** Where the page should go on success. */
  redirect?: string;
  startedAt: number;
  endedAt?: number;
}

/** How long a finished run stays readable before it is forgotten. */
export const ACTION_RUN_TERMINAL_TTL_MS = 60_000;

const runs = new Map<string, ActionRunState>();
/** taskId\0operation → run id, so a double-click cannot launch twice. */
const inflightByKey = new Map<string, string>();
const listeners = new Map<string, Set<(run: ActionRunState) => void>>();

function keyOf(taskId: string, operation: string): string {
  return `${taskId}\0${operation}`;
}

function notify(run: ActionRunState): void {
  const set = listeners.get(run.id);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(run);
    } catch {
      // A hung-up WebSocket must not fail the operation it is watching.
    }
  }
}

function expireIfStale(run: ActionRunState): ActionRunState | null {
  // Same TTL for every key, including per-request Link ids that are not a
  // stored task — those still live in `runs` and must not accumulate.
  if (run.status !== 'running' && run.endedAt && Date.now() - run.endedAt > ACTION_RUN_TERMINAL_TTL_MS) {
    runs.delete(run.id);
    listeners.delete(run.id);
    return null;
  }
  return run;
}

/** The current run, or null. Finished runs expire so a later poll is empty. */
export function getActionRun(runId: string): ActionRunState | null {
  const run = runs.get(runId);
  if (!run) return null;
  return expireIfStale(run);
}

/**
 * Whether a poll/WS path may read this run.
 *
 * The path's `:id` matches when it is the run's own key (a stored task id, or
 * a per-request Link key that is not a task), or when it resolves to that
 * same stored task (short id / code). A run for task A is never readable
 * through task B's path, even if the caller knows the run id.
 */
export function actionRunMatchesPath(
  run: ActionRunState,
  pathId: string,
  resolvedTaskId: string | null,
): boolean {
  if (run.taskId === pathId) return true;
  return resolvedTaskId !== null && run.taskId === resolvedTaskId;
}

/**
 * Kick off a verb, or return the one already running for this task+operation.
 *
 * Idempotent while in flight: a double-clicked Unblock must not launch a
 * second agent turn.
 */
export function beginActionRun(opts: {
  taskId: string;
  operation: string;
  work: (onProgress: ProgressEmitter) => Promise<{ redirect: string }>;
}): ActionRunState {
  const existingId = inflightByKey.get(keyOf(opts.taskId, opts.operation));
  if (existingId) {
    const existing = getActionRun(existingId);
    if (existing && existing.status === 'running') return existing;
  }

  const run: ActionRunState = {
    id: crypto.randomUUID(),
    taskId: opts.taskId,
    operation: opts.operation,
    status: 'running',
    events: [],
    startedAt: Date.now(),
  };
  runs.set(run.id, run);
  inflightByKey.set(keyOf(opts.taskId, opts.operation), run.id);

  const onProgress: ProgressEmitter = (event) => {
    // Activity events belong to `lazy watch`, not to a phased verb.
    if (event.kind === 'activity') return;
    run.events.push(event);
    notify(run);
  };

  void opts
    .work(onProgress)
    .then((result) => {
      run.status = 'done';
      run.redirect = result.redirect;
      run.endedAt = Date.now();
      inflightByKey.delete(keyOf(opts.taskId, opts.operation));
      notify(run);
    })
    .catch((err: unknown) => {
      run.status = 'failed';
      run.error = err instanceof Error ? err.message : String(err);
      // The daemon composed this; the dialog renders it. Absent for ordinary
      // errors (a 400, a raised-item gate) so the page stays on the message.
      const remedy = acceptRemedyOf(err);
      if (remedy) run.remedy = remedy;
      run.endedAt = Date.now();
      inflightByKey.delete(keyOf(opts.taskId, opts.operation));
      notify(run);
    });

  return run;
}

/**
 * Follow a run. The listener is called with the current snapshot immediately,
 * then on every progress event and on settle. Returns an unsubscribe.
 */
export function subscribeActionRun(
  runId: string,
  listener: (run: ActionRunState) => void,
): () => void {
  const run = getActionRun(runId);
  if (run) listener(run);
  let set = listeners.get(runId);
  if (!set) {
    set = new Set();
    listeners.set(runId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) listeners.delete(runId);
  };
}

/** JSON the page and the poll endpoint both consume. */
export function actionRunJson(run: ActionRunState): Record<string, unknown> {
  return {
    runId: run.id,
    taskId: run.taskId,
    operation: run.operation,
    status: run.status,
    events: run.events,
    ...(run.error ? { error: run.error } : {}),
    ...(run.remedy ? { remedy: run.remedy } : {}),
    ...(run.redirect ? { redirect: run.redirect } : {}),
  };
}

/** Header the dialog script sends so the route returns a run instead of a 303. */
export const ACTION_DIALOG_HEADER = 'x-lazy-action-dialog';

export function wantsActionDialog(req: Request): boolean {
  return req.headers.get(ACTION_DIALOG_HEADER) === '1';
}

/** Test seam: drop all recorded runs. */
export function resetActionRuns(): void {
  runs.clear();
  inflightByKey.clear();
  listeners.clear();
}
