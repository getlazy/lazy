/**
 * Daemon RPC client — sends commands to the daemon over its TCP port, the
 * daemon's only transport.
 *
 * Used by CLI commands to route read-only operations through the daemon.
 * In v0.11+, the daemon is required — if it's unavailable, commands fail
 * with an actionable error instead of falling back to direct execution.
 */

import { parseAcceptRemedy } from '../types';
import type { AcceptRemedy } from '../types';
import {
  heartbeatRequestHeaders,
  isHeartbeatEnvelope,
  readHeartbeatEnvelope,
  DaemonConnectionLostError,
} from './heartbeat';
import { currentTraceparent } from '../tracing';
import { readToken, getDaemonTcpTarget } from './lifecycle';
import { findLazyRoot } from '../project-paths';
import type { ProgressEmitter } from './progress';
import { resolveTeamsLogin } from '../teams/login';

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
    /**
     * The structured remedy the daemon attached to a refused accept, if any.
     * Carried across the wire so a client (the review page talking to a daemon
     * in another process) has exactly what an in-process caller has, instead of
     * re-deriving next steps from the message prose.
     */
    public readonly remedy?: AcceptRemedy,
  ) {
    super(message);
    this.name = 'RpcApplicationError';
  }
}

/** `{ traceparent }` when this process has an active span, `{}` otherwise. */
function traceparentHeader(): Record<string, string> {
  const traceparent = currentTraceparent();
  return traceparent ? { traceparent } : {};
}

/**
 * Build the fetch URL + options for a daemon RPC call.
 *
 * `target` is always an `http(s)://host:port` base: the host-side CLI reaches
 * the daemon at its recorded loopback address (see getDaemonTcpTarget), and a
 * container (e.g. the builder supervisor) at the `target` in its daemon MCP
 * config (`http://host.docker.internal:<webPort>`). Pure and exported so the
 * request shape is unit-testable without a live daemon.
 */
export function buildDaemonRpcRequest(
  target: string,
  token: string,
  command: string,
  project: string,
  params: Record<string, unknown>,
  /**
   * Which daemon route family to post to. `rpc` (the default) is the full CLI
   * pass-through, gated on the SHARED daemon token. `builder` is the narrow
   * capture surface a builder container reaches with its per-identity MCP token
   * — see the /builder/storage route in src/daemon/server.ts for why the two
   * cannot be one route.
   */
  routePrefix: DaemonRoutePrefix = 'rpc',
): { url: string; options: Record<string, unknown> } {
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
      // W3C trace context, so the daemon's request span lands in the same trace
      // as the CLI command that made the call and `lazy stats timings` shows one
      // request end to end. Empty when this process isn't tracing.
      ...traceparentHeader(),
    },
    body: JSON.stringify(params),
  };
  return { url: `${target}/${routePrefix}/${command}`, options };
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

/**
 * Daemon route family a client posts to.
 *
 * `rpc` — POST /rpc/<command>, the full CLI pass-through. Requires the SHARED
 * daemon token; that is why host-side clients use it and containers do not.
 *
 * `builder` — POST /builder/<command>, the narrow capture surface authenticated
 * with a builder-session MCP token. Today the one command is `storage`, and the
 * daemon allowlists which Storage methods it will run (BUILDER_STORAGE_METHODS).
 */
export type DaemonRoutePrefix = 'rpc' | 'builder';

export class DaemonClient {
  constructor(
    /** An http(s):// base URL where the daemon listens. */
    private target: string,
    private token: string,
    /** Optional re-read of the credential source, used once per 401. */
    private credentialSource?: DaemonCredentialSource,
    /**
     * Route family every call from this client goes to. Fixed per client
     * because it is a property of the CREDENTIAL, not of the call: a client
     * holding a builder MCP token can only ever reach /builder/*, and one
     * holding the shared daemon token has no reason to leave /rpc/*.
     */
    private routePrefix: DaemonRoutePrefix = 'rpc',
  ) {}

  /**
   * The Teams install and project this client reaches, when it belongs to a
   * bound clone — null for a local daemon. Read by the error paths below: a
   * bound clone has no local daemon, so `lazy daemon start|status|restart`
   * (which refuse there) is never the remedy for a failure to reach Teams.
   */
  teams: TeamsTarget | null = null;

  /**
   * Create a client for a specific project's daemon, at either of two
   * targets — a bound clone (design doc §4.4, §4.7) never has a local daemon
   * or store at all, and the login record decides which this is:
   *
   * - **Bound**: the client points at Teams' proxy route
   *   (`<teamsUrl>/api/projects/<project>/rpc`) carrying the clone's
   *   CLI-scoped ApiToken. This is the ONE seam the design routes the whole
   *   remote-client change through — `RemoteStorage`, the typed RPC wrappers
   *   and every `lazy_*` tool are unchanged, because none of them know where
   *   the daemon is.
   * - **Local**: the recorded TCP address and shared daemon token (see
   *   `getDaemonTcpTarget`), exactly as before.
   *
   * Returns null if neither a login record nor a local port marker/token
   * exists.
   */
  static async create(projectRoot: string): Promise<DaemonClient | null> {
    const bound = await resolveTeamsLogin(projectRoot);
    if (bound) {
      // The path segment IS `/api/projects/<slug>/rpc` already, so the base
      // handed to `buildDaemonRpcRequest` must stop one segment short of
      // `rpc` — that function appends `/${routePrefix}/${command}` itself.
      const target = `${bound.login.binding.teams_url}/api/projects/${bound.login.binding.project}`;
      const client = new DaemonClient(target, bound.token, async () => {
        // Re-reads the credential store, not a token FILE — there is no
        // local marker file for a bound clone. One re-read either way: a
        // revoked or rotated ApiToken surfaces as a second 401, which is
        // final, exactly as it is for the local path below.
        const fresh = await resolveTeamsLogin(projectRoot);
        return fresh ? { target, token: fresh.token } : null;
      });
      client.teams = { url: bound.login.binding.teams_url, project: bound.login.binding.project };
      return client;
    }

    const target = getDaemonTcpTarget(projectRoot);
    if (!target) return null;

    const token = readToken(projectRoot);
    if (!token) return null;

    // On the host the marker/token files themselves are the live source: a
    // daemon restart that moves port or rotates the token is picked up by
    // re-reading them.
    return new DaemonClient(target, token, async () => {
      const freshTarget = getDaemonTcpTarget(projectRoot);
      const fresh = readToken(projectRoot);
      return fresh && freshTarget ? { target: freshTarget, token: fresh } : null;
    });
  }

  /**
   * Create a client for an explicit target + token.
   *
   * Used inside containers (the builder supervisor), where the daemon is
   * reachable at the `target` carried by the daemon MCP config
   * (`http://host.docker.internal:<webPort>`).
   *
   * `routePrefix` must match the KIND of token being presented. A container's
   * daemon MCP config carries a per-identity MCP token, which /rpc/* rejects by
   * design — such a caller passes 'builder' and reaches the narrow capture
   * surface instead. Getting this wrong is a 401 on every call, which is
   * exactly the bug this parameter exists to make unrepeatable.
   */
  static fromTarget(
    target: string,
    token: string,
    credentialSource?: DaemonCredentialSource,
    routePrefix: DaemonRoutePrefix = 'rpc',
  ): DaemonClient {
    return new DaemonClient(target, token, credentialSource, routePrefix);
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
    /**
     * Abort the call in flight. A long-lived subscription (`lazy watch`'s
     * traffic stream) must be able to let go of its window immediately when the
     * task it is watching finishes — without one, the pending request keeps the
     * connection and the process alive for the rest of the window.
     */
    signal?: AbortSignal,
  ): Promise<unknown> {
    let response = await this.send(command, project, params, signal);

    if (response.status === 401 && this.credentialSource) {
      const fresh = await this.credentialSource().catch(() => null);
      if (fresh && (fresh.token !== this.token || fresh.target !== this.target)) {
        this.target = fresh.target;
        this.token = fresh.token;
        response = await this.send(command, project, params, signal);
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
        throw new RpcApplicationError(
          status,
          `RPC ${command} failed: ${status} ${detail}`,
          parseAcceptRemedy((body as { remedy?: unknown })?.remedy),
        );
      }
      return body;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      if (this.teams) {
        const refused = teamsCommandRefusal(this.teams, response.status, body, command, params);
        if (refused) throw refused;
      }
      // Application-level error — daemon responded but rejected the request.
      // The body is JSON in every daemon reply; a non-JSON body (a proxy page,
      // a truncated stream) is not an error worth surfacing here, so it simply
      // yields no remedy and the text still reaches the message.
      let remedy: AcceptRemedy | undefined;
      try {
        remedy = parseAcceptRemedy((JSON.parse(body) as { remedy?: unknown })?.remedy);
      } catch {
        remedy = undefined;
      }
      throw new RpcApplicationError(
        response.status,
        `RPC ${command} failed: ${response.status} ${body}`,
        remedy,
      );
    }

    return response.json();
  }

  private async send(
    command: string,
    project: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const { url, options } = buildDaemonRpcRequest(
      this.target, this.token, command, project, params, this.routePrefix,
    );
    // Applied here rather than inside the pure request builder: aborting is a
    // property of THIS call, not of the request's shape.
    if (signal) options.signal = signal;
    return await fetch(url, options as any);
  }
}

/** Which Teams install and project a bound clone's client reaches. */
export interface TeamsTarget {
  url: string;
  project: string;
}

/**
 * Teams answered "this command is not offered through the proxy" — the Rails
 * route's refuse-by-default for anything its tables do not admit (the browser
 * could not do it either, so a bound clone may not).
 *
 * Deliberately NOT an {@link RpcApplicationError}: several callers read a 404
 * from the daemon as "no such task" and fall back quietly, and a command Teams
 * will never run is not an absent task.
 */
export class TeamsCommandRefusedError extends Error {
  constructor(message: string, readonly refused: string) {
    super(message);
    this.name = 'TeamsCommandRefusedError';
  }
}

/**
 * Turn the proxy's own refusal into one that names the binding and the way
 * forward. The route's wording ("Unknown or unsupported command 'storage'")
 * names neither the install nor, for a storage call, the method that was
 * refused, and tells a person nothing about what to do. Returns null for any
 * other failure, which keeps its own wording.
 */
export function teamsCommandRefusal(
  teams: TeamsTarget,
  status: number,
  body: string,
  command: string,
  params: Record<string, unknown>,
): TeamsCommandRefusedError | null {
  const way =
    'Use the Teams web UI where it offers this, or a server-side builder session (`lazy builder`), ' +
    'which runs where the project lives — or run `lazy logout` to work on this clone as a local project instead.';
  // The route's content refusals (a body key or a task setting the browser
  // could not have sent) already say what was refused; they lack the install
  // and the way forward. Status 403 alone is not enough — an authorization
  // refusal is also a 403 and says something else.
  if (status === 403 && /from a clone logged in to Lazy Teams/.test(body)) {
    let reason = body;
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (typeof parsed.error === 'string') reason = parsed.error;
    } catch {
      // Not JSON: the raw body is the best wording there is, so it is used as is.
    }
    return new TeamsCommandRefusedError(
      `This clone is bound to Lazy Teams (${teams.project} on ${teams.url}), and Teams refused the request: ` +
      `${reason} ${way}`,
      command === 'storage' && typeof params.method === 'string' ? `storage.${params.method}` : command,
    );
  }
  if (status !== 404 || !/Unknown or unsupported command '/.test(body)) return null;
  const refused = command === 'storage' && typeof params.method === 'string'
    ? `storage.${params.method}`
    : command;
  return new TeamsCommandRefusedError(
    `This clone is bound to Lazy Teams (${teams.project} on ${teams.url}), and Teams does not offer ` +
    `'${refused}' to a bound clone. ${way}`,
    refused,
  );
}

/**
 * The error a bound clone shows when a call to Teams fails in a way the
 * local-daemon remedies would otherwise describe: Teams unreachable, the
 * connection dropped mid-call, or the login refused (a final 401 — revoked or
 * expired token). Every `lazy daemon …` command refuses in a bound clone, so
 * suggesting one would send the person between two dead ends; instead this
 * names the install and project, and the two ways forward.
 *
 * Returns `err` unchanged for anything else — an application refusal other
 * than 401 is the daemon's own answer and already says what to do.
 */
export function boundCloneFailure(teams: TeamsTarget, err: unknown): unknown {
  // Teams was reached and answered: it already names the binding and the way forward.
  if (err instanceof TeamsCommandRefusedError) return err;
  const where = `${teams.project} on ${teams.url}`;
  const ways =
    'Run `lazy login` to sign in again, or `lazy logout` to work on this clone as a local project instead.';
  if (err instanceof RpcApplicationError) {
    if (err.status !== 401) return err;
    return new RpcApplicationError(401, `Lazy Teams refused this clone's login for ${where}.\n${ways}`);
  }
  if (err instanceof DaemonConnectionLostError) {
    return new Error(
      `The connection to Lazy Teams (${where}) dropped while the command was still running — ` +
      'it may have completed there. Re-check with `lazy show <task>` before retrying.',
    );
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(
    `Could not reach Lazy Teams (${where}): ${msg}\n` +
    `Check that ${teams.url} is up and reachable from this machine. ${ways}`,
  );
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
  /** Abort the in-flight call — see DaemonClient.rpc. */
  signal?: AbortSignal,
): Promise<T | null> {
  // Test mode and daemon-self bypass still return null
  if (isDaemonRpcBypassed()) return null;

  const root = findLazyRoot();
  if (!root) throw new NotALazyProjectError();

  const client = await DaemonClient.create(root);
  if (!client) throw new DaemonNotRunningError();

  try {
    return await client.rpc(command, root, params, observers, signal) as T;
  } catch (err) {
    // A bound clone has no local daemon to check or restart: say which Teams
    // install could not be reached and how to recover, instead.
    if (client.teams) throw boundCloneFailure(client.teams, err);

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
