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
import { readFile, readdir, readlink, stat } from 'fs/promises';
import { spawn, spawnSyncUnsupervised } from './spawn';
import { isManagedMode, MANAGED_BACKEND_ENV } from '../config/managed-mode';

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

// ---------------------------------------------------------------------------
// Process GROUPS
//
// Signalling a process group is how one process reaches a whole tree, and it is
// the only way to reach an agent whose supervisor has already died. Everything
// below exists to make that signal VERIFIABLE rather than merely plausible: a
// pgid is a pid, pids are recycled, and a SIGKILL aimed at a group on the
// strength of a stale number kills whatever now occupies it.
// ---------------------------------------------------------------------------

/**
 * The process-group id of a live pid, or null if it cannot be read.
 *
 * Same platform split as the identity readers above: procfs field 5, taken
 * after the last `)` because the comm field is parenthesised and may itself
 * contain spaces and parens; `ps -o pgid=` elsewhere. Null means "no answer",
 * never "no group".
 */
export async function processGroupId(pid: number): Promise<number | null> {
  if (process.platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf-8');
      const close = stat.lastIndexOf(')');
      if (close === -1) return null;
      // rest[0] is field 3 (state), so field 5 (pgrp) is rest[2].
      return toPid(stat.slice(close + 1).trim().split(/\s+/)[2]);
    } catch {
      return null;
    }
  }
  const out = spawnSyncUnsupervised(['ps', '-o', 'pgid=', '-p', String(pid)], { timeout: PS_TIMEOUT_MS });
  if (out.exitCode !== 0) return null;
  return toPid(out.stdout.toString().trim());
}

/**
 * Every pid currently in `pgid`, or an empty list when it cannot be enumerated.
 *
 * Empty is deliberately indistinguishable from "could not read": both mean "no
 * member was verified", and the only caller treats that as a reason NOT to
 * signal. Erring towards signalling would be the whole hazard.
 */
export async function processesInGroup(pgid: number): Promise<number[]> {
  const members: number[] = [];
  if (process.platform === 'linux') {
    let entries: string[];
    try {
      entries = await readdir('/proc');
    } catch {
      return [];
    }
    for (const entry of entries) {
      const pid = toPid(entry);
      if (pid === null) continue;
      if ((await processGroupId(pid)) === pgid) members.push(pid);
    }
    return members;
  }
  const out = spawnSyncUnsupervised(['ps', '-eo', 'pid=,pgid='], { timeout: PS_TIMEOUT_MS });
  if (out.exitCode !== 0) return [];
  for (const line of out.stdout.toString().split('\n')) {
    const [rawPid, rawPgid] = line.trim().split(/\s+/);
    const pid = toPid(rawPid);
    if (pid !== null && toPid(rawPgid) === pgid) members.push(pid);
  }
  return members;
}

/**
 * The working directory of a live pid, or null when it cannot be read.
 *
 * Linux only, by design rather than omission. procfs answers it with a readlink;
 * everything else would need `lsof`, which lazy does not depend on and will not
 * start depending on for this. A null here makes its caller decline to signal a
 * group — so the cost of the gap is a missed reap, never a wrong kill.
 */
export async function processCwd(pid: number): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  try {
    return await readlink(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

/**
 * Is this pid a process that is still RUNNING, as opposed to merely present?
 *
 * `kill(pid, 0)` answers the second question, and a ZOMBIE answers it yes. A
 * zombie holds nothing and will never exit again of its own accord, so treating
 * one as alive makes every caller wait out a grace period for a process that is
 * already dead — and, for a whole group of them, escalate to a SIGKILL with
 * nothing to kill.
 *
 * "Cannot tell" resolves to TRUE: a process that was in the table a moment ago
 * and whose state will not read is not evidence of death.
 */
export async function isRunningProcess(pid: number): Promise<boolean> {
  if (!pidExists(pid)) return false;
  const identity = await readProcessIdentity(pid);
  return identity === null ? true : !isZombieState(identity.state);
}

/** Parse a pid-shaped string, rejecting anything that is not a positive integer. */
function toPid(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Synchronous {@link isRunningProcess}, for callers that cannot await — test
 * teardown and exit handlers, chiefly. Same rules, same "cannot tell is TRUE".
 */
export function isRunningProcessSync(pid: number): boolean {
  if (!pidExists(pid)) return false;
  const identity = readProcessIdentitySync(pid);
  return identity === null ? true : !isZombieState(identity.state);
}

/**
 * Synchronous {@link processGroupId}, for callers that cannot await — the test
 * harness's exit-handler sweep, chiefly. Same platform split, same "null means
 * no answer".
 */
export function processGroupIdSync(pid: number): number | null {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const close = stat.lastIndexOf(')');
      if (close === -1) return null;
      return toPid(stat.slice(close + 1).trim().split(/\s+/)[2]);
    } catch {
      return null;
    }
  }
  const out = spawnSyncUnsupervised(['ps', '-o', 'pgid=', '-p', String(pid)], { timeout: PS_TIMEOUT_MS });
  if (out.exitCode !== 0) return null;
  return toPid(out.stdout.toString().trim());
}

// ---------------------------------------------------------------------------
// Pid NAMESPACE identity
//
// A pid means something only inside the pid namespace (and kernel) that issued
// it. The store is shared across that boundary on Lazy Teams: the host and a
// project's microVM guest both reach it, and a container sees its own pids. A
// lock or marker written on the other side names a pid this side cannot judge
// at all — "no such process here" says nothing about whether it is running
// there. Recording WHERE a pid lives is what lets a reader tell "dead" apart
// from "not mine to judge".
// ---------------------------------------------------------------------------

let namespaceIdPromise: Promise<string | null> | null = null;

/**
 * This process's pid namespace, as a string that differs between any two
 * places whose pids are not comparable: a different kernel boot (a VM guest
 * vs its host, a reboot) or a different pid namespace on one kernel (a
 * container). Null where it cannot be determined — callers treat null as
 * "unknown", never as a match.
 *
 * Linux: the kernel's boot id plus the pid-namespace link (the initial
 * namespace's inode is the same constant on every kernel, hence the boot id).
 * macOS: the boot session UUID (no pid namespaces there).
 */
export function processNamespaceId(): Promise<string | null> {
  if (!namespaceIdPromise) namespaceIdPromise = readNamespaceId();
  return namespaceIdPromise;
}

async function readNamespaceId(): Promise<string | null> {
  if (process.platform === 'linux') {
    try {
      const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf-8')).trim();
      const ns = await readlink('/proc/self/ns/pid');
      return boot && ns ? `linux:${boot}:${ns}` : null;
    } catch {
      // No procfs answer (an unusual mount, a restricted sandbox): unknown.
      // Callers treat null as "cannot compare", which is the safe reading.
      return null;
    }
  }
  if (process.platform === 'darwin') {
    try {
      const proc = spawn(['sysctl', '-n', 'kern.bootsessionuuid'], { stdout: 'pipe', stderr: 'ignore', timeout: 5000 });
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      const uuid = out.trim();
      return code === 0 && uuid ? `darwin:${uuid}` : null;
    } catch {
      // sysctl unavailable: unknown, as above.
      return null;
    }
  }
  return null;
}

/**
 * Is THIS process a Lazy Teams project's machine (a microVM guest)? Its store
 * is mounted from a host that also reaches it — the one place lazy has a
 * holder in another kernel that may be alive. Recorded on locks and markers
 * (`holder_guest`) so the host can tell a live guest from a dead past boot.
 */
export function isVmGuest(env: NodeJS.ProcessEnv = process.env): boolean {
  return isManagedMode(env) && env[MANAGED_BACKEND_ENV] === 'microvm';
}

/**
 * What a recorded holder's namespace says about judging its pid from here:
 *
 * - `judgeable`: the same namespace, or one side unknown (older lazy, no
 *   answer) — judge the pid as always.
 * - `dead`: another boot of a kernel that is not a guest's (this machine
 *   before a crash or reboot, or a container from then), or — judged from the
 *   kernel's INITIAL pid namespace only, the one that can see its siblings — a
 *   pid namespace on THIS kernel in which the holder's pid is gone (a
 *   recreated container, or a dead holder in a container still running) or
 *   now belongs to a process with a different start identity (a recycled
 *   pid). A recycled pid must never make a holder look alive (the pid-reuse
 *   wedge).
 * - `foreign`: a holder that may genuinely be running where this side cannot
 *   see it — a holder on another OS kernel (a macOS host daemon seen from a
 *   Linux container, or the reverse: only an earlier boot of the SAME kind of
 *   kernel is dead); a guest (`holder_guest`) in another kernel; any sibling pid
 *   namespace judged from inside a NESTED one (a neighbour container's live
 *   namespace looks empty from here, so empty proves nothing); or, from the
 *   initial namespace, a holder whose pid is still there with the recorded
 *   identity, or whose namespace could not be fully inspected.
 */
export type HolderNamespaceVerdict = 'judgeable' | 'dead' | 'foreign';

export async function judgeHolderNamespace(
  recorded: {
    namespace?: string | null;
    guest?: boolean | null;
    /** The holder's pid and start identity in ITS namespace: tells a live holder from a dead one in a still-populated namespace. */
    holder?: RecordedHolder | null;
  },
  /** Test seam: where /proc is, this side's namespace, and how a process identity is read. */
  seam: { procRoot?: string; ownNamespace?: string | null; readIdentity?: (pid: number) => Promise<ProcessIdentity | null> } = {},
): Promise<HolderNamespaceVerdict> {
  const theirs = recorded.namespace ?? null;
  if (!theirs) return 'judgeable';
  const own = seam.ownNamespace !== undefined ? seam.ownNamespace : await processNamespaceId();
  if (own === null || own === theirs) return 'judgeable';
  // A guest in another kernel is alive or not by a fact this side cannot read —
  // unless this side IS that project's guest, on a later boot of its own.
  if (recorded.guest && !isVmGuest()) return 'foreign';
  const mine = parseNamespace(own);
  const other = parseNamespace(theirs);
  // Another OS kernel altogether — a macOS host daemon seen from a Linux
  // container sharing its store, or the reverse — runs BESIDE this one, not
  // before it: no boot comparison can prove it gone, so it is never reclaimed.
  // An id that does not parse is treated the same way: nothing says it is our past.
  if (!mine || !other || mine.kind !== other.kind) return 'foreign';
  if (mine.kind === 'linux' && mine.boot === other.boot) {
    // Same kernel, another pid namespace. Only the initial namespace can see
    // into its siblings: from inside a container a neighbour's live namespace
    // shows no processes at all, so "empty" would be a guess, not a fact.
    if (mine.ns !== INITIAL_PID_NAMESPACE) return 'foreign';
    const holder = recorded.holder ?? null;
    const found = await findPidInNamespace(other.ns, holder ? holder.pid : null, seam.procRoot ?? '/proc');
    // A process whose namespace could not be read may be the real holder (inner
    // pids like 1 collide across containers), so no identity mismatch elsewhere
    // can prove it gone.
    if (found.uncertain) return 'foreign';
    if (found.pid === null) return 'dead';
    // Without the holder's identity, a populated namespace may hold it.
    if (!holder) return 'foreign';
    // That pid number exists in its namespace: it is the holder only when its
    // start identity says so (a recycled pid must not read as alive).
    return judgeHolder(holder, await (seam.readIdentity ?? readProcessIdentity)(found.pid)).alive ? 'foreign' : 'dead';
  }
  // Seen FROM a guest, another kernel's unflagged holder is the host (a
  // restore or backup running there) — out of sight, possibly alive.
  if (isVmGuest() && !recorded.guest) return 'foreign';
  // Another boot, not a guest's: this machine (or a container on it) before a
  // restart. Nothing from it is running.
  return 'dead';
}

function parseNamespace(id: string): { kind: string; boot: string; ns: string } | null {
  const m = /^(linux):([^:]+):(.+)$/.exec(id) ?? /^(darwin):(.+)()$/.exec(id);
  return m ? { kind: m[1], boot: m[2], ns: m[3] } : null;
}

/** The kernel's initial pid namespace link; every other namespace is nested and cannot see its siblings. */
const INITIAL_PID_NAMESPACE = 'pid:[4026531836]';

/**
 * The pid, as THIS side numbers it, of a process living in pid namespace `ns`.
 * With `nspid` given, the process must carry that pid inside `ns` (the last
 * `NSpid:` entry); without it any process in `ns` matches.
 *
 * A namespace link only a privileged reader may follow (a root-owned
 * container's, seen by a non-root host user) cannot be matched by namespace, so
 * such a process can never be returned as the holder (inner pids collide
 * across containers); a nested one (two or more `NSpid` entries) that ends in
 * the holder's pid, or any nested one when no holder pid is known, makes the
 * answer `uncertain`. Null pid with `uncertain: false` means the namespace was
 * fully looked at and the holder is not in it (or there is no procfs).
 */
async function findPidInNamespace(
  ns: string,
  nspid: number | null,
  procRoot: string,
): Promise<{ pid: number | null; uncertain: boolean }> {
  let entries: string[];
  try {
    entries = await readdir(procRoot);
  } catch {
    // No procfs: nothing to look at, so nothing found.
    return { pid: null, uncertain: false };
  }
  // A procfs mounted `hidepid=2` lists only this user's processes, and pid 1 is
  // always there otherwise: without it, what is missing proves nothing.
  let uncertain = !entries.includes('1');
  let found: number | null = null;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const link = await readlink(`${procRoot}/${entry}/ns/pid`).catch(() => null);
    if (link !== null && link !== ns) continue;
    if (link === ns && nspid === null) return { pid: Number(entry), uncertain: false };
    const status = await readFile(`${procRoot}/${entry}/status`, 'utf-8').catch(() => null);
    if (link === null && status === null) {
      // Neither file readable (`hidepid=1`, another user's process): it may be
      // anywhere, the holder included — unless it simply exited meanwhile.
      if (await stat(`${procRoot}/${entry}`).then(() => true, () => false)) uncertain = true;
      continue;
    }
    const m = status ? /^NSpid:\s+(.*)$/m.exec(status) : null;
    const levels = m ? m[1].trim().split(/\s+/) : [];
    if (link === null) {
      // Unreadable link: only a nested process can be in a sibling namespace.
      if (levels.length < 2) continue;
      // Never "the" holder: it may be in any container's namespace.
      if (nspid === null || levels[levels.length - 1] === String(nspid)) uncertain = true;
      continue;
    }
    // Scan on: a later unreadable process still makes the answer uncertain.
    if (found === null && levels[levels.length - 1] === String(nspid)) found = Number(entry);
  }
  return { pid: found, uncertain };
}
