/**
 * `lazy daemon` command
 *
 * Manages the lazy daemon process lifecycle:
 *   lazy daemon start     — start daemon (detaches by default)
 *   lazy daemon stop      — graceful shutdown via socket RPC
 *   lazy daemon restart   — stop + start
 *   lazy daemon status    — show PID, uptime, socket path
 *
 * Per-project: each project gets its own daemon process. Commands must be
 * run inside a lazy project directory (error otherwise).
 *
 * Singleton enforcement: flock(2) is the sole source of truth. Start commands
 * never kill existing daemons — only stop/restart do that.
 */

import { existsSync } from 'fs';
import { parseFlags, requireLazyRoot } from '../helpers';
import { formatDuration } from '../helpers';
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
} from '../../daemon';
import { startDaemonBackground } from '../../daemon/auto-start';
import { commandLogs } from './logs';

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
    case 'logs':
      await daemonLogs(subArgs);
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
      console.log(`Web:    http://localhost:${daemon.webPort}`);
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
      console.log(`Web:    http://localhost:${status.webPort}`);
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
      console.log(`  Web:     http://localhost:${status.webPort}`);
    }
    if (status.uptime !== undefined) {
      console.log(`  Uptime:  ${formatDuration(status.uptime)}`);
    }
    if (status.version) {
      console.log(`  Version: ${status.version}`);
    }

    // Auto-react budget info
    if (status.autoReactBudget && status.autoReactBudget.length > 0) {
      console.log('');
      console.log('  Auto-react budget:');
      for (const entry of status.autoReactBudget) {
        console.log(`    ${entry.project}: ${entry.used}/${entry.limit} turns today`);
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
  status      Show daemon status and web dashboard URL
  logs        Tail the daemon log file (same as \`lazy logs\`)

Start options:
  --foreground    Run in foreground (don't detach)
  --background    Run in background (default, explicit flag for auto-start)
  --project PATH  Explicit project root (default: auto-detect from cwd)

The daemon is required for all CLI commands (except init, daemon, and help).
It auto-starts when you run any command. If auto-start fails, start manually.

Examples:
  lazy daemon start             # Start in background
  lazy daemon start --foreground  # Start in foreground (for debugging)
  lazy daemon status            # Check if running, show web URL
  lazy daemon stop              # Stop gracefully
  lazy daemon restart           # Stop + start`);
}
