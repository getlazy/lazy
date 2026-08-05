/**
 * Daemon RPC client — sends commands to the daemon over unix socket.
 *
 * Used by CLI commands to route read-only operations through the daemon.
 * In v0.11+, the daemon is required — if it's unavailable, commands fail
 * with an actionable error instead of falling back to direct execution.
 */

import { existsSync } from 'fs';
import {
  heartbeatRequestHeaders,
  isHeartbeatEnvelope,
  readHeartbeatEnvelope,
  DaemonConnectionLostError,
} from './heartbeat';
import { getSocketPath } from './paths';
import { readToken } from './lifecycle';
import { findLazyRoot } from '../cli/init';
import type { ProgressEmitter } from './progress';

/** Optional observers for a long RPC's mid-flight envelope lines. */
export interface RpcObservers {
  /** Phase-progress the daemon narrated (see ./progress.ts). */
  onProgress?: ProgressEmitter;
  /** Liveness ticks: daemon-reported elapsed ms and the phase in flight. */
  onHeartbeat?: (elapsedMs: number, phase?: string) => void;
}

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

/**
 * Build the fetch URL + options for a daemon RPC call.
 *
 * The daemon exposes the same `/rpc/{command}` handler on two transports:
 *   - a unix socket (host-side CLI) — `target` is the socket file path
 *   - the TCP web server (containers) — `target` is an `http(s)://host:port` base
 *
 * A container (e.g. the builder supervisor) cannot reach the unix socket, so it
 * must talk to the daemon over TCP via the `target` in its daemon MCP config
 * (`http://host.docker.internal:<webPort>`). Pure and exported so the
 * unix-vs-TCP branching is unit-testable without a live daemon.
 */
export function buildDaemonRpcRequest(
  target: string,
  token: string,
  command: string,
  project: string,
  params: Record<string, unknown>,
): { url: string; options: Record<string, unknown> } {
  const isHttp = target.startsWith('http://') || target.startsWith('https://');
  const options: Record<string, unknown> = {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Lazy-Project': project,
      // Ask for heartbeat framing so a long call (wait's 600s long-poll, a big
      // accept/merge) is not reaped by the listener's idle timer. A daemon too
      // old to understand the header just replies with plain JSON, which
      // `rpc()` still handles.
      ...heartbeatRequestHeaders(),
    },
    body: JSON.stringify(params),
  };
  let url: string;
  if (isHttp) {
    // TCP web server: target is the base URL.
    url = `${target}/rpc/${command}`;
  } else {
    // Unix socket: Bun routes the request to the socket file via `unix`.
    url = `http://localhost/rpc/${command}`;
    options.unix = target;
  }
  return { url, options };
}

/**
 * Re-read the client's credential source and return current values.
 *
 * Long-lived clients (the in-container builder supervisor's RemoteStorage)
 * outlive daemon restarts. When the daemon moves port or rotates its token, the
 * client's frozen pair stops authenticating and every write fails with 401 for
 * the rest of the session. A refresher lets the client re-read the SAME trusted
 * local source it was minted from and retry once. Return null when the source
 * is unreadable.
 */
export type DaemonCredentialSource = () => Promise<{ target: string; token: string } | null>;

export class DaemonClient {
  constructor(
    /** Either a unix socket path (host) or an http(s):// base URL (container). */
    private target: string,
    private token: string,
    /** Optional re-read of the credential source, used once per 401. */
    private credentialSource?: DaemonCredentialSource,
  ) {}

  /**
   * Create a client for a specific project's daemon over its unix socket.
   * Returns null if socket or token file doesn't exist.
   */
  static create(projectRoot: string): DaemonClient | null {
    const socketPath = getSocketPath(projectRoot);
    if (!existsSync(socketPath)) return null;

    const token = readToken(projectRoot);
    if (!token) return null;

    // On the host the token file itself is the live source: a daemon restart
    // that rotates the token is picked up by re-reading it.
    return new DaemonClient(socketPath, token, async () => {
      const fresh = readToken(projectRoot);
      return fresh ? { target: socketPath, token: fresh } : null;
    });
  }

  /**
   * Create a client for an explicit target + token.
   *
   * Used inside containers (the builder supervisor), where the daemon is only
   * reachable over TCP at the `target` carried by the daemon MCP config
   * (`http://host.docker.internal:<webPort>`) — the unix socket does not exist
   * in the container.
   */
  static fromTarget(
    target: string,
    token: string,
    credentialSource?: DaemonCredentialSource,
  ): DaemonClient {
    return new DaemonClient(target, token, credentialSource);
  }

  /**
   * Send an RPC request to the daemon.
   * Throws RpcApplicationError on non-2xx responses (daemon responded with error).
   * Throws other errors on network/transport failures (daemon unreachable).
   *
   * A 401 triggers exactly one re-read of the credential source and one retry
   * (see DaemonCredentialSource). This never weakens auth: the retry uses
   * credentials from the same trusted local file, and a second 401 is final.
   */
  async rpc(
    command: string,
    project: string,
    params: Record<string, unknown> = {},
    observers?: RpcObservers,
  ): Promise<unknown> {
    let response = await this.send(command, project, params);

    if (response.status === 401 && this.credentialSource) {
      const fresh = await this.credentialSource().catch(() => null);
      if (fresh && (fresh.token !== this.token || fresh.target !== this.target)) {
        this.target = fresh.target;
        this.token = fresh.token;
        response = await this.send(command, project, params);
      }
    }

    // A heartbeat-framed reply always carries HTTP 200 — the real status is in
    // the envelope's final line, so unwrap before deciding success or failure.
    // A stream that ends without that line throws DaemonConnectionLostError,
    // which is deliberately NOT reported as an unreachable daemon.
    if (isHeartbeatEnvelope(response)) {
      const { status, body } = await readHeartbeatEnvelope(
        response, command, observers?.onHeartbeat, observers?.onProgress,
      );
      if (status < 200 || status >= 300) {
        const detail = typeof (body as { error?: unknown })?.error === 'string'
          ? (body as { error: string }).error
          : JSON.stringify(body ?? null);
        throw new RpcApplicationError(status, `RPC ${command} failed: ${status} ${detail}`);
      }
      return body;
    }

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

  private async send(
    command: string,
    project: string,
    params: Record<string, unknown>,
  ): Promise<Response> {
    const { url, options } = buildDaemonRpcRequest(this.target, this.token, command, project, params);
    return await fetch(url, options as any);
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
 * Error thrown when a daemon-backed command runs outside a lazy project.
 *
 * Distinct from DaemonNotRunningError on purpose: there is no project for a
 * daemon to bind to, so telling the user to run `lazy daemon start` sends them
 * down a path that cannot work. The actionable problem is initialization.
 * Wording matches requireLazyRoot() so both entry points read the same.
 */
export class NotALazyProjectError extends Error {
  constructor() {
    super('not in a lazy project. Run `lazy init` first.');
    this.name = 'NotALazyProjectError';
  }
}

/**
 * True when {@link tryRpc} deliberately does NOT talk to a daemon and returns
 * null regardless of whether one is running.
 *
 * This is an EXPLICIT signal, exported so callers can distinguish "the daemon
 * was bypassed by design" from "the daemon should have answered and didn't".
 * A null from `tryRpc` alone cannot tell those apart, and treating every null
 * as benign is exactly how a fail-hard path degrades into a silent fallback
 * (see resolveLiveProxyUrl in daemon/auth-env.ts).
 *
 * - LAZY_TEST=1: the test harness runs the CLI without a daemon by design.
 * - LAZY_IS_DAEMON=1: the daemon must not RPC itself; it reads its own context.
 */
export function isDaemonRpcBypassed(): boolean {
  return process.env.LAZY_TEST === '1' || process.env.LAZY_IS_DAEMON === '1';
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
export async function tryRpc<T>(
  command: string,
  params: Record<string, unknown> = {},
  observers?: RpcObservers,
): Promise<T | null> {
  // Test mode and daemon-self bypass still return null
  if (isDaemonRpcBypassed()) return null;

  const root = findLazyRoot();
  if (!root) throw new NotALazyProjectError();

  const client = DaemonClient.create(root);
  if (!client) throw new DaemonNotRunningError();

  try {
    return await client.rpc(command, root, params, observers) as T;
  } catch (err) {
    // Application-level error (daemon responded with error) — surface it directly
    if (err instanceof RpcApplicationError) {
      throw err;
    }

    // The daemon answered and then the connection died mid-operation. That is a
    // different fault from "the daemon is not reachable", and the message
    // already says what to do — do not bury it under "restart the daemon".
    if (err instanceof DaemonConnectionLostError) {
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
