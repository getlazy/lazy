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
import { readFile, stat, unlink } from 'fs/promises';
import { dirname } from 'path';
import { spawn } from '../utils/spawn';
import { waitForDaemon, cleanupStaleFiles, isDaemonRunning, readPid, readDaemonLockPid, isProcessAlive, getLogPath, getStartupErrorPath } from './index';
import { getLazyCommand } from '../utils/cli-path';
import { findForeignDaemon, foreignDaemonRefusal, type ForeignDaemon } from './foreign-daemon';
import { assertManagedStartAllowed } from './managed-marker';

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
/**
 * How much longer a background start waits for a child that is alive and has
 * reported no failure: the daemon's store-open deadline plus a margin, since
 * the store is opened before the daemon binds.
 */
/** Mirrors `STORE_OPEN_DEADLINE_MS` in ./rpc-handlers (not imported: that module is the daemon's whole RPC surface, far too heavy for every CLI start). A unit test keeps the two equal. */
export const DAEMON_STORE_OPEN_DEADLINE_MS = 60_000;
export const SLOW_START_BUDGET_MS = DAEMON_STORE_OPEN_DEADLINE_MS + 15_000;

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

  // Never an unmanaged daemon where Lazy Teams runs one: it would come up
  // without the credentials and settings the fleet starts it with
  // (src/daemon/managed-marker.ts). Covers `lazy daemon start` and the
  // auto-start every other command performs (ensureDaemon).
  await assertManagedStartAllowed(projectRoot);

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
  // runs before the event loop matters, per AGENTS.md's allowance for sync
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
      // Its own session (setsid): out of the starting terminal's process group,
      // so a Ctrl+C on this CLI, or the terminal closing, never reaches a
      // daemon that may be minutes into a store backup.
      detached: true,
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

  const outcome = await waitForStartingDaemon(projectRoot, proc.pid, proc.exited);

  if (outcome === 'ready') return;

  // Our child exiting early may just mean it LOST the singleton lock to a
  // sibling CLI's daemon starting at the same moment — then that daemon serves
  // us. A lock loser writes no startup-error marker, so a marker (a real
  // startup failure) is reported at once below without this extra wait.
  if (
    outcome === 'exited' &&
    !(await readStartupErrorMarker(startupErrorPath)) &&
    isDaemonRunning(projectRoot)
  ) {
    // The winning start may still be binding its proxy. Join exactly the same
    // bounded, progress-reporting wait as a command finding it already alive.
    await waitForLaunchReadyDaemon(projectRoot);
    return;
  }

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
    `Daemon did not start within ${Math.round((5000 + SLOW_START_BUDGET_MS) / 1000)} seconds.\n` +
    `Check logs: ${logPath}`,
  );
}

/**
 * Wait for a daemon start to answer, saying what it is doing all the while.
 *
 * Polls readiness every two seconds and, in between, the pre-upgrade backup's
 * progress marker (src/daemon/store-backup-progress.ts): a daemon starting on a
 * new lazy version backs the store up BEFORE it listens, and a big store takes
 * longer than any fixed budget. While that backup is making progress there is
 * no deadline — the marker going stale is what bounds it — and the person sees
 * how far it is, every few seconds, instead of a silent wait they will
 * interrupt. The fixed budget (5s + SLOW_START_BUDGET_MS) counts only the time
 * with no backup running, restarting when a backup ends.
 *
 * `exited` is the child's exit when this process spawned it; for a start some
 * other process made (found already starting) liveness of `pid` stands in.
 */
export async function waitForStartingDaemon(
  projectRoot: string,
  pid: number,
  exited?: Promise<unknown>,
): Promise<'ready' | 'exited' | 'timeout'> {
  const { readLiveBackupProgress, readBackupResult, backupSummary } = await import('./store-backup-progress');
  const startupErrorPath = getStartupErrorPath(projectRoot);
  let gone = false;
  exited?.then(() => { gone = true; }, () => { gone = true; });
  let budgetFrom = Date.now();
  let saidSlow = false;
  let lastPrinted = 0;
  let saidDetached = false;
  const waitStarted = Date.now();
  for (;;) {
    // Progress first, so the person sees the backup the moment it is reported.
    const progress = await readLiveBackupProgress(projectRoot, pid);
    if (progress) {
      budgetFrom = Date.now();
      if (Date.now() - lastPrinted >= 4000) {
        lastPrinted = Date.now();
        console.error(`Daemon (PID ${pid}): ${backupSummary(progress)}.` +
          (saidDetached ? '' : ' It keeps going if you close this terminal or press Ctrl+C.'));
        saidDetached = true;
      }
    }
    const ready = await Promise.race([
      waitForDaemon(projectRoot, 1000),
      ...(exited ? [exited.then(() => false, () => false)] : []),
    ]);
    if (ready) {
      // How the backup ended, when this start took one: where it is and how to go back.
      const result = await readBackupResult(projectRoot, pid);
      if (result) console.error(result);
      return 'ready';
    }
    if (gone || (!exited && !isProcessAlive(pid))) return 'exited';
    if (progress) continue;
    // A marker counts only if it was written by THIS start: one we spawned
    // cleared any old marker first; for a start someone else made, a marker
    // older than our wait is a previous failure, not this one's.
    if (await readStartupErrorMarker(startupErrorPath, exited ? 0 : waitStarted)) return 'timeout';
    const waited = Date.now() - budgetFrom;
    if (waited >= 5000 && !saidSlow) {
      saidSlow = true;
      console.error(`Daemon is still starting (PID ${pid}); waiting up to ${Math.round(SLOW_START_BUDGET_MS / 1000)}s more...`);
    }
    if (waited >= 5000 + SLOW_START_BUDGET_MS) return 'timeout';
  }
}

/**
 * Read the startup-error marker written by a failing daemon child.
 * Returns the message if present, null otherwise. ENOENT is the normal
 * case (no marker because the child hung rather than crashing with a
 * handled error) — any other error is swallowed with a side-channel
 * warning on stderr because we still want to fall through to the
 * generic timeout rather than blow up the CLI on a marker read failure.
 */
async function readStartupErrorMarker(markerPath: string, newerThanMs = 0): Promise<string | null> {
  try {
    if (newerThanMs > 0 && (await stat(markerPath)).mtimeMs < newerThanMs) return null;
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
 * alive; launch readiness also waits for its proxy. If not, spawns a daemon
 * and polls its /daemon/status endpoint.
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

  // A daemon already STARTING — in its pre-upgrade store backup, holding the
  // lock and not yet listening — is waited for, out loud. Checked BEFORE the
  // liveness fast path: its PID file is already written, so that path would
  // call it running and the command would then fail to reach it.
  if (await waitForBackingUpDaemon(projectRoot)) return true;

  // Fast path: token + port marker readable, AND process is alive.
  // After a crash, the marker files remain but the process is dead —
  // the PID check catches this (the old check only tested file existence).
  if (isDaemonRunning(projectRoot)) {
    await waitForLaunchReadyDaemon(projectRoot);
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
      await waitForLaunchReadyDaemon(projectRoot);
      console.error(`Using the running daemon (PID ${foreign.pid}) from ${foreign.baseDir}.`);
      return true;
    }
    if (previous === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
    else process.env.LAZY_DAEMON_BASE_DIR = previous;
  }
  // The scan may have waited out a sibling CLI's daemon starting in OUR dir.
  if (!foreign && isDaemonRunning(projectRoot)) {
    await waitForLaunchReadyDaemon(projectRoot);
    return true;
  }

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

/**
 * When a daemon start for this project is running its pre-upgrade store
 * backup right now, wait for it (printing its progress) and return true once
 * it answers; false when no such start is running. Throws when that start
 * ends without answering, naming what it reported.
 */
export async function waitForBackingUpDaemon(projectRoot: string): Promise<boolean> {
  const { readLiveBackupProgress } = await import('./store-backup-progress');
  const progress = await readLiveBackupProgress(projectRoot);
  if (!progress) return false;
  const waitStarted = Date.now();
  const outcome = await waitForStartingDaemon(projectRoot, progress.pid);
  if (outcome === 'ready') return true;
  const marker = await readStartupErrorMarker(getStartupErrorPath(projectRoot), waitStarted);
  throw new Error(marker ?? `The daemon (PID ${progress.pid}) stopped while backing up the store and did not start.\nCheck logs: ${getLogPath(projectRoot)}`);
}

/** A live process may still be between the RPC bind and the proxy bind. */
async function waitForLaunchReadyDaemon(projectRoot: string): Promise<void> {
  if (await waitForDaemon(projectRoot, 100)) return;
  // Announce the wait when joining it. The CLI's own startup time can consume
  // most of a short proxy delay before the five-second slow-start notice.
  console.error('Daemon is still starting; waiting for startup to finish...');
  // The lock owner's record survives deletion of lazy.pid and is written by
  // the process that won the singleton lock. Legacy/test daemons use lazy.pid.
  const pid = readDaemonLockPid(projectRoot) ?? readPid(projectRoot);
  if (pid && await waitForStartingDaemon(projectRoot, pid) === 'ready') return;
  const marker = await readStartupErrorMarker(getStartupErrorPath(projectRoot));
  throw new Error(marker ?? `Daemon is still starting and did not make its proxy ready within the startup timeout.\nCheck logs: ${getLogPath(projectRoot)}`);
}
