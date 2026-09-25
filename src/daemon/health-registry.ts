/**
 * What the daemon's own moving parts last did — kept in memory so
 * `lazy daemon health` can answer "is it actually working?" instead of only
 * "is the process up?".
 *
 * WHY THIS EXISTS. A daemon can answer `/daemon/status` perfectly while the
 * work it exists for has stopped: the reconcile loop wedged on one hanging
 * phase, a sweep throwing on every tick, the proxy gone. Every one of those is
 * caught and LOGGED so the daemon never crashes — which is right — but a log
 * line is only an answer for someone who already knows which line to look for.
 * This records the same events as data: each loop's ticks, each sweep's last
 * run and last error, what the listeners bound.
 *
 * WRITTEN BY the loops and sweeps themselves (src/daemon/server.ts,
 * src/utils/reconcile.ts, src/daemon/sync-retry.ts), READ BY
 * src/daemon/daemon-health.ts. Nothing here decides anything; it only
 * remembers.
 *
 * DAEMON MEMORY, DELIBERATELY. This is not storage state: it describes this
 * process, is meaningless after it exits, and must be writable from inside a
 * sweep whose failure may BE the store. Keyed by project root because tests run
 * several in-process daemons in one process, and a module-level singleton would
 * let one daemon's ticks answer for another's.
 *
 * Every write is a plain field assignment — nothing here can throw into the
 * loop it is observing.
 */

/** One periodic loop (the reconciler, the sync-retry loop, the remote sync loop). */
export interface LoopRecord {
  name: string;
  /** How often the loop is scheduled to tick. */
  intervalMs: number;
  /** When the loop was started (epoch ms). */
  startedAt: number;
  /** Ticks that ran to completion (success or caught error). */
  ticksCompleted: number;
  /** Ticks skipped because the previous one was still running. */
  ticksSkipped: number;
  lastTickStartedAt: number | null;
  lastTickFinishedAt: number | null;
  lastTickDurationMs: number | null;
  /** Start of the tick running right now, or null when idle. */
  currentTickStartedAt: number | null;
  /** Named phase the running tick is in, when the loop reports phases. */
  currentPhase: string | null;
  /** Error that escaped the tick's own phase isolation, and when. */
  lastError: string | null;
  lastErrorAt: number | null;
  /** True when the most recent completed tick ended in that error. */
  lastTickFailed: boolean;
}

/** One named sweep or phase inside a loop tick. */
export interface SweepRecord {
  name: string;
  /** The loop the sweep runs inside, for grouping. */
  loop: string;
  runs: number;
  lastRunAt: number | null;
  lastDurationMs: number | null;
  lastOkAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  /** Consecutive failed runs ending with the most recent one (0 when it last succeeded). */
  consecutiveFailures: number;
  /** Start of the current failure streak, or null when the last run succeeded. */
  failingSince: number | null;
}

/** One listener the daemon tried to bind. */
export interface BindRecord {
  surface: 'dashboard' | 'proxy';
  host: string;
  port: number | null;
  /** True for the address every other one is an extra of. */
  primary: boolean;
  ok: boolean;
  /** Why the bind failed — the same text the daemon logged. */
  reason?: string;
}

/** What the health check needs from the running proxy. */
export interface ProxyHealthHandle {
  /** `[proxy] bind`, as configured. */
  bind: string;
  /** Every address actually listening. */
  binds: string[];
  port: number | null;
  /** Directory the audit segments are appended in. */
  auditDir: string;
  /** The audit queue's own record of its last append. */
  auditHealth: () => AuditAppendHealth;
}

/** The audit queue's append history, as far as health needs it. */
export interface AuditAppendHealth {
  lastSuccessAt: number | null;
  lastFailure: string | null;
  lastFailureAt: number | null;
  /** Records dropped since the last successful append. */
  droppedSinceSuccess: number;
}

export interface DaemonHealthSnapshot {
  startedAt: number | null;
  loops: LoopRecord[];
  sweeps: SweepRecord[];
  binds: BindRecord[];
  /** Set when [server] bind is loopback on Linux with no container bridge found. */
  bridgeUnreachable: string | null;
  dashboardUrl: string | null;
  proxy: ProxyHealthHandle | null;
}

export class DaemonHealthRecorder {
  private startedAt: number | null = null;
  private readonly loops = new Map<string, LoopRecord>();
  private readonly sweeps = new Map<string, SweepRecord>();
  private binds: BindRecord[] = [];
  private bridgeUnreachable: string | null = null;
  private dashboardUrl: string | null = null;
  private proxy: ProxyHealthHandle | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  daemonStarted(at: number): void {
    this.startedAt = at;
  }

  loopStarted(name: string, intervalMs: number): void {
    this.loops.set(name, {
      name,
      intervalMs,
      startedAt: this.now(),
      ticksCompleted: 0,
      ticksSkipped: 0,
      lastTickStartedAt: null,
      lastTickFinishedAt: null,
      lastTickDurationMs: null,
      currentTickStartedAt: null,
      currentPhase: null,
      lastError: null,
      lastErrorAt: null,
      lastTickFailed: false,
    });
  }

  tickStarted(loop: string): void {
    const record = this.loops.get(loop);
    if (!record) return;
    const at = this.now();
    record.currentTickStartedAt = at;
    record.lastTickStartedAt = at;
    record.currentPhase = null;
  }

  tickSkipped(loop: string): void {
    const record = this.loops.get(loop);
    if (record) record.ticksSkipped++;
  }

  currentPhase(loop: string): string | null {
    return this.loops.get(loop)?.currentPhase ?? null;
  }

  tickPhase(loop: string, phase: string | null): void {
    const record = this.loops.get(loop);
    if (record) record.currentPhase = phase;
  }

  /**
   * Close a tick. `startedAt` is the tick's own start, so a tick that was
   * force-reset past (the reconciler's stuck-tick timeout) and finishes late
   * does not clobber the newer tick's in-flight marker.
   */
  tickFinished(loop: string, startedAt: number, error?: unknown): void {
    const record = this.loops.get(loop);
    if (!record) return;
    const at = this.now();
    record.ticksCompleted++;
    record.lastTickFinishedAt = at;
    record.lastTickDurationMs = at - startedAt;
    if (record.currentTickStartedAt === startedAt) {
      record.currentTickStartedAt = null;
      record.currentPhase = null;
    }
    record.lastTickFailed = error !== undefined;
    if (error !== undefined) {
      record.lastError = errorMessage(error);
      record.lastErrorAt = at;
    }
  }

  sweepFinished(loop: string, name: string, startedAt: number, error?: unknown): void {
    const key = `${loop}:${name}`;
    let record = this.sweeps.get(key);
    if (!record) {
      record = {
        name, loop, runs: 0, lastRunAt: null, lastDurationMs: null, lastOkAt: null,
        lastError: null, lastErrorAt: null, consecutiveFailures: 0, failingSince: null,
      };
      this.sweeps.set(key, record);
    }
    const at = this.now();
    record.runs++;
    record.lastRunAt = startedAt;
    record.lastDurationMs = at - startedAt;
    if (error === undefined) {
      record.lastOkAt = at;
      record.consecutiveFailures = 0;
      record.failingSince = null;
    } else {
      record.lastError = errorMessage(error);
      record.lastErrorAt = at;
      if (record.consecutiveFailures === 0) record.failingSince = startedAt;
      record.consecutiveFailures++;
    }
  }

  recordBind(bind: BindRecord): void {
    this.binds = [...this.binds.filter(b => !(b.surface === bind.surface && b.host === bind.host)), bind];
  }

  recordBridgeUnreachable(message: string): void {
    this.bridgeUnreachable = message;
  }

  recordDashboardUrl(url: string | null): void {
    this.dashboardUrl = url;
  }

  setProxy(handle: ProxyHealthHandle | null): void {
    this.proxy = handle;
  }

  /** A deep-enough copy that a reader can never mutate what the loops write. */
  snapshot(): DaemonHealthSnapshot {
    return {
      startedAt: this.startedAt,
      loops: [...this.loops.values()].map(l => ({ ...l })),
      sweeps: [...this.sweeps.values()].map(s => ({ ...s })),
      binds: this.binds.map(b => ({ ...b })),
      bridgeUnreachable: this.bridgeUnreachable,
      dashboardUrl: this.dashboardUrl,
      proxy: this.proxy,
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const recorders = new Map<string, DaemonHealthRecorder>();

/** The recorder for one project's daemon, created on first use. */
export function daemonHealthRecorder(projectRoot: string): DaemonHealthRecorder {
  let recorder = recorders.get(projectRoot);
  if (!recorder) {
    recorder = new DaemonHealthRecorder();
    recorders.set(projectRoot, recorder);
  }
  return recorder;
}

/**
 * Drop a project's recorder. Called when its daemon STARTS (startDaemonServer),
 * before any loop is created, so a restart in the same process begins with a
 * clean record rather than the previous daemon's ticks. Deliberately not on the
 * stop path: a stopped daemon's record is harmless, and clearing at start is
 * the one point that is guaranteed to precede the new daemon's first write.
 */
export function forgetDaemonHealth(projectRoot: string): void {
  recorders.delete(projectRoot);
}

/** The loop names the recorder knows, spelled once. */
export const RECONCILE_LOOP = 'reconcile';
export const SYNC_RETRY_LOOP = 'sync-retry';
export const REMOTE_SYNC_LOOP = 'remote-sync';

/**
 * Run one sweep with its outcome recorded. Errors are handed to `onError` —
 * the caller's existing log line — and never rethrown: every call site this
 * replaces caught and continued, and so does this.
 */
export async function runRecordedSweep(
  projectRoot: string,
  loop: string,
  name: string,
  fn: () => Promise<unknown>,
  onError: (err: unknown) => void,
): Promise<void> {
  const recorder = daemonHealthRecorder(projectRoot);
  const startedAt = Date.now();
  // Hand the phase back when done: a tick wedged BETWEEN phases must not read
  // as stuck in one that already finished. Nested sweeps (the reconciler's own
  // sweeps inside the `reconcileTasks` phase) restore their enclosing phase.
  const enclosing = recorder.currentPhase(loop);
  recorder.tickPhase(loop, name);
  try {
    await fn();
    recorder.sweepFinished(loop, name, startedAt);
  } catch (err) {
    recorder.sweepFinished(loop, name, startedAt, err);
    onError(err);
  } finally {
    recorder.tickPhase(loop, enclosing);
  }
}
