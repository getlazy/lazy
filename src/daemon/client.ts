/**
 * Daemon RPC client — sends commands to the daemon over unix socket.
 *
 * Used by CLI commands to route read-only operations through the daemon.
 * In v0.11+, the daemon is required — if it's unavailable, commands fail
 * with an actionable error instead of falling back to direct execution.
 */

import { existsSync } from 'fs';
import { getSocketPath } from './paths';
import { readToken } from './lifecycle';
import { findLazyRoot } from '../cli/init';

/**
 * Error thrown when the daemon responds with a non-2xx status code.
 * This indicates an application-level error (e.g., 409 Conflict), not a transport error.
 * The daemon is working correctly — it just rejected the request with a meaningful error.
 */
export class RpcApplicationError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'RpcApplicationError';
  }
}

export class DaemonClient {
  constructor(
    private socketPath: string,
    private token: string,
  ) {}

  /**
   * Create a client for a specific project's daemon.
   * Returns null if socket or token file doesn't exist.
   */
  static create(projectRoot: string): DaemonClient | null {
    const socketPath = getSocketPath(projectRoot);
    if (!existsSync(socketPath)) return null;

    const token = readToken(projectRoot);
    if (!token) return null;

    return new DaemonClient(socketPath, token);
  }

  /**
   * Send an RPC request to the daemon.
   * Throws RpcApplicationError on non-2xx responses (daemon responded with error).
   * Throws other errors on network/transport failures (daemon unreachable).
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
      // Application-level error — daemon responded but rejected the request
      throw new RpcApplicationError(
        response.status,
        `RPC ${command} failed: ${response.status} ${body}`,
      );
    }

    return response.json();
  }
}

/**
 * Error thrown when the daemon is required but not available.
 */
export class DaemonNotRunningError extends Error {
  constructor() {
    super(
      'Daemon is not running.\n' +
      'The lazy daemon is required for CLI commands. Start it with:\n\n' +
      '  lazy daemon start\n',
    );
    this.name = 'DaemonNotRunningError';
  }
}

/**
 * Execute a command via the daemon RPC.
 *
 * In v0.11+, the daemon is required. This function throws DaemonNotRunningError
 * if the daemon is unavailable, instead of returning null.
 *
 * Exceptions:
 * - LAZY_TEST=1: returns null (test infrastructure bypasses daemon)
 * - LAZY_IS_DAEMON=1: returns null (daemon process avoids calling itself)
 */
export async function tryRpc<T>(command: string, params: Record<string, unknown> = {}): Promise<T | null> {
  // Test mode and daemon-self bypass still return null
  if (process.env.LAZY_TEST === '1') return null;
  if (process.env.LAZY_IS_DAEMON === '1') return null;

  const root = findLazyRoot();
  if (!root) throw new DaemonNotRunningError();

  const client = DaemonClient.create(root);
  if (!client) throw new DaemonNotRunningError();

  try {
    return await client.rpc(command, root, params) as T;
  } catch (err) {
    // Application-level error (daemon responded with error) — surface it directly
    if (err instanceof RpcApplicationError) {
      throw err;
    }

    // Transport error (daemon unreachable, connection failed) — add troubleshooting advice
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Daemon RPC failed: ${msg}\n` +
      'Check daemon status with: lazy daemon status\n' +
      'Restart it with: lazy daemon restart',
    );
  }
}
