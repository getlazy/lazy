/**
 * `lazy daemon` command
 *
 * Manages the lazy daemon process lifecycle:
 *   lazy daemon start     — start daemon (detaches by default)
 *   lazy daemon stop      — graceful shutdown via socket RPC
 *   lazy daemon restart   — stop + start
 *   lazy daemon status    — show PID, uptime, socket path
 *   lazy daemon logs      — tail the daemon log file
 *
 * Per-project: each project gets its own daemon process. Commands must be
 * run inside a lazy project directory (error otherwise).
 *
 * Singleton enforcement: flock(2) is the sole source of truth. Start commands
 * never kill existing daemons — only stop/restart do that.
 */

import { existsSync } from 'fs';
import { rm, readFile } from 'fs/promises';
import { parseFlags, requireLazyRoot } from '../helpers';
import { formatDuration } from '../helpers';
import { describeExpiry } from '../../utils/local-day';
import { isTTY, promptYesNo } from '../editor';
import {
  checkDaemonHealth,
  isDaemonRunning,
  readPid,
  readToken,
  releaseDaemonLock,
  isProcessAlive,
  requestShutdown,
  blockingFlock,
  cleanupStaleFiles,
  getSocketPath,
  getDaemonBaseDir,
  getStartupErrorPath,
  formatDashboardUrl,
  enumerateDaemons,
  type DaemonRecord,
} from '../../daemon';
import { listInteractiveSessions, describeInteractiveSession } from '../../daemon/interactive-registry';
import { startDaemonBackground } from '../../daemon/auto-start';
import { getRunningCodeSha } from '../../daemon/code-version';
import { assertDaemonCredentials } from '../../daemon/credential-gate';
import { collectDaemonStopInventory, confirmDaemonStop } from './daemon-pre-stop';
import { commandLogs, logsUsage } from './logs';
import { commandAutoBudget, autoBudgetUsage } from './auto-budget';
import { commandDaemonConfig, daemonConfigUsage } from './daemon-config';

export async function commandDaemon(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

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
    console.log(`Socket: ${daemon.socketPath}`);
    console.log(`Token:  ${daemon.token.substring(0, 8)}...`);
    if (daemon.webPort) {
      console.log(`Web:    ${formatDashboardUrl(daemon.bindHost, daemon.webPort)}`);
    }
    console.log('Press Ctrl+C to stop.');

    // Keep the process alive
    await new Promise(() => {});
  } else {
    // Background mode: use unified liveness check (socket + token + PID alive).
    // After a crash, socket+token files remain but process is dead — the old
    // check (file existence only) would say "already running" while `daemon status`
    // (which connects to the socket) said "not running".
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
    console.log(`Socket: ${getSocketPath(projectRoot)}`);
    if (status.webPort) {
      console.log(`Web:    ${formatDashboardUrl(status.bindHost, status.webPort)}`);
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
  // After a crash, socket file may exist but process is dead.
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

  // Try graceful shutdown via socket
  const shutdownAccepted = await requestShutdown(projectRoot);

  if (!shutdownAccepted && pid && isProcessAlive(pid)) {
    // Socket shutdown failed — try SIGTERM directly
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }

  // Wait for daemon exit using blocking flock. When flock returns,
  // daemon is dead (OS released the lock on process exit).
  const result = blockingFlock(projectRoot, 5000);
  if (result) {
    // Release BEFORE cleaning up: cleanupStaleFiles refuses while the daemon
    // lock is held, and flock conflicts across separate fds even within one
    // process — so cleaning up while still holding our own probe lock would
    // refuse and leave the files behind.
    releaseDaemonLock(result.fd);
    cleanupStaleFiles(projectRoot);
    console.log('Daemon stopped.');
    return true;
  }

  console.error(`Error: daemon did not stop within 5 seconds.${pid ? ` Try: kill -9 ${pid}` : ''}`);
  process.exit(1);
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
  // If the process is dead but socket file remains (crash), clean up and
  // report "not running" — don't attempt a socket health check that will fail.
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

  // Daemon process is alive — get rich diagnostic info via socket.
  const status = await checkDaemonHealth(projectRoot);

  if (status.running) {
    console.log('Daemon is running.');
    console.log(`  PID:     ${status.pid}`);
    console.log(`  Socket:  ${status.socketPath}`);
    if (status.webPort) {
      console.log(`  Web:     ${formatDashboardUrl(status.bindHost, status.webPort)}`);
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
    // INVARIANT: always print this line. The proxy is on by default, so an absent
    // line would be indistinguishable from a running one and would hide that
    // agent traffic is flowing unaudited.
    if (status.proxy) {
      const p = status.proxy;
      if (!p.enabled) {
        console.log('  Proxy:   disabled ([proxy] enabled = false) — agent traffic connects directly, not audited');
      } else if (p.running && p.address) {
        const fb = `${p.fallbacks} fallback${p.fallbacks === 1 ? '' : 's'}`;
        console.log(`  Proxy:   ${p.address} → ${p.upstream} (${fb}, policy ${p.policyEnforce ? 'on' : 'off'})`);
      } else {
        console.log('  Proxy:   enabled but not running (degraded — restart the daemon)');
      }
    }
    if (status.uptime !== undefined) {
      console.log(`  Uptime:  ${formatDuration(status.uptime)}`);
    }
    if (status.version) {
      console.log(`  Version: ${status.version}`);
    }
    if (status.buildTime) {
      // 'dev' when the daemon runs from source (no build step); otherwise the
      // UTC timestamp embedded into the compiled binary at build time.
      console.log(`  Built:   ${status.buildTime}${status.buildTime === 'dev' ? '' : ' (UTC)'}`);
    }

    // Staleness check (dev mode): the daemon serves whatever code it started
    // with — it does not hot-reload on source changes. When the daemon's running
    // SHA diverges from the working tree's current HEAD, its handlers are stale
    // and on-disk fixes won't take effect until restart. Surface this loudly so
    // the "why is the merged fix not working?" confusion is diagnosable.
    if (status.codeSha) {
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
  } else {
    // Process is alive (isDaemonRunning passed) but socket isn't responding.
    // This can happen if the daemon is still starting up or the HTTP handler is stuck.
    const pid = readPid(projectRoot);
    console.log(`Daemon process is alive${pid ? ` (PID ${pid})` : ''} but not responding on socket.`);
    if (!existsSync(getSocketPath(projectRoot))) {
      // The socket FILE is gone, not just unresponsive — something deleted this
      // daemon's state files while it was running. The daemon repairs that
      // itself within seconds; doctor is the single surface that explains it.
      console.log("Its socket file is missing. Run `lazy doctor` for details.");
    } else {
      console.log('It may be starting up. If this persists, try: lazy daemon restart');
    }
  }
}

/**
 * `lazy daemon dashboard-url` — print the web dashboard URL and exit.
 *
 * Deliberately does NOT auto-start the daemon (unlike the old `lazy server`
 * alias): this is meant for scripting (`open $(lazy daemon dashboard-url)`),
 * where silently spawning a daemon on a bare URL lookup would surprise a
 * caller that just wants to know if one is already up. Same "check, don't
 * start" posture as `lazy daemon status`.
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
    console.error('Error: daemon process is alive but not responding on socket. Try: lazy daemon restart');
    process.exit(1);
  }

  if (!status.webPort) {
    console.error('Error: daemon is running but the web dashboard port is not available.');
    process.exit(1);
  }

  console.log(formatDashboardUrl(status.bindHost, status.webPort));
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

/** SIGTERM a pid, wait up to `timeoutMs` for it to exit, then SIGKILL. */
async function terminatePid(pid: number, timeoutMs = 3000): Promise<void> {
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
};

export function daemonUsage(): void {
  console.log(`Usage: lazy daemon <subcommand> [options]

Manage the lazy daemon process. Each project gets its own daemon.
The daemon serves both the unix socket (for CLI/agent RPC) and
a TCP web dashboard (default port: 26024).

Subcommands:
  start       Start the daemon (includes web dashboard)
  stop        Stop the daemon gracefully
  restart     Restart the daemon
  status      Show daemon status and web dashboard URL (current project)
  dashboard-url  Print the web dashboard URL, or exit non-zero if not running
  list        List ALL running lazy daemons on this host (marks strays)
  kill-stray  Reap daemons whose project root no longer exists on disk
  logs        Tail the daemon log file (primary debugging tool)
  auto-budget Control + inspect the auto-react daily budget (list/update/pause/resume)
  config      Inspect + override concurrency caps at runtime (get/set/reset, ephemeral)

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
  lazy daemon dashboard-url     # Print the web dashboard URL (for scripting)
  open $(lazy daemon dashboard-url)  # Open the dashboard in the default browser
  lazy daemon stop              # Stop gracefully
  lazy daemon restart           # Stop + start
  lazy daemon list              # Show every daemon on the host
  lazy daemon kill-stray        # Reap daemons whose project root was deleted
  lazy daemon kill-stray --yes --prune-dirs  # Non-interactive full cleanup
  lazy daemon auto-budget list  # Inspect today's auto-react budget
  lazy daemon config get        # Show concurrency caps + current usage
  lazy daemon config set max_concurrent_agents 12  # Raise the agent cap (ephemeral)`);
}
