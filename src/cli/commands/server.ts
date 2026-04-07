/**
 * `lazy server` command
 *
 * Alias for the daemon's built-in web dashboard.
 *
 * In normal mode: ensures the daemon is running, prints the web dashboard URL.
 * In standalone mode (--port flag or test env): starts a standalone HTTP server
 * on the specified port, same as the old `lazy server` behavior.
 */

import {
  checkDaemonHealth,
  ensureDaemon,
} from '../../daemon';
import { startServer } from '../../server';
import { findLazyRoot } from '../init';
import { loadConfig } from '../../config/loader';
import { DEFAULT_WEB_PORT } from '../../config/constants';

export async function commandServer(args: string[]): Promise<void> {
  // Parse --port flag
  const portIndex = args.indexOf('--port');
  let explicitPort: number | undefined;
  if (portIndex !== -1 && args[portIndex + 1]) {
    const parsed = parseInt(args[portIndex + 1], 10);
    if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
      console.error('Error: --port must be a number between 1 and 65535');
      process.exit(1);
    }
    explicitPort = parsed;
  }

  // If --port is given, or we're in test mode, use standalone mode.
  if (explicitPort !== undefined || process.env.LAZY_TEST === '1') {
    const root = findLazyRoot();
    const config = root ? await loadConfig(root) : null;
    const port = explicitPort ?? config?.server.port ?? DEFAULT_WEB_PORT;
    await startServer(port);
    return;
  }

  // Normal mode: start daemon and print URL
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
    console.log(`Web dashboard: http://localhost:${status.webPort}`);
  } else {
    console.log('Daemon is running but web dashboard port is not available.');
    console.log('Check daemon status: lazy daemon status');
  }
}

export function serverUsage(): void {
  console.log(`Usage: lazy server [--port <port>]

Start the web dashboard server.

When run without --port, starts the daemon (if not already running) and prints
the web dashboard URL. The web dashboard is built into the daemon and binds to
TCP port 26024 by default (configurable via [server].port in lazy.toml).

When run with --port, starts a standalone HTTP server on the specified port
(legacy mode, without the daemon).

Options:
  --port <port>  Start standalone server on this port (bypasses daemon)

Examples:
  lazy server              # Start daemon and show web URL
  lazy server --port 8080  # Start standalone server on port 8080
  lazy daemon status       # Check daemon and web dashboard status
  lazy daemon stop         # Stop daemon (and web dashboard)`);
}
