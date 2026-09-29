/**
 * Daemon auto-start — starts the daemon if not running.
 *
 * Called early in the CLI entry point before command dispatch.
 * Also exports startDaemonBackground() for use by `lazy daemon start`.
 *
 * In v0.11+, the daemon is required. If auto-start fails, the CLI
 * exits with an actionable error. The only exceptions are:
 * - Test mode (LAZY_TEST=1): daemon is bypassed entirely
 * - Commands that don't need the daemon (daemon, init, completion, help)
 */

import { mkdirSync, openSync, closeSync } from 'fs';
import { readFile, unlink } from 'fs/promises';
import { dirname } from 'path';
import { spawn } from '../utils/spawn';
import { waitForDaemon, cleanupStaleFiles, isDaemonRunning, getLogPath, getStartupErrorPath } from './index';
import { getLazyCommand } from '../utils/cli-path';
import { findForeignDaemon, foreignDaemonRefusal, type ForeignDaemon } from './foreign-daemon';

/** Commands that should NOT trigger auto-start (they work without daemon) */
export const SKIP_AUTO_START = new Set([
  'daemon',     // avoid recursion
  'init',       // bootstrap command — must work before daemon exists
  'completion', // shell completion — must be fast
  'customize',  // writes template files into the project; touches no task state
  // `lazy auth` is how you FIX a missing credential, and it needs no daemon:
  // it touches no task state — it writes to OS secure storage and the
  // per-project daemon dir, both of which the daemon re-reads at startup.
  'auth',
  // `lazy playground` provisions a project of its OWN, under a throwaway root, and
  // starts that project's daemon itself with the environment a demo needs.
  // Whichever project the caller happens to be standing in is irrelevant to it,
  // and starting THAT project's daemon would be a daemon it never wanted.
  'playground',
  'demo', // the old spelling of `playground`, kept as an alias for one release
  // `lazy login` / `lazy logout` talk only to Lazy Teams and the clone's
  // binding file. They run in exactly the checkout that is NOT bound yet —
  // after a store handover, one whose lazy.toml still names the store Teams
  // now owns — so auto-starting there would put a second writer on that store.
  'login',
  'logout',
  '--help',
  '-h',
  '--version',
  '-V',
]);

/**
 * Start the daemon in the background. Used by ensureDaemon() and daemonStart().
 *
 * Forks a child process and waits for its TCP port to become ready.
 * Singleton enforcement is handled by startDaemonServer()'s flock — if two
 * callers race and both spawn, only one child wins the lock; the other exits.
 *
 * @param projectRoot - Project root directory
 */
export async function startDaemonBackground(
  projectRoot: string,
  scanned?: { foreign: ForeignDaemon | null },
): Promise<void> {
  const logPath = getLogPath(projectRoot);
  const startupErrorPath = getStartupErrorPath(projectRoot);

  // Never a second daemon for one project: a daemon started under another
  // base dir (a managed guest's) is invisible to this shell's state files.
  // ensureDaemon hands down the scan it already made.
  const foreign = scanned ? scanned.foreign : await findForeignDaemon(projectRoot);
  if (foreign) throw new Error(foreignDaemonRefusal(projectRoot, foreign));

  // Ensure daemon directory exists before spawning — Bun.spawn needs the
  // log file's parent directory to exist for stdout/stderr redirection.
  mkdirSync(dirname(logPath), { recursive: true });

  // Clear any stale startup-error marker from a previous failed run. We own
  // the marker file name across the spawn: if it appears after we clear it,
  // the current child wrote it on its way out. Without this, a subsequent
  // "daemon did not start" poll timeout would surface an OLD marker's text
  // as the actionable error, even when the actual failure was a hang with
  // no marker written.
  try {
    await unlink(startupErrorPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Non-ENOENT unlink failures (e.g., permission) would mean we can't
      // distinguish a fresh marker from a stale one. Surface it loudly —
      // a silent failure here is exactly the kind of thing that turns a
      // fixable config bug into a "why does this feel random" mystery.
      throw new Error(
        `Failed to clear stale startup-error marker at ${startupErrorPath}: ${(err as Error).message}`,
      );
    }
  }

  // Open the log file in APPEND mode (O_APPEND) and pass the fd to the child.
  // Using Bun.file(logPath) instead would open the file in TRUNCATE mode at
  // position 0 — uncaught errors written to stderr (e.g., the top-level catch
  // in src/index.ts calling console.error on daemon bind failure) would
  // overwrite the BEGINNING of daemon.log while logger.* appendFileSync writes
  // land at the END. Users running `tail daemon.log` would only see the old
  // logger content and miss the error, creating the illusion of a silent hang.
  // O_APPEND forces every write to land at end-of-file atomically, so stderr
  // output and logger output interleave in chronological order.
  //
  // Sync openSync is acceptable here: this is one-shot cold-start code that
  // runs before the event loop matters, per CLAUDE.md's allowance for sync
  // calls in "CLI startup/init code that runs once".
  const logFd = openSync(logPath, 'a');

  let proc: Bun.Subprocess;
  try {
    // Fork a detached child running `lazy daemon start --foreground --project <root>`.
    // LAZY_DAEMON_BACKGROUND=1 tells the child it's a detached daemon whose
    // stdout/stderr are redirected to daemon.log (not a terminal). The child
    // uses this to silence console output from the logger — otherwise every
    // logger.error call would write the same message to the file twice (once
    // via appendFileSync with a timestamp, once via console.error via the
    // O_APPEND fd without one).
    proc = spawn([...getLazyCommand(), 'daemon', 'start', '--foreground', '--project', projectRoot], {
      stdout: logFd,
      stderr: logFd,
      stdin: 'ignore',
      timeout: 0, // Long-running: daemon runs indefinitely
      env: { ...process.env, LAZY_DAEMON_BACKGROUND: '1' },
    });

    // Detach the child so it outlives this process. unref() removes the
    // child from the event loop's "keep alive" set — but we can still
    // observe proc.exited (see below) to detect an early crash.
    proc.unref();
  } finally {
    // Close the parent's copy of the fd. The child inherits its own reference
    // via the kernel's per-process fd table, so the file stays open for the
    // daemon's lifetime.
    closeSync(logFd);
  }

  // Race readiness polling against the child's exit. If the child dies
  // before becoming ready (bind failure, uncaught throw in startup) there
  // is no point in waiting the full 5s timeout — we know the daemon is
  // not coming up. Without this race, a hard failure like "web port
  // busy" stalls the user's CLI for the full readiness budget before we
  // even start producing an error message.
  const readyPromise = waitForDaemon(projectRoot, 5000).then(ready => (ready ? 'ready' : 'timeout'));
  const exitPromise = proc.exited.then(() => 'exited' as const);
  const outcome = await Promise.race([readyPromise, exitPromise]);

  if (outcome === 'ready') return;

  // Our child exiting early may just mean it LOST the singleton lock to a
  // sibling CLI's daemon starting at the same moment — then that daemon serves
  // us. A lock loser writes no startup-error marker, so a marker (a real
  // startup failure) is reported at once below without this extra wait.
  if (
    outcome === 'exited' &&
    !(await readStartupErrorMarker(startupErrorPath)) &&
    (await waitForDaemon(projectRoot, 5000))
  ) return;

  // Either the child exited early, or the readiness poll timed out while
  // the child is still alive but not responding. In both cases, check for
  // a startup-error marker first — it's the actionable message, and we
  // prefer it over the generic timeout text whenever it exists.
  const markerMessage = await readStartupErrorMarker(startupErrorPath);
  if (markerMessage) {
    // Surface the daemon's actionable error directly to the caller.
    // The CLI's top-level catch will print this to the user's terminal,
    // closing the UX loop: the user now sees the same actionable text
    // that is in daemon.log, without having to open the log file.
    throw new Error(markerMessage);
  }

  // No marker: either the child hung (outcome='timeout') or it died
  // from a code path that never wrote one (e.g., SIGSEGV, OOM). Fall
  // back to the generic timeout with a pointer to the log file so the
  // user can at least inspect what the daemon was doing.
  throw new Error(
    `Daemon did not start within 5 seconds.\n` +
    `Check logs: ${logPath}`,
  );
}

/**
 * Read the startup-error marker written by a failing daemon child.
 * Returns the message if present, null otherwise. ENOENT is the normal
 * case (no marker because the child hung rather than crashing with a
 * handled error) — any other error is swallowed with a side-channel
 * warning on stderr because we still want to fall through to the
 * generic timeout rather than blow up the CLI on a marker read failure.
 */
async function readStartupErrorMarker(markerPath: string): Promise<string | null> {
  try {
    const content = await readFile(markerPath, 'utf-8');
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    // Unexpected read failure — log to stderr so a persistent issue is
    // discoverable, but fall through to the generic timeout so the user
    // still gets *some* actionable message.
    console.error(
      `Warning: failed to read startup-error marker at ${markerPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Ensure the daemon is running for the given project. Called before command dispatch.
 *
 * Fast-checks the daemon state files — if they show a live daemon, it is
 * ready. If not, spawns a daemon and polls its /daemon/status endpoint.
 * Singleton enforcement is in startDaemonServer() (flock), not here.
 *
 * @param command - The CLI command being run (to check skip list)
 * @param projectRoot - The project root directory (for per-project daemon paths)
 */
export async function ensureDaemon(command: string | undefined, projectRoot: string): Promise<boolean> {
  // Test mode bypasses daemon entirely
  if (process.env.LAZY_TEST === '1') return false;

  // Commands that don't need daemon
  if (!command || SKIP_AUTO_START.has(command)) return false;

  // Fast path: token + port marker readable, AND process is alive.
  // After a crash, the marker files remain but the process is dead —
  // the PID check catches this (the old check only tested file existence).
  if (isDaemonRunning(projectRoot)) {
    return true;
  }

  // A live daemon for this project under ANOTHER base dir (a managed guest's
  // daemon, seen from a shell without its env): talk to it when its base dir
  // is readable and it answers there; startDaemonBackground refuses otherwise.
  const foreign = await findForeignDaemon(projectRoot);
  if (foreign?.baseDir) {
    const previous = process.env.LAZY_DAEMON_BASE_DIR;
    process.env.LAZY_DAEMON_BASE_DIR = foreign.baseDir;
    if (isDaemonRunning(projectRoot)) {
      console.error(`Using the running daemon (PID ${foreign.pid}) from ${foreign.baseDir}.`);
      return true;
    }
    if (previous === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
    else process.env.LAZY_DAEMON_BASE_DIR = previous;
  }
  // The scan may have waited out a sibling CLI's daemon starting in OUR dir.
  if (!foreign && isDaemonRunning(projectRoot)) return true;

  // Daemon is dead or never started. Clean up stale files (PID, legacy socket)
  // left behind by a crash, then start a fresh daemon.
  // startDaemonServer's flock ensures only one daemon wins if multiple
  // callers race to start.
  //
  // The isDaemonRunning check above is not what makes this safe — two callers
  // can both pass it and one then loses the flock race. cleanupStaleFiles
  // itself refuses while a live process holds the daemon lock, so a loser
  // cannot delete the winner's files.
  cleanupStaleFiles(projectRoot);
  await startDaemonBackground(projectRoot, { foreign });
  return true;
}
