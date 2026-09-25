/**
 * `lazy daemon` command
 *
 * Manages the lazy daemon process lifecycle:
 *   lazy daemon start     — start daemon (detaches by default)
 *   lazy daemon stop      — graceful shutdown via RPC over the daemon's TCP port
 *   lazy daemon restart   — stop + start
 *   lazy daemon status    — show PID, uptime, web/dashboard address
 *   lazy daemon logs      — tail the daemon log file
 *
 * Per-project: each project gets its own daemon process. Commands must be
 * run inside a lazy project directory (error otherwise).
 *
 * Singleton enforcement: flock(2) is the sole source of truth. Start commands
 * never kill existing daemons — only stop/restart do that.
 */

import { rm, readFile } from 'fs/promises';
import { parseFlags, requireLazyRoot, refuseIfBoundClone } from '../helpers';
import { formatDuration } from '../../utils/format';
import { describeExpiry } from '../../utils/local-day';
import { isTTY, promptYesNo } from '../editor';
import {
  checkDaemonHealth,
  DAEMON_HEALTH_TIMEOUT_MS,
  SIGNAL_SHUTDOWN_BUDGET_MS,
  isDaemonRunning,
  readPid,
  readToken,
  releaseDaemonLock,
  isProcessAlive,
  requestShutdown,
  blockingFlock,
  cleanupStaleFiles,
  getDaemonBaseDir,
  getDaemonTcpTarget,
  getStartupErrorPath,
  enumerateDaemons,
  type DaemonRecord,
} from '../../daemon';
import { dashboardUrlFromStatus } from '../../daemon/dashboard-availability';
import { checkDashboardAddress, dashboardAddressNote } from '../../daemon/dashboard-address';
import { listInteractiveSessions, describeInteractiveSession } from '../../daemon/interactive-registry';
import { startDaemonBackground } from '../../daemon/auto-start';
import { getRunningCodeSha } from '../../daemon/code-version';
import type { DaemonStatus } from '../../daemon/lifecycle';
import { assertDaemonCredentials } from '../../daemon/credential-gate';
import { collectDaemonStopInventory, confirmDaemonStop } from './daemon-pre-stop';
import { commandLogs, logsUsage } from './logs';
import { commandAutoBudget, autoBudgetUsage } from './auto-budget';
import { commandDaemonConfig, daemonConfigUsage } from './daemon-config';
import { commandResumeQueue, resumeQueueUsage } from './resume-queue';
import { commandDaemonHealth, daemonHealthUsage } from './daemon-health';

import { formatDaemonBuiltLine } from '../../utils/build-provenance';
import { getSourceIdentity } from '../../utils/source-id';

/**
 * Compare a daemon's reported source id against this checkout's.
 *
 * Returns null when there is nothing to say — the daemon is too old to report an
 * id, or this process is a compiled binary whose `build:` identity is not
 * comparable to a checkout's fingerprint. Saying nothing is the right answer
 * there: a warning derived from two incomparable values is worse than silence.
 */
async function describeSourceStaleness(
  reported: string | undefined,
): Promise<{ line: string; stale: boolean; running: string; current: string } | null> {
  if (!reported) return null;

  let identity;
  try {
    identity = await getSourceIdentity();
  } catch {
    return null;
  }
  if (identity.kind === 'build') return null;

  const stale = identity.id !== reported;
  return {
    line: stale ? `${reported} (running) — this checkout is ${identity.id}` : `${reported} (up to date)`,
    stale,
    running: reported,
    current: identity.id,
  };
}

export async function commandDaemon(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  // Operating THIS machine's daemon by hand is exactly the thing a bound
  // clone does not do — Teams' own daemon is the one that runs (design doc
  // §4.4, §4.7). Fleet-wide introspection (`list`, `kill-stray`) and `logs`
  // are left alone: they are host-diagnostic, not "operate my daemon".
  if (['start', 'stop', 'restart', 'status', 'health'].includes(subcommand ?? '')) {
    await refuseIfBoundClone(`daemon ${subcommand}`);
  }

  switch (subcommand) {
    case 'start':
      await daemonStart(subArgs);
      break;
    case 'stop':
      await daemonStop(subArgs);
      break;
    case 'restart':
      await daemonRestart(subArgs);
      break;
    case 'status':
      await daemonStatus(subArgs);
      break;
    case 'health':
      await commandDaemonHealth(subArgs);
      break;
    case 'dashboard-url':
      await daemonDashboardUrl(subArgs);
      break;
    case 'list':
      await daemonList(subArgs);
      break;
    case 'kill-stray':
      await daemonKillStray(subArgs);
      break;
    case 'logs':
      await daemonLogs(subArgs);
      break;
    case 'auto-budget':
      await commandAutoBudget(subArgs);
      break;
    case 'config':
      await commandDaemonConfig(subArgs);
      break;
    case 'resume-queue':
      await commandResumeQueue(subArgs);
      break;
    default:
      if (subcommand === '--help' || subcommand === '-h' || !subcommand) {
        daemonUsage();
      } else {
        console.error(`Unknown daemon subcommand: ${subcommand}`);
        daemonUsage();
        process.exit(1);
      }
  }
}

/**
 * Resolve the project root for daemon commands.
 * --project flag takes precedence, otherwise requireLazyRoot().
 */
function resolveProjectRoot(flags: Map<string, string | boolean | string[]>): string {
  const projectFlag = flags.get('project');
  if (typeof projectFlag === 'string') return projectFlag;
  return requireLazyRoot();
}

async function daemonStart(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'foreground', takesValue: false },
    { name: 'background', takesValue: false },
    { name: 'project', takesValue: true },
  ], 'daemon start');

  const foreground = parsed.flags.get('foreground') === true;
  const projectRoot = resolveProjectRoot(parsed.flags);

  if (foreground) {
    // Credential gate PRE-FLIGHT. startDaemonServer() enforces the same gate
    // authoritatively, but running it here first means a foreground start
    // refuses on the user's terminal before touching stale files or the log,
    // with no marker-file round trip.
    await assertDaemonCredentials(projectRoot);

    // Foreground mode: startDaemonServer() acquires the flock internally.
    // If lock held → throws "Already running." If not → starts. One path.
    //
    // INVARIANT: no cleanup here. A start that has not yet acquired the daemon
    // lock has no standing to delete another daemon's state files. This call
    // site used to unconditionally unlink lazy.pid and lazy.sock; run while a
    // healthy daemon was up, it deleted the LIVE daemon's files and — because
    // liveness was decided from those same files — wedged every CLI command
    // against a daemon that was running fine. Nothing here needs the delete:
    // startDaemonServer() unlinks a stale socket and overwrites the PID file
    // itself, AFTER acquireDaemonLock has proved it owns the directory.
    console.log('Starting daemon in foreground mode...');
    const { startDaemonServer } = await import('../../daemon/server');
    const daemon = await startDaemonServer({ projectRoot });
    console.log(`Daemon started (PID ${process.pid})`);
    console.log(`Token:  ${daemon.token.substring(0, 8)}...`);
    console.log(`Web:    ${daemon.dashboardUrl}`);
    console.log('Press Ctrl+C to stop.');

    // Keep the process alive
    await new Promise(() => {});
  } else {
    // Background mode: use unified liveness check (token + port marker + PID
    // alive). After a crash, the marker files remain but the process is dead —
    // the old check (file existence only) would say "already running" while
    // `daemon status` (which connects) said "not running".
    if (isDaemonRunning(projectRoot)) {
      const pid = readPid(projectRoot);
      console.log(`Daemon is already running${pid ? ` (PID ${pid})` : ''}.`);
      return;
    }

    cleanupStaleFiles(projectRoot);
    await startDaemonBackground(projectRoot);

    // Report status after successful start
    const status = await checkDaemonHealth(projectRoot);
    console.log(`Daemon started (PID ${status.pid})`);
    const dashboardUrl = dashboardUrlFromStatus(status);
    if (dashboardUrl) {
      console.log(`Web:    ${dashboardUrl}`);
    }
  }
}

/**
 * Tell the human which interactive sessions (`lazy pair`, `lazy chat`) this stop
 * affects.
 *
 * Runs alongside `collectDaemonStopInventory`, not instead of it, and covers the
 * gap that inventory's own note calls out (see daemon-pre-stop.ts): the inventory
 * finds pair sessions by TASK STATUS, so it cannot see a branchless `lazy pair`
 * or any `lazy chat` at all. This reads the process registry
 * (src/daemon/interactive-registry.ts), so it names both, with pid and cwd.
 *
 * Printed BEFORE the confirmation prompt — after it, the human has already
 * decided. Task agents and builders are stopped and resumed for them by the next
 * daemon (src/daemon/restart-reaper.ts), and an interactive session restarts
 * itself once a new daemon answers (src/supervisor/interactive.ts) — but an
 * interactive session is somebody sitting at a terminal RIGHT NOW, and unsent
 * input in it cannot be preserved.
 *
 * Never throws: an unreadable registry must not block a daemon stop.
 */
async function noticeInteractiveSessions(projectRoot: string, resuming: boolean): Promise<void> {
  let sessions;
  try {
    sessions = await listInteractiveSessions(projectRoot);
  } catch {
    return; // Best-effort notice; the stop matters more than the warning.
  }
  if (sessions.length === 0) return;

  console.log('');
  console.log(`${sessions.length} interactive session${sessions.length === 1 ? '' : 's'} running:`);
  for (const entry of sessions) console.log(`  ${describeInteractiveSession(entry)}`);
  console.log(resuming
    ? 'Each restarts itself once the new daemon is up. Any message typed into one and'
    : 'Each resumes when a daemon is running again. Any message typed into one and');
  console.log('not yet submitted cannot be preserved.');
  console.log('');
}

/** Time allowed for a SIGKILLed process to disappear. Kernel-immediate; slack only. */
const SIGKILL_GRACE_MS = 2_000;

/** Poll interval while waiting for the daemon process to disappear. */
const EXIT_POLL_MS = 100;

/**
 * @param opts.skipPreStop set by `daemon restart`, which has already run (and
 *   shown) the pre-stop warning itself — a restart must warn ONCE, not twice, and
 *   it must warn in restart's own terms.
 * @param opts.resuming set when a daemon is coming back up immediately, which
 *   changes what the interactive-session notice promises the human.
 */
async function daemonStop(
  args: string[],
  opts: { resuming?: boolean; skipPreStop?: boolean } = {},
): Promise<boolean> {
  const parsed = parseFlags(args, [
    { name: 'project', takesValue: true },
    { name: 'yes', aliases: ['y'], takesValue: false },
  ], 'daemon stop');
  const projectRoot = resolveProjectRoot(parsed.flags);
  const yes = parsed.flags.get('yes') === true;

  // Use unified liveness check — same as start and status.
  // After a crash, marker files may exist but the process is dead.
  if (!isDaemonRunning(projectRoot)) {
    // Clean up stale files from a previous crash so the next start works cleanly
    cleanupStaleFiles(projectRoot);
    console.log('Daemon is not running.');
    return true;
  }

  // Pre-stop courtesy: report every live session the daemon is responsible for
  // and what stopping does to each, then let the human back out. Runs BEFORE
  // anything is signalled, and never blocks a non-interactive caller.
  if (!opts.skipPreStop) {
    await noticeInteractiveSessions(projectRoot, opts.resuming === true);
    const inventory = await collectDaemonStopInventory(projectRoot);
    if (!await confirmDaemonStop(inventory, 'stop', yes)) return false;
  }

  const pid = readPid(projectRoot);
  console.log(`Stopping daemon${pid ? ` (PID ${pid})` : ''}...`);

  // Try graceful shutdown over the daemon's TCP port. Bounded (see
  // DAEMON_HEALTH_TIMEOUT_MS): a frozen daemon accepts the connection and never
  // answers, so an unbounded request here would hang the stop on exactly the
  // daemon that needs stopping.
  const shutdownAccepted = await requestShutdown(projectRoot);

  if (!shutdownAccepted && pid && isProcessAlive(pid)) {
    // RPC shutdown failed — try SIGTERM directly
    console.log('  Daemon did not accept the shutdown request — sending SIGTERM...');
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }

  // How long to wait before force-killing. A daemon that ACCEPTED the request is
  // winding down on purpose — closing storage, waiting on children — and gets the
  // longer window; one that never answered has already failed to behave and gets
  // the short one. Escalating on the same short clock in both cases would
  // SIGKILL a healthy daemon in the middle of a slow but correct shutdown.
  const graceMs = shutdownAccepted ? 15_000 : 5_000;

  if (await waitForDaemonExit(projectRoot, graceMs, pid)) {
    console.log('Daemon stopped.');
    return true;
  }

  // ESCALATE, rather than telling the human to run `kill -9` themselves.
  //
  // The shutdown request went unanswered and SIGTERM did not finish the job
  // within the window. WHY is not established here and must not be asserted: a
  // frozen event loop cannot run the handler at all, but a healthy daemon can
  // also still be inside a shutdown that is simply taking longer than its
  // budget. Either way nothing short of SIGKILL will clear it now, and
  // until it is cleared the dead-but-alive process holds the daemon lock, so no
  // replacement can start — which makes "did not stop, try kill -9 yourself"
  // both the wrong answer and the only thing standing between the human and a
  // working project. The stop was already confirmed; escalating to finish the
  // job the human asked for is not a new decision, so it does not need a
  // separate --force flag. It is narrated at every step.
  if (pid && isProcessAlive(pid)) {
    console.log(`  Still running after ${graceMs / 1000}s — it did not answer the shutdown`);
    console.log('  request and did not exit on SIGTERM. Escalating to SIGKILL...');
    try {
      process.kill(pid, 'SIGKILL');
    } catch (err) {
      // EPERM (another user's process) is the only realistic failure here; a
      // dead pid is the outcome we wanted anyway. Either way, say what happened
      // rather than reporting a clean stop.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: could not SIGKILL PID ${pid}: ${msg}`);
      process.exit(1);
    }

    // The kernel reaps a SIGKILLed process immediately, so this is a formality —
    // but it is also what releases the lock and cleans up the state files the
    // killed daemon never got to remove.
    if (await waitForDaemonExit(projectRoot, SIGKILL_GRACE_MS, pid)) {
      console.log('Daemon stopped (SIGKILL — it was not responding).');
      return true;
    }
  }

  // Two distinct dead ends, and conflating them would send the human the wrong
  // way: a pid that survived SIGKILL is a kernel problem, while no recorded pid
  // at all means there was nothing left to escalate against.
  if (pid) {
    console.error(
      `Error: daemon did not stop — PID ${pid} is still alive after SIGKILL.\n` +
      'A process that survives SIGKILL is stuck in the kernel (uninterruptible I/O —\n' +
      'often a hung network mount). Run `lazy doctor` for details; the process cannot\n' +
      'be cleared from user space and the machine may need a reboot.',
    );
  } else {
    console.error(
      'Error: daemon did not stop, and no daemon PID is recorded, so there is nothing\n' +
      'to signal. Its state files are still in place. Run `lazy doctor` for details, and\n' +
      '`lazy daemon list` to find a daemon still holding this project.',
    );
  }
  process.exit(1);
}

/**
 * Wait for the daemon process to exit, then remove its state files. Returns
 * true once it is gone.
 *
 * This is `daemon stop`'s own wait rather than `waitForDaemonStop`, because stop
 * also has to REMOVE the state files a killed daemon never got to clean up, and
 * doing that safely depends on having held (and then released) the lock.
 *
 * The flock is the primary signal, for the reason `waitForDaemonStop` documents:
 * the daemon releases it as the very LAST step of exit, after removing its own
 * socket and PID files, so acquiring it proves the exit finished rather than
 * merely started.
 *
 * `blockingFlock` returning null is AMBIGUOUS — it means either "timed out" or
 * "there is no lock file at all" (a daemon predating flock enforcement, or one
 * started under LAZY_TEST=1, which skips the lock). In the second case it returns
 * null INSTANTLY, which is why the pid is polled rather than checked once: taking
 * the instant null at face value would collapse the whole grace window to zero
 * and escalate to SIGKILL on a daemon that was given no time to exit, while
 * treating it as "still running" would report a stop failure for one that had
 * already exited. The pid is unambiguous either way.
 */
async function waitForDaemonExit(
  projectRoot: string,
  timeoutMs: number,
  pid: number | null,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    const result = blockingFlock(projectRoot, Math.max(0, remaining));
    if (result) {
      // Release BEFORE cleaning up: cleanupStaleFiles refuses while the daemon
      // lock is held, and flock conflicts across separate fds even within one
      // process — so cleaning up while still holding our own probe lock would
      // refuse and leave the files behind.
      releaseDaemonLock(result.fd);
      cleanupStaleFiles(projectRoot);
      return true;
    }

    if (pid !== null && !isProcessAlive(pid)) {
      cleanupStaleFiles(projectRoot);
      return true;
    }

    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, EXIT_POLL_MS));
  }
}

async function daemonRestart(args: string[]): Promise<void> {
  // Credential gate PRE-FLIGHT, before the stop. Without it, a restart run from
  // a shell that has no credential would kill a perfectly good daemon and only
  // then discover it cannot start a replacement — leaving the project with no
  // daemon at all. Same reasoning as `lazy upgrade`'s preflight: check what can
  // refuse us BEFORE doing anything destructive.
  const parsed = parseFlags(args, [
    { name: 'foreground', takesValue: false },
    { name: 'background', takesValue: false },
    { name: 'project', takesValue: true },
    { name: 'yes', aliases: ['y'], takesValue: false },
  ], 'daemon restart');
  const projectRoot = resolveProjectRoot(parsed.flags);
  await assertDaemonCredentials(projectRoot);

  // Pre-stop courtesy, in restart's own terms. A restart is a stop with extra
  // steps and has exactly the same blast radius, so it must not be quieter than
  // `stop` — but it must warn only ONCE, hence skipPreStop below.
  //
  // `resuming: true` on the interactive notice: a restart brings a daemon back
  // immediately, so each supervisor relaunches on its own. A bare stop cannot
  // promise that, which is why the wording differs.
  const yes = parsed.flags.get('yes') === true;
  if (isDaemonRunning(projectRoot)) {
    await noticeInteractiveSessions(projectRoot, true);
    const inventory = await collectDaemonStopInventory(projectRoot);
    if (!await confirmDaemonStop(inventory, 'restart', yes)) return;
  }

  // Rebuild each leg's args from the parsed flags instead of forwarding ours
  // verbatim: `stop` has no --foreground/--background and `start` has no --yes,
  // and parseFlags exits(1) on a flag a subcommand does not declare.
  const projectArgs = typeof parsed.flags.get('project') === 'string'
    ? ['--project', parsed.flags.get('project') as string]
    : [];
  const startArgs = [...projectArgs];
  if (parsed.flags.get('foreground') === true) startArgs.push('--foreground');
  if (parsed.flags.get('background') === true) startArgs.push('--background');

  if (!await daemonStop(projectArgs, { resuming: true, skipPreStop: true })) return;
  await daemonStart(startArgs);
}

async function daemonStatus(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'project', takesValue: true },
  ], 'daemon status');
  const projectRoot = resolveProjectRoot(parsed.flags);

  // Primary check: same isDaemonRunning() used by start/stop/ensureDaemon.
  // If the process is dead but marker files remain (crash), clean up and
  // report "not running" — don't attempt a health check that will fail.
  if (!isDaemonRunning(projectRoot)) {
    cleanupStaleFiles(projectRoot);
    console.log('Daemon is not running.');
    // Surface the last startup-error marker if present — the daemon fails hard
    // (and does not run) when the [proxy] server can't start, so this is where
    // the "why isn't the proxy up?" reason lives once the daemon is down.
    try {
      const marker = (await readFile(getStartupErrorPath(projectRoot), 'utf-8')).trim();
      if (marker) {
        console.log('');
        console.log('Last start attempt failed with:');
        console.log(marker.split('\n').map((l) => `  ${l}`).join('\n'));
      }
    } catch { /* no marker (normal) — nothing to surface */ }
    return;
  }

  // Daemon process is alive — get rich diagnostic info over its TCP port.
  const status = await checkDaemonHealth(projectRoot);

  if (status.running) {
    console.log('Daemon is running.');
    console.log(`  PID:     ${status.pid}`);
    const dashboardUrl = dashboardUrlFromStatus(status);
    if (dashboardUrl) {
      console.log(`  Web:     ${dashboardUrl}`);
    } else {
      // INVARIANT: always surface the web-port state. Post-fix, the daemon
      // refuses to start when web binding fails, so this branch is only
      // reachable against a daemon built before that fix — but silently
      // omitting the Web line made the "degraded" mode invisible (see the
      // original "Daemon context not initialized" bug) and must never
      // regress.
      console.log('  Web:     not bound (degraded — restart after freeing the port)');
    }
    // Proxy: the primary way to find the (OS-assigned by default) proxy address.
    // INVARIANT: always print this line. The proxy is always on, so an absent
    // line would be indistinguishable from a running one and would hide that
    // agent traffic is flowing unaudited.
    if (status.proxy) {
      const p = status.proxy;
      if (p.running && p.address) {
        const fb = `${p.fallbacks} fallback${p.fallbacks === 1 ? '' : 's'}`;
        console.log(`  Proxy:   ${p.address} → ${p.upstream} (${fb}, policy ${p.policyEnforce ? 'on' : 'off'})`);
      } else {
        console.log('  Proxy:   not running (degraded — restart the daemon)');
      }
    }
    if (status.uptime !== undefined) {
      console.log(`  Uptime:  ${formatDuration(status.uptime)}`);
    }
    if (status.version) {
      console.log(`  Version: ${status.version}`);
    }
    const builtLine = formatDaemonBuiltLine(status);
    if (builtLine) {
      console.log(`  Built:   ${builtLine}`);
    }

    // Staleness check (dev mode): the daemon serves whatever code it started
    // with — it does not hot-reload on source changes. When the daemon's running
    // SHA diverges from the working tree's current HEAD, its handlers are stale
    // and on-disk fixes won't take effect until restart. Surface this loudly so
    // the "why is the merged fix not working?" confusion is diagnosable.
    //
    // The SOURCE ID answers it better than the SHA and is preferred wherever
    // the daemon reports one: it is a content hash, so it moves with
    // uncommitted edits — which is most of a development day, and exactly the
    // window in which "why is my fix not working?" gets asked. The SHA check
    // remains for a daemon too old to report an id.
    const sourceStale = await describeSourceStaleness(status.sourceId);
    if (sourceStale) {
      console.log(`  Source:  ${sourceStale.line}`);
      if (sourceStale.stale) {
        console.log('');
        console.log(`  ⚠ Daemon is STALE: it is running source ${sourceStale.running}, but this`);
        console.log(`    checkout is now ${sourceStale.current}. On-disk changes (merged fixes,`);
        console.log('    new handlers) will NOT take effect until you restart the daemon:');
        console.log('      lazy daemon restart');
      }
    } else if (status.codeSha) {
      const currentSha = getRunningCodeSha();
      if (currentSha && currentSha !== status.codeSha) {
        console.log(`  Code:    ${status.codeSha} (running) — working tree at ${currentSha}`);
        console.log('');
        console.log(`  ⚠ Daemon is STALE: it is running code from ${status.codeSha}, but the`);
        console.log(`    working tree is now at ${currentSha}. On-disk changes (merged fixes,`);
        console.log('    new handlers) will NOT take effect until you restart the daemon:');
        console.log('      lazy daemon restart');
      } else {
        console.log(`  Code:    ${status.codeSha}${currentSha ? ' (up to date)' : ''}`);
      }
    }

    // Auto-react budget info
    if (status.autoReactBudget && status.autoReactBudget.length > 0) {
      console.log('');
      console.log('  Auto-react budget:');
      for (const entry of status.autoReactBudget) {
        const reset = entry.resetAt !== undefined ? ` — resets ${describeExpiry(new Date(entry.resetAt))}` : '';
        const override = entry.capOverridden ? ' (today-only override)' : '';
        console.log(`    ${entry.project}: ${entry.used}/${entry.limit} turns today${override}${reset}`);
        if (entry.paused) {
          const pauseInfo =
            entry.pauseExpiresAt !== undefined
              ? `resumes ${describeExpiry(new Date(entry.pauseExpiresAt))}`
              : 'indefinite (no expiry)';
          console.log(`      Paused — ${pauseInfo}`);
        }
        if (entry.tasksAtLimit.length > 0) {
          console.log(`      Tasks at limit: ${entry.tasksAtLimit.join(', ')}`);
        }
      }
    }
  } else if (status.unresponsive) {
    // The port ACCEPTED the connection and then nothing came back — the
    // process is alive with a frozen event loop. This is a different failure
    // from "not responding" below (connection refused / port gone) and needs
    // a different remedy, so say so explicitly rather than letting the human
    // spend an hour deciding which one they are looking at.
    const pid = status.pid ?? readPid(projectRoot);
    console.log(`Daemon is ALIVE but UNRESPONSIVE${pid ? ` (PID ${pid})` : ''}.`);
    console.log(`  Address: ${getDaemonTcpTarget(projectRoot) ?? 'unknown (no port marker)'}`);
    console.log(`  Probe:   connected, but no reply within ${DAEMON_HEALTH_TIMEOUT_MS / 1000}s`);
    console.log('');
    console.log('  Its event loop is stuck: the port is still listening, so the connection');
    console.log('  succeeds, but nothing in the daemon is running to answer. Reconciliation,');
    console.log('  turns, and every other daemon-owned activity are stalled.');
    console.log('');
    console.log('  Recover with:');
    console.log('    lazy daemon restart');
    console.log('  It force-kills a daemon in this state — SIGTERM alone would be ignored,');
    console.log('  because the signal handler runs on the same frozen loop.');
  } else {
    // Process is alive (isDaemonRunning passed) but the daemon isn't answering
    // on its recorded TCP port — still starting up, a stuck HTTP handler, or a
    // foreign daemon has taken the port (checkDaemonHealth rejects those).
    const pid = readPid(projectRoot);
    console.log(`Daemon process is alive${pid ? ` (PID ${pid})` : ''} but not responding on its TCP port.`);
    if (pid === null) {
      // The lock says a daemon owns this dir but its PID file is gone —
      // something deleted this daemon's state files while it was running. The
      // daemon repairs that itself within seconds; doctor is the single
      // surface that explains it.
      console.log('Its PID file is missing. Run `lazy doctor` for details.');
    } else {
      console.log('It may be starting up. If this persists, try: lazy daemon restart');
    }
  }
}

/**
 * `lazy daemon dashboard-url` — print the web dashboard URL and exit.
 *
 * Deliberately does NOT auto-start the daemon (unlike the old `lazy server`
 * alias): this is meant for scripting, where silently spawning a daemon on a
 * bare URL lookup would surprise a caller that just wants to know if one is
 * already up. Same "check, don't start" posture as `lazy daemon status`.
 *
 * It stays the ADDRESS lookup, and only that. Signing in is `lazy dashboard`,
 * which mints a one-time login link and opens a browser at it — a URL printed
 * here reaches the sign-in page, not the dashboard. Keeping the two separate
 * means the scriptable form has no secret in its output and stays safe to log,
 * paste, or leave in shell history.
 *
 * The host it prints is the dashboard's own (`lazy.localhost` on a loopback
 * bind), because that is the only host the dashboard answers on — see
 * src/daemon/dashboard-url.ts for why it is not 127.0.0.1.
 */
async function daemonDashboardUrl(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'project', takesValue: true },
  ], 'daemon dashboard-url');
  const projectRoot = resolveProjectRoot(parsed.flags);

  if (!isDaemonRunning(projectRoot)) {
    cleanupStaleFiles(projectRoot);
    console.error('Error: daemon is not running. Start it with `lazy daemon start`.');
    process.exit(1);
  }

  const status = await checkDaemonHealth(projectRoot);
  if (!status.running) {
    console.error(
      status.unresponsive
        ? 'Error: daemon is alive but unresponsive (event loop stuck). Clear it with `lazy daemon restart`.'
        : 'Error: daemon process is alive but not responding on socket. Try: lazy daemon restart',
    );
    process.exit(1);
  }

  const dashboardUrl = dashboardUrlFromStatus(status);
  if (!dashboardUrl) {
    console.error('Error: daemon is running but the web dashboard port is not available.');
    process.exit(1);
  }

  // Same rule as `lazy dashboard`: print what is served, never silently when
  // lazy.toml asks for something else — one line on stderr, stdout stays the URL.
  const addressProblem = await checkDashboardAddress(projectRoot, status);
  if (addressProblem) console.error(dashboardAddressNote(addressProblem));

  console.log(dashboardUrl);
}

/** Human-readable age for a daemon record: live uptime if known, else pidfile age. */
function daemonAge(rec: DaemonRecord): string {
  if (rec.uptimeMs !== undefined) return formatDuration(rec.uptimeMs);
  if (rec.pidMtimeMs !== undefined) return formatDuration(Date.now() - rec.pidMtimeMs);
  return '?';
}

/** One-line description of a daemon's project root for table/confirmation output. */
function daemonProjectLabel(rec: DaemonRecord): string {
  if (!rec.rootKnown) return '(unknown root)';
  if (!rec.rootExists) return `${rec.projectRoot} (stray — root missing)`;
  return rec.projectRoot!;
}

/**
 * `lazy daemon list` — enumerate every running lazy daemon on the host, not
 * just the current project's. Daemons whose project root has been deleted are
 * marked "(stray)". A footer reports dead-pid state dirs left behind by crashes.
 */
async function daemonList(args: string[]): Promise<void> {
  parseFlags(args, [], 'daemon list');

  const records = await enumerateDaemons();
  const running = records.filter(r => r.alive);
  const deadDirs = records.filter(r => !r.alive);

  if (running.length === 0) {
    console.log('No running lazy daemons.');
  } else {
    const strayCount = running.filter(r => r.stray).length;
    const header = strayCount > 0
      ? `Running lazy daemons (${running.length}, ${strayCount} stray):`
      : `Running lazy daemons (${running.length}):`;
    console.log(header);
    console.log('');

    // Build a simple aligned table. PROJECT is last (variable width).
    const rows = running.map(r => ({
      pid: r.pid !== null ? String(r.pid) : '?',
      port: r.webPort !== undefined ? String(r.webPort) : '-',
      version: r.version ?? '?',
      age: daemonAge(r),
      project: daemonProjectLabel(r),
    }));
    const widths = {
      pid: Math.max(3, ...rows.map(x => x.pid.length)),
      port: Math.max(4, ...rows.map(x => x.port.length)),
      version: Math.max(7, ...rows.map(x => x.version.length)),
      age: Math.max(3, ...rows.map(x => x.age.length)),
    };
    console.log(
      `  ${'PID'.padEnd(widths.pid)}  ${'PORT'.padEnd(widths.port)}  ${'VERSION'.padEnd(widths.version)}  ${'AGE'.padEnd(widths.age)}  PROJECT`,
    );
    for (const x of rows) {
      console.log(
        `  ${x.pid.padEnd(widths.pid)}  ${x.port.padEnd(widths.port)}  ${x.version.padEnd(widths.version)}  ${x.age.padEnd(widths.age)}  ${x.project}`,
      );
    }
  }

  if (deadDirs.length > 0) {
    console.log('');
    console.log(
      `${deadDirs.length} orphaned daemon state dir${deadDirs.length === 1 ? '' : 's'} (no live daemon) under ${getDaemonBaseDir()}.`,
    );
    // Pid reuse is the confusing case: the recorded pid IS alive, just not a
    // lazy daemon. Say so, or the count reads as a contradiction to anyone who
    // checks the pidfile by hand.
    const reused = deadDirs.filter(r => r.identity === 'pid-reused' || r.identity === 'duplicate').length;
    if (reused > 0) {
      console.log(
        `  ${reused} of them record a PID that now belongs to an unrelated process (PID reuse).`,
      );
    }
    console.log('Remove them with: lazy daemon kill-stray --prune-dirs');
  }
}

/**
 * SIGTERM a pid, wait up to `timeoutMs` for it to exit, then SIGKILL.
 *
 * The default allows the daemon its whole signal-shutdown budget plus a second
 * for the exit itself. A stray daemon's ROOT is gone, but the PROCESS is
 * usually healthy and shuts down properly — stopping this project's agents,
 * recording why their turns ended, closing storage — and the old 3s cut that
 * off partway, which is how a SIGKILL lands inside a storage write.
 */
async function terminatePid(pid: number, timeoutMs = SIGNAL_SHUTDOWN_BUDGET_MS + 1_000): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return; // already gone
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise(r => setTimeout(r, 100));
  }
  if (isProcessAlive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* exited between the checks */ }
  }
}

/**
 * `lazy daemon kill-stray` — reap daemons whose project root no longer exists
 * on disk. Per CLAUDE.md "principle of least surprise": a daemon whose root
 * STILL exists is never touched, and reaping requires confirmation interactively
 * (`--yes` skips it for non-interactive callers — NOT LAZY_PROMPT_DEFAULTS).
 *
 * `--prune-dirs` additionally removes orphaned state dirs — those whose pid is
 * dead OR whose pid now belongs to an unrelated process (pid reuse) — so the
 * dir count under the daemon base dir doesn't grow unbounded after crashes.
 *
 * INVARIANT: only identity-verified daemons are ever signalled. The registry
 * classifies a dir alive only when the process is provably a lazy daemon, so a
 * recycled pid belonging to a stranger's process can never be SIGTERM'd here.
 */
async function daemonKillStray(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'yes', aliases: ['y'], takesValue: false },
    { name: 'prune-dirs', takesValue: false },
  ], 'daemon kill-stray');
  const yes = parsed.flags.get('yes') === true;
  const pruneDirs = parsed.flags.get('prune-dirs') === true;

  const records = await enumerateDaemons();
  const strays = records.filter(r => r.stray);
  // Dirs with no live daemon are pruning candidates only. A verified-live
  // daemon with an unknown root is intentionally excluded — we can't prove its
  // root is gone. Dirs whose pid was recycled DO land here: their process is
  // not a daemon, so nothing is signalled, only the dead state dir is removed.
  const orphanDirs = pruneDirs ? records.filter(r => !r.alive) : [];

  if (strays.length === 0 && orphanDirs.length === 0) {
    if (pruneDirs) {
      console.log('No stray daemons and no orphaned state dirs to clean up.');
    } else {
      console.log('No stray daemons to reap.');
    }
    return;
  }

  // Show exactly what will happen before doing it.
  if (strays.length > 0) {
    console.log(`Stray daemon${strays.length === 1 ? '' : 's'} to reap (project root no longer exists):`);
    for (const r of strays) {
      console.log(`  PID ${r.pid}  ${r.projectRoot}`);
    }
  }
  if (orphanDirs.length > 0) {
    console.log(`Orphaned state dir${orphanDirs.length === 1 ? '' : 's'} to remove (no live process):`);
    for (const r of orphanDirs) {
      console.log(`  ${r.dir}`);
    }
  }

  if (!yes) {
    if (!isTTY()) {
      console.error('Refusing to reap without confirmation. Re-run with --yes for non-interactive use.');
      process.exit(1);
    }
    const ok = await promptYesNo('Proceed?', false);
    if (!ok) {
      console.log('Aborted. Nothing was killed.');
      return;
    }
  }

  // Reap strays: kill the process, then remove its now-useless state dir (its
  // root is gone, so nothing will ever reattach to it).
  for (const r of strays) {
    if (r.pid !== null) await terminatePid(r.pid);
    try {
      await rm(r.dir, { recursive: true, force: true });
    } catch (err) {
      console.error(`Killed PID ${r.pid} (${r.projectRoot}) but could not remove its state dir ${r.dir}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    console.log(`Killed PID ${r.pid} — ${r.projectRoot}`);
  }

  // Prune dead-pid dirs.
  for (const r of orphanDirs) {
    try {
      await rm(r.dir, { recursive: true, force: true });
      console.log(`Removed orphaned state dir ${r.dir}`);
    } catch (err) {
      console.error(`Could not remove orphaned state dir ${r.dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const reaped = strays.length;
  const pruned = orphanDirs.length;
  console.log('');
  console.log(
    `Done: reaped ${reaped} stray daemon${reaped === 1 ? '' : 's'}` +
    (pruneDirs ? `, removed ${pruned} orphaned state dir${pruned === 1 ? '' : 's'}.` : '.'),
  );
}

async function daemonLogs(args: string[]): Promise<void> {
  await commandLogs(args);
}

/**
 * Usage functions for `lazy daemon <subcommand>`, keyed by subcommand name.
 *
 * The dispatcher in src/index.ts intercepts -h/--help before the command runs,
 * so a subcommand's own usage is only reachable if it is listed here — without
 * this map `lazy daemon logs -h` prints the parent's usage. Subcommands with no
 * dedicated usage (start/stop/restart/status/list/kill-stray) are intentionally
 * absent and fall back to daemonUsage().
 */
export const daemonSubcommandUsage: Record<string, () => void> = {
  'logs': logsUsage,
  'auto-budget': autoBudgetUsage,
  'config': daemonConfigUsage,
  'resume-queue': resumeQueueUsage,
  'health': daemonHealthUsage,
};

export function daemonUsage(): void {
  console.log(`Usage: lazy daemon <subcommand> [options]

Manage the lazy daemon process. Each project gets its own daemon.
The daemon serves everything — CLI/agent RPC, MCP, and the web
dashboard — on a single TCP port (default: 26024, loopback-only).

Subcommands:
  start       Start the daemon (includes web dashboard)
  stop        Stop the daemon gracefully
  restart     Restart the daemon
  status      Show daemon status and web dashboard URL (current project)
  health      Check the daemon's moving parts: loops, sweeps, proxy, storage,
              runner, stuck tasks, dashboard (OK / WARN / FAIL per row)
  dashboard-url  Print the web dashboard URL, or exit non-zero if not running
                 (the address only — to SIGN IN, run: lazy dashboard)
  list        List ALL running lazy daemons on this host (marks strays)
  kill-stray  Reap daemons whose project root no longer exists on disk
  logs        Tail the daemon log file (primary debugging tool)
  auto-budget Control + inspect the auto-react daily budget (list/update/pause/resume)
  config      Inspect + override concurrency caps at runtime (get/set/reset, ephemeral)
  resume-queue  Show the slow-lane auto-resume queue (read-only)

Start options:
  --foreground    Run in foreground (don't detach)
  --background    Run in background (default, explicit flag for auto-start)
  --project PATH  Explicit project root (default: auto-detect from cwd)

stop / restart options:
  --yes           Skip the pre-stop confirmation (for non-interactive callers)
  --project PATH  Explicit project root (default: auto-detect from cwd)

Stopping the daemon affects every live session it is responsible for: working
task agents are stopped mid-turn, and live builder and pair sessions keep
running but lose the proxy they reach the model through. stop and restart list
what is running and what happens to each before doing anything; --yes or a
non-TTY still prints the warning but never blocks.

kill-stray options:
  --yes           Skip the confirmation prompt (for non-interactive callers)
  --prune-dirs    Also remove orphaned state dirs whose process is dead

The daemon is required for all CLI commands (except init, daemon, and help).
It auto-starts when you run any command. If auto-start fails, start manually.

Examples:
  lazy daemon start             # Start in background
  lazy daemon start --foreground  # Start in foreground (for debugging)
  lazy daemon status            # Check if running, show web URL
  lazy daemon health            # Is everything inside it still working?
  lazy daemon dashboard-url     # Print the web dashboard URL (for scripting)
  lazy dashboard                # Sign in and open the dashboard in a browser
  lazy daemon stop              # Stop gracefully
  lazy daemon restart           # Stop + start
  lazy daemon list              # Show every daemon on the host
  lazy daemon kill-stray        # Reap daemons whose project root was deleted
  lazy daemon kill-stray --yes --prune-dirs  # Non-interactive full cleanup
  lazy daemon auto-budget list  # Inspect today's auto-react budget
  lazy daemon config get        # Show the builder cap + current usage
  lazy daemon config set builders 4  # Change the builder cap (ephemeral)`);
}
