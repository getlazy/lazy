/**
 * What the project's MACHINE is doing, answered by the project daemon that
 * runs on it: the state of its services, each one's recent log, and CPU,
 * memory and disk against the machine's size. Read-only — the one write here,
 * restarting a guest service, is god mode's (`restartMachineService`).
 *
 * THE SERVICES. On a Lazy Teams microVM the guest has no init system;
 * `lazy-guest-init` (src/guest/lazy-guest-init, run by the image's shim) starts
 * dockerd and the forwarder that carries the daemon's port to the VM's relay,
 * and leaves their logs and pid files at fixed paths (GUEST_PATHS below, kept
 * in step with that script). The project daemon is this process, and the task
 * proxy runs inside it — so their state is known first-hand and their log is
 * the daemon's log (the proxy's lines are the ones tagged `[proxy]`).
 *
 * Elsewhere (a laptop, Teams' local-docker backend) there is no guest: dockerd
 * is whatever the host runs, its log is not ours to read, and there is no
 * forwarder. Those are reported as such — `not_applicable`, `logAvailable:
 * false` — never guessed.
 *
 * Every answer leaves through `redactAnswer` (./observability-redaction.ts) at
 * the RPC boundary: these logs are exactly where a credential can surface.
 */
import { open, readFile, rm, stat, statfs, writeFile } from 'fs/promises';
import { cpus, loadavg, totalmem, freemem, hostname } from 'os';
import { spawn } from '../utils/spawn';
import { logger } from '../utils/logger';
import { getLogPath } from './paths';
import { daemonHealthRecorder } from './health-registry';
import type { ProxyProbe } from './daemon-health-rows';
import { VERSION } from '../version';
import { isManagedMode, MANAGED_BACKEND_ENV } from '../config/managed-mode';
import { loadConfig } from '../config/loader';
import { basename } from 'path';
import { isZombieState, readProcessIdentity } from '../utils/process-identity';
import type { Escalation } from './image-state';
import { machineIntegrityView, type MachineIntegrityView } from './machine-integrity';
import { DOCKERD_HISTORY_LOG, describeDockerdOom, dockerdOomRemedy, GUEST_RESTART_WINDOW_MS, dockerdOomSentence, latestDockerdOomFromHistory, runRequestedDockerdRestart } from './guest-dockerd';

/** Where lazy-guest-init leaves things. Keep in step with that script. */
export const GUEST_PATHS = {
  dockerdLog: '/var/log/lazy-dockerd.log',
  /** Written by the shell that starts dockerd: dockerd's own pid. */
  dockerdPid: '/run/lazy-dockerd.pid',
  /** Why each dockerd died and every restart, appended by lazy-guest-init. */
  dockerdHistory: DOCKERD_HISTORY_LOG,
  /** dockerd's exit status, written when it ends. */
  dockerdExit: '/run/lazy-dockerd.exit',
  /** One epoch per crash restart this boot — the restart budget. */
  dockerdRestarts: '/run/lazy-dockerd.restarts',
  /** Present once lazy-guest-init stopped restarting a crash-looping dockerd. */
  dockerdGaveUp: '/run/lazy-dockerd.gave-up',
  /** The epoch a RUNNING dockerd was first found not answering. */
  dockerdUnresponsiveSince: '/run/lazy-dockerd.unresponsive-since',
  /** God mode's restart request (an epoch), honoured by lazy-guest-init as "not a crash". */
  dockerdRestartRequested: '/run/lazy-dockerd.restart-requested',
  forwarderLog: '/var/log/lazy-forwarder.log',
  forwarderPid: '/run/lazy-guest-forwarder.pid',
  /** The guest's real disk, where docker's data-root lives. */
  storageRoot: '/storage',
};

export type MachineServiceName = 'dockerd' | 'forwarder' | 'daemon' | 'proxy';
export const MACHINE_SERVICES: readonly MachineServiceName[] = ['dockerd', 'forwarder', 'daemon', 'proxy'];

/**
 * `unresponsive`: running but not answering. `crash_loop`: dockerd kept dying
 * and lazy-guest-init stopped restarting it.
 */
export type ServiceState = 'running' | 'unresponsive' | 'crash_loop' | 'stopped' | 'not_started' | 'not_applicable';

export interface ServiceLog {
  /** False when this service's log cannot be read here (not lazy's, or not on this machine). */
  available: boolean;
  /** Where it was read from, in words. */
  source: string | null;
  /** The last lines, oldest first. */
  lines: string[];
  /** True when older lines exist beyond the ones returned. */
  truncated: boolean;
}

export interface ServiceView {
  name: MachineServiceName;
  label: string;
  state: ServiceState;
  detail: string | null;
  pid: number | null;
  /**
   * How god mode restarts it: `guest` through `restartMachineService`, `fleet`
   * through the fleet's own daemon restart (the daemon cannot restart itself,
   * and the proxy lives inside it), or `none` where it is not lazy's to restart.
   */
  restart: 'guest' | 'fleet' | 'none';
  log: ServiceLog;
  /**
   * dockerd on a Lazy Teams microVM only (null elsewhere): lazy-guest-init's
   * restart history — how each dockerd ended and every restart, requested or not.
   */
  history: ServiceLog | null;
  /**
   * dockerd on a Lazy Teams microVM only (null elsewhere): the restarts after a
   * crash within lazy-guest-init's window. A restart god mode asked for is not one.
   */
  recentRestarts: { count: number; windowSeconds: number } | null;
  /** Present when the service is not healthy. Machine services are always the maintainer's. */
  escalation: Escalation | null;
}

export interface ResourceView {
  cpu: { cores: number; load1: number; load5: number; load15: number; /** load1 / cores. */ loadPerCore: number };
  memory: { totalBytes: number; availableBytes: number; usedPercent: number };
  /** The disks that matter: docker's data-root (or the guest's storage) and the project checkout. */
  disks: Array<{ label: string; path: string; totalBytes: number; freeBytes: number; usedPercent: number }>;
  /** Plain-language warnings (`disk 93% full`), each with who can act on it. */
  warnings: Array<{ resource: 'cpu' | 'memory' | 'disk'; message: string; escalation: Escalation }>;
}

export interface MachineView {
  /** `microvm` (a Teams guest lazy manages), `local-docker` (Teams' shared host), `host` (the person's own machine). */
  kind: 'microvm' | 'local-docker' | 'host';
  /** Empty on `local-docker`: the shared host's name is not this project's to see. */
  hostname: string;
  observedAt: string;
  services: ServiceView[];
  /**
   * Null on `local-docker` (see `resourcesWithheld`): the host's load, memory
   * and disks there reflect every project on it, not this one.
   */
  resources: ResourceView | null;
  /** Why `resources` is null, in words; null when they are reported. */
  resourcesWithheld: string | null;
  /** The guest service restart running or last run, if any. */
  restart: RestartView | null;
  /** The Docker storage reset running or last run, if any. */
  storageReset: StorageResetView | null;
  /**
   * A Lazy Teams microVM only (null elsewhere): the automatic memory and image
   * data checks (src/daemon/machine-integrity.ts) — the quiet "last checked"
   * line, or what a damaging result found.
   */
  integrity: MachineIntegrityView | null;
}

/** A reset of the machine's Docker storage: narrated step by step as it runs. */
export interface StorageResetView {
  state: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  /** What happened so far, in order, in plain words. */
  steps: string[];
  /** Disk space the reset gave back (kB), when the guest could tell. */
  freedKb: number | null;
  /** Why it failed, in words; null otherwise. */
  failure: string | null;
}

export interface RestartView {
  service: MachineServiceName;
  state: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  /** What lazy-guest-init printed, or why it failed. */
  output: string | null;
}

/** Injected seams — the real paths and probes by default, fixtures in tests. */
export interface MachineDeps {
  paths?: typeof GUEST_PATHS;
  /** Absolute path of `lazy-guest-init`, or null when this is not a lazy guest. */
  guestInit?: () => string | null;
  /** The container runtime binary, or null for a non-container runner. */
  dockerBinary?: () => Promise<string | null>;
  /**
   * The in-process proxy's liveness — its port and `lazy daemon health`'s own
   * probe of it — or null when it is not running.
   */
  proxy?: () => Promise<{ port: number; probe: ProxyProbe } | null>;
}

const DEFAULT_LOG_LINES = 200;
const MAX_LOG_LINES = 2000;
/** Read at most this much from the end of a log file. */
const MAX_TAIL_BYTES = 512 * 1024;
const DOCKER_PROBE_TIMEOUT_MS = 8_000;

const LOCAL_DOCKER_RESOURCES_WITHHELD =
  'This project runs on a shared host; its CPU, memory and disk figures cover every project there, so they are not shown.';

const DISK_WARN_PERCENT = 90;
const MEMORY_WARN_PERCENT = 92;
const LOAD_WARN_PER_CORE = 2;

/**
 * Which machine this is, from what the FLEET declared (`LAZY_MANAGED_BACKEND`,
 * pushed by its supervisor) — never from what happens to be installed: a
 * guest script on PATH must not turn a shared host into "this project's own
 * machine". Fails closed like `autoBuildsRootDockerfile`: a managed daemon
 * not told its backend is treated as the shared case.
 */
function machineKind(): MachineView['kind'] {
  if (!isManagedMode()) return 'host';
  return process.env[MANAGED_BACKEND_ENV] === 'microvm' ? 'microvm' : 'local-docker';
}

function maintainer(summary: string, why: string): Escalation {
  return { to: 'maintainer', summary, why, actions: [] };
}

/** The last `lines` lines of `path`, filtered by `keep`, or an unavailable log. */
export async function tailLog(path: string, lines: number, keep?: (line: string) => boolean): Promise<ServiceLog> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EACCES') return { available: false, source: path, lines: [], truncated: false };
    throw new Error(`could not open ${path}: ${(err as Error).message}`);
  }
  try {
    const { size } = await handle.stat();
    // Asked for no lines: say the log exists, read none of it.
    if (lines <= 0) return { available: true, source: path, lines: [], truncated: size > 0 };
    const start = Math.max(0, size - MAX_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await handle.read(buf, 0, buf.length, start);
    let all = buf.toString('utf-8').split('\n');
    if (start > 0) all = all.slice(1); // the first line is cut mid-way
    if (all.at(-1) === '') all.pop();
    const kept = keep ? all.filter(keep) : all;
    // slice(-0) is slice(0) — the whole tail — so "no lines" is said explicitly.
    const tail = lines > 0 ? kept.slice(-lines) : [];
    return { available: true, source: path, lines: tail, truncated: start > 0 || kept.length > tail.length };
  } finally {
    await handle.close();
  }
}

async function readPid(path: string): Promise<number | null> {
  try {
    const pid = Number.parseInt((await readFile(path, 'utf-8')).trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`could not read ${path}: ${(err as Error).message}`);
  }
}

/** The program each guest service runs as — what a pid file's pid must still be. */
const SERVICE_PROGRAMS = { dockerd: 'dockerd', forwarder: 'socat' } as const;

/**
 * Is the process at `pid` still `program`? A pid file outlives its process
 * and pids are reused, so "a process exists at that pid" is not "the service
 * is running" — and must never be the reason to SIGTERM it. `unknown` when
 * the OS will not say what it is (it is alive, but its command is unreadable).
 */
async function serviceProcess(pid: number | null, program: string): Promise<'alive' | 'dead' | 'foreign' | 'unknown'> {
  if (!pid) return 'dead';
  const identity = await readProcessIdentity(pid);
  if (!identity || isZombieState(identity.state)) return 'dead';
  if (!identity.command) return 'unknown';
  const argv0 = identity.command.trim().split(/\s+/)[0] ?? '';
  return basename(argv0) === program ? 'alive' : 'foreign';
}


/** Ask the container runtime whether it answers, bounded. */
async function probeDocker(binary: string): Promise<{ ok: true; version: string; rootDir: string | null; running: number | null } | { ok: false; detail: string }> {
  try {
    const proc = spawn([binary, 'info', '--format', '{{.ServerVersion}}|{{.DockerRootDir}}|{{.ContainersRunning}}'], {
      stdout: 'pipe', stderr: 'pipe', timeout: DOCKER_PROBE_TIMEOUT_MS,
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code === 0) {
      const [version, rootDir, running] = out.trim().split('|');
      return { ok: true, version: version || 'unknown', rootDir: rootDir || null, running: running ? Number(running) : null };
    }
    return { ok: false, detail: code === null ? `did not answer within ${DOCKER_PROBE_TIMEOUT_MS / 1000}s` : (err.trim() || `exit ${code}`) };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** An epoch (seconds) a guest file holds, or null when absent or not a number. */
async function readEpoch(path: string): Promise<number | null> {
  try {
    const text = (await readFile(path, 'utf-8')).trim();
    return /^\d+$/.test(text) ? Number(text) : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`could not read ${path}: ${(err as Error).message}`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error(`could not stat ${path}: ${(err as Error).message}`);
  }
}

/** Crash restarts within lazy-guest-init's window, from its per-boot record (one epoch per line). */
async function recentDockerdRestarts(path: string): Promise<{ count: number; windowSeconds: number }> {
  const windowSeconds = GUEST_RESTART_WINDOW_MS / 1000;
  let text = '';
  try {
    text = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`could not read ${path}: ${(err as Error).message}`);
  }
  const now = Math.floor(Date.now() / 1000);
  const count = text.split('\n').filter((l) => /^\d+$/.test(l.trim()) && now - Number(l.trim()) <= windowSeconds).length;
  return { count, windowSeconds };
}

function restartsPhrase(r: { count: number; windowSeconds: number }): string {
  return `${r.count} time${r.count === 1 ? '' : 's'} in the last ${Math.round(r.windowSeconds / 60)} minutes`;
}

async function dockerService(deps: Required<MachineDeps>, kind: MachineView['kind'], lines: number): Promise<ServiceView & { rootDir: string | null }> {
  const binary = await deps.dockerBinary();
  const guest = kind === 'microvm';
  const log: ServiceLog = guest
    ? await tailLog(deps.paths.dockerdLog, lines)
    : { available: false, source: null, lines: [], truncated: false };
  // The guest's own account of dockerd: why each one died, and how often.
  const history = guest ? await tailLog(deps.paths.dockerdHistory, lines) : null;
  const recentRestarts = guest ? await recentDockerdRestarts(deps.paths.dockerdRestarts) : null;
  const base = { name: 'dockerd' as const, label: 'Container runtime (dockerd)', log, history, recentRestarts };
  if (!binary) {
    return {
      ...base, state: 'not_applicable', detail: 'This project does not run agents in containers.',
      pid: null, restart: 'none', escalation: null, rootDir: null,
    };
  }
  const pid = guest ? await readPid(deps.paths.dockerdPid) : null;
  const probe = await probeDocker(binary);
  // Only while the restart is recent: days later a healthy dockerd needs no note.
  const lastOom = history && recentRestarts && recentRestarts.count > 0 ? latestDockerdOomFromHistory(history.lines) : null;
  const restarted = recentRestarts && recentRestarts.count > 0 ? `; lazy restarted it after it stopped ${restartsPhrase(recentRestarts)}` : '';
  if (probe.ok) {
    return {
      ...base, state: 'running',
      // On Teams' local-docker backend this dockerd is the HOST's, shared by
      // every project: its container count is other projects' business.
      detail: `version ${probe.version}${probe.running !== null && kind !== 'local-docker' ? `, ${probe.running} container${probe.running === 1 ? '' : 's'} running` : ''}${restarted}${lastOom ? `. Its last stop: ${dockerdOomSentence(lastOom)}` : ''}`,
      pid, restart: guest ? 'guest' : 'none', escalation: null, rootDir: kind === 'local-docker' ? null : probe.rootDir,
    };
  }
  const restartOrder = 'Restarting it is a machine operation for your god-mode maintainer.';
  const unusable = 'Without it no task, builder or image build can run.';
  // God mode is restarting it right now: down is expected, not a fault to report.
  if (guest && lastRestart?.service === 'dockerd' && lastRestart.state === 'running') {
    return {
      ...base, state: 'stopped', detail: 'Being restarted from god mode.',
      pid, restart: 'guest', escalation: null, rootDir: null,
    };
  }
  // A storage reset stops dockerd on purpose: down is expected, and the page narrates it.
  if (guest && lastStorageReset?.state === 'running') {
    return {
      ...base, state: 'stopped', detail: 'Its Docker storage is being reset.',
      pid, restart: 'guest', escalation: null, rootDir: null,
    };
  }
  const oomDeath = history ? latestDockerdOomFromHistory(history.lines) : null;
  const oomNote = oomDeath ? ` Its last death: ${dockerdOomSentence(oomDeath)}` : '';
  const proc = guest ? await serviceProcess(pid, SERVICE_PROGRAMS.dockerd) : 'dead';
  if (guest && await exists(deps.paths.dockerdGaveUp)) {
    return {
      ...base, state: 'crash_loop',
      detail: `${recentRestarts!.count > 0 ? `lazy restarted it ${restartsPhrase(recentRestarts!)} and it stopped again` : 'It kept stopping'}, so lazy stopped restarting it. ${probe.detail}${oomNote}`,
      pid, restart: 'guest', rootDir: null,
      escalation: oomDeath ? {
        to: 'admin',
        summary: `The container runtime keeps stopping: ${describeDockerdOom(oomDeath.used, oomDeath.machine)}, so lazy stopped restarting it.`,
        howToFix: dockerdOomRemedy(),
        actions: [],
      } : maintainer(
        'The container runtime keeps stopping, so lazy stopped restarting it.',
        `${unusable} ${oomDeath ? dockerdOomSentence(oomDeath) : 'The restart history says how each one ended.'} ${restartOrder}`,
      ),
    };
  }
  const state: ServiceState = proc === 'alive' || proc === 'unknown' ? 'unresponsive' : 'stopped';
  let detail = probe.detail;
  if (state === 'unresponsive' && guest) {
    const since = await readEpoch(deps.paths.dockerdUnresponsiveSince);
    if (since !== null) {
      const secs = Math.max(0, Math.floor(Date.now() / 1000) - since);
      detail = `Running but not answering for ${formatUptime(secs)} (since ${new Date(since * 1000).toISOString()}); lazy restarts it if it stays that way. ${probe.detail}`;
    }
  }
  if (restarted) detail = `${detail}${restarted}`;
  if (oomDeath) detail = `${detail}${oomNote}`;
  return {
    ...base, state, detail,
    pid, restart: guest ? 'guest' : 'none',
    escalation: maintainer(
      state === 'unresponsive' ? 'The container runtime is running but not answering.' : 'The container runtime is not running.',
      `${unusable} ${restartOrder}`,
    ),
    rootDir: null,
  };
}

async function forwarderService(deps: Required<MachineDeps>, kind: MachineView['kind'], lines: number): Promise<ServiceView> {
  if (kind !== 'microvm') {
    return {
      name: 'forwarder', label: 'Port forwarder', state: 'not_applicable', detail: 'Only a Lazy Teams microVM has one.',
      pid: null, restart: 'none', log: { available: false, source: null, lines: [], truncated: false }, history: null, recentRestarts: null, escalation: null,
    };
  }
  const pid = await readPid(deps.paths.forwarderPid);
  const log = await tailLog(deps.paths.forwarderLog, lines);
  const proc = await serviceProcess(pid, SERVICE_PROGRAMS.forwarder);
  const state: ServiceState = pid === null ? 'not_started' : proc === 'alive' || proc === 'unknown' ? 'running' : 'stopped';
  return {
    name: 'forwarder', label: 'Port forwarder', state, detail: state === 'running' ? null : 'It carries the daemon\'s port to the machine\'s relay.',
    pid, restart: 'guest', log, history: null, recentRestarts: null,
    escalation: state === 'running' ? null : maintainer(
      'The port forwarder is not running.',
      'Lazy Teams reaches this project\'s daemon through it; restarting it is a machine operation for your god-mode maintainer.',
    ),
  };
}

async function daemonAndProxy(deps: Required<MachineDeps>, projectRoot: string, lines: number): Promise<ServiceView[]> {
  const logPath = getLogPath(projectRoot);
  const daemonLog = await tailLog(logPath, lines);
  const proxyLog = await tailLog(logPath, lines, (l) => l.includes('[proxy]') || /\bProxy: /.test(l));
  const uptime = Math.round(process.uptime());
  const daemon: ServiceView = {
    name: 'daemon', label: 'Project daemon', state: 'running',
    detail: `lazy ${VERSION}, up ${formatUptime(uptime)}`,
    pid: process.pid, restart: 'fleet', log: { ...daemonLog, source: daemonLog.source ? 'the project daemon\'s log' : null }, history: null, recentRestarts: null, escalation: null,
  };
  const live = await deps.proxy();
  let proxyState: ServiceState = 'stopped';
  let proxyDetail: string | null = 'The task proxy is not running; agents cannot reach their model.';
  if (live) {
    proxyState = live.probe.ok ? 'running' : 'unresponsive';
    proxyDetail = live.probe.ok ? `listening on port ${live.port}` : `its health check failed: ${live.probe.error}`;
  }
  const proxy: ServiceView = {
    name: 'proxy', label: 'Task proxy', state: proxyState, detail: proxyDetail,
    pid: process.pid, restart: 'fleet', log: { ...proxyLog, source: proxyLog.source ? 'the project daemon\'s log, [proxy] lines' : null }, history: null, recentRestarts: null,
    escalation: proxyState === 'running' ? null : maintainer(
      'The task proxy is not answering.',
      'Every agent\'s model traffic goes through it. It runs inside the project daemon, so the fix is restarting the daemon — a god-mode operation.',
    ),
  };
  return [daemon, proxy];
}

function formatUptime(seconds: number): string {
  if (seconds < 120) return `${seconds}s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

async function availableMemory(): Promise<number> {
  try {
    const meminfo = await readFile('/proc/meminfo', 'utf-8');
    const m = /^MemAvailable:\s+(\d+) kB/m.exec(meminfo);
    if (m) return Number(m[1]) * 1024;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logger.debug(`machine state: /proc/meminfo unreadable: ${(err as Error).message}`);
  }
  return freemem();
}

async function disk(label: string, path: string): Promise<(ResourceView['disks'][number] & { dev: number }) | null> {
  try {
    const dev = (await stat(path)).dev;
    const s = await statfs(path);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    if (total <= 0) return null;
    return { label, path, dev, totalBytes: total, freeBytes: free, usedPercent: Math.round(((total - free) / total) * 1000) / 10 };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`could not read disk usage of ${path}: ${(err as Error).message}`);
  }
}

async function resources(projectRoot: string, dockerRoot: string | null, kind: MachineView['kind'], paths: typeof GUEST_PATHS): Promise<ResourceView> {
  const cores = cpus().length || 1;
  const [l1, l5, l15] = loadavg();
  const total = totalmem();
  const available = await availableMemory();
  const disks: ResourceView['disks'] = [];
  const seen = new Set<number>();
  const candidates: Array<[string, string]> = [];
  if (dockerRoot) candidates.push(['Container images and data', dockerRoot]);
  else if (kind === 'microvm') candidates.push(['Machine storage', paths.storageRoot]);
  candidates.push(['Project checkout', projectRoot]);
  for (const [label, path] of candidates) {
    const found = await disk(label, path);
    // Two paths on one filesystem are one disk: report it once, under the first name.
    if (!found || seen.has(found.dev)) continue;
    seen.add(found.dev);
    const { dev: _dev, ...view } = found;
    disks.push(view);
  }
  const usedPercent = total > 0 ? Math.round(((total - available) / total) * 1000) / 10 : 0;
  const warnings: ResourceView['warnings'] = [];
  for (const d of disks) {
    if (d.usedPercent >= DISK_WARN_PERCENT) {
      warnings.push({
        resource: 'disk',
        message: `${d.label} is ${d.usedPercent}% full.`,
        escalation: maintainer(`${d.label} is nearly full.`, 'Builds and tasks fail when the disk fills; resizing the machine or pruning its images is a god-mode operation.'),
      });
    }
  }
  if (usedPercent >= MEMORY_WARN_PERCENT) {
    warnings.push({
      resource: 'memory',
      message: `Memory is ${usedPercent}% used.`,
      escalation: maintainer('The machine is nearly out of memory.', 'Resizing the machine is a god-mode operation; stopping tasks you do not need frees memory meanwhile.'),
    });
  }
  const loadPerCore = Math.round((l1 / cores) * 100) / 100;
  if (loadPerCore >= LOAD_WARN_PER_CORE) {
    warnings.push({
      resource: 'cpu',
      message: `The CPU is overloaded (load ${l1.toFixed(1)} on ${cores} core${cores === 1 ? '' : 's'}).`,
      escalation: maintainer('The machine\'s CPU is overloaded.', 'Everything runs slower until the load drops; a bigger machine is a god-mode operation.'),
    });
  }
  return {
    cpu: { cores, load1: l1, load5: l5, load15: l15, loadPerCore },
    memory: { totalBytes: total, availableBytes: available, usedPercent },
    disks,
    warnings,
  };
}

/**
 * Where `lazy-guest-init` is installed, looked up once: the PATH lookup is a
 * synchronous filesystem walk, and the answer cannot change under a running
 * daemon (it is part of the machine's image).
 */
let guestInitLookup: { path: string | null } | null = null;
function guestInitPath(): string | null {
  guestInitLookup ??= { path: Bun.which('lazy-guest-init') };
  return guestInitLookup.path;
}

function resolvedDeps(deps: MachineDeps, projectRoot: string): Required<MachineDeps> {
  return {
    paths: deps.paths ?? GUEST_PATHS,
    guestInit: deps.guestInit ?? guestInitPath,
    // From the configured runner type, not by constructing a runner: an
    // observation must not depend on (or have the side effects of) a launch's
    // preconditions, such as a running proxy.
    dockerBinary: deps.dockerBinary ?? (async () => {
      const type = (await loadConfig(projectRoot)).runner.type;
      return type === 'docker' || type === 'podman' ? type : null;
    }),
    // The SAME probe `lazy daemon health` runs, against the handle the daemon
    // registered when its proxy bound — so a non-loopback `[proxy] bind` is
    // reached where it listens. No handle (an in-process CLI): no proxy.
    proxy: deps.proxy ?? (async () => {
      const handle = daemonHealthRecorder(projectRoot).snapshot().proxy;
      if (!handle?.port) return null;
      const { probeProxy } = await import('./daemon-health');
      return { port: handle.port, probe: await probeProxy(handle) };
    }),
  };
}

/** The machine's state — what the `machineState` RPC answers (before redaction). */
export async function observeMachine(projectRoot: string, opts: { lines?: number } = {}, deps: MachineDeps = {}): Promise<MachineView> {
  const d = resolvedDeps(deps, projectRoot);
  const lines = Math.min(MAX_LOG_LINES, Math.max(0, Math.floor(opts.lines ?? DEFAULT_LOG_LINES)));
  const kind = machineKind();
  const [docker, forwarder, rest] = await Promise.all([
    dockerService(d, kind, lines),
    forwarderService(d, kind, lines),
    daemonAndProxy(d, projectRoot, lines),
  ]);
  const { rootDir, ...dockerView } = docker;
  // A local-docker project shares its host with every other tenant: the
  // host's name, load, memory and disks describe all of them, so none of it is
  // reported to a reader of THIS project.
  const shared = kind === 'local-docker';
  return {
    kind,
    hostname: shared ? '' : hostname(),
    observedAt: new Date().toISOString(),
    services: [dockerView, forwarder, ...rest],
    resources: shared ? null : await resources(projectRoot, rootDir, kind, d.paths),
    resourcesWithheld: shared ? LOCAL_DOCKER_RESOURCES_WITHHELD : null,
    restart: lastRestart,
    storageReset: lastStorageReset,
    integrity: kind === 'microvm' ? machineIntegrityView() : null,
  };
}

// ---------------------------------------------------------------------------
// Restarting a guest service — god mode only (the RPC refuses member tokens).
// ---------------------------------------------------------------------------

let lastRestart: RestartView | null = null;

export class MachineRestartError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** How long a stopped service gets to exit before the restart gives up. */
const STOP_WAIT_MS = { dockerd: 60_000, forwarder: 10_000 } as const;
const GUEST_INIT_TIMEOUT_MS = 180_000;

/** Gone, or a zombie nobody has reaped yet (the guest has no init system to do it). */
async function waitForExit(pid: number, program: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await serviceProcess(pid, program)) === 'dead') return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return (await serviceProcess(pid, program)) === 'dead';
}

/**
 * Restart `service` on this machine. Only the guest services lazy-guest-init
 * manages can be restarted here: the service is stopped (SIGTERM, waiting for
 * it to exit) and `lazy-guest-init --force` brings the guest back to its
 * prepared state, which starts whatever is missing. Restarting dockerd stops
 * every running task container and builder with it.
 *
 * A dockerd restart is a REQUESTED restart, never a crash: before stopping it
 * this writes the guest's restart request (an epoch, `dockerdRestartRequested`),
 * which lazy-guest-init honours by logging "restart requested from god mode"
 * in the restart history — no death record, no entry against its crash budget
 * — and the daemon's own dockerd recovery is held off until it is done
 * (`runRequestedDockerdRestart`), so the watchdog cannot race it.
 *
 * Returns as soon as the restart has STARTED; `machineState.restart` reports
 * how it went. The daemon and the proxy inside it are restarted by the fleet,
 * never by themselves (409).
 */
export function restartMachineService(service: string, deps: MachineDeps = {}, projectRoot = ''): RestartView {
  if (!(MACHINE_SERVICES as readonly string[]).includes(service)) {
    throw new MachineRestartError(400, `Unknown service "${service}". Services: ${MACHINE_SERVICES.join(', ')}.`);
  }
  if (service === 'daemon' || service === 'proxy') {
    throw new MachineRestartError(409,
      `The ${service === 'daemon' ? 'project daemon' : 'task proxy (which runs inside the project daemon)'} is restarted by the fleet, not by itself: use the machine's daemon restart in god mode.`);
  }
  // Gated on the declared backend first: the script being installed is only
  // how it is FOUND, never what makes a restart allowed.
  if (machineKind() !== 'microvm') {
    throw new MachineRestartError(409, `This machine is not a Lazy Teams microVM, so lazy does not manage its ${service}.`);
  }
  const d = resolvedDeps(deps, projectRoot);
  const guestInit = d.guestInit();
  if (!guestInit) {
    throw new MachineRestartError(409, `lazy-guest-init is not installed on this machine, so its ${service} cannot be restarted from here.`);
  }
  if (lastStorageReset?.state === 'running') {
    throw new MachineRestartError(409, 'A reset of Docker storage is running; wait for it to finish.');
  }
  if (lastRestart?.state === 'running') {
    throw new MachineRestartError(409, `A restart of ${lastRestart.service} is already running.`);
  }
  const name = service as 'dockerd' | 'forwarder';
  const view: RestartView = { service: name, state: 'running', startedAt: new Date().toISOString(), finishedAt: null, output: null };
  lastRestart = view;
  logger.info(`Machine: restarting ${name} (requested from god mode)`);
  const restart = async () => {
    const pid = await readPid(name === 'dockerd' ? d.paths.dockerdPid : d.paths.forwarderPid);
    // Only the service itself is ever signalled: a stale pid file's pid may
    // belong to anything by now, the daemon included.
    if (pid && (await serviceProcess(pid, SERVICE_PROGRAMS[name])) === 'alive') {
      process.kill(pid, 'SIGTERM');
      if (!(await waitForExit(pid, SERVICE_PROGRAMS[name], STOP_WAIT_MS[name]))) {
        throw new Error(`${name} (pid ${pid}) did not stop within ${STOP_WAIT_MS[name] / 1000}s after SIGTERM`);
      }
    }
    const proc = spawn([guestInit, '--force'], { stdout: 'pipe', stderr: 'pipe', timeout: GUEST_INIT_TIMEOUT_MS });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const output = [out.trim(), err.trim()].filter(Boolean).join('\n');
    if (code !== 0) throw new Error(`lazy-guest-init --force exited ${code === null ? 'on its timeout' : code}${output ? `:\n${output}` : ''}`);
    return output;
  };
  const requested = d.paths.dockerdRestartRequested;
  const dockerdRestart = () => runRequestedDockerdRestart(async () => {
    // Written BEFORE the stop, so whichever lazy-guest-init run finds dockerd
    // gone (ours, or a `lazy` invocation's) records it as requested.
    await writeFile(requested, `${Math.floor(Date.now() / 1000)}\n`);
    try {
      return await restart();
    } finally {
      // lazy-guest-init consumes it when it starts dockerd; a restart that
      // failed before that must not leave it to excuse a later real crash.
      await rm(requested, { force: true });
    }
  });
  void (async () => {
    try {
      const output = name === 'dockerd' ? await dockerdRestart() : await restart();
      Object.assign(view, { state: 'succeeded', finishedAt: new Date().toISOString(), output });
      logger.info(`Machine: ${name} restarted`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Object.assign(view, { state: 'failed', finishedAt: new Date().toISOString(), output: message });
      logger.warn(`Machine: restarting ${name} FAILED: ${message}`);
    }
  })();
  return view;
}

/** Tests only. */
export function resetMachineRestartForTests(): void {
  lastRestart = null;
}

// ---------------------------------------------------------------------------
// Resetting the machine's Docker storage — an admin's action, narrated.
// ---------------------------------------------------------------------------

let lastStorageReset: StorageResetView | null = null;

const RESET_REASON_WORDS: Record<string, string> = {
  'reset-stop-failed': 'dockerd would not stop, so the storage was not touched',
  'reset-unmount-failed': 'some mounts under the Docker storage would not unmount, so nothing was removed',
  'reset-remove-failed': 'some files in the Docker storage could not be removed',
  'reset-refused-data-root': 'the Docker storage directory is not where lazy expects it, so nothing was touched',
  'docker-storage-reset-running': 'a reset is already running on this machine',
  'dockerd-timeout': 'dockerd did not come back up',
};

/**
 * Reset this machine's Docker storage: stop dockerd and containerd, unmount
 * everything under the data root (deepest first), remove it without crossing a
 * mount point, and start dockerd again. `lazy-guest-init --reset-storage` does
 * the guest side (and refuses an unsafe data root); this holds the daemon's own
 * dockerd recovery off for the duration, and keeps the narration the guest
 * prints, line by line, for `machineState.storageReset`.
 *
 * DESTRUCTIVE — every image, container, volume and build cache on the machine —
 * so it needs `confirm === true` (the CLI and Teams ask a person first), and the
 * RPC refuses member tokens. Builds afterwards are cold, and the narration says so.
 * Returns as soon as it has STARTED; one at a time (409), and not beside a restart.
 */
export function resetMachineDockerStorage(confirm: unknown, deps: MachineDeps = {}, projectRoot = ''): StorageResetView {
  if (confirm !== true) {
    throw new MachineRestartError(400, 'Resetting Docker storage deletes every image, container, volume and build cache on this machine. Pass confirm: true to go ahead.');
  }
  if (machineKind() !== 'microvm') {
    throw new MachineRestartError(409, 'This machine is not a Lazy Teams microVM, so lazy does not manage its Docker storage.');
  }
  const d = resolvedDeps(deps, projectRoot);
  const guestInit = d.guestInit();
  if (!guestInit) {
    throw new MachineRestartError(409, 'lazy-guest-init is not installed on this machine, so its Docker storage cannot be reset from here.');
  }
  if (lastStorageReset?.state === 'running') {
    throw new MachineRestartError(409, 'A reset of Docker storage is already running.');
  }
  if (lastRestart?.state === 'running') {
    throw new MachineRestartError(409, `A restart of ${lastRestart.service} is running; wait for it to finish.`);
  }
  const view: StorageResetView = { state: 'running', startedAt: new Date().toISOString(), finishedAt: null, steps: [], freedKb: null, failure: null };
  lastStorageReset = view;
  const say = (text: string) => { view.steps.push(text); logger.info(`Machine: Docker storage reset: ${text}`); };
  void (async () => {
    try {
      await runRequestedDockerdRestart(async () => {
        say('Holding off the daemon\'s automatic dockerd recovery for the reset');
        const proc = spawn([guestInit, '--reset-storage'], { stdout: 'pipe', stderr: 'pipe', timeout: STORAGE_RESET_TIMEOUT_MS });
        const kv: Record<string, string> = {};
        const stderrText = new Response(proc.stderr).text();
        const reader = proc.stdout.getReader();
        const decoder = new TextDecoder();
        let pending = '';
        const line = (l: string) => {
          const eq = l.indexOf('=');
          if (eq <= 0) return;
          const key = l.slice(0, eq).trim();
          const value = l.slice(eq + 1).trim();
          if (key === 'reset_step') say(value); else kv[key] = value;
        };
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          const parts = pending.split('\n');
          pending = parts.pop() ?? '';
          parts.forEach(line);
        }
        if (pending) line(pending);
        const [code, err] = await Promise.all([proc.exited, stderrText]);
        if (/^\d{1,12}$/.test(kv.reset_freed_kb ?? '')) view.freedKb = Number(kv.reset_freed_kb);
        const reason = kv.reset_reason ?? kv.reason;
        if (code !== 0 || kv.reset_result === 'failed' || kv.ready !== 'yes') {
          // Only claim what the narration backs: dockerd was stopped once the guest got past its refusals.
          const stopped = view.steps.some((s) => /^Stopping dockerd/.test(s));
          const restarted = view.steps.some((s) => /^Starting dockerd/.test(s));
          const dockerState = !stopped ? '; Docker was not touched' : kv.ready === 'yes' ? '; dockerd is running again' : restarted ? '; dockerd is NOT running' : '; dockerd may not be running';
          const words = reason ? (RESET_REASON_WORDS[reason] ?? reason) : `lazy-guest-init exited ${code === null ? 'on its timeout' : code}`;
          throw new Error(`${words}${dockerState}${err.trim() ? `\n${err.trim()}` : ''}`);
        }
        say('Docker is running again on an empty store. Builds and task starts are cold now: images are pulled and layers rebuilt, so the next ones take longer.');
      });
      Object.assign(view, { state: 'succeeded', finishedAt: new Date().toISOString() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      say(`The reset did not complete: ${message}`);
      Object.assign(view, { state: 'failed', finishedAt: new Date().toISOString(), failure: message });
      logger.warn(`Machine: Docker storage reset FAILED: ${message}`);
    }
  })();
  return view;
}

/** A reset of Docker storage that guest init may take a while over: unmounting and deleting a big store. */
const STORAGE_RESET_TIMEOUT_MS = 30 * 60_000;

/** Tests only. */
export function resetStorageResetForTests(): void {
  lastStorageReset = null;
}
