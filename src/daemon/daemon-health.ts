/**
 * `lazy daemon health` — the daemon's answer to "are my moving parts alive?".
 *
 * `lazy daemon status` answers "is the process up". This answers the question
 * that matters once it is: is the reconcile loop still ticking, is any sweep
 * failing on every tick, does the proxy answer, is the store being written, can
 * the runner launch anything, is any task stuck. Every one of those can go
 * wrong WITHOUT crashing the daemon — that is by design, each failure is caught
 * and logged — so without this they are only visible to someone who already
 * knows which log line to grep for.
 *
 * THE DAEMON OWNS THE ANSWER. Every row's state (ok / warn / fail), reason and
 * remedy is decided here; the CLI, doctor and any other client only render
 * rows. Rows are built by pure functions from snapshots (loop and sweep records
 * from ./health-registry.ts, the storage lock, the task list) so each verdict is
 * unit-testable without a daemon.
 *
 * REPORTING, NEVER REPAIRING. A stuck task or a wedged lock is reported with
 * its remedy; nothing here changes state. The proxy self-check sends one
 * request to the proxy's own liveness path, which carries no credential,
 * reaches no upstream, spends nothing and is not audited.
 *
 * BOUNDED. Every check runs under its own deadline: a check that hangs becomes
 * a FAIL row naming what hung, never a report that never arrives. Rows stream
 * to the caller as they complete (a `daemon-health` activity event per row), in
 * a fixed order, so the human sees progress and the output is stable.
 */

import { access, readFile } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import { dirname, join } from 'path';
import type { Storage } from '../storage/interface';
import type { Session, Task } from '../types';
import type { Runner } from '../runner';
import type { ResolvedConfig } from '../config/types';
import { loadConfig } from '../config/loader';
import { isManagedMode } from '../config/managed';
import { displayId } from '../task/identity';
import { isSyncDispatchable } from '../task/sync-dispatch';
import { isLinkedTask } from '../task/linked';
import { isUserStopped } from '../task/user-stop';
import { readSupervisorStatusAsync } from '../utils/working-substate';
import { probeWorkingRun, type RunnerFactory, type WorkingRunProbe } from '../utils/working-run';
import { formatElapsed } from '../utils/elapsed';
import { checkHolder } from '../utils/process-identity';
import { STORAGE_LOCK_FILENAME, storageLockActivity } from '../utils/storage-lock';
import { PROXY_HEALTH_PATH } from '../proxy';
import { getSlowLaneState } from './auto-resume-queue';
import { syncRetryBackoffSnapshot, syncRetryFailureSnapshot, type BackoffEntry, type SyncFailureEntry } from './sync-retry';
import { memberInsideTask } from '../server/member-terminals';
import {
  daemonHealthRecorder,
  RECONCILE_LOOP,
  REMOTE_SYNC_LOOP,
  SYNC_RETRY_LOOP,
  type ProxyHealthHandle,
} from './health-registry';
import { getOrCreateStorage } from './rpc-handlers';
import { getWorkingGracePeriodMs } from '../utils/reconcile';
import {
  buildAuditRow,
  buildBuildMatchRow,
  buildDashboardRow,
  buildHeldSyncsRow,
  buildImageRow,
  buildInterruptedRow,
  buildLoopRow,
  buildProxyRow,
  buildRunnerRows,
  runnerTimeoutRow,
  stuckWorkingTimeoutRow,
  RUNNER_CHECK_TIMEOUT_MS,
  buildStorageLockRow,
  buildStorageWritesRow,
  buildStuckWorkingRow,
  buildSweepRow,
  buildVersionRow,
  firstLine,
  notAliveGoneForMs,
  summarizeRows,
  CHECK_TIMEOUT_MS,
  CHECK_FALLBACK_IDS,
  LOOP_NAMES,
  PROXY_PROBE_TIMEOUT_MS,
  RESTART_REMEDY,
  type AuditWritable,
  type DaemonHealthReport,
  type DaemonHealthRow,
  type DaemonIdentityFacts,
  type HealthClientIdentity,
  type HealthGroup,
  type HeldSync,
  type InterruptedTask,
  type ProxyProbe,
  type StorageLockFacts,
  type StuckWorkingTask,
} from './daemon-health-rows';


// ── probes (I/O, bounded) ───────────────────────────────────────────────

/** Where to send a request to reach a listener bound on `bind`. */
function connectHost(bind: string): string {
  if (bind === '0.0.0.0' || bind === '') return '127.0.0.1';
  if (bind === '::') return '[::1]';
  return bind.includes(':') && !bind.startsWith('[') ? `[${bind}]` : bind;
}

/** One GET to the proxy's own liveness path. Never throws. */
export async function probeProxy(handle: ProxyHealthHandle): Promise<ProxyProbe> {
  const url = `http://${connectHost(handle.bind)}:${handle.port}${PROXY_HEALTH_PATH}`;
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROXY_PROBE_TIMEOUT_MS) });
    const body = await res.text();
    if (!res.ok) return { ok: false, url, error: `HTTP ${res.status}` };
    let service: unknown;
    try {
      service = (JSON.parse(body) as { service?: unknown }).service;
    } catch {
      service = undefined;
    }
    if (service !== 'lazy-proxy') {
      return { ok: false, url, error: 'something answered, but it is not this daemon\'s proxy' };
    }
    return { ok: true, url, rttMs: Date.now() - started };
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    const error = name === 'TimeoutError' || name === 'AbortError'
      ? `no answer within ${PROXY_PROBE_TIMEOUT_MS}ms`
      : (err instanceof Error ? err.message : String(err));
    return { ok: false, url, error };
  }
}

/**
 * Can the daemon append to the audit directory? `access(2)`, never a write:
 * a health check must not leave anything behind. A directory not created yet
 * is fine when its parent is writable — the first append creates it.
 */
export async function probeAuditWritable(auditDir: string): Promise<AuditWritable> {
  try {
    await access(auditDir, fsConstants.W_OK);
    return { ok: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') return { ok: false, error: (err as Error).message };
  }
  try {
    await access(dirname(auditDir), fsConstants.W_OK);
    return { ok: true, note: 'created on the first request' };
  } catch (err) {
    return { ok: false, error: `cannot be created: ${(err as Error).message}` };
  }
}

async function readStorageLockFacts(config: ResolvedConfig, projectRoot: string): Promise<StorageLockFacts> {
  // The same resolution `lazy doctor` uses to find the lock (external store
  // path, else ~/.lazy/<project>), so the two can never look at different files.
  const { resolveStorageLockDir } = await import('../doctor/sweep');
  const lockDir = await resolveStorageLockDir(projectRoot, config);
  if (!lockDir) return { kind: 'no-file-lock', backend: String(config.storage.backend) };
  const lockPath = join(lockDir, STORAGE_LOCK_FILENAME);
  let raw: string;
  try {
    raw = await readFile(lockPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing', lockPath };
    return { kind: 'unreadable', lockPath, error: (err as Error).message };
  }
  let lock: { pid?: unknown; acquired_at?: unknown; holder_started_at?: unknown; holder_start_source?: unknown };
  try {
    lock = JSON.parse(raw);
  } catch (err) {
    return { kind: 'unreadable', lockPath, error: `not valid JSON: ${(err as Error).message}` };
  }
  if (typeof lock.pid !== 'number') return { kind: 'unreadable', lockPath, error: 'it records no pid' };
  const acquiredAt = typeof lock.acquired_at === 'string' ? lock.acquired_at : null;
  // checkHolder is the pid-reuse-aware verdict (start time recorded at acquire
  // vs the process at that pid now) — a recycled pid reads as dead, never alive.
  const verdict = await checkHolder({
    pid: lock.pid,
    started: typeof lock.holder_started_at === 'string' ? lock.holder_started_at : null,
    startedSource: lock.holder_start_source === 'proc' || lock.holder_start_source === 'ps' ? lock.holder_start_source : null,
    acquiredAt,
  });
  return { kind: 'held', lockPath, pid: lock.pid, acquiredAt, verdict };
}

/**
 * How the health row asks about one working task's run: the shared resolution
 * the reconciler and every read surface use (src/utils/working-run.ts). A seam
 * so a test can fake the resolver rather than a runner.
 */
export type WorkingRunProber = (task: Task, session: Session) => Promise<WorkingRunProbe>;

/** The production prober: {@link probeWorkingRun} against the project's runner. */
export function workingRunProber(projectRoot: string, defaultRunner: Runner, runnerOf?: RunnerFactory): WorkingRunProber {
  return (task, session) => probeWorkingRun(projectRoot, task, session, defaultRunner, runnerOf);
}

/**
 * `working` tasks with no live run, each on its own: one failed lookup never
 * hides the rest. The lookups are independent (one runner call per task), so
 * they run at once — on a busy Docker the check then takes as long as the
 * slowest lookup, not the sum of them. Results keep the task order.
 */
export async function collectStuckWorking(
  storage: Storage,
  probe: WorkingRunProber,
  working: Task[],
  now: number,
): Promise<StuckWorkingTask[]> {
  const entries = await Promise.all(working.map(async (task): Promise<StuckWorkingTask | null> => {
    try {
      return await stuckWorkingEntry(storage, probe, task, now);
    } catch (err) {
      // One task's lookup failing (a runner call that timed out, an unreadable
      // session) says nothing about the others; report it as unknown and go on.
      return { code: displayId(task), goneForMs: null, livenessError: firstLine(err instanceof Error ? err.message : String(err)) };
    }
  }));
  return entries.filter((e): e is StuckWorkingTask => e !== null);
}

async function stuckWorkingEntry(storage: Storage, probe: WorkingRunProber, task: Task, now: number): Promise<StuckWorkingTask | null> {
  const session = await storage.getSessionByTaskId(task.id);
  if (!session) return null;
  // The one shared resolution — which run speaks for the task, on which
  // runner, and whether the runtime answered at all — never re-derived here,
  // so this row and `lazy list` / `lazy show` cannot disagree. A lookup the
  // runtime never answered confirms nothing: "liveness unknown", never dead.
  const found = await probe(task, session);
  if (found.livenessUnknown !== undefined) {
    return { code: displayId(task), goneForMs: null, livenessError: found.livenessUnknown };
  }
  if (found.substate?.kind !== 'not-alive') return null;
  // Last sign of life: the run's exit, its last checkpoint, or the launch —
  // and nothing at all while the reconciler's own launch grace holds.
  const info = found.info !== undefined ? found.info : await found.run.runner.getRunInfo(found.run.runName);
  const status = await readSupervisorStatusAsync(found.run.protoDir);
  const goneFor = notAliveGoneForMs(
    { finishedAt: info?.finishedAt, statusUpdatedAt: status?.updated_at, lastInteractionAt: session.last_interaction_at },
    now,
    getWorkingGracePeriodMs(),
  );
  if (goneFor === null) return null;
  return { code: displayId(task), goneForMs: goneFor === 'unknown' ? null : goneFor };
}

/** Where one held sync stands, from the retry loop's backoff and throw records. */
export function describeHeldSync(
  task: Task,
  backoff: BackoffEntry | undefined,
  now: number,
  failure?: SyncFailureEntry,
): HeldSync {
  const code = displayId(task);
  if (!isSyncDispatchable(task.status)) {
    return { code, pending: task.pending_sync, state: `waits for the ${task.status} task to park`, attempt: null };
  }
  if (memberInsideTask(task.id)) {
    return { code, pending: task.pending_sync, state: 'held while a member works in its terminal', attempt: null };
  }
  // A sync that threw is retried every tick with no backoff, so the backoff
  // record alone would call it "due" forever; the throw record says otherwise.
  if (failure) {
    const times = failure.failures === 1 ? 'once' : `${failure.failures} times in a row`;
    return {
      code,
      pending: task.pending_sync,
      state: `sync threw ${times}: ${firstLine(failure.lastError)}`,
      attempt: null,
      failures: failure.failures,
    };
  }
  if (!backoff) {
    return { code, pending: task.pending_sync, state: 'due on the next retry tick', attempt: null };
  }
  const why = backoff.reason === 'usage-pause' ? 'held by the usage pause' : 'fetch failed';
  const next = backoff.nextRetryAt <= now ? 'retrying now' : `next try in ${formatElapsed(backoff.nextRetryAt - now)}`;
  return { code, pending: task.pending_sync, state: `${why}, attempt ${backoff.attempt + 1}, ${next}`, attempt: backoff.attempt };
}

async function collectInterrupted(storage: Storage, tasks: Task[]): Promise<InterruptedTask[]> {
  const out: InterruptedTask[] = [];
  for (const task of tasks) {
    if (task.status !== 'interrupted') continue;
    const session = await storage.getSessionByTaskId(task.id);
    if (session && isUserStopped(session)) {
      out.push({ code: displayId(task), state: 'stopped' });
      continue;
    }
    // The slow lane marks a task exhausted once it has spent
    // daemon.auto_resume_max_attempts; after that nothing retries it
    // (src/daemon/auto-resume-queue.ts).
    const slow = await getSlowLaneState(storage, task.id);
    out.push({ code: displayId(task), state: slow.exhausted ? 'gave-up' : 'queued' });
  }
  return out;
}

/**
 * The Runner rows: the runner's own diagnostics, then whether the container
 * image is built. Cheap probes only — `launchProbes: false` keeps the runner
 * from starting a container to answer, which on a health check run on demand
 * (and inside every doctor run) would be both slow and a side effect.
 */
export async function collectRunnerRows(projectRoot: string, type: string, runner: Runner): Promise<DaemonHealthRow[]> {
  const rows = buildRunnerRows(type, await runner.diagnose({ launchProbes: false }));
  const container = type === 'docker' || type === 'podman';
  let image: { name: string; present: boolean } | null = null;
  // Only worth asking when the runtime itself answered.
  if (container && rows.every(row => row.state !== 'fail')) {
    const { resolveImageName } = await import('../capture/claude');
    const { checkContainerImage } = await import('../doctor/sweep');
    const name = await resolveImageName(projectRoot);
    image = { name, present: (await checkContainerImage(name, type)).ok };
  }
  // A container runtime that failed its own checks already explains why
  // nothing launches; an "image missing" row beside it would only guess.
  if (container && !image) return rows;
  return [...rows, buildImageRow(type, image)];
}

// ── the collector ───────────────────────────────────────────────────────

export interface CollectDaemonHealthOptions {
  /** The asking client's build (CLI), for the build-match row. */
  client?: HealthClientIdentity;
  /** Called with each row as it completes, in report order. */
  onRow?: (row: DaemonHealthRow) => void;
}

export interface PlannedCheck {
  /**
   * The id of the row that stands in for this check when it produces none of
   * its own (it threw, or ran out of time) — in the same family as its success
   * rows (see CHECK_FALLBACK_IDS).
   */
  id: string;
  group: HealthGroup;
  name: string;
  run: () => Promise<DaemonHealthRow[]>;
  /** This check's own deadline, when the shared one does not fit what it probes. */
  timeoutMs?: number;
  /**
   * What running out of time MEANS for this check. A deadline blown by the
   * container runtime is a runtime problem; one blown inside the daemon (the
   * store, its own loops) is the daemon's. Each says its own cause and remedy.
   */
  remedyOnTimeout?: string;
  onTimeout?: (timeoutMs: number) => DaemonHealthRow;
}

function timeoutRow(check: PlannedCheck, timeoutMs: number): DaemonHealthRow {
  if (check.onTimeout) return check.onTimeout(timeoutMs);
  return {
    id: check.id,
    group: check.group,
    name: check.name,
    state: 'fail',
    reason: `the check did not finish within ${formatElapsed(timeoutMs)}`,
    remedy: check.remedyOnTimeout ?? '`lazy daemon logs` may show what is slow; re-run to see whether it persists.',
  };
}

function errorRow(check: PlannedCheck, err: unknown): DaemonHealthRow {
  return {
    id: check.id,
    group: check.group,
    name: check.name,
    state: 'fail',
    reason: `the check itself failed: ${firstLine(err instanceof Error ? err.message : String(err))}`,
    remedy: '`lazy daemon logs` may say more; re-run to see whether it persists.',
  };
}

/**
 * The "Working tasks have a live run" check. Built by a factory so its inputs
 * (the task list, the store, the runner) can be faked in a test, and so its
 * timeout behaviour is part of the check rather than of the collector: running
 * out of time here means the runtime was too slow to say whether runs are
 * alive, which confirms nothing — a WARN, never a FAIL.
 */
export function stuckWorkingCheck(deps: {
  listWorking: () => Promise<Task[]>;
  storage: () => Promise<Storage>;
  /** The shared liveness resolution, bound to the project's runner. */
  prober: () => Promise<WorkingRunProber>;
  /** The configured runner type, once known — the timeout remedy names it. */
  runnerType: () => string | null;
  now: () => number;
  timeoutMs?: number;
}): PlannedCheck {
  return {
    id: 'tasks:working-not-alive',
    group: 'tasks',
    name: 'Working tasks have a live run',
    timeoutMs: deps.timeoutMs,
    onTimeout: (ms) => stuckWorkingTimeoutRow(deps.runnerType(), ms),
    run: async () => {
      const working = await deps.listWorking();
      const stuck = working.length === 0
        ? []
        : await collectStuckWorking(await deps.storage(), await deps.prober(), working, deps.now());
      return [buildStuckWorkingRow(stuck, working.length)];
    },
  };
}

/** Run one check under its deadline. Never throws: a failure or a timeout is itself a row. */
export function runBoundedCheck(check: PlannedCheck): Promise<DaemonHealthRow[]> {
  return bounded(check);
}

function bounded(check: PlannedCheck): Promise<DaemonHealthRow[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = check.timeoutMs ?? CHECK_TIMEOUT_MS;
  const deadline = new Promise<DaemonHealthRow[]>((resolve) => {
    timer = setTimeout(() => resolve([timeoutRow(check, timeoutMs)]), timeoutMs);
  });
  const work = check.run().catch((err) => [errorRow(check, err)]);
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Run every check and build the report. Checks run concurrently, rows are
 * handed to `onRow` in report order as soon as each one (and everything before
 * it) has finished. Never throws: a check that fails or hangs is itself a row.
 */
export async function collectDaemonHealth(
  projectRoot: string,
  options: CollectDaemonHealthOptions = {},
): Promise<DaemonHealthReport> {
  const now = () => Date.now();
  const snapshot = daemonHealthRecorder(projectRoot).snapshot();

  // Shared lazily-built inputs, each built at most once however many checks read it.
  let configP: Promise<ResolvedConfig> | null = null;
  const config = () => (configP ??= loadConfig(projectRoot));
  let runnerP: Promise<Runner> | null = null;
  const runner = () => (runnerP ??= import('../runner').then(m => m.createRunner(projectRoot)));
  let tasksP: Promise<Task[]> | null = null;
  const tasks = () => (tasksP ??= getOrCreateStorage().then(s => s.listTasksWithOptions({ nonTerminalOnly: true })));

  // Known once config has loaded; a Runner timeout names it when it can.
  let runnerTypeSeen: string | null = null;
  const runnerTimeoutRowFor = (ms: number) => runnerTimeoutRow(runnerTypeSeen, ms);

  // The runner type is needed by the timeout rows of checks that may never get
  // far enough to load config themselves; start loading it now.
  void config().then((cfg) => { runnerTypeSeen = cfg.runner.type; }, () => { /* reported by the checks that need config */ });

  const checks: PlannedCheck[] = [
    {
      id: 'daemon:version', group: 'daemon', name: 'Version and uptime',
      run: async () => {
        const facts = await daemonIdentity(snapshot.startedAt);
        return [buildVersionRow(facts, now()), buildBuildMatchRow(facts, options.client)];
      },
    },
    ...[RECONCILE_LOOP, SYNC_RETRY_LOOP, REMOTE_SYNC_LOOP].map((name): PlannedCheck => ({
      id: `loop:${name}`, group: 'loops', name: LOOP_NAMES[name]!,
      run: async () => [buildLoopRow(name, snapshot.loops.find(l => l.name === name), now())],
    })),
    {
      id: CHECK_FALLBACK_IDS.sweeps, group: 'sweeps', name: 'Reconciler sweeps',
      run: async () => {
        if (snapshot.sweeps.length === 0) {
          return [{ id: 'sweep:none', group: 'sweeps', name: 'Reconciler sweeps', state: 'ok', reason: 'no sweep has run yet' }];
        }
        return snapshot.sweeps.map(s => buildSweepRow(s, now()));
      },
    },
    {
      id: 'proxy:listening', group: 'proxy', name: 'Proxy answering',
      run: async () => {
        const probe = snapshot.proxy && snapshot.proxy.port !== null ? await probeProxy(snapshot.proxy) : null;
        return [buildProxyRow(snapshot.proxy, probe)];
      },
    },
    {
      id: 'proxy:audit-log', group: 'proxy', name: 'Proxy audit log writable',
      run: async () => {
        const handle = snapshot.proxy;
        const writable = handle ? await probeAuditWritable(handle.auditDir) : null;
        return [buildAuditRow(handle, writable, handle ? handle.auditHealth() : null, now())];
      },
    },
    {
      id: 'storage:lock', group: 'storage', name: 'Storage lock',
      // Reading one lock file and asking the OS about one pid should be
      // instant; a daemon that cannot is itself wedged.
      remedyOnTimeout: `\`lazy daemon logs\` may show what is stuck; ${RESTART_REMEDY}`,
      run: async () => {
        const facts = await readStorageLockFacts(await config(), projectRoot);
        const fileLocked = facts.kind !== 'no-file-lock';
        const activity = facts.kind === 'no-file-lock' ? null : storageLockActivity(facts.lockPath);
        return [
          buildStorageLockRow(facts, process.pid, now()),
          buildStorageWritesRow(activity, fileLocked, now()),
        ];
      },
    },
    {
      id: CHECK_FALLBACK_IDS.runner, group: 'runner', name: 'Runner',
      timeoutMs: RUNNER_CHECK_TIMEOUT_MS,
      onTimeout: (ms) => runnerTimeoutRowFor(ms),
      run: async () => {
        const cfg = await config();
        runnerTypeSeen = cfg.runner.type;
        return collectRunnerRows(projectRoot, cfg.runner.type, await runner());
      },
    },
    stuckWorkingCheck({
      listWorking: async () => (await tasks()).filter(t => t.status === 'working'),
      storage: () => getOrCreateStorage(),
      prober: async () => workingRunProber(projectRoot, await runner()),
      runnerType: () => runnerTypeSeen,
      now,
    }),
    {
      id: 'tasks:held-syncs', group: 'tasks', name: 'Held syncs',
      run: async () => {
        const backoff = syncRetryBackoffSnapshot(projectRoot);
        const failures = syncRetryFailureSnapshot(projectRoot);
        const held = (await tasks())
          .filter(t => t.pending_sync > 0 && !isLinkedTask(t))
          .map(t => describeHeldSync(t, backoff.get(t.id), now(), failures.get(t.id)));
        return [buildHeldSyncsRow(held)];
      },
    },
    {
      id: 'tasks:interrupted', group: 'tasks', name: 'Interrupted tasks resume',
      run: async () => {
        const cfg = await config();
        const interrupted = await collectInterrupted(await getOrCreateStorage(), await tasks());
        return [buildInterruptedRow(interrupted, cfg.daemon.auto_resume)];
      },
    },
    {
      id: 'dashboard:bound', group: 'dashboard', name: 'Dashboard bound',
      run: async () => [buildDashboardRow({
        managed: isManagedMode(),
        binds: snapshot.binds,
        dashboardUrl: snapshot.dashboardUrl,
        bridgeUnreachable: snapshot.bridgeUnreachable,
      })],
    },
  ];

  // Start everything at once; hand rows over in plan order.
  const pending = checks.map(bounded);
  const rows: DaemonHealthRow[] = [];
  for (const p of pending) {
    for (const row of await p) {
      rows.push(row);
      try {
        options.onRow?.(row);
      } catch {
        // A listener that hung up must not cost the report its remaining rows.
      }
    }
  }

  const { state, counts } = summarizeRows(rows);
  return {
    checkedAt: new Date(now()).toISOString(),
    projectRoot,
    pid: process.pid,
    state,
    counts,
    rows,
  };
}

async function daemonIdentity(startedAt: number | null): Promise<DaemonIdentityFacts> {
  let version = 'unknown';
  try {
    version = (await import('../version')).VERSION;
  } catch {
    // The generated version file is absent in some test trees; "unknown" says so.
  }
  let sourceId: string | null = null;
  let sourceIdKind: string | null = null;
  try {
    const identity = await (await import('../utils/source-id')).getSourceIdentity();
    sourceId = identity.id;
    sourceIdKind = identity.kind;
  } catch {
    // Identity is diagnostic; the version row still says what it can.
  }
  return { pid: process.pid, startedAt, version, sourceId, sourceIdKind };
}
