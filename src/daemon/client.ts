/**
 * Daemon RPC client — sends commands to the daemon over unix socket.
 *
 * Used by CLI commands to route read-only operations through the daemon.
 * Falls back gracefully: if the daemon is unavailable, returns null
 * so the CLI can execute commands directly.
 */

import { existsSync } from 'fs';
import { getSocketPath } from './paths';
import { readToken } from './lifecycle';
import { findLazyRoot } from '../cli/init';

export class DaemonClient {
  constructor(
    private socketPath: string,
    private token: string,
  ) {}

  /**
   * Create a client if the daemon appears to be running.
   * Returns null if socket or token file doesn't exist.
   */
  static create(): DaemonClient | null {
    const socketPath = getSocketPath();
    if (!existsSync(socketPath)) return null;

    const token = readToken();
    if (!token) return null;

    return new DaemonClient(socketPath, token);
  }

  /**
   * Send an RPC request to the daemon.
   * Throws on non-200 responses or network errors.
   */
  async rpc(command: string, project: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const response = await fetch(`http://localhost/rpc/${command}`, {
      method: 'POST',
      unix: this.socketPath,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'X-Lazy-Project': project,
      },
      body: JSON.stringify(params),
    } as any);

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`RPC ${command} failed: ${response.status} ${body}`);
    }

    return response.json();
  }
}

/**
 * Try to execute a command via the daemon RPC.
 * Returns null if daemon is unavailable, disabled, or RPC fails.
 *
 * This is the primary interface for CLI commands to attempt daemon routing.
 * Usage: `const data = await tryRpc<MyType>('list', { all: true });`
 */
export async function tryRpc<T>(command: string, params: Record<string, unknown> = {}): Promise<T | null> {
  // Skip daemon in test mode, when explicitly disabled, or when we ARE the daemon
  if (process.env.LAZY_NO_DAEMON === '1') return null;
  if (process.env.LAZY_TEST === '1') return null;
  if (process.env.LAZY_IS_DAEMON === '1') return null;

  const client = DaemonClient.create();
  if (!client) return null;

  const root = findLazyRoot();
  if (!root) return null;

  try {
    return await client.rpc(command, root, params) as T;
  } catch {
    // Daemon unavailable or RPC failed — fall back to direct mode
    return null;
  }
}
