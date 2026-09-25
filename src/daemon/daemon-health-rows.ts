/**
 * The rows of `lazy daemon health` — wire types, thresholds and the pure
 * functions that turn a snapshot into an OK / WARN / FAIL verdict.
 *
 * Split from ./daemon-health.ts (which gathers the snapshots) so that the
 * verdicts are unit-testable with plain fakes, and so that clients rendering a
 * report (the CLI, doctor) load none of the daemon's handler graph. No I/O here.
 */

import { formatElapsed } from '../utils/elapsed';
import { describeDeadReason, type HolderVerdict } from '../utils/process-identity';
import type { StorageLockActivity } from '../utils/storage-lock';
import type { HealthCheck } from '../runner/types';
import {
  RECONCILE_LOOP,
  REMOTE_SYNC_LOOP,
  SYNC_RETRY_LOOP,
  type AuditAppendHealth,
  type BindRecord,
  type LoopRecord,
  type ProxyHealthHandle,
  type SweepRecord,
} from './health-registry';

// ── wire types ──────────────────────────────────────────────────────────

export type HealthState = 'ok' | 'warn' | 'fail';

/** Sections of the report, in the order they are rendered. */
export type HealthGroup = 'daemon' | 'loops' | 'sweeps' | 'proxy' | 'storage' | 'runner' | 'tasks' | 'dashboard';

export const HEALTH_GROUP_TITLES: Record<HealthGroup, string> = {
  daemon: 'Daemon',
  loops: 'Loops',
  sweeps: 'Reconciler sweeps',
  proxy: 'Proxy',
  storage: 'Storage',
  runner: 'Runner',
  tasks: 'Tasks',
  dashboard: 'Dashboard',
};

export interface DaemonHealthRow {
  /** Stable machine id (`loop:reconcile`, `sweep:reconcile:stranded-working`, …). */
  id: string;
  group: HealthGroup;
  /** Human name of the thing checked. */
  name: string;
  state: HealthState;
  /** One line: what was found. */
  reason: string;
  /** What to do about it — always present on a FAIL. */
  remedy?: string;
}

export interface DaemonHealthReport {
  checkedAt: string;
  projectRoot: string;
  pid: number;
  /** The worst row state. */
  state: HealthState;
  counts: Record<HealthState, number>;
  rows: DaemonHealthRow[];
}

/** Progress channel each row streams on (see ./progress.ts `activity` events). */
export const DAEMON_HEALTH_CHANNEL = 'daemon-health';

/** The asking client's build, so the daemon can say whether the two match. */
export interface HealthClientIdentity {
  version?: string;
  sourceId?: string;
  sourceIdKind?: string;
}

// ── thresholds ──────────────────────────────────────────────────────────

/**
 * How stale a loop's last completed tick may be before it is a WARN and a FAIL.
 * Scaled by the interval so a slow loop (remote sync, every minute) is not held
 * to the reconciler's pace; floored so a very short test interval does not turn
 * one slow tick into a failure. The FAIL floor is the reconciler's own
 * stuck-tick force-reset (5 minutes): past it, the loop has given up on a tick.
 */
export function loopThresholds(intervalMs: number): { warnMs: number; failMs: number } {
  return {
    warnMs: Math.max(intervalMs * 12, 60_000),
    failMs: Math.max(intervalMs * 60, 300_000),
  };
}

/** A sweep failing continuously for this long, and at least this many runs, is a FAIL. */
export const SWEEP_FAIL_AFTER_MS = 5 * 60_000;
export const SWEEP_FAIL_AFTER_RUNS = 3;

/** One locked storage section running this long is a WARN, then a FAIL. */
export const STORAGE_WRITE_WARN_MS = 10_000;
export const STORAGE_WRITE_FAIL_MS = 60_000;

/**
 * A `working` task with no live run is a FAIL once its run has been gone this
 * long. The reconciler acts on a dead run within a tick or two (plus a short
 * startup grace), so minutes of it means the reconciler is not getting there.
 */
export const STUCK_WORKING_FAIL_MS = 2 * 60_000;

/** A held sync that has failed this many retries in a row is a WARN. */
export const HELD_SYNC_WARN_ATTEMPTS = 3;

/**
 * The row id a check reports under when it produces no rows of its own — it
 * threw, or ran out of time. Always in the same family (the part before the
 * first ':') as that check's success rows, so a script filtering `--json` on
 * `runner:*` or `sweep:*` still sees the failure. Checks whose success row is
 * a single fixed id use that id as their fallback.
 */
export const CHECK_FALLBACK_IDS = {
  runner: 'runner:diagnose',
  sweeps: 'sweep:collect',
} as const;

/** Deadline for any single check. */
export const CHECK_TIMEOUT_MS = 15_000;
/**
 * The Runner check's own, longer deadline. Its probes are separate CLI calls to
 * the container runtime (`--version`, `info`, `image inspect`), each allowed
 * 10 s, and a healthy but busy Docker Desktop can take most of that — the
 * shared 15 s would call it hung.
 */
export const RUNNER_CHECK_TIMEOUT_MS = 35_000;
/** Deadline for the proxy self-request. */
export const PROXY_PROBE_TIMEOUT_MS = 3_000;

export const RESTART_REMEDY =
  '`lazy daemon restart` clears it — that interrupts running agent and pair sessions; ' +
  'each agent turn resumes against the new daemon.';

// ── small helpers ───────────────────────────────────────────────────────

/** A duration a human reads: milliseconds below a second (a tick usually is), else `1m05s`. */
export function span(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  return clamped < 1000 ? `${clamped}ms` : formatElapsed(clamped);
}

function ago(ms: number): string {
  return `${span(ms)} ago`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function worst(states: HealthState[]): HealthState {
  if (states.includes('fail')) return 'fail';
  if (states.includes('warn')) return 'warn';
  return 'ok';
}

/** Collapse a multi-line message to its first line, for a one-line reason. */
export function firstLine(message: string): string {
  const line = message.split('\n').find(l => l.trim().length > 0) ?? message;
  return line.trim();
}

// ── row builders (pure) ─────────────────────────────────────────────────

export interface DaemonIdentityFacts {
  pid: number;
  startedAt: number | null;
  version: string;
  sourceId: string | null;
  sourceIdKind: string | null;
}

export function buildVersionRow(facts: DaemonIdentityFacts, now: number): DaemonHealthRow {
  const uptime = facts.startedAt === null ? 'unknown uptime' : `up ${formatElapsed(now - facts.startedAt)}`;
  const source = facts.sourceId ? `, source ${facts.sourceId} (${facts.sourceIdKind ?? 'unknown'})` : '';
  return {
    id: 'daemon:version',
    group: 'daemon',
    name: 'Version and uptime',
    state: 'ok',
    reason: `lazy ${facts.version}, pid ${facts.pid}, ${uptime}${source}`,
  };
}

/** Row id of the build comparison — doctor leaves it out, having its own check. */
export const BUILD_MATCH_ROW_ID = 'daemon:build-match';

/**
 * Whether the asking client runs the daemon's build. Two identities compare
 * only when they are the same KIND of answer: a checkout fingerprint (baked or
 * computed) against another, or a compiled build against another — a compiled
 * binary's identity says nothing about a checkout's, and a verdict derived from
 * two incomparable values would be worse than none.
 */
export function buildBuildMatchRow(
  daemon: Pick<DaemonIdentityFacts, 'version' | 'sourceId' | 'sourceIdKind'>,
  client: HealthClientIdentity | undefined,
): DaemonHealthRow {
  const base = { id: BUILD_MATCH_ROW_ID, group: 'daemon' as const, name: 'Daemon runs the CLI\'s build' };
  if (!client || (!client.version && !client.sourceId)) {
    return { ...base, state: 'ok', reason: 'not compared — the caller did not say which build it runs' };
  }
  const checkout = (kind: string | null | undefined) => kind === 'baked' || kind === 'computed';
  const comparable =
    client.sourceId && daemon.sourceId &&
    ((checkout(client.sourceIdKind) && checkout(daemon.sourceIdKind)) ||
      (client.sourceIdKind === 'build' && daemon.sourceIdKind === 'build'));

  if (client.version && client.version !== daemon.version) {
    return {
      ...base,
      state: 'warn',
      reason: `the daemon runs lazy ${daemon.version}, this CLI is ${client.version}`,
      remedy: `Restart the daemon to run this CLI's version: ${RESTART_REMEDY}`,
    };
  }
  if (!comparable) {
    return {
      ...base,
      state: 'ok',
      reason: `same version (${daemon.version}); the source identities are not comparable ` +
        `(${daemon.sourceIdKind ?? 'unknown'} vs ${client.sourceIdKind ?? 'unknown'})`,
    };
  }
  if (client.sourceId !== daemon.sourceId) {
    return {
      ...base,
      state: 'warn',
      reason: `the daemon runs source ${daemon.sourceId}, this CLI is ${client.sourceId} — ` +
        'changes since the daemon started are not in force',
      remedy: `Restart the daemon to pick up the current code: ${RESTART_REMEDY}`,
    };
  }
  return { ...base, state: 'ok', reason: `same build (${daemon.sourceId})` };
}

export const LOOP_NAMES: Record<string, string> = {
  [RECONCILE_LOOP]: 'Reconcile loop',
  [SYNC_RETRY_LOOP]: 'Sync retry loop',
  [REMOTE_SYNC_LOOP]: 'Remote sync loop',
};

/**
 * One loop: is it still completing ticks?
 *
 * The measure is the LAST COMPLETED tick, not the last started one: a tick
 * wedged on one phase keeps the loop "running" while nothing it exists for
 * happens. When the answer is bad, the running tick's age and phase say where
 * it is stuck.
 */
export function buildLoopRow(
  name: string,
  loop: LoopRecord | undefined,
  now: number,
): DaemonHealthRow {
  const base = { id: `loop:${name}`, group: 'loops' as const, name: LOOP_NAMES[name] ?? `${name} loop` };
  if (!loop) {
    return {
      ...base,
      state: 'fail',
      reason: 'never started in this daemon',
      remedy: `Check \`lazy daemon logs\` for a startup error; ${RESTART_REMEDY}`,
    };
  }

  const { warnMs, failMs } = loopThresholds(loop.intervalMs);
  const every = `every ${formatElapsed(loop.intervalMs)}`;
  const running = loop.currentTickStartedAt !== null
    ? `; the current tick has been running ${formatElapsed(now - loop.currentTickStartedAt)}` +
      (loop.currentPhase ? `, in '${loop.currentPhase}'` : '')
    : '';
  const skipped = loop.ticksSkipped > 0 ? `, ${loop.ticksSkipped} skipped while one was still running` : '';

  // Reference point for staleness: the last completed tick, or — before the
  // first one — when the loop started (its first tick is scheduled shortly after).
  const reference = loop.lastTickFinishedAt ?? loop.startedAt;
  const staleFor = now - reference;
  const lastPart = loop.lastTickFinishedAt === null
    ? `no tick completed yet (started ${ago(now - loop.startedAt)})`
    : `last tick finished ${ago(staleFor)} (took ${span(loop.lastTickDurationMs ?? 0)})`;
  const summary = `${lastPart}; ${plural(loop.ticksCompleted, 'tick')} since start, ${every}${skipped}${running}`;

  if (staleFor >= failMs) {
    return {
      ...base,
      state: 'fail',
      reason: summary,
      remedy:
        '`lazy daemon logs` shows what the tick is waiting on (search for the phase named above); ' +
        `while it is stuck nothing this loop does happens. ${RESTART_REMEDY}`,
    };
  }
  if (staleFor >= warnMs) {
    return {
      ...base,
      state: 'warn',
      reason: summary,
      remedy: '`lazy daemon logs` shows what the tick is waiting on; re-run to see whether it moved.',
    };
  }
  if (loop.lastTickFailed && loop.lastError) {
    return {
      ...base,
      state: 'warn',
      reason: `the last tick failed: ${firstLine(loop.lastError)} (${summary})`,
      remedy: '`lazy daemon logs` has the full error; the loop retries on its next tick.',
    };
  }
  return { ...base, state: 'ok', reason: summary };
}

/** One sweep or reconcile phase: did its last run succeed, and for how long has it been failing? */
export function buildSweepRow(sweep: SweepRecord, now: number): DaemonHealthRow {
  const base = { id: `sweep:${sweep.loop}:${sweep.name}`, group: 'sweeps' as const, name: sweep.name };
  const lastRun = sweep.lastRunAt === null
    ? 'never ran'
    : `last ran ${ago(now - sweep.lastRunAt)} in ${span(sweep.lastDurationMs ?? 0)}`;

  if (sweep.consecutiveFailures === 0) {
    const earlier = sweep.lastError && sweep.lastErrorAt !== null
      ? `; last error ${ago(now - sweep.lastErrorAt)}: ${firstLine(sweep.lastError)}`
      : '';
    return { ...base, state: 'ok', reason: `${lastRun}${earlier}` };
  }

  const failingFor = sweep.failingSince === null ? 0 : now - sweep.failingSince;
  const streak = `failing for ${formatElapsed(failingFor)} (${plural(sweep.consecutiveFailures, 'run')} in a row)`;
  const reason = `${streak}: ${firstLine(sweep.lastError ?? 'unknown error')}`;
  const remedy =
    '`lazy daemon logs` has every failure in full. The sweep retries on each tick; while it fails, ' +
    'whatever it recovers stays unrecovered.';
  const persistent = failingFor >= SWEEP_FAIL_AFTER_MS && sweep.consecutiveFailures >= SWEEP_FAIL_AFTER_RUNS;
  return { ...base, state: persistent ? 'fail' : 'warn', reason, remedy };
}

/** What the self-request to the proxy's liveness path found. */
export type ProxyProbe =
  | { ok: true; url: string; rttMs: number }
  | { ok: false; url: string; error: string };

export function buildProxyRow(handle: ProxyHealthHandle | null, probe: ProxyProbe | null): DaemonHealthRow {
  const base = { id: 'proxy:listening', group: 'proxy' as const, name: 'Proxy answering' };
  if (!handle || handle.port === null || !probe) {
    return {
      ...base,
      state: 'fail',
      reason: 'the proxy is not running in this daemon',
      remedy: `Every agent turn reaches the model through the proxy, so none can run. ${RESTART_REMEDY}`,
    };
  }
  const also = handle.binds.length > 1 ? ` (also on ${handle.binds.slice(1).join(', ')})` : '';
  if (!probe.ok) {
    return {
      ...base,
      state: 'fail',
      reason: `${handle.bind}:${handle.port}${also} did not answer ${probe.url}: ${probe.error}`,
      remedy: `Agent turns cannot reach the model until the proxy answers. ${RESTART_REMEDY}`,
    };
  }
  return {
    ...base,
    state: 'ok',
    reason: `listening on ${handle.bind}:${handle.port}${also}; self-check answered in ${probe.rttMs}ms`,
  };
}

/** Is the audit directory writable, as far as `access(2)` can tell without writing? */
export type AuditWritable = { ok: true; note?: string } | { ok: false; error: string };

export function buildAuditRow(
  handle: ProxyHealthHandle | null,
  writable: AuditWritable | null,
  appends: AuditAppendHealth | null,
  now: number,
): DaemonHealthRow {
  const base = { id: 'proxy:audit-log', group: 'proxy' as const, name: 'Proxy audit log writable' };
  if (!handle || !writable) {
    return { ...base, state: 'fail', reason: 'no proxy, so no audit log', remedy: RESTART_REMEDY };
  }
  const remedy =
    `Make ${handle.auditDir} writable by the daemon's user (and check free disk space). ` +
    'Proxied requests keep flowing; only their audit records are dropped.';
  if (appends?.lastFailure) {
    const when = appends.lastFailureAt !== null ? ` ${ago(now - appends.lastFailureAt)}` : '';
    return {
      ...base,
      state: 'fail',
      reason: `the last append failed${when} (${plural(appends.droppedSinceSuccess, 'record')} dropped): ` +
        firstLine(appends.lastFailure),
      remedy,
    };
  }
  if (!writable.ok) {
    return { ...base, state: 'fail', reason: `${handle.auditDir}: ${writable.error}`, remedy };
  }
  const last = appends?.lastSuccessAt ? `; last record ${ago(now - appends.lastSuccessAt)}` : '; no request audited yet';
  return { ...base, state: 'ok', reason: `${handle.auditDir}${writable.note ? ` (${writable.note})` : ''}${last}` };
}

/** What the storage lock file says, read without taking the lock. */
export type StorageLockFacts =
  | { kind: 'no-file-lock'; backend: string }
  | { kind: 'missing'; lockPath: string }
  | { kind: 'unreadable'; lockPath: string; error: string }
  | { kind: 'held'; lockPath: string; pid: number; acquiredAt: string | null; verdict: HolderVerdict };

/**
 * The storage lock, from the daemon's side. The daemon takes it at startup and
 * holds it for its whole life — that is what makes it the store's single
 * writer — so the ONLY healthy answer is "held by this daemon". Any other
 * holder, a dead or recycled one, or no file at all is a daemon whose writes
 * are either queued forever or unprotected against a second writer.
 */
export function buildStorageLockRow(facts: StorageLockFacts, daemonPid: number, now: number): DaemonHealthRow {
  const base = { id: 'storage:lock', group: 'storage' as const, name: 'Storage lock' };
  if (facts.kind === 'no-file-lock') {
    return { ...base, state: 'ok', reason: `the ${facts.backend} backend has no file lock` };
  }
  if (facts.kind === 'missing') {
    return {
      ...base,
      state: 'fail',
      reason: `${facts.lockPath} is gone — the daemon still writes as the store's owner, but nothing ` +
        'stops a second process from taking the store and writing beside it',
      remedy: `Stop every other lazy process on this store, then restart the daemon so it takes the lock again: ${RESTART_REMEDY}`,
    };
  }
  if (facts.kind === 'unreadable') {
    return {
      ...base,
      state: 'fail',
      reason: `${facts.lockPath} cannot be read: ${firstLine(facts.error)}`,
      remedy: `Run \`lazy doctor\`, which diagnoses and can clear a damaged storage lock.`,
    };
  }
  const since = facts.acquiredAt ? `, taken ${ago(now - Date.parse(facts.acquiredAt))}` : '';
  if (!facts.verdict.alive) {
    return {
      ...base,
      state: 'fail',
      reason: `${facts.lockPath} names pid ${facts.pid}${since}, but ${describeDeadReason(facts.verdict.reason)}`,
      remedy: 'Run `lazy doctor`, which offers to remove a stale lock, then restart the daemon.',
    };
  }
  if (facts.pid !== daemonPid) {
    return {
      ...base,
      state: 'fail',
      reason: `held by pid ${facts.pid}${since}, not by this daemon (pid ${daemonPid}) — the daemon's writes queue behind it`,
      remedy:
        `Find out what pid ${facts.pid} is (\`ps -p ${facts.pid}\`) and stop it if it is hung. ` +
        'Do NOT delete the lock file while its holder is alive — that admits a second writer and corrupts the store.',
    };
  }
  return { ...base, state: 'ok', reason: `held by this daemon (pid ${daemonPid})${since}, as designed` };
}

/** Whether the store is being written: the locked section in flight, and the last one that finished. */
export function buildStorageWritesRow(
  activity: StorageLockActivity | null,
  fileLocked: boolean,
  now: number,
): DaemonHealthRow {
  const base = { id: 'storage:writes', group: 'storage' as const, name: 'Storage writes' };
  if (!fileLocked) {
    return { ...base, state: 'ok', reason: 'not tracked for this backend' };
  }
  const last = activity?.lastSuccessAt ? `last successful write ${ago(now - activity.lastSuccessAt)}` : 'no write since the daemon started';
  const queued = activity && activity.waiting > 0 ? `, ${activity.waiting} queued behind it` : '';
  if (activity?.activeSince) {
    const runningFor = now - activity.activeSince;
    const reason = `one write has been running ${formatElapsed(runningFor)}${queued}; ${last}`;
    if (runningFor >= STORAGE_WRITE_FAIL_MS) {
      return {
        ...base,
        state: 'fail',
        reason,
        remedy: `Every store write in this daemon waits on that one. \`lazy daemon logs\` may show what it is doing; ${RESTART_REMEDY}`,
      };
    }
    if (runningFor >= STORAGE_WRITE_WARN_MS) {
      return { ...base, state: 'warn', reason, remedy: 'Re-run in a minute; if the same write is still running, it is stuck.' };
    }
  }
  return { ...base, state: 'ok', reason: last };
}

/**
 * A stable key for one runner diagnostic. The runner's labels carry what it
 * found — versions, image names, the endpoint it reached — so the raw text
 * changes on every upgrade and differs between a check's OK and FAIL forms
 * ("reachable at http://…" vs "reachable"). The key keeps only the part that
 * names the check: no parenthesised detail, nothing after a colon, no " at
 * <address>", no version numbers.
 */
export function runnerCheckKey(what: string): string {
  return what
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/:.*$/, '')
    .replace(/\s+at\s+\S+\s*$/, '')
    .replace(/\bv?\d+(\.\d+)+\S*/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'check';
}

/** Suffix a repeat (-2, -3, …) so two checks that key alike never share an id. */
function uniqueId(id: string, used: Map<string, number>): string {
  const n = (used.get(id) ?? 0) + 1;
  used.set(id, n);
  return n === 1 ? id : `${id}-${n}`;
}

/** Runner diagnostics as rows — the runner's own checks, verdicts unchanged. */
export function buildRunnerRows(runnerType: string, checks: HealthCheck[]): DaemonHealthRow[] {
  if (checks.length === 0) {
    return [{ id: CHECK_FALLBACK_IDS.runner, group: 'runner', name: `Runner (${runnerType})`, state: 'ok', reason: 'no diagnostics to run' }];
  }
  const used = new Map<string, number>();
  return checks.map((check) => ({
    id: uniqueId(`runner:${runnerCheckKey(check.what)}`, used),
    group: 'runner' as const,
    name: check.what,
    state: check.state,
    reason: check.state === 'ok' ? 'ok' : firstLine(check.reason ?? 'no reason given'),
    ...(check.state === 'fail'
      ? { remedy: `Nothing can launch until this is fixed: ${check.reason ?? check.what}` }
      : {}),
  }));
}

/**
 * The Runner check ran out of time. That is the container runtime (or the host
 * agent binary) not answering — a runtime problem, so the remedy points there
 * and never at restarting lazy's daemon, which would interrupt every agent and
 * change nothing about Docker.
 */
export function runnerTimeoutRow(runnerType: string | null, timeoutMs: number): DaemonHealthRow {
  const container = runnerType === 'docker' || runnerType === 'podman';
  const name = runnerType === 'podman' ? 'Podman' : container ? 'Docker' : runnerType ? `The ${runnerType} runner` : 'The runner';
  const secs = `${Math.round(timeoutMs / 1000)}s`;
  return {
    id: CHECK_FALLBACK_IDS.runner,
    group: 'runner',
    name: runnerType ? `Runner (${runnerType})` : 'Runner',
    state: 'fail',
    reason: `${name} did not answer within ${secs}`,
    remedy: container
      ? `Check that ${name} is running and responsive: \`${runnerType} info\` should answer within a few seconds` +
        (runnerType === 'docker' ? ' (on a Mac, look at Docker Desktop)' : ' (\`podman machine start\` if its machine is stopped)') +
        '. Tasks cannot launch while it is unresponsive.'
      : 'Check that the agent binary answers `--version` promptly on this host; tasks cannot launch until it does.',
  };
}

export function buildImageRow(
  runnerType: string,
  image: { name: string; present: boolean } | null,
): DaemonHealthRow {
  const base = { id: 'runner:image', group: 'runner' as const, name: 'Container image present' };
  if (!image) {
    return { ...base, state: 'ok', reason: `not used by the ${runnerType} runner` };
  }
  if (!image.present) {
    return {
      ...base,
      state: 'warn',
      reason: `${image.name} is not built yet`,
      remedy: 'It is built on the next task launch, which then waits for the build.',
    };
  }
  return { ...base, state: 'ok', reason: image.name };
}

/** A `working` task whose run is gone and has left no response behind. */
export interface StuckWorkingTask {
  code: string;
  /** How long ago the run was last seen alive, or null when nothing says. */
  goneForMs: number | null;
  /** Set when the task's liveness could not be checked at all — why. */
  livenessError?: string;
}

/** What a not-alive working task has left behind that says when it was last alive. */
export interface SignsOfLife {
  /** The run's own exit time (ISO), when the runner knows it. */
  finishedAt: string | null | undefined;
  /** The supervisor's last status checkpoint (ISO). */
  statusUpdatedAt: string | null | undefined;
  /** When the turn was launched — the session's last interaction (epoch ms or ISO). */
  lastInteractionAt: number | string | null | undefined;
}

/**
 * How long a `working(not-alive)` task's run has been gone, or null when it is
 * not a stuck candidate at all.
 *
 * A task launched moments ago has no live run and no checkpoint yet — its
 * container is still being created — and the reconciler deliberately leaves it
 * alone for `graceMs` after launch. Health waits exactly as long (the caller
 * passes the reconciler's own grace), so it never FAILs on what the reconciler
 * is right to wait for. After that, the launch itself is the fallback sign of
 * life. `'unknown'` only when nothing at all says when the task was alive.
 */
export function notAliveGoneForMs(signs: SignsOfLife, now: number, graceMs: number): number | 'unknown' | null {
  const toMs = (v: number | string | null | undefined) =>
    v === null || v === undefined ? NaN : typeof v === 'number' ? v : Date.parse(v);
  const launchedAt = toMs(signs.lastInteractionAt);
  if (Number.isFinite(launchedAt) && launchedAt > 0) {
    const sinceLaunch = now - launchedAt;
    if (sinceLaunch >= 0 && sinceLaunch < graceMs) return null;
  }
  const times = [toMs(signs.finishedAt), toMs(signs.statusUpdatedAt), launchedAt]
    .filter(t => Number.isFinite(t) && t > 0);
  if (times.length === 0) return 'unknown';
  return Math.max(0, now - Math.max(...times));
}

export function buildStuckWorkingRow(stuck: StuckWorkingTask[], workingCount: number): DaemonHealthRow {
  const base = { id: 'tasks:working-not-alive', group: 'tasks' as const, name: 'Working tasks have a live run' };
  if (stuck.length === 0) {
    return { ...base, state: 'ok', reason: workingCount === 0 ? 'no working tasks' : `all ${workingCount} working task(s) have a live run` };
  }
  // A task whose liveness could not be checked is not evidence of a stuck one:
  // it is listed, and warns, but only a confirmed dead run can FAIL the row.
  const dead = stuck.filter(t => t.livenessError === undefined);
  const unknown = stuck.filter(t => t.livenessError !== undefined);
  const parts: string[] = [];
  if (dead.length > 0) {
    const list = dead
      .map(t => `${t.code} (${t.goneForMs === null ? 'gone for an unknown time' : `gone ${formatElapsed(t.goneForMs)}`})`)
      .join(', ');
    parts.push(`${plural(dead.length, 'task')} say working with no live run: ${list}`);
  }
  if (unknown.length > 0) {
    parts.push(`liveness unknown for ${unknown.map(t => `${t.code} (${t.livenessError})`).join(', ')}`);
  }
  const overdue = dead.some(t => t.goneForMs === null || t.goneForMs >= STUCK_WORKING_FAIL_MS);
  return {
    ...base,
    state: overdue ? 'fail' : 'warn',
    reason: parts.join('; '),
    remedy:
      'The reconciler should move each to `interrupted` or `blocked` within a tick or two — check the ' +
      '`working-tasks` and `stranded-working` sweeps above and search `lazy daemon logs` for the task. ' +
      '`lazy stop <task>` ends one by hand.',
  };
}

/**
 * The working-tasks check ran out of time: the runner could not say, in time,
 * whether the runs are alive. That confirms nothing about any task, so it is a
 * WARN — only a confirmed dead run may FAIL this row — and the remedy names the
 * runner actually configured.
 */
export function stuckWorkingTimeoutRow(runnerType: string | null, timeoutMs: number): DaemonHealthRow {
  const secs = `${Math.round(timeoutMs / 1000)}s`;
  const container = runnerType === 'docker' || runnerType === 'podman';
  return {
    id: 'tasks:working-not-alive',
    group: 'tasks',
    name: 'Working tasks have a live run',
    state: 'warn',
    reason: `liveness could not be checked within ${secs} — the runner did not answer for every working task in time`,
    remedy: container
      ? `Each task is one \`${runnerType} inspect\`; check that ${runnerType === 'podman' ? 'Podman' : 'Docker'} is responsive (\`${runnerType} info\`) and re-run.`
      : `The ${runnerType ?? 'configured'} runner's process lookups were slow; re-run, and check the host's load if it persists.`,
  };
}

/** A task with syncs queued (`pending_sync`), and where its retry stands. */
export interface HeldSync {
  code: string;
  pending: number;
  /** Plain-language state: waiting for the task to park, backed off, held by a member, … */
  state: string;
  attempt: number | null;
  /** Consecutive attempts that THREW, when the last one did. */
  failures?: number;
}

export function buildHeldSyncsRow(held: HeldSync[]): DaemonHealthRow {
  const base = { id: 'tasks:held-syncs', group: 'tasks' as const, name: 'Held syncs' };
  if (held.length === 0) return { ...base, state: 'ok', reason: 'none queued' };
  const list = held.map(h => `${h.code} ×${h.pending} (${h.state})`).join(', ');
  // Failing repeatedly either way: backed off after failed fetches, or throwing
  // on every tick (which the loop retries without backing off).
  const failing = held.filter(h =>
    (h.attempt !== null && h.attempt + 1 >= HELD_SYNC_WARN_ATTEMPTS) ||
    (h.failures !== undefined && h.failures >= HELD_SYNC_WARN_ATTEMPTS));
  if (failing.length > 0) {
    return {
      ...base,
      state: 'warn',
      reason: `${plural(held.length, 'task')} with queued syncs, ${failing.length} failing repeatedly: ${list}`,
      remedy: 'The retry loop keeps retrying. `lazy daemon logs` has each failure in full; `lazy sync <task>` tries one now and shows its error.',
    };
  }
  return { ...base, state: 'ok', reason: `${plural(held.length, 'task')} with queued syncs: ${list}` };
}

/** An `interrupted` task and whether anything will resume it by itself. */
export interface InterruptedTask {
  code: string;
  /** `queued` — auto-resume will retry it; `stopped` — a person stopped it; `gave-up` — auto-resume ran out. */
  state: 'queued' | 'stopped' | 'gave-up';
}

export function buildInterruptedRow(tasks: InterruptedTask[], autoResume: boolean): DaemonHealthRow {
  const base = { id: 'tasks:interrupted', group: 'tasks' as const, name: 'Interrupted tasks resume' };
  if (tasks.length === 0) return { ...base, state: 'ok', reason: 'no interrupted tasks' };
  const stranded = autoResume
    ? tasks.filter(t => t.state === 'gave-up')
    : tasks.filter(t => t.state !== 'stopped');
  const counts = [
    ['queued', 'waiting for auto-resume'],
    ['stopped', 'stopped by a person'],
    ['gave-up', 'past the auto-resume budget'],
  ] as const;
  const summary = counts
    .map(([state, label]) => {
      const n = tasks.filter(t => t.state === state).length;
      return n > 0 ? `${n} ${label}` : null;
    })
    .filter(Boolean)
    .join(', ');
  if (stranded.length > 0) {
    const why = autoResume ? 'auto-resume gave up on' : '[daemon] auto_resume is off, so nothing resumes';
    return {
      ...base,
      state: 'warn',
      reason: `${why} ${stranded.map(t => t.code).join(', ')} (${summary})`,
      remedy: 'Resume each by hand with `lazy resume <task>` once whatever interrupted it is fixed.',
    };
  }
  return { ...base, state: 'ok', reason: summary };
}

export interface DashboardFacts {
  managed: boolean;
  binds: BindRecord[];
  dashboardUrl: string | null;
  bridgeUnreachable: string | null;
}

export function buildDashboardRow(facts: DashboardFacts): DaemonHealthRow {
  const base = { id: 'dashboard:bound', group: 'dashboard' as const, name: 'Dashboard bound' };
  if (facts.managed) {
    return { ...base, state: 'ok', reason: 'off — this daemon is managed, and its web interface is served elsewhere' };
  }
  const primary = facts.binds.find(b => b.surface === 'dashboard' && b.primary);
  if (!primary || !primary.ok) {
    return {
      ...base,
      state: 'fail',
      reason: primary?.reason ?? 'no dashboard listener was recorded',
      remedy: RESTART_REMEDY,
    };
  }
  const failed = facts.binds.filter(b => b.surface === 'dashboard' && !b.primary && !b.ok);
  const bound = `${facts.dashboardUrl ?? `${primary.host}:${primary.port}`}`;
  if (failed.length > 0 || facts.bridgeUnreachable) {
    const reasons = [...failed.map(b => b.reason ?? `${b.host} did not bind`), facts.bridgeUnreachable]
      .filter((r): r is string => Boolean(r))
      .map(firstLine);
    return {
      ...base,
      state: 'warn',
      reason: `bound at ${bound}, but ${reasons.join('; ')}`,
      remedy: 'Containers may not reach the daemon. Set a reachable interface via [server] bind in lazy.toml, then restart the daemon.',
    };
  }
  const extras = facts.binds.filter(b => b.surface === 'dashboard' && !b.primary && b.ok).map(b => b.host);
  return { ...base, state: 'ok', reason: `bound at ${bound}${extras.length ? ` (also on ${extras.join(', ')})` : ''}` };
}

export function summarizeRows(rows: DaemonHealthRow[]): { state: HealthState; counts: Record<HealthState, number> } {
  const counts: Record<HealthState, number> = { ok: 0, warn: 0, fail: 0 };
  for (const row of rows) counts[row.state]++;
  return { state: worst(rows.map(r => r.state)), counts };
}
