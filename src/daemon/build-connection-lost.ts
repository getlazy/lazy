/**
 * A container build whose docker client lost its connection to BuildKit —
 * `failed to receive status: rpc error: code = Unavailable desc = error reading
 * from server: EOF` — on a Lazy Teams microVM.
 *
 * Inside the machine the docker client talks to the guest's own dockerd over
 * its local unix socket (`lazy-guest-init` starts it with
 * `--host unix:///var/run/docker.sock`); no relay, proxy or timeout sits in
 * between. So that EOF means dockerd's end of the stream went away: dockerd
 * died or restarted (most often the kernel's OOM killer on a small machine),
 * or BuildKit inside it dropped the session. BuildKit's own line names none of
 * that, and the engineer reading it sees "a Docker problem".
 *
 * What this module does, given the failed output:
 *  - recognises the signature ({@link isBuildConnectionLost});
 *  - asks the guest supervisor to bring dockerd back if it is down
 *    (`recoverGuestDockerd`, which also records how it died), waiting a bounded
 *    time for a dockerd that is alive but slow to answer;
 *  - reads what the machine RECORDED since the build started — dockerd deaths
 *    and requested restarts in its restart history, kernel OOM kills — and
 *    names a cause only from that evidence ({@link explainLostBuildConnection}).
 *
 * The retry itself (exactly one) is the build runner's, in src/capture/claude.ts.
 */
import { readFile } from 'fs/promises';
import { spawn } from '../utils/spawn';
import {
  DOCKERD_HISTORY_LOG,
  describeDockerdDeath,
  describeDockerdOom,
  dockerdOomRemedy,
  managedDockerDownMessage,
  recoverGuestDockerd,
  type GuestDockerdReport,
} from './guest-dockerd';

/**
 * BuildKit/gRPC wording for "the stream to the builder ended under us".
 * Matched ONLY on the docker client's own error lines — a line that starts
 * (after an optional `ERROR:` / `error:`) with the wording. A Dockerfile
 * step's output is printed under its `#N` progress prefix, so a step that
 * happens to echo "error reading from server: EOF" (a failing curl, a test
 * log) is the step's failure, never a lost connection — reading it as one sent
 * the human to the machine's Docker for a bug in their Dockerfile.
 */
const CONNECTION_LOST_PATTERNS = [
  /^(?:error: |ERROR: )?(?:failed to (?:build|solve): )?failed to receive status: rpc error: code = Unavailable/i,
  /^(?:error: |ERROR: )?(?:failed to (?:build|solve): )?rpc error: code = Unavailable desc = (error reading from server: EOF|connection error|transport is closing)/i,
];

export function isBuildConnectionLost(output: string): boolean {
  return output.split('\n').some((line) => CONNECTION_LOST_PATTERNS.some((re) => re.test(line.trim())));
}

/** The first words of every diagnosis — also what marks a failure as the machine's (image-state.ts). */
export const LOST_CONNECTION_HEADLINE = "The build lost its connection to Docker in the project's machine";

/** One entry of the restart history that bears on a build. */
export type HistoryEvent =
  | { kind: 'death'; at: Date; cause: string; oomUsedKb?: number; oomMachineKb?: number }
  | { kind: 'requested'; at: Date };

const DEATH_LINE = /^=== (\S+) dockerd \(pid [^)]*\) stopped answering \(cause=([a-z0-9+-]+)/;
const MEMORY_LINE = /^--- dockerd memory at the kill: used (\d+) kB of the machine's (\d+) kB/;
const REQUESTED_LINE = /^=== (\S+) restarting dockerd: restart requested from god mode/;

export function parseDockerdHistory(history: string): HistoryEvent[] {
  const out: HistoryEvent[] = [];
  for (const line of history.split('\n')) {
    let m = DEATH_LINE.exec(line);
    if (m) {
      const at = new Date(m[1]);
      if (!Number.isNaN(at.getTime())) out.push({ kind: 'death', at, cause: m[2] });
      continue;
    }
    m = MEMORY_LINE.exec(line);
    if (m) {
      const last = out.at(-1);
      if (last?.kind === 'death') { last.oomUsedKb = Number(m[1]); last.oomMachineKb = Number(m[2]); }
      continue;
    }
    m = REQUESTED_LINE.exec(line);
    if (m) {
      const at = new Date(m[1]);
      if (!Number.isNaN(at.getTime())) out.push({ kind: 'requested', at });
    }
  }
  return out;
}

/**
 * Names of processes the kernel's OOM killer killed at or after `sinceBootSeconds`
 * (dmesg's default clock: seconds since boot).
 */
export function parseOomKills(kernelLog: string, sinceBootSeconds: number): string[] {
  const names: string[] = [];
  for (const line of kernelLog.split('\n')) {
    const m = /^\[\s*(\d+(?:\.\d+)?)\].*[Kk]illed process \d+ \(([^)]+)\)/.exec(line);
    if (m && Number(m[1]) >= sinceBootSeconds) names.push(m[2]);
  }
  return names;
}

export interface MemorySnapshot {
  totalMiB: number;
  availableMiB: number;
}

export function parseMeminfo(text: string): MemorySnapshot | null {
  const kib = (key: string) => {
    const m = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text);
    return m ? Number(m[1]) : null;
  };
  const total = kib('MemTotal');
  const available = kib('MemAvailable');
  if (total === null || available === null) return null;
  return { totalMiB: Math.round(total / 1024), availableMiB: Math.round(available / 1024) };
}

export interface LostConnectionFacts {
  /** The guest supervisor's report after recovery (and any wait for a slow dockerd). */
  report: GuestDockerdReport;
  /** dockerd answered `docker info` at the end of the check. */
  answers: boolean;
  /** Restart-history events since the build started. */
  events: HistoryEvent[];
  /** Processes the OOM killer killed since the build started; null when the kernel log could not be read. */
  oomKills: string[] | null;
  memory: MemorySnapshot | null;
}

export interface LostConnectionDiagnosis {
  /** dockerd answers again: one retry may run. */
  retryable: boolean;
  /** One line naming the likely cause — the first line of the final error. */
  headline: string;
  /** Plain words for the human: what happened, from what the machine recorded. */
  explanation: string;
}

export function explainLostBuildConnection(facts: LostConnectionFacts): LostConnectionDiagnosis {
  const { report, answers, events, oomKills, memory } = facts;
  const mem = memory ? ` The machine has ${memory.totalMiB} MiB of memory.` : '';
  const kills = oomKills && oomKills.length > 0
    ? ` The kernel's out-of-memory killer killed ${[...new Set(oomKills)].join(', ')} during the build; a larger machine size may help.`
    : '';
  const deaths = events.filter((e): e is Extract<HistoryEvent, { kind: 'death' }> => e.kind === 'death');
  const requested = events.find((e) => e.kind === 'requested');
  const death = deaths.at(-1) ?? (report.died ? { at: null as Date | null, cause: report.died } : undefined);

  let cause: string;
  let headline: string;
  if (death) {
    const when = death.at ? ` at ${death.at.toISOString()}` : '';
    const oom = death.cause.endsWith('+oom-killer');
    const oomUsed = ('oomUsedKb' in death ? death.oomUsedKb : undefined) ?? report.oomUsedKb;
    const oomMachine = ('oomMachineKb' in death ? death.oomMachineKb : undefined) ?? report.oomMachineKb;
    headline = `${LOST_CONNECTION_HEADLINE}: Docker stopped${when}${oom ? ' (out of memory)' : ''}.`;
    cause =
      `Docker stopped${when} while the build ran: ${oom ? `${describeDockerdOom(oomUsed, oomMachine)}. ${dockerdOomRemedy()}${oomUsed === undefined ? mem : ''}` : `${describeDockerdDeath(death.cause)}.${kills}${mem}`}` +
      ` Details: ${DOCKERD_HISTORY_LOG}.`;
  } else if (requested) {
    headline = `${LOST_CONNECTION_HEADLINE}: Docker was restarted from god mode during the build.`;
    cause = `Docker was restarted from god mode at ${requested.at.toISOString()}, while the build ran.`;
  } else if (oomKills && oomKills.length > 0) {
    headline = `${LOST_CONNECTION_HEADLINE}: the machine ran out of memory.`;
    cause = `Docker itself kept running.${kills}${mem}`;
  } else {
    headline = `${LOST_CONNECTION_HEADLINE}.`;
    cause =
      'Docker itself kept running and the machine recorded no out-of-memory kill' +
      (oomKills === null ? ' (lazy could not read the kernel log to check)' : '') +
      ', so BuildKit dropped the build session or the connection was reset. The cause was not recorded.' + mem;
  }

  if (answers) return { retryable: true, headline, explanation: cause };
  const down = report.reason === 'dockerd-not-answering'
    ? "Docker is running in the project's machine but stopped answering, and did not answer again within the wait. This needs the Lazy Teams maintainer: report it to support."
    : managedDockerDownMessage(report);
  return { retryable: false, headline, explanation: `${cause}\n\n${down}` };
}

export interface DiagnoseDeps {
  recover: (trigger: string) => Promise<GuestDockerdReport>;
  dockerAnswers: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  readHistory: () => Promise<string>;
  readMeminfo: () => Promise<string>;
  /** Seconds since boot, now (`/proc/uptime`). */
  readUptimeSeconds: () => Promise<number | null>;
  /** The kernel log, or null when it cannot be read. */
  readKernelLog: () => Promise<string | null>;
  now: () => number;
}

async function readOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    // A machine that never restarted dockerd has no history file: no events.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw new Error(`could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const realDeps: DiagnoseDeps = {
  recover: recoverGuestDockerd,
  dockerAnswers: async () =>
    (await spawn(['docker', 'info'], { stdout: 'ignore', stderr: 'ignore', timeout: 15_000 }).exited) === 0,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  readHistory: () => readOrEmpty(DOCKERD_HISTORY_LOG),
  readMeminfo: () => readOrEmpty('/proc/meminfo'),
  readUptimeSeconds: async () => {
    const first = Number((await readOrEmpty('/proc/uptime')).split(/\s+/)[0]);
    return Number.isFinite(first) && first > 0 ? first : null;
  },
  readKernelLog: async () => {
    const proc = spawn(['dmesg'], { stdout: 'pipe', stderr: 'ignore', timeout: 15_000 });
    const [code, text] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    return code === 0 ? text : null;
  },
  now: () => Date.now(),
};

/** How long to wait for a dockerd that is alive but not answering (or mid-requested-restart). */
export const SLOW_DOCKERD_WAIT_MS = 120_000;
const SLOW_DOCKERD_POLL_MS = 5_000;

/**
 * After a lost connection: bring dockerd back if needed (waiting a bounded time
 * for a slow one), gather what the machine recorded since `buildStartedAt`, and
 * explain it.
 */
export async function diagnoseLostBuildConnection(
  buildStartedAt: Date,
  deps: DiagnoseDeps = realDeps,
  signal?: AbortSignal,
): Promise<LostConnectionDiagnosis> {
  let report = await deps.recover('a build that lost its connection to Docker');
  let answers = report.ready;
  if (!answers && (report.reason === 'dockerd-not-answering' || report.reason === 'dockerd-restart-requested')) {
    const deadline = deps.now() + SLOW_DOCKERD_WAIT_MS;
    while (!answers && deps.now() < deadline && !signal?.aborted) {
      await deps.sleep(SLOW_DOCKERD_POLL_MS);
      answers = await deps.dockerAnswers();
    }
    // Still silent past the wait: one more recovery, which treats it as hung
    // once the guest's own threshold has passed.
    if (!answers && !signal?.aborted) {
      report = await deps.recover('a build that lost its connection to Docker');
      answers = report.ready;
    }
  }
  const [history, meminfo, uptime, kernel] = await Promise.all([
    deps.readHistory(), deps.readMeminfo(), deps.readUptimeSeconds(), deps.readKernelLog(),
  ]);
  // History timestamps have whole-second precision.
  const since = buildStartedAt.getTime() - 1000;
  const events = parseDockerdHistory(history).filter((e) => e.at.getTime() >= since);
  let oomKills: string[] | null = null;
  if (kernel !== null && uptime !== null) {
    const sinceBoot = uptime - (deps.now() - buildStartedAt.getTime()) / 1000 - 1;
    oomKills = parseOomKills(kernel, sinceBoot);
  }
  return explainLostBuildConnection({ report, answers, events, oomKills, memory: parseMeminfo(meminfo) });
}

/**
 * Whether a failure text is lazy's diagnosis of a build lost to dockerd running
 * out of memory, with the figures when the diagnosis carried them. The ONE
 * reader of the wording `explainLostBuildConnection` writes above.
 */
export function lostBuildOomFacts(text: string): { sentence: string } | null {
  const headlineOom = text.split('\n').some((l) => l.includes(LOST_CONNECTION_HEADLINE) && l.includes('(out of memory)'));
  const figures = /dockerd ran out of memory(?: \(used [^)]*of the machine's [^)]*\))?/.exec(text);
  if (!headlineOom && !figures) return null;
  return { sentence: figures ? figures[0] : 'dockerd ran out of memory' };
}
