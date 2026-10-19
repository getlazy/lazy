/**
 * Bring a Lazy Teams microVM's dockerd back when it dies, and say so.
 *
 * The guest has no init system; `lazy-guest-init --ensure` (shipped in the
 * daemon image) is what starts dockerd, and since it learned to supervise it,
 * what RESTARTS it — recording why it died (exit status, the dockerd log's tail,
 * kernel OOM lines) in `/var/log/lazy-dockerd-restarts.log` first. Every `lazy`
 * invocation in the guest runs it, but a long-running daemon is not an
 * invocation: a dockerd killed during a build stayed dead with nothing calling
 * `--ensure` again, and every later build and launch failed with "Docker is not
 * installed". So the daemon calls it too, from two places:
 *
 *  - a WATCHDOG timer, so the machine heals between builds; and
 *  - {@link recoverGuestDockerd} from `checkDocker`, so a build or launch that
 *    hits a dead dockerd gets one recovery attempt before it fails.
 *
 * Only on the managed microVM backend, where the dockerd is the project's own
 * and the script is on PATH. Everywhere else the module does nothing.
 *
 * What happened is logged (the daemon log, which god mode reads) and filed as a
 * system message through the reporter the daemon registers, so a project admin
 * sees it in Teams without anyone opening a shell.
 */

import { isManagedMode, MANAGED_BACKEND_ENV } from '../config/managed-mode';
import { logger } from '../utils/logger';
import { spawn } from '../utils/spawn';
import { redactSecretValues } from '../utils/redact';
import type { SystemMessage, SystemMessageInput } from '../types';

export const GUEST_INIT_BINARY = 'lazy-guest-init';
export const DOCKERD_HISTORY_LOG = '/var/log/lazy-dockerd-restarts.log';

/** The parsed `key=value` report of one `lazy-guest-init --ensure`. */
export interface GuestDockerdReport {
  ready: boolean;
  /**
   * marker | running-dockerd | started-dockerd | restarted-dockerd (after a crash;
   * files a notice) | requested-restart (god mode asked for it; files nothing)
   */
  source?: string;
  /** Why it failed (`dockerd-crash-loop`, `dockerd-timeout`, …). */
  reason?: string;
  /** How the previous dockerd ended, e.g. `exited-137+oom-killer`. */
  died?: string;
  /** dockerd's anonymous memory (kB) at an OOM kill, and the machine's total (kB). */
  oomUsedKb?: number;
  oomMachineKb?: number;
  restarts?: number;
  /** Init's own stderr, for the log. */
  detail: string;
}

export type GuestDockerdEvent =
  | { kind: 'restarted'; report: GuestDockerdReport; trigger: string }
  | { kind: 'failed'; report: GuestDockerdReport; trigger: string };

type Reporter = (event: GuestDockerdEvent) => Promise<void> | void;
let reporter: Reporter | null = null;

/** The daemon registers where events go (system messages). */
export function setGuestDockerdReporter(fn: Reporter | null): void {
  reporter = fn;
}

/** True where this daemon runs on its own microVM dockerd it may supervise. */
export function guestDockerdSupervised(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isManagedMode(env) || env[MANAGED_BACKEND_ENV] !== 'microvm') return false;
  return Bun.which(GUEST_INIT_BINARY, { PATH: env.PATH ?? '' }) !== null;
}

export function parseGuestInitReport(stdout: string, stderr: string): GuestDockerdReport {
  const kv: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) kv[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return {
    ready: kv.ready === 'yes',
    source: kv.source,
    // These land in published system messages: keep only the closed vocabulary
    // the guest script emits, never free text from the machine.
    died: token(kv.dockerd_died),
    reason: token(kv.reason),
    oomUsedKb: kbValue(kv.dockerd_oom_used_kb),
    oomMachineKb: kbValue(kv.dockerd_oom_machine_kb),
    restarts: kv.dockerd_restarts !== undefined && /^\d+$/.test(kv.dockerd_restarts) ? Number(kv.dockerd_restarts) : undefined,
    // Init's stderr can quote the dockerd log; it goes to the daemon log only,
    // and through the registered-secret scrubber first.
    detail: redactSecretValues(stderr.trim()),
  };
}

function kbValue(value: string | undefined): number | undefined {
  return value !== undefined && /^\d{1,12}$/.test(value) ? Number(value) : undefined;
}

function token(value: string | undefined): string | undefined {
  return value !== undefined && /^[a-z0-9+-]{1,64}$/.test(value) ? value : undefined;
}

/** Plain words for how dockerd ended. OOM is named only when the guest matched the kill to this dockerd instance. */
export function describeDockerdDeath(died: string): string {
  const oom = died.endsWith('+oom-killer');
  const base = oom ? died.slice(0, -'+oom-killer'.length) : died;
  const how = base === 'not-answering' ? 'it was running but stopped answering'
    : base === 'gone' ? 'its process was gone (how it exited was not recorded)'
    : base.startsWith('exited-') ? `it exited with status ${base.slice('exited-'.length)}`
    : base;
  return oom ? `${how}; the kernel's out-of-memory killer killed it` : how;
}

/** Memory in the units a person reads: GiB from 1 GiB up, else MiB. */
export function formatKb(kb: number): string {
  const mib = kb / 1024;
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)} GiB` : `${Math.round(mib)} MiB`;
}

/** The remedy for a dockerd the kernel killed for memory. The ONE place its wording lives, so another option (e.g. resetting Docker storage) is added here. */
export function dockerdOomRemedy(): string {
  return 'Give this project\'s machine more memory (the machine size, set by your god-mode admin), then run the build again. If the Docker storage itself has grown too large, a project admin can reset it from the Machine page (or `lazy system machine reset-docker-storage`); builds are cold afterwards.';
}

/** "dockerd ran out of memory (used X of the machine's Y)", or without the figures when the guest did not record them. */
export function describeDockerdOom(used?: number, machine?: number): string {
  return used !== undefined && machine !== undefined
    ? `dockerd ran out of memory (used ${formatKb(used)} of the machine's ${formatKb(machine)})`
    : 'dockerd ran out of memory';
}

let inFlight: Promise<GuestDockerdReport> | null = null;

/**
 * A dockerd restart god mode asked for, while it runs. Recovery stands aside
 * for it: the watchdog skips its ticks, and a build or launch that finds
 * dockerd down waits for the restart to finish instead of racing a second
 * `--ensure` against it.
 */
let requestedRestart: Promise<void> | null = null;

/**
 * Run a REQUESTED dockerd restart (`work`) with recovery held off: any
 * recovery already running finishes first, and none starts until `work`
 * settles. The guest records the restart as requested through the marker the
 * caller writes (`lazy-dockerd.restart-requested`); holding recovery off is
 * what keeps the daemon's own `--ensure` from racing it.
 */
export async function runRequestedDockerdRestart<T>(work: () => Promise<T>): Promise<T> {
  if (requestedRestart) throw new Error('a requested dockerd restart is already running');
  let release!: () => void;
  requestedRestart = new Promise<void>((resolve) => { release = resolve; });
  try {
    if (inFlight) await inFlight.catch(() => undefined);
    return await work();
  } finally {
    requestedRestart = null;
    release();
  }
}

/** True while a requested restart runs — the watchdog's reason to skip a tick. */
export function requestedDockerdRestartRunning(): boolean {
  return requestedRestart !== null;
}

/**
 * Run `lazy-guest-init --ensure` once (single-flight: concurrent callers share
 * one run, so a build and the watchdog never race two restarts). Logs and
 * reports a restart or a failure; returns the report.
 */
export function recoverGuestDockerd(trigger: string): Promise<GuestDockerdReport> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    // God mode is restarting dockerd: let it finish, then check what it left.
    if (requestedRestart) await requestedRestart;
    // The init's own wait for dockerd is 60s, plus up to a few seconds of
    // backoff and stopping a hung dockerd.
    const proc = spawn([GUEST_INIT_BINARY, '--ensure'], { stdout: 'pipe', stderr: 'pipe', timeout: 120_000 });
    const [, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const report = parseGuestInitReport(stdout, stderr);
    if (report.ready && report.source === 'restarted-dockerd') {
      logger.warn(
        `Docker stopped running in this project's machine (${report.died ?? 'cause unknown'}); ` +
        `lazy restarted it (restart ${report.restarts ?? '?'}, noticed by ${trigger}). History: ${DOCKERD_HISTORY_LOG}`,
      );
      await emit({ kind: 'restarted', report, trigger });
    } else if (!report.ready && report.reason === 'machine-stopping') {
      // Teams stopped Docker on purpose because the machine is about to stop
      // (`lazy-guest-init --stop-docker`): not a failure, nothing to file.
      logger.info(`Docker is stopped because this project's machine is stopping (noticed by ${trigger})`);
    } else if (!report.ready) {
      logger.error(
        `Docker is not running in this project's machine and lazy could not bring it back ` +
        `(${report.reason ?? 'unknown reason'}${report.died ? `; it ${report.died}` : ''}, noticed by ${trigger}). ` +
        `History: ${DOCKERD_HISTORY_LOG}${report.detail ? `\n${report.detail}` : ''}`,
      );
      await emit({ kind: 'failed', report, trigger });
    }
    return report;
  })().finally(() => { inFlight = null; });
  return inFlight;
}

async function emit(event: GuestDockerdEvent): Promise<void> {
  if (!reporter) return;
  try {
    await reporter(event);
  } catch (err) {
    logger.error(`Could not record the dockerd ${event.kind} event: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The message `checkDocker` throws in managed mode instead of "Install Docker". */
export function managedDockerDownMessage(report: GuestDockerdReport | null): string {
  if (!report) {
    return "Docker is not running where this project's tasks run. This needs the Lazy Teams maintainer: report it to support.";
  }
  const why = report.reason === 'dockerd-crash-loop'
    ? 'it kept stopping, so lazy stopped restarting it'
    : `lazy tried to restart it and could not (${report.reason ?? 'unknown reason'})`;
  if (report.died?.endsWith('+oom-killer')) {
    return (
      `Docker stopped running in this project's machine: ${describeDockerdOom(report.oomUsedKb, report.oomMachineKb)}, and ${why}. ` +
      dockerdOomRemedy()
    );
  }
  return (
    `Docker stopped running in this project's machine${report.died ? ` (${describeDockerdDeath(report.died)})` : ''}, and ${why}. ` +
    'The restart history is in the machine\'s dockerd log. This needs the Lazy Teams maintainer: report it to support.'
  );
}

export const GUEST_DOCKERD_MESSAGE_SOURCE = 'machine-docker';

/** The system message a restart (notice) or a failed recovery (alert) files. */
export function guestDockerdSystemMessage(event: GuestDockerdEvent): SystemMessageInput {
  const { report } = event;
  const cause = report.died
    ? (report.died.endsWith('+oom-killer')
      ? `How it ended: ${describeDockerdOom(report.oomUsedKb, report.oomMachineKb)}. ${dockerdOomRemedy()}`
      : `How it ended: ${describeDockerdDeath(report.died)}.`)
    : 'How it ended was not recorded.';
  // An OOM kill is a different event from a plain crash (it has its own remedy),
  // so it carries its own title: repeats collapse on source+kind+title, and a
  // shared title would fold an OOM into an earlier crash message unseen.
  const oom = report.died?.endsWith('+oom-killer') === true;
  if (event.kind === 'restarted') {
    return {
      source: GUEST_DOCKERD_MESSAGE_SOURCE,
      kind: 'notice',
      title: oom
        ? "Docker ran out of memory in this project's machine and was restarted"
        : "Docker stopped in this project's machine and was restarted",
      body:
        `Docker stopped running in the project's machine and lazy restarted it (restart ${report.restarts ?? '?'} ` +
        `recently; noticed by ${event.trigger}). ${cause}\n\n` +
        `A build or task that was running when it stopped may have failed; run it again. ` +
        `Details are in the machine's dockerd log (${DOCKERD_HISTORY_LOG}).`,
    };
  }
  return {
    source: GUEST_DOCKERD_MESSAGE_SOURCE,
    kind: 'alert',
    title: oom
      ? "Docker ran out of memory and is not running in this project's machine"
      : "Docker is not running in this project's machine",
    body:
      `${managedDockerDownMessage(report)}\n\n${report.died?.endsWith('+oom-killer') ? '' : `${cause} `}Builds and tasks will fail until it runs again. ` +
      `Details are in the machine's dockerd log (${DOCKERD_HISTORY_LOG}).`,
  };
}

/**
 * File a dockerd event, collapsing repeats. A crash loop files the same notice
 * (or the same alert) over and over; each one used to be a new message, and a
 * day of them buried the rest of the inbox. Now an identical event while one is
 * still OPEN bumps that message's repeat count and last-seen time instead. A
 * different kind of event (the alert after the restart notices) has a
 * different title and gets its own message; once dismissed, the next event
 * starts a fresh one.
 */
export async function fileGuestDockerdEvent(
  storage: { createSystemMessage(input: SystemMessageInput, options?: { collapseRepeats?: boolean }): Promise<SystemMessage> },
  event: GuestDockerdEvent,
): Promise<SystemMessage> {
  return storage.createSystemMessage(guestDockerdSystemMessage(event), { collapseRepeats: true });
}

/** How often the watchdog checks dockerd between `lazy` invocations. */
const WATCHDOG_INTERVAL_MS = 60_000;
/** The guest script's default restart window (LAZY_GUEST_DOCKERD_RESTART_WINDOW). */
export const GUEST_RESTART_WINDOW_MS = 900_000;

/**
 * Periodically ask dockerd if it is alive and run recovery when not. Cheap
 * (`docker info`) and a no-op off the microVM backend. Stops calling recovery
 * after a crash loop until dockerd answers again, so a dead machine is not
 * hammered — the guest script would refuse anyway.
 */
export function startGuestDockerdWatchdog(): () => void {
  if (!guestDockerdSupervised()) return () => {};
  let running = false;
  // When the guest refused as a crash loop; retried once its restart window
  // (default 900s) has passed, so the machine can heal without a build.
  let gaveUpAt: number | null = null;
  const tick = async () => {
    if (running || requestedDockerdRestartRunning()) return;
    running = true;
    try {
      const probe = spawn(['docker', 'info'], { stdout: 'ignore', stderr: 'ignore', timeout: 15_000 });
      if ((await probe.exited) === 0) {
        gaveUpAt = null;
      } else if (gaveUpAt === null || Date.now() - gaveUpAt >= GUEST_RESTART_WINDOW_MS) {
        const report = await recoverGuestDockerd('the daemon watchdog');
        gaveUpAt = !report.ready && report.reason === 'dockerd-crash-loop' ? Date.now() : null;
      }
      // The hourly memory canary and the after-idle image data check (src/daemon/machine-integrity.ts).
      // Neither needs dockerd, so they run whether or not it answered; not awaited, so a
      // 30-second canary or a long re-hash never holds up the next dockerd check.
      const { machineIntegrityTick } = await import('./machine-integrity');
      void machineIntegrityTick().catch((err: unknown) =>
        logger.error(`machine integrity tick failed: ${err instanceof Error ? err.message : String(err)}`));
    } catch (err) {
      logger.error(`dockerd watchdog tick failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
    }
  };
  const id = setInterval(() => { void tick(); }, WATCHDOG_INTERVAL_MS);
  logger.debug(`Guest dockerd watchdog enabled: every ${WATCHDOG_INTERVAL_MS / 1000}s`);
  return () => clearInterval(id);
}

/**
 * Whether the LATEST death in the restart history (the lines the guest
 * appended) was an OOM kill of dockerd, with the memory figures when it
 * recorded them. Null when the latest death was anything else.
 */
export function latestDockerdOomFromHistory(lines: string[]): { used?: number; machine?: number } | null {
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^=== \S+ dockerd \(pid [^)]*\) stopped answering \(cause=/.test(lines[i])) { idx = i; break; }
  }
  if (idx < 0 || !/cause=[a-z0-9+-]*\+oom-killer/.test(lines[idx])) return null;
  for (let i = idx + 1; i < lines.length && !lines[i].startsWith('=== '); i++) {
    const m = /^--- dockerd memory at the kill: used (\d+) kB of the machine's (\d+) kB/.exec(lines[i]);
    if (m) return { used: Number(m[1]), machine: Number(m[2]) };
  }
  return {};
}

/** The sentence the Machine page shows for such a death, remedy included. */
export function dockerdOomSentence(oom: { used?: number; machine?: number }): string {
  return `${describeDockerdOom(oom.used, oom.machine)}. ${dockerdOomRemedy()}`;
}
