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
import { rm } from 'fs/promises';
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
  formatDashboardUrl,
  enumerateDaemons,
  type DaemonRecord,
} from '../../daemon';
import { startDaemonBackground } from '../../daemon/auto-start';
import { assertDaemonCredentials } from '../../daemon/credential-gate';
import { commandLogs } from './logs';
import { commandAutoBudget } from './auto-budget';

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
    // Credential gate (single enforcement point for auth). The background path
    // checks this inside startDaemonBackground before spawning; the foreground
    // path starts the server in-process, so gate here too. This also covers the
    // detached child, which runs `daemon start --foreground`.
    await assertDaemonCredentials(projectRoot);

    // Foreground mode: startDaemonServer() acquires the flock internally.
    // If lock held → throws "Already running." If not → starts. One path.
    cleanupStaleFiles(projectRoot);
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

async function daemonStop(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'project', takesValue: true },
  ], 'daemon stop');
  const projectRoot = resolveProjectRoot(parsed.flags);

  // Use unified liveness check — same as start and status.
  // After a crash, socket file may exist but process is dead.
  if (!isDaemonRunning(projectRoot)) {
    // Clean up stale files from a previous crash so the next start works cleanly
    cleanupStaleFiles(projectRoot);
    console.log('Daemon is not running.');
    return;
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
    releaseDaemonLock(result.fd);
    cleanupStaleFiles(projectRoot);
    console.log('Daemon stopped.');
    return;
  }

  console.error(`Error: daemon did not stop within 5 seconds.${pid ? ` Try: kill -9 ${pid}` : ''}`);
  process.exit(1);
}

async function daemonRestart(args: string[]): Promise<void> {
  await daemonStop(args);
  await daemonStart(args);
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
    console.log('It may be starting up. If this persists, try: lazy daemon restart');
  }
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
      `${deadDirs.length} orphaned daemon state dir${deadDirs.length === 1 ? '' : 's'} (no live process) under ${getDaemonBaseDir()}.`,
    );
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
 * `--prune-dirs` additionally removes orphaned state dirs whose pid is dead, so
 * the dir count under the daemon base dir doesn't grow unbounded after crashes.
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
  // Dead-pid dirs are pruning candidates only. A live daemon with an unknown
  // root is intentionally excluded — we can't prove its root is gone.
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
  list        List ALL running lazy daemons on this host (marks strays)
  kill-stray  Reap daemons whose project root no longer exists on disk
  logs        Tail the daemon log file (primary debugging tool)
  auto-budget Control + inspect the auto-react daily budget (list/update/pause/resume)

Start options:
  --foreground    Run in foreground (don't detach)
  --background    Run in background (default, explicit flag for auto-start)
  --project PATH  Explicit project root (default: auto-detect from cwd)

kill-stray options:
  --yes           Skip the confirmation prompt (for non-interactive callers)
  --prune-dirs    Also remove orphaned state dirs whose process is dead

The daemon is required for all CLI commands (except init, daemon, and help).
It auto-starts when you run any command. If auto-start fails, start manually.

Examples:
  lazy daemon start             # Start in background
  lazy daemon start --foreground  # Start in foreground (for debugging)
  lazy daemon status            # Check if running, show web URL
  lazy daemon stop              # Stop gracefully
  lazy daemon restart           # Stop + start
  lazy daemon list              # Show every daemon on the host
  lazy daemon kill-stray        # Reap daemons whose project root was deleted
  lazy daemon kill-stray --yes --prune-dirs  # Non-interactive full cleanup
  lazy daemon auto-budget list  # Inspect today's auto-react budget`);
}
