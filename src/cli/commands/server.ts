/**
 * `lazy server` command
 *
 * Launches an HTTP server providing a web dashboard for lazy tasks.
 */

import { startServer } from '../../server';
import { findLazyRoot } from '../init';
import { loadConfig } from '../../config/loader';

export async function commandServer(args: string[]): Promise<void> {
  const root = findLazyRoot();
  const config = root ? loadConfig(root) : null;
  let port = config?.server.port ?? 26024;

  // Parse --port flag (overrides config)
  const portIndex = args.indexOf('--port');
  if (portIndex !== -1 && args[portIndex + 1]) {
    const parsed = parseInt(args[portIndex + 1], 10);
    if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
      console.error('Error: --port must be a number between 1 and 65535');
      process.exit(1);
    }
    port = parsed;
  }

  await startServer(port);
}

export function serverUsage(): void {
  console.log(`Usage: lazy server [--port <port>]

Start an HTTP server providing a web dashboard for lazy tasks.

Options:
  --port <port>  Port to listen on (default: from [server].port in lazy.toml, or 26024)

If the configured port is busy, the server will automatically try the next
port, up to 100 attempts.

The server provides:
  - Task list with status filtering
  - Task detail view with sessions, turns, commits, notes
  - Full-text search
  - JSON API at /api/tasks

Examples:
  lazy server              # Start on configured port (default: 26024)
  lazy server --port 8080  # Start on port 8080`);
}
