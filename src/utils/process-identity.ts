/**
 * Process identity for PID-based lock files.
 *
 * A lock file that records only a pid cannot tell "pid 1433, the process that
 * took this lock" apart from "pid 1433, whatever the OS assigned that number to
 * later". PIDs are recycled — fast, on macOS — so a long-lived lock file whose
 * holder died without releasing it will EVENTUALLY always name a live, unrelated
 * process. Observed in the wild: a storage lock left behind by a dead lazy
 * process named pid 1433, which macOS had since handed to `postersyncd`. Every
 * lazy command then failed to acquire the lock, forever, across daemon restarts
 * — the stale-lock cleanup path was unreachable because the holder looked alive.
 *
 * This module makes holder identity verifiable. Locks record the holder's
 * process START TIME alongside its pid; a process at that pid whose start time
 * differs is a different process, so the lock is stale.
 *
 * Why start time and not the alternatives:
 *
 *  - Advisory `flock(2)` on an open fd would be strongest — the kernel drops it
 *    when the holder dies, so there is no liveness heuristic to get wrong and no
 *    stale-lock path at all. Rejected here: Bun exposes no flock binding (it
 *    would need `bun:ffi` with per-platform `LOCK_EX` constants), and stores can
 *    live anywhere the user points `external_path`, including network mounts
 *    where flock is a no-op or advisory-only per-client. A lock that silently
 *    stops excluding on NFS is worse than one that occasionally over-waits.
 *  - The holder's command line alone is a weak heuristic ("does this look like
 *    lazy?"), not an identity. It is kept here only as a BACKSTOP for lock files
 *    written before start times were recorded, or by a `ps` without `lstart`.
 *
 * Start time is read from procfs where it exists (Linux) and from `ps -o lstart=`
 * otherwise (macOS) — and only on the path where a lock file already exists,
 * never on the uncontended fast path.
 */

import { readFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { spawn, spawnSyncUnsupervised } from './spawn';

/**
 * Where a start time came from. The two sources use different units (procfs
 * reports ticks since boot, `ps` an absolute local timestamp), so a start time
 * is only ever compared against one from the SAME source — otherwise a lock
 * written by a process that used one source and read by a process that used the
 * other would look like pid reuse and get stolen out from under a live holder.
 */
export type StartTimeSource = 'proc' | 'ps';

/** What the OS reports about the process currently occupying a pid. */
export interface ProcessIdentity {
  /** Process state code — 'S', 'R', 'Z+', … */
  state: string;
  /** Absolute-ish start time, or null when it could not be determined. */
  started: string | null;
  /** Which mechanism produced `started` (null when `started` is null). */
  startedSource: StartTimeSource | null;
  /** Full command line, or null when it could not be determined. */
  command: string | null;
}

/** The identity fields a lock file recorded about its holder at acquire time. */
export interface RecordedHolder {
  pid: number;
  /** Start time of the holder, captured when it took the lock. */
  started?: string | null;
  /** Which mechanism produced `started`. */
  startedSource?: StartTimeSource | null;
  /** When the lock was taken (ISO). Used as a weaker fallback signal. */
  acquiredAt?: string | null;
}

export type HolderDeadReason =
  /** No process occupies the pid at all. */
  | 'no-process'
  /** Terminated but unreaped — answers kill(0), will never release anything. */
  | 'zombie'
  /** A process occupies the pid, but it is not the one that took the lock. */
  | 'pid-reused'
  /** Unverifiable identity, and the occupant cannot plausibly be a lazy process. */
  | 'implausible-holder';

export type HolderVerdict =
  | { alive: true }
  | { alive: false; reason: HolderDeadReason };

/** True if a `ps`-reported process state denotes a zombie/defunct process. */
export function isZombieState(state: string): boolean {
  // 'Z' is the zombie/defunct code on both macOS and Linux ps output.
  return state.trim().startsWith('Z');
}

/** True if the pid exists in the process table (says nothing about identity). */
export function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false; // No such process.
  }
}

/**
 * Parse one line of `ps -o state=,lstart=,command=`.
 *
 * `lstart` is a fixed five-field format on both macOS and Linux
 * ("Thu Aug  6 20:26:07 2026"), so the columns split unambiguously on
 * whitespace: state, five lstart fields, then the command line. Returns null
 * when the line does not have that shape — a `ps` without `lstart` support
 * (busybox) prints something else entirely, and guessing would be worse than
 * falling back to the state-only query.
 */
export function parsePsIdentityLine(raw: string): ProcessIdentity | null {
  const line = raw.trim();
  if (!line) return null;
  const tokens = line.split(/\s+/);
  if (tokens.length < 6) return null;
  // Validate the lstart shape: weekday, month, day, HH:MM:SS, 4-digit year.
  if (!/^[A-Za-z]{3}$/.test(tokens[1])) return null;
  if (!/^[A-Za-z]{3}$/.test(tokens[2])) return null;
  if (!/^\d{1,2}$/.test(tokens[3])) return null;
  if (!/^\d{1,2}:\d{2}:\d{2}$/.test(tokens[4])) return null;
  if (!/^\d{4}$/.test(tokens[5])) return null;

  return {
    state: tokens[0],
    started: tokens.slice(1, 6).join(' '),
    startedSource: 'ps',
    command: tokens.slice(6).join(' ') || null,
  };
}

/**
 * Parse `/proc/<pid>/stat` (Linux).
 *
 * Field 3 is the state code and field 22 the start time in clock ticks since
 * boot — the canonical procfs answer to "is this the same process". Field 2 is
 * the executable name in parentheses and MAY contain spaces and parentheses, so
 * parsing starts after the LAST ')' rather than splitting the whole line.
 */
export function parseProcStat(raw: string, cmdline: string | null): ProcessIdentity | null {
  const close = raw.lastIndexOf(')');
  if (close === -1) return null;
  const rest = raw.slice(close + 1).trim().split(/\s+/);
  // rest[0] is field 3 (state); field 22 is therefore rest[19].
  if (rest.length < 20) return null;
  const state = rest[0];
  const starttime = rest[19];
  if (!state || !/^\d+$/.test(starttime)) return null;
  return { state, started: starttime, startedSource: 'proc', command: cmdline };
}

const PS_IDENTITY_ARGS = ['-o', 'state=,lstart=,command=', '-p'];
const PS_STATE_ARGS = ['-o', 'state=', '-p'];

/**
 * Deadline for a `ps` lookup. `ps` on a single pid returns in milliseconds; a
 * multi-second wait means the system is wedged, and an unbounded wait in the
 * sync path would take the daemon's event loop with it.
 */
const PS_TIMEOUT_MS = 5_000;

/** Read a process's identity from procfs. Returns null when procfs is absent. */
async function readProcIdentity(pid: number): Promise<ProcessIdentity | null> {
  let stat: string;
  try {
    stat = await readFile(`/proc/${pid}/stat`, 'utf-8');
  } catch {
    return null; // Not Linux, or the process vanished between checks.
  }
  let cmdline: string | null = null;
  try {
    // /proc/<pid>/cmdline is NUL-separated and NUL-terminated.
    cmdline = (await readFile(`/proc/${pid}/cmdline`, 'utf-8')).replace(/\0+$/, '').replace(/\0/g, ' ').trim() || null;
  } catch {
    // Command line is a nice-to-have (kernel threads have none) — identity
    // still works off the start time.
  }
  return parseProcStat(stat, cmdline);
}

/** Synchronous variant of {@link readProcIdentity}. */
function readProcIdentitySync(pid: number): ProcessIdentity | null {
  let stat: string;
  try {
    // Sync justified: the only caller is the pairing lock, which is read from
    // synchronous call sites. procfs reads never touch a disk.
    stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
  } catch {
    return null;
  }
  let cmdline: string | null = null;
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0+$/, '').replace(/\0/g, ' ').trim() || null;
  } catch {
    // See readProcIdentity — command line is optional.
  }
  return parseProcStat(stat, cmdline);
}

/**
 * Ask the OS who currently occupies a pid.
 *
 * procfs first (Linux: exact, no subprocess, and works on minimal images that
 * ship no `ps` at all — the lazy agent container is one), then `ps` (macOS and
 * anywhere else). Returns null when neither can answer — callers MUST treat
 * that as "unknown", never as "dead", so we never steal a lock from a live
 * holder. The `ps` path falls back to a state-only query when `lstart` is
 * unsupported, which preserves zombie detection on minimal userlands.
 */
export async function readProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  const fromProc = await readProcIdentity(pid);
  if (fromProc) return fromProc;

  try {
    const proc = spawn(['ps', ...PS_IDENTITY_ARGS, String(pid)], { stdout: 'pipe', stderr: 'ignore' });
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const parsed = parsePsIdentityLine(out);
    if (parsed) return parsed;
  } catch {
    // `ps` unavailable — fall through to the state-only attempt, which will
    // fail the same way and yield null (i.e. "unknown holder").
  }

  try {
    const proc = spawn(['ps', ...PS_STATE_ARGS, String(pid)], { stdout: 'pipe', stderr: 'ignore' });
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const state = out.trim();
    if (!state) return null;
    return { state, started: null, startedSource: null, command: null };
  } catch {
    return null;
  }
}

/**
 * Synchronous variant, for the pairing lock only.
 *
 * The pairing lock is read from deeply synchronous call sites (the reconciler,
 * task-lifecycle guards) where making it async would ripple through a dozen
 * modules for no behavioural gain. The cost is bounded: this runs ONLY when a
 * pairing lock file actually exists, which is rare and short-lived — and on
 * Linux it is a procfs read, with no subprocess at all.
 */
export function readProcessIdentitySync(pid: number): ProcessIdentity | null {
  const fromProc = readProcIdentitySync(pid);
  if (fromProc) return fromProc;

  // DAEMON-REACHABLE sync spawn: the pairing lock is read from the reconciler
  // and task-lifecycle guards, so a wedged `ps` would block the daemon's event
  // loop. 5s overrides the (much longer) default backstop — a `ps` that has not
  // answered in five seconds is not going to.
  try {
    const proc = spawnSyncUnsupervised(['ps', ...PS_IDENTITY_ARGS, String(pid)], { stdout: 'pipe', stderr: 'ignore', timeout: PS_TIMEOUT_MS });
    const parsed = parsePsIdentityLine(proc.stdout.toString());
    if (parsed) return parsed;
  } catch {
    // Fall through to the state-only attempt.
  }

  try {
    const proc = spawnSyncUnsupervised(['ps', ...PS_STATE_ARGS, String(pid)], { stdout: 'pipe', stderr: 'ignore', timeout: PS_TIMEOUT_MS });
    const state = proc.stdout.toString().trim();
    if (!state) return null;
    return { state, started: null, startedSource: null, command: null };
  } catch {
    return null;
  }
}

/** Capture this process's own identity, for recording into a lock file. */
export async function selfIdentity(): Promise<ProcessIdentity | null> {
  return readProcessIdentity(process.pid);
}

/** Synchronous variant of {@link selfIdentity}. */
export function selfIdentitySync(): ProcessIdentity | null {
  return readProcessIdentitySync(process.pid);
}

/**
 * Could this command line belong to a lazy process?
 *
 * Deliberately PERMISSIVE: a false "yes" only means we keep waiting on a lock
 * we could have reclaimed, while a false "no" would steal a lock from a live
 * holder. Lazy runs as `lazy …`, `lazy-agent …`, or under a JS runtime in
 * development (`bun run ./src/index.ts …`), so any of those count.
 */
export function looksLikeLazyProcess(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return true; // Nothing to judge on — assume it could be ours.
  if (/lazy/i.test(cmd)) return true;
  // A JS runtime could be running lazy from source or from a global install.
  if (/(^|[/\\\s])(bun|node|deno|npx)(\s|$)/i.test(cmd)) return true;
  return false;
}

/** Normalise a `ps` start-time string for comparison. */
function sameStart(a: string, b: string): boolean {
  return a.trim().replace(/\s+/g, ' ') === b.trim().replace(/\s+/g, ' ');
}

/**
 * Decide whether the recorded holder of a lock is still the process at that pid.
 *
 * Pure — takes the `ps` result rather than fetching it — so the decision table
 * is directly testable without spawning processes.
 */
export function judgeHolder(recorded: RecordedHolder, identity: ProcessIdentity | null): HolderVerdict {
  // `ps` told us nothing. Be conservative: assume the holder is alive rather
  // than risk stealing a lock from a genuinely-running process.
  if (!identity) return { alive: true };

  // A zombie (terminated, unreaped) still answers kill(0) but holds no
  // resources and will NEVER release the lock. Treat it as dead.
  // (Observed in the wild: an unreaped `lazy pair` child wedged the daemon.)
  if (isZombieState(identity.state)) return { alive: false, reason: 'zombie' };

  // Primary test: the start time recorded when the lock was taken. Same pid
  // AND same start time is the same process; a different start time means the
  // OS recycled the pid and this is somebody else. Only comparable when both
  // start times came from the same mechanism (see StartTimeSource).
  if (
    recorded.started &&
    identity.started &&
    recorded.startedSource &&
    recorded.startedSource === identity.startedSource
  ) {
    return sameStart(recorded.started, identity.started)
      ? { alive: true }
      : { alive: false, reason: 'pid-reused' };
  }

  // Backstop path: lock file predates identity recording, or the two sides
  // could not use the same mechanism. Two weaker signals, in order of strength.

  // 1. If the occupant started AFTER the lock was taken, it cannot be the
  //    holder — nothing can acquire a lock before it exists. Only meaningful
  //    for `ps`, whose start time is an absolute timestamp (procfs reports
  //    ticks since boot, which is not comparable to a wall-clock instant).
  if (recorded.acquiredAt && identity.started && identity.startedSource === 'ps') {
    const acquired = Date.parse(recorded.acquiredAt);
    const started = Date.parse(identity.started);
    // One second of slack: `lstart` has second resolution and is reported in
    // local time, so an exactly-simultaneous acquire must not read as reuse.
    if (!Number.isNaN(acquired) && !Number.isNaN(started) && started > acquired + 1000) {
      return { alive: false, reason: 'pid-reused' };
    }
  }

  // 2. If the occupant cannot plausibly be a lazy process, it never took a
  //    lazy lock — the pid was recycled to an unrelated program.
  if (identity.command && !looksLikeLazyProcess(identity.command)) {
    return { alive: false, reason: 'implausible-holder' };
  }

  return { alive: true };
}

/** Human-readable explanation of why a lock holder counts as dead. */
export function describeDeadReason(reason: HolderDeadReason): string {
  switch (reason) {
    case 'no-process': return 'the holding process no longer exists';
    case 'zombie': return 'the holding process is defunct (zombie) and will never release it';
    case 'pid-reused': return 'the pid now belongs to a different, unrelated process (pid reuse)';
    case 'implausible-holder': return 'the process at that pid is not a lazy process (pid reuse)';
  }
}

/** Is the recorded holder of a lock still alive AND still the same process? */
export async function checkHolder(recorded: RecordedHolder): Promise<HolderVerdict> {
  if (!pidExists(recorded.pid)) return { alive: false, reason: 'no-process' };
  return judgeHolder(recorded, await readProcessIdentity(recorded.pid));
}

/** Synchronous variant of {@link checkHolder} — pairing lock only. */
export function checkHolderSync(recorded: RecordedHolder): HolderVerdict {
  if (!pidExists(recorded.pid)) return { alive: false, reason: 'no-process' };
  return judgeHolder(recorded, readProcessIdentitySync(recorded.pid));
}
