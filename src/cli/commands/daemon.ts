/**
 * `lazy daemon` command
 *
 * Manages the lazy daemon process lifecycle:
 *   lazy daemon start     — start daemon (detaches by default)
 *   lazy daemon stop      — graceful shutdown via socket RPC
 *   lazy daemon restart   — stop + start
 *   lazy daemon status    — show PID, uptime, socket path
 */

import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { spawn } from '../../utils/spawn';
import { parseFlags } from '../helpers';
import { formatDuration } from '../helpers';
import {
  checkDaemonHealth,
  checkDaemonProcess,
  requestShutdown,
  waitForDaemon,
  cleanupStaleFiles,
  getSocketPath,
  getLogPath,
  acquireStartLock,
  releaseStartLock,
} from '../../daemon';
import { getLazyCommand } from '../../utils/cli-path';

export async function commandDaemon(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'start':
      await daemonStart(subArgs);
      break;
    case 'stop':
      await daemonStop();
      break;
    case 'restart':
      await daemonRestart(subArgs);
      break;
    case 'status':
      await daemonStatus();
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

async function daemonStart(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'foreground', takesValue: false },
    { name: 'background', takesValue: false },
  ], 'daemon start');

  const foreground = parsed.flags.get('foreground') === true;

  // Check if already running
  const status = await checkDaemonHealth();
  if (status.running) {
    console.log(`Daemon is already running (PID ${status.pid})`);
    return;
  }

  if (foreground) {
    // Foreground mode: run the server in this process.
    // No lock needed — foreground is the actual daemon, not a spawner.
    cleanupStaleFiles();
    console.log('Starting daemon in foreground mode...');
    const { startDaemonServer } = await import('../../daemon/server');
    const daemon = startDaemonServer();
    console.log(`Daemon started (PID ${process.pid})`);
    console.log(`Socket: ${daemon.socketPath}`);
    console.log(`Token:  ${daemon.token.substring(0, 8)}...`);
    console.log('Press Ctrl+C to stop.');

    // Keep the process alive
    await new Promise(() => {});
  } else {
    // Background mode: acquire lock to prevent concurrent spawns
    if (!acquireStartLock()) {
      // Another process is starting the daemon — wait for it
      const ready = await waitForDaemon(5000);
      if (ready) {
        const s = await checkDaemonHealth();
        console.log(`Daemon is already starting (PID ${s.pid})`);
      } else {
        console.error('Error: another process is starting the daemon but it did not become ready.');
        process.exit(1);
      }
      return;
    }

    try {
      // Re-check after acquiring lock
      const recheck = await checkDaemonHealth();
      if (recheck.running) {
        console.log(`Daemon is already running (PID ${recheck.pid})`);
        return;
      }

      cleanupStaleFiles();
      await startBackgroundDaemon();
    } finally {
      releaseStartLock();
    }
  }
}

async function startBackgroundDaemon(): Promise<void> {
  const logPath = getLogPath();

  // Ensure daemon directory exists before spawning — Bun.spawn needs the
  // log file's parent directory to exist for stdout/stderr redirection.
  mkdirSync(dirname(logPath), { recursive: true });

  // Fork a detached child running `lazy daemon start --foreground`
  const proc = spawn([...getLazyCommand(), 'daemon', 'start', '--foreground'], {
    stdout: Bun.file(logPath),
    stderr: Bun.file(logPath),
    stdin: 'ignore',
  });

  // Detach the child so it outlives this process
  proc.unref();

  // Wait for the daemon to become available
  const ready = await waitForDaemon(5000);
  if (ready) {
    const status = await checkDaemonHealth();
    console.log(`Daemon started (PID ${status.pid})`);
    console.log(`Socket: ${getSocketPath()}`);
  } else {
    console.error('Error: daemon did not start within 5 seconds.');
    console.error(`Check logs: ${logPath}`);
    process.exit(1);
  }
}

async function daemonStop(): Promise<void> {
  const pid = checkDaemonProcess();
  if (pid === null) {
    console.log('Daemon is not running.');
    return;
  }

  console.log(`Stopping daemon (PID ${pid})...`);
  const stopped = await requestShutdown();

  if (stopped) {
    // Wait briefly for the process to exit
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (checkDaemonProcess() === null) {
        console.log('Daemon stopped.');
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  // If graceful shutdown didn't work, try SIGTERM
  try {
    process.kill(pid, 'SIGTERM');
    console.log('Daemon stopped (SIGTERM).');
  } catch {
    // Process already gone
    console.log('Daemon stopped.');
  }

  cleanupStaleFiles();
}

async function daemonRestart(args: string[]): Promise<void> {
  await daemonStop();
  await daemonStart(args);
}

async function daemonStatus(): Promise<void> {
  const status = await checkDaemonHealth();

  if (!status.running) {
    console.log('Daemon is not running.');
    return;
  }

  console.log('Daemon is running.');
  console.log(`  PID:     ${status.pid}`);
  console.log(`  Socket:  ${status.socketPath}`);
  if (status.uptime !== undefined) {
    console.log(`  Uptime:  ${formatDuration(status.uptime)}`);
  }
  if (status.version) {
    console.log(`  Version: ${status.version}`);
  }
}

export function daemonUsage(): void {
  console.log(`Usage: lazy daemon <subcommand> [options]

Manage the lazy daemon process.

Subcommands:
  start       Start the daemon
  stop        Stop the daemon gracefully
  restart     Restart the daemon
  status      Show daemon status

Start options:
  --foreground    Run in foreground (don't detach)
  --background    Run in background (default, explicit flag for auto-start)

Environment:
  LAZY_NO_DAEMON=1    Disable auto-start of daemon

Examples:
  lazy daemon start             # Start in background
  lazy daemon start --foreground  # Start in foreground (for debugging)
  lazy daemon status            # Check if running
  lazy daemon stop              # Stop gracefully
  lazy daemon restart           # Stop + start`);
}
