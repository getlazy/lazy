/**
 * Daemon process identity — proving that a recorded PID really IS a lazy daemon.
 *
 * WHY THIS EXISTS
 * ---------------
 * A daemon state dir records the daemon's PID in `lazy.pid`. PIDs are recycled
 * by the OS, so `kill(pid, 0)` only answers "some process holds this number
 * today" — not "the daemon that wrote this file is still running". On a machine
 * that has been up for months, the PID recorded by a long-dead daemon is very
 * likely to name an unrelated process, which made months-dead state dirs look
 * permanently "running" in `lazy daemon list` and immortal to `kill-stray`
 * (they never appeared dead, so `--prune-dirs` never touched them).
 *
 * Worse, `kill-stray` reaps by PID: without an identity check, a reused PID
 * belonging to someone else's process could be SIGTERM'd by lazy.
 *
 * THE SIGNALS, STRONGEST FIRST
 * ----------------------------
 * 1. **The daemon answers on its own unix socket.** Definitive: only a live
 *    lazy daemon serving THIS dir can respond there. Immune to PID reuse
 *    because it never looks at a PID. (Probed by the registry, not here.)
 * 2. **The daemon holds an flock on `daemon.lock`.** The daemon acquires it at
 *    startup and holds it for its entire lifetime; the OS releases it on exit,
 *    crash or SIGKILL (see acquireDaemonLock). If we can take the lock, nothing
 *    is holding it, so no daemon is running for that dir — regardless of what
 *    the pidfile says. Also immune to PID reuse: the lock is per-dir.
 * 3. **The process command line looks like a daemon.** The fallback for dirs
 *    with no lock file — daemons started under `LAZY_TEST=1` skip the lock, and
 *    dirs predating flock enforcement have none. Weakest of the three, so it is
 *    only consulted last.
 *
 * If NONE of the three can be evaluated (no socket, no lock file, and the
 * command line cannot be read) we deliberately fall back to "assume it is a
 * daemon". Being wrong in that direction leaves a phantom in the list; being
 * wrong the other way would let `--prune-dirs` delete a live daemon's socket
 * and token, or let `kill-stray` kill a stranger's process.
 */

import { open, readFile } from 'fs/promises';
import { join } from 'path';
import { DAEMON_LOCK_FILE } from './paths';
import { tryFlockNonBlocking } from './lifecycle';

/** Outcome of a command-line identity check. */
export type CommandVerdict =
  /** The command line looks like `lazy daemon start …`. */
  | 'match'
  /** The command line was readable and is NOT a lazy daemon (PID reuse). */
  | 'mismatch'
  /** The command line could not be read — no conclusion either way. */
  | 'unknown';

/** Outcome of the `daemon.lock` flock probe. */
export type LockVerdict =
  /** Something holds the lock — a live daemon owns this dir. */
  | 'held'
  /** We acquired the lock, so nothing holds it — no daemon owns this dir. */
  | 'free'
  /** No lock file, or flock is unavailable — no conclusion either way. */
  | 'unknown';

/**
 * Probe whether a daemon dir's `daemon.lock` is currently held.
 *
 * Opens the EXISTING lock file (never creates one — an absent lock file means
 * "no conclusion", not "free") and attempts a non-blocking exclusive flock. If
 * the attempt succeeds we immediately close the handle, which releases the lock
 * the OS just gave us; a real daemon's lock is untouched either way because
 * flock never preempts a held lock.
 *
 * Note that flock conflicts even within a single process when two separate file
 * descriptors are used, so this probe is correct even when it runs inside the
 * daemon that holds the lock.
 */
export async function probeDaemonLock(dir: string): Promise<LockVerdict> {
  let handle;
  try {
    handle = await open(join(dir, DAEMON_LOCK_FILE), 'r+');
  } catch {
    // ENOENT (dir predates flock enforcement, or LAZY_TEST daemons that skip
    // the lock) / EACCES — nothing can be concluded from the lock.
    return 'unknown';
  }
  try {
    // Acquiring means nobody held it → no live daemon for this dir.
    return tryFlockNonBlocking(handle.fd) ? 'free' : 'held';
  } catch {
    // FFI/dlopen unavailable on this platform — no conclusion.
    return 'unknown';
  } finally {
    // Closing the fd releases any lock we just took.
    await handle.close().catch(() => { /* fd already gone; nothing to release */ });
  }
}

/**
 * Read the full command line of each pid. Pids whose command line cannot be
 * read are simply absent from the returned map (caller treats that as
 * "unknown", never as "mismatch").
 *
 * Linux reads /proc directly — no subprocess, and `ps` is not installed in
 * every container. Everything else (macOS) shells out to `ps` once for the
 * whole batch rather than once per pid.
 */
export async function readProcessCommands(pids: number[]): Promise<Map<number, string>> {
  const unique = [...new Set(pids)];
  if (unique.length === 0) return new Map();
  return process.platform === 'linux'
    ? await readProcCommands(unique)
    : await readPsCommands(unique);
}

async function readProcCommands(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  await Promise.all(
    pids.map(async pid => {
      try {
        // /proc/<pid>/cmdline is NUL-separated (and NUL-terminated).
        const raw = await readFile(`/proc/${pid}/cmdline`);
        const cmd = raw.toString('utf-8').replace(/\0/g, ' ').trim();
        // Kernel threads have an empty cmdline — unreadable, not a mismatch.
        if (cmd.length > 0) out.set(pid, cmd);
      } catch {
        // Process exited between the liveness check and here, or /proc is not
        // mounted — leave it out of the map.
      }
    }),
  );
  return out;
}

async function readPsCommands(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  try {
    const { spawn } = await import('../utils/spawn');
    const proc = spawn(['ps', '-p', pids.join(','), '-o', 'pid=,command='], {
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: 5000,
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    for (const line of stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!m) continue;
      out.set(parseInt(m[1], 10), m[2].trim());
    }
  } catch {
    // `ps` missing or failed — every pid stays "unknown", which is the safe
    // direction (we never downgrade a process to "not a daemon" on a guess).
  }
  return out;
}

/**
 * Decide whether a command line belongs to a lazy daemon.
 *
 * A daemon is always spawned as `<lazy command…> daemon start --foreground
 * --project <root>` (see startDaemonBackground), and `lazy daemon start
 * --foreground` run by hand looks the same minus `--project`. The `lazy`
 * command itself is not a reliable token — it can be a compiled binary at any
 * path or `bun run <repo>/src/index.ts` — so we key on the ARGUMENTS, which are
 * identical in every spawn form.
 *
 * Requiring `daemon` plus one of the daemon-only flags keeps unrelated
 * processes that merely contain the word "daemon" from being mistaken for one.
 * When the dir's project root is known, seeing that exact path in the command
 * line is accepted on its own — that is the strongest form of this signal.
 */
export function commandLooksLikeDaemon(cmd: string, projectRoot: string | null): boolean {
  if (projectRoot && cmd.includes(`--project ${projectRoot}`)) return true;
  return /(^|\s)daemon(\s|$)/.test(cmd) && (cmd.includes('--foreground') || cmd.includes('--project'));
}

/** Classify a live pid against the command-line signal. */
export function commandVerdict(
  pid: number,
  commands: Map<number, string>,
  projectRoot: string | null,
): CommandVerdict {
  const cmd = commands.get(pid);
  if (cmd === undefined) return 'unknown';
  return commandLooksLikeDaemon(cmd, projectRoot) ? 'match' : 'mismatch';
}
