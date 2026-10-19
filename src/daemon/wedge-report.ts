/**
 * What a daemon is WAITING ON, for the day it stops answering.
 *
 * WHY THIS EXISTS. A Teams project daemon was found (2026-10-05) with its timers
 * still firing — the reconcile and sync loops logged "previous tick still
 * running" every few seconds — while `/daemon/status` never answered and every
 * tick never finished. From outside, that state names nothing: the log says
 * WHICH loops are stuck but not on what, and the one surface that could say
 * more is the HTTP route that is itself stuck.
 *
 * Three things here make that state legible without the HTTP surface:
 *
 *  - an IN-FLIGHT REQUEST registry: every daemon HTTP request is entered on
 *    arrival and removed when its handler settles, so a request that never
 *    settles is listed with its route and age;
 *  - {@link boundedStep}: the status route's awaits run under a short deadline,
 *    and a step that misses it is NAMED in the response instead of holding the
 *    response hostage. One pending probe per label, so a wedged dependency is
 *    asked once, not once per status call;
 *  - {@link collectWedgeReport}: loops (current phase, how long the tick has
 *    run), the oldest requests, the store's opening stage, and — on Linux — the
 *    kernel wait channel of every thread in this process, which is what tells a
 *    filesystem that stopped answering (threads parked in `fuse_*` /
 *    `request_wait_answer`) from a JavaScript promise nobody resolves (threads
 *    idle in `ep_poll` / `futex`). `SIGUSR2` writes it to the daemon log on
 *    demand, and a loop tick wedged past {@link WEDGE_LOG_AFTER_MS} writes it by
 *    itself, once per wedge.
 *
 * Nothing here awaits anything it does not bound: a diagnostic that could wedge
 * on the thing it diagnoses would be worse than none.
 */

import { readdirSync, readFileSync } from 'fs';
import { daemonHealthRecorder } from './health-registry';
import { logger } from '../utils/logger';

/** A loop tick older than this is reported as wedged, and logged once. */
export const WEDGE_LOG_AFTER_MS = 120_000;

/** Deadline for each awaited step of `/daemon/status`. */
export const STATUS_STEP_DEADLINE_MS = 1_000;

interface InFlightRequest {
  method: string;
  route: string;
  startedAt: number;
}

const inFlight = new Map<number, InFlightRequest>();
let nextRequestId = 1;

/** Enter a request; the returned function removes it (idempotent). */
export function trackRequest(method: string, route: string, now: number = Date.now()): () => void {
  const id = nextRequestId++;
  inFlight.set(id, { method, route, startedAt: now });
  return () => { inFlight.delete(id); };
}

/** Requests still being handled, oldest first. */
export function inFlightRequests(now: number = Date.now()): Array<{ method: string; route: string; ageMs: number }> {
  return [...inFlight.values()]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((r) => ({ method: r.method, route: r.route, ageMs: now - r.startedAt }));
}

/** Test seam. */
export function resetWedgeReportForTests(): void {
  inFlight.clear();
  pendingSteps.clear();
  loggedWedges.clear();
}

export type BoundedResult<T> = { ok: true; value: T } | { ok: false; reason: 'timeout' | 'error'; error?: string };

/**
 * The pending probe for each label. A step that has not settled is NOT asked
 * again: a status poll every few seconds against a dependency that never
 * answers would otherwise queue one more waiter per poll, forever.
 */
const pendingSteps = new Map<string, Promise<unknown>>();

/**
 * Run `fn` under a deadline. Never throws and never waits longer than `ms`;
 * the step keeps running in the background and its NEXT caller reuses it.
 */
export async function boundedStep<T>(
  label: string,
  fn: () => Promise<T>,
  ms: number = STATUS_STEP_DEADLINE_MS,
  /** Whose step this is (a project root): two in-process daemons never share a probe. */
  scope = '',
): Promise<BoundedResult<T>> {
  const key = stepKey(scope, label);
  let pending = pendingSteps.get(key) as Promise<T> | undefined;
  if (!pending) {
    pending = Promise.resolve().then(fn);
    pendingSteps.set(key, pending);
    const clear = () => { if (pendingSteps.get(key) === pending) pendingSteps.delete(key); };
    pending.then(clear, clear);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<BoundedResult<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), ms);
  });
  try {
    return await Promise.race([
      pending.then(
        (value): BoundedResult<T> => ({ ok: true, value }),
        (err): BoundedResult<T> => ({ ok: false, reason: 'error', error: err instanceof Error ? err.message : String(err) }),
      ),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Steps whose probe is still pending — i.e. what is wedged right now. */
function stepKey(scope: string, label: string): string {
  return `${scope}\u0000${label}`;
}

export function pendingStepLabels(scope = ''): string[] {
  const prefix = stepKey(scope, '');
  return [...pendingSteps.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
}

export interface LoopWedgeView {
  name: string;
  /** How long the running tick has been running, or null when idle. */
  tickRunningMs: number | null;
  phase: string | null;
  ticksSkipped: number;
  /**
   * How long since the loop last COMPLETED a tick (or since it started, when
   * none ever has). Unlike tickRunningMs this survives the reconcile loop's
   * force-reset, which restarts the running tick's clock but finishes nothing.
   */
  stalledMs: number;
  /** True when stalledMs is past the wedge threshold plus two intervals. */
  stalled: boolean;
}

/** The daemon's loops as a wedge reader needs them. Synchronous, in-memory only. */
export function loopWedgeViews(projectRoot: string, now: number = Date.now()): LoopWedgeView[] {
  return daemonHealthRecorder(projectRoot).snapshot().loops.map((loop) => ({
    name: loop.name,
    tickRunningMs: loop.currentTickStartedAt === null ? null : now - loop.currentTickStartedAt,
    phase: loop.currentPhase,
    ticksSkipped: loop.ticksSkipped,
    stalledMs: now - (loop.lastTickFinishedAt ?? loop.startedAt),
    stalled: now - (loop.lastTickFinishedAt ?? loop.startedAt) > WEDGE_LOG_AFTER_MS + 2 * loop.intervalMs,
  }));
}

/**
 * The kernel wait channel of every thread of this process, grouped and counted
 * (`{ "fuse_wait_answer": 3, "ep_poll": 1, ... }`), or null off Linux.
 *
 * Read SYNCHRONOUSLY on purpose: procfs is answered by the kernel itself, never
 * by the filesystem under suspicion, and this must still work when every async
 * file operation in the process is stuck behind a thread that is.
 */
export function threadWaitChannels(): Record<string, number> | null {
  if (process.platform !== 'linux') return null;
  try {
    const counts: Record<string, number> = {};
    for (const tid of readdirSync('/proc/self/task')) {
      let wchan = '?';
      try {
        wchan = readFileSync(`/proc/self/task/${tid}/wchan`, 'utf-8').trim() || 'running';
      } catch (err) {
        // A thread that exited between the listing and the read: nothing to count.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        wchan = 'unreadable';
      }
      if (wchan === '0') wchan = 'running';
      counts[wchan] = (counts[wchan] ?? 0) + 1;
    }
    return counts;
  } catch (err) {
    return { [`unreadable: ${err instanceof Error ? err.message : String(err)}`]: 1 };
  }
}

export interface WedgeReport {
  pid: number;
  at: string;
  loops: LoopWedgeView[];
  requests: Array<{ method: string; route: string; ageMs: number }>;
  /** Status probes still pending from an earlier call — the wedged dependencies. */
  pendingStatusSteps: string[];
  storeOpen: { stage: string; sinceMs: number } | null;
  threads: Record<string, number> | null;
}

/** Everything above, in one synchronous read. */
export function collectWedgeReport(
  projectRoot: string,
  storeOpen: { stage: string; sinceMs: number } | null,
  now: number = Date.now(),
): WedgeReport {
  return {
    pid: process.pid,
    at: new Date(now).toISOString(),
    loops: loopWedgeViews(projectRoot, now),
    requests: inFlightRequests(now).slice(0, 20),
    pendingStatusSteps: pendingStepLabels(projectRoot),
    storeOpen,
    threads: threadWaitChannels(),
  };
}

const loggedWedges = new Set<string>();

/**
 * Log the report once per wedged tick: when a loop's running tick passes
 * {@link WEDGE_LOG_AFTER_MS}. Keyed by loop + tick start so a later wedge of the
 * same loop is logged again. Called from a timer, so it runs while the loops
 * themselves cannot.
 */
export function logWedgeIfStuck(
  projectRoot: string,
  storeOpen: () => { stage: string; sinceMs: number } | null,
  now: number = Date.now(),
): boolean {
  const snapshot = daemonHealthRecorder(projectRoot).snapshot();
  const wedged = snapshot.loops.filter(
    (l) => l.currentTickStartedAt !== null && now - l.currentTickStartedAt > WEDGE_LOG_AFTER_MS,
  );
  const fresh = wedged.filter((l) => !loggedWedges.has(`${l.name}@${l.currentTickStartedAt}`));
  if (fresh.length === 0) return false;
  for (const l of fresh) loggedWedges.add(`${l.name}@${l.currentTickStartedAt}`);
  logger.warn(
    `Daemon wedge: ${fresh.map((l) => `${l.name} tick running ${Math.round((now - (l.currentTickStartedAt ?? now)) / 1000)}s in phase '${l.currentPhase ?? 'none'}'`).join('; ')}. ` +
      `What the daemon is waiting on: ${JSON.stringify(collectWedgeReport(projectRoot, storeOpen(), now))}`,
  );
  return true;
}

export interface LockHolderReport {
  lockPath: string;
  /** null when the file is absent (nobody holds the lock). */
  pid: number | null;
  acquiredAt: string | null;
  holderStartedAt: string | null;
  isThisProcess: boolean;
  alive: boolean | null;
  /** The holder's process state and command line, when the OS would say. */
  state: string | null;
  command: string | null;
  /** Set when the file or the process could not be read in time. */
  problem?: string;
}

/**
 * Who holds the storage lock, read ASYNCHRONOUSLY and under a deadline: the
 * lock file sits on the store's filesystem, which is exactly the thing under
 * suspicion, so a sync read here could freeze the whole daemon on a hung mount.
 */
export async function describeLockHolderBounded(
  lockPath: string,
  ms: number = STATUS_STEP_DEADLINE_MS,
): Promise<LockHolderReport> {
  const base: LockHolderReport = {
    lockPath, pid: null, acquiredAt: null, holderStartedAt: null,
    isThisProcess: false, alive: null, state: null, command: null,
  };
  const raw = await boundedStep('lock-file', async () => {
    const { readFile } = await import('fs/promises');
    try {
      return await readFile(lockPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }, ms, lockPath);
  if (!raw.ok) return { ...base, problem: raw.reason === 'timeout' ? `lock file not readable within ${ms}ms` : `lock file unreadable: ${raw.error}` };
  if (raw.value === null) return { ...base, problem: 'no lock file (nobody holds the lock)' };
  let parsed: { pid?: unknown; acquired_at?: unknown; holder_started_at?: unknown };
  try {
    parsed = JSON.parse(raw.value);
  } catch (err) {
    return { ...base, problem: `lock file is not JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const pid = typeof parsed.pid === 'number' ? parsed.pid : null;
  const report: LockHolderReport = {
    ...base,
    pid,
    acquiredAt: typeof parsed.acquired_at === 'string' ? parsed.acquired_at : null,
    holderStartedAt: typeof parsed.holder_started_at === 'string' ? parsed.holder_started_at : null,
    isThisProcess: pid === process.pid,
  };
  if (pid === null) return { ...report, problem: 'lock file names no pid' };
  try {
    process.kill(pid, 0);
    report.alive = true;
  } catch (err) {
    // EPERM: it exists but is not ours to signal — alive all the same.
    report.alive = (err as NodeJS.ErrnoException).code === 'EPERM';
  }
  if (report.alive) {
    const identity = await boundedStep('lock-holder-identity', async () => {
      const { readProcessIdentity } = await import('../utils/process-identity');
      return readProcessIdentity(pid);
    }, ms, `${lockPath}:${pid}`);
    if (identity.ok && identity.value) {
      report.state = identity.value.state;
      report.command = identity.value.command;
    } else if (!identity.ok) {
      report.problem = `holder identity not readable: ${identity.reason}`;
    }
  }
  return report;
}
