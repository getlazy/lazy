/**
 * `lazy server` command
 *
 * Thin alias for the daemon's built-in web dashboard. Ensures the daemon is
 * running and prints the dashboard URL. The dashboard is served by the daemon
 * itself (the single storage writer) — there is no separate standalone server.
 */

import {
  checkDaemonHealth,
  ensureDaemon,
  formatDashboardUrl,
} from '../../daemon';
import { findLazyRoot } from '../init';

export async function commandServer(_args: string[]): Promise<void> {
  const root = findLazyRoot();
  if (!root) {
    console.error('Error: not in a lazy project. Run `lazy init` first.');
    process.exit(1);
  }

  let status = await checkDaemonHealth(root);

  if (!status.running) {
    const started = await ensureDaemon('server', root);
    if (!started) {
      console.error('Error: could not start daemon. Run `lazy daemon start` manually.');
      process.exit(1);
    }
    status = await checkDaemonHealth(root);
  }

  if (!status.running) {
    console.error('Error: daemon is not running.');
    process.exit(1);
  }

  if (status.webPort) {
    console.log(`Web dashboard: ${formatDashboardUrl(status.bindHost, status.webPort)}`);
  } else {
    console.log('Daemon is running but web dashboard port is not available.');
    console.log('Check daemon status: lazy daemon status');
  }
}

export function serverUsage(): void {
  console.log(`Usage: lazy server

Show the web dashboard URL.

Ensures the daemon is running (starting it if needed) and prints the URL of the
web dashboard. The dashboard is built into the daemon and binds to TCP port
26024 by default (configurable via [server].port in lazy.toml).

Examples:
  lazy server          # Start daemon (if needed) and show web dashboard URL
  lazy daemon status   # Check daemon and web dashboard status
  lazy daemon stop     # Stop daemon (and web dashboard)`);
}
