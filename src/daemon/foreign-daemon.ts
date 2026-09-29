/**
 * Find a live daemon for THIS project that the current shell's daemon base dir
 * cannot see.
 *
 * A daemon's state files (pid, port, token) live under the daemon base dir,
 * which `LAZY_DAEMON_BASE_DIR` relocates. A managed daemon (a Teams guest) is
 * started with that variable set; a shell opened in the same guest without it
 * resolves `$HOME/.lazy/daemon/<slug>`, finds nothing, and auto-start used to
 * spawn a SECOND daemon for the same project — which then failed on the real
 * one's storage lock and answered every RPC with a 500.
 *
 * INVARIANT: the CLI never starts a daemon for a project some live process on
 * this host already serves as a daemon. The question is asked of the PROCESS
 * TABLE, keyed on the project root in the daemon's own argv
 * (`daemon start --foreground --project <root>`), never of the base dir — the
 * base dir is exactly the thing that diverges.
 */

import { readdir, readFile, realpath } from 'fs/promises';
import { join } from 'path';
import { spawn } from '../utils/spawn';
import { getDaemonBaseDir } from './paths';
import { readPid, readDaemonLockPid, waitForDaemon } from './lifecycle';

export interface ForeignDaemon {
  pid: number;
  /** The daemon base dir that process uses, when its environment is readable. */
  baseDir: string | null;
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    // Root no longer on disk (or unreadable) — compare the spelling as given.
    return path;
  }
}

/** The project root in a daemon argv (`… daemon start … --project <root>`), else null. */
export function daemonProjectFromArgv(argv: string[]): string | null {
  const d = argv.indexOf('daemon');
  if (d < 0 || argv[d + 1] !== 'start') return null;
  const p = argv.indexOf('--project');
  return p >= 0 && argv[p + 1] ? argv[p + 1] : null;
}

/** Parse `ps -A -o pid=,command=` output into pid → argv (space-split). */
export function parsePsListing(stdout: string): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (m) out.set(parseInt(m[1], 10), m[2].split(/\s+/));
  }
  return out;
}

/** The daemon base dir named by an environment (explicit override, else $HOME default). */
export function baseDirFromEnv(env: Map<string, string>): string | null {
  const override = env.get('LAZY_DAEMON_BASE_DIR');
  if (override) return override;
  const home = env.get('HOME');
  return home ? join(home, '.lazy', 'daemon') : null;
}

/** Parse a NUL-separated /proc/<pid>/environ. */
export function parseProcEnviron(raw: string): Map<string, string> {
  const env = new Map<string, string>();
  for (const kv of raw.split('\0')) {
    const i = kv.indexOf('=');
    if (i > 0) env.set(kv.slice(0, i), kv.slice(i + 1));
  }
  return env;
}

/**
 * Parse the environment tokens `ps -E` appends after a command line. Only the
 * two variables we need are extracted; values are whitespace-delimited, so a
 * path containing spaces is not recoverable (it then reads as unknown).
 */
export function parsePsEnvironment(line: string): Map<string, string> {
  const env = new Map<string, string>();
  for (const key of ['LAZY_DAEMON_BASE_DIR', 'HOME']) {
    const m = line.match(new RegExp(`(?:^|\\s)${key}=(\\S+)`));
    if (m) env.set(key, m[1]);
  }
  return env;
}

/** Every process on the host as pid → argv. Linux reads /proc; else `ps`. */
async function listProcessArgv(): Promise<Map<number, string[]>> {
  if (process.platform === 'linux') {
    const out = new Map<number, string[]>();
    let entries: string[];
    try {
      entries = await readdir('/proc');
    } catch {
      // No /proc mounted — nothing we can inspect; caller proceeds as before.
      return out;
    }
    await Promise.all(
      entries.filter(e => /^\d+$/.test(e)).map(async e => {
        try {
          const raw = (await readFile(`/proc/${e}/cmdline`)).toString('utf-8');
          const argv = raw.split('\0').filter(a => a.length > 0);
          if (argv.length > 0) out.set(parseInt(e, 10), argv);
        } catch {
          // Process exited mid-scan or is unreadable — skip it.
        }
      }),
    );
    return out;
  }
  try {
    const proc = spawn(['ps', '-A', '-o', 'pid=,command='], { stdout: 'pipe', stderr: 'ignore', timeout: 5000 });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return parsePsListing(stdout);
  } catch {
    // `ps` unavailable — no scan possible; caller proceeds as before.
    return new Map();
  }
}

/** The daemon base dir a process resolves, from its environment. */
async function readProcessBaseDir(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    try {
      return baseDirFromEnv(parseProcEnviron((await readFile(`/proc/${pid}/environ`)).toString('utf-8')));
    } catch {
      // Another user's process — its environment is not ours to read.
      return null;
    }
  }
  try {
    // macOS/BSD: `ps -E` appends the environment of same-user processes.
    const proc = spawn(['ps', '-E', '-ww', '-o', 'command=', '-p', String(pid)], {
      stdout: 'pipe', stderr: 'ignore', timeout: 5000,
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return baseDirFromEnv(parsePsEnvironment(stdout));
  } catch {
    // `ps` unavailable or refused — the environment stays unknown.
    return null;
  }
}

/**
 * A live daemon serving `projectRoot` whose state is NOT in this shell's base
 * dir, or null. The daemon recorded in our own base dir (pidfile or lock
 * holder) is ours — possibly still starting — and never counts as foreign.
 *
 * When a candidate's base dir cannot be read, it may be a sibling CLI's daemon
 * still starting in OUR dir (two commands auto-starting at once). Give our own
 * dir a readiness window first: if a daemon comes up there, nothing is foreign.
 */
export async function findForeignDaemon(projectRoot: string): Promise<ForeignDaemon | null> {
  const want = await canonical(projectRoot);
  const ourBase = await canonical(getDaemonBaseDir());
  const ownPids = new Set<number>([process.pid, process.ppid]);
  const recorded = readPid(projectRoot);
  if (recorded !== null) ownPids.add(recorded);
  const lockPid = readDaemonLockPid(projectRoot);
  if (lockPid !== null) ownPids.add(lockPid);

  let unknown: ForeignDaemon | null = null;
  for (const [pid, argv] of await listProcessArgv()) {
    if (ownPids.has(pid)) continue;
    const root = daemonProjectFromArgv(argv);
    if (!root || (await canonical(root)) !== want) continue;
    const baseDir = await readProcessBaseDir(pid);
    if (baseDir === null) {
      unknown ??= { pid, baseDir: null };
      continue;
    }
    if ((await canonical(baseDir)) === ourBase) continue;
    return { pid, baseDir };
  }
  if (unknown && (await waitForDaemon(projectRoot, 5000))) return null;
  return unknown;
}

/** The refusal text when a foreign daemon cannot be adopted. */
export function foreignDaemonRefusal(projectRoot: string, found: ForeignDaemon): string {
  const remedy = found.baseDir
    ? `Point this shell at it:  export LAZY_DAEMON_BASE_DIR=${found.baseDir}`
    : `Run lazy from a shell that has the daemon's environment (in a managed guest: the admin shell), ` +
      `or set LAZY_DAEMON_BASE_DIR to the directory that daemon uses.`;
  return (
    `A lazy daemon for ${projectRoot} is already running (PID ${found.pid}) outside this shell's ` +
    `daemon directory (${getDaemonBaseDir()}); refusing to start a second one.\n${remedy}`
  );
}
