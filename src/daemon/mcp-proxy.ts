/**
 * Daemon MCP proxy client — forwards tool calls to the daemon over HTTP.
 *
 * Used inside containers (or host-process supervisors) to forward MCP tool
 * calls to the daemon's /mcp/:taskId/:toolName routes. The daemon executes
 * tool calls with full host access — storage, git, Docker, filesystem.
 *
 * This replaces the builder-specific TCP server pattern (src/builder/server.ts)
 * with a unified approach: the daemon is the single MCP server for all agents.
 *
 * Connection modes:
 *   - Unix socket: when running on the host (daemon socket at ~/.lazy/daemon/lazy.sock)
 *   - TCP via host.docker.internal: when running inside a container
 *
 * Credential freshness: the config is minted once at launch and mounted into
 * the container, but the daemon rewrites that same file IN PLACE whenever it
 * (re)starts (see refreshDaemonMcpConfigs in task-launcher.ts). A single-file
 * bind mount pins the inode, so an in-place rewrite is visible inside a running
 * container. That makes the mounted file a live, trusted credential source —
 * so a 401 is recoverable: re-read the file and retry once. See
 * `createDaemonConfigRefresher`.
 *
 * What that rewrite changes is the ADDRESS, not the identity: the per-identity
 * token survives daemon restarts (the registry is on disk), so a 401 caused by
 * a moved port heals on refresh, while a 401 caused by a REVOKED token — the
 * session ended — finds the same token on disk and correctly does not retry.
 */

import { readFileSync } from 'fs';
import { readFile } from 'fs/promises';
import type { McpToolCallContext, McpToolHandler } from '../mcp/types';
import {
  DaemonConnectionLostError,
  heartbeatRequestHeaders,
  isHeartbeatEnvelope,
  readHeartbeatEnvelope,
} from './heartbeat';
import { describeProgress } from './progress';

export interface DaemonMcpConfig {
  /**
   * This caller's OWN MCP bearer token, minted for exactly one identity — this
   * task, or the builder (see src/daemon/mcp-tokens.ts). It is not the shared
   * daemon token, and the shared token is not accepted on /mcp routes: the
   * daemon derives the caller's identity FROM this token and refuses (403) when
   * the `taskId` below disagrees with it. Never share or forward it.
   */
  token: string;
  /** Project root path (sent as X-Lazy-Project header) */
  projectRoot: string;
  /** Task ID for scoping tool execution (empty string for builder/project-wide mode) */
  taskId: string;
  /**
   * Connection target. Either:
   *   - A unix socket path (e.g., ~/.lazy/daemon/lazy.sock)
   *   - An HTTP URL (e.g., http://host.docker.internal:26024)
   */
  target: string;
  /**
   * Path this config was read from, when it came from a file. The daemon keeps
   * this file current across its own restarts, so it is the trusted local
   * source a 401 refresh re-reads. Absent for configs built in memory (tests).
   */
  sourcePath?: string;
}

/**
 * Re-read the credential source and update the config in place.
 * Resolves true when the token or target actually changed (retry is worthwhile),
 * false otherwise (same credentials — retrying would just 401 again).
 */
export type DaemonCredentialRefresh = () => Promise<boolean>;

/**
 * Build a refresher bound to a config's `sourcePath`.
 *
 * Security: this re-reads the SAME trusted local file the config was minted
 * from — it never accepts credentials from the network and never relaxes the
 * auth check. Concurrent refreshes share one in-flight read so a burst of
 * simultaneous 401s causes one file read, not N.
 *
 * Returns null when the config has no file source (nothing to re-read).
 */
export function createDaemonConfigRefresher(
  config: DaemonMcpConfig,
  log?: (message: string) => void,
): DaemonCredentialRefresh | null {
  const sourcePath = config.sourcePath;
  if (!sourcePath) return null;

  let inFlight: Promise<boolean> | null = null;

  return () => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      let raw: string;
      try {
        raw = await readFile(sourcePath, 'utf-8');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log?.(`[daemon-mcp] could not re-read credentials from ${sourcePath}: ${msg}`);
        return false;
      }
      let parsed: DaemonMcpConfigFile;
      try {
        parsed = JSON.parse(raw) as DaemonMcpConfigFile;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log?.(`[daemon-mcp] credential file ${sourcePath} is not valid JSON: ${msg}`);
        return false;
      }
      if (!parsed.token || !parsed.target) {
        log?.(`[daemon-mcp] credential file ${sourcePath} is missing token/target`);
        return false;
      }
      const changed = parsed.token !== config.token || parsed.target !== config.target;
      if (changed) {
        // Only credentials/address are refreshed. taskId is set by the caller
        // (--task-id overrides the on-disk template) and must survive a refresh.
        log?.(
          `[daemon-mcp] daemon credentials changed on disk — reloaded from ${sourcePath} ` +
          `(target ${config.target} → ${parsed.target}); retrying`,
        );
        config.token = parsed.token;
        config.target = parsed.target;
      }
      return changed;
    })().finally(() => { inFlight = null; });
    return inFlight;
  };
}

/** Outcome of a /daemon/status probe. */
export interface DaemonStatusProbe {
  /** True when SOMETHING answered on the target — proof the daemon is not down. */
  responded: boolean;
  /** Project the responder serves, when it reported one. */
  projectRoot: string | null;
}

/**
 * How long to wait for the diagnostic /daemon/status probe.
 *
 * This runs only on an error path, to decide which failure message to print.
 * It must be short: a slow probe delays an error the caller is already waiting
 * for, and a daemon that cannot answer a trivial status GET in this long is not
 * meaningfully "up" from the caller's point of view either.
 */
const STATUS_PROBE_TIMEOUT_MS = 3_000;

/**
 * Ask the (unauthenticated) /daemon/status endpoint whether anything is
 * answering on `target`, and which project it serves. Used only to explain a
 * failure — never to obtain credentials.
 *
 * `responded` is the load-bearing bit: it is direct evidence that the daemon is
 * NOT down, which is what keeps "the daemon appears to be down" off a healthy
 * daemon. A non-2xx status still counts as responding — something is listening
 * and speaking HTTP.
 */
export async function probeDaemonStatus(target: string): Promise<DaemonStatusProbe> {
  try {
    const { url, init } = buildTargetRequest(target, '/daemon/status');
    const res = await fetch(url, {
      ...init,
      method: 'GET',
      signal: AbortSignal.timeout(STATUS_PROBE_TIMEOUT_MS),
    } as RequestInit);
    if (!res.ok) return { responded: true, projectRoot: null };
    const body = await res.json().catch(() => ({})) as { projectRoot?: string };
    return {
      responded: true,
      projectRoot: typeof body.projectRoot === 'string' ? body.projectRoot : null,
    };
  } catch {
    // Diagnostics only — an unreachable/odd status endpoint just means we
    // cannot add the "wrong project" hint. The caller's error is still raised.
    return { responded: false, projectRoot: null };
  }
}

/**
 * Which project the daemon on `target` serves, or null when unknown.
 *
 * Thin wrapper over {@link probeDaemonStatus} for the 401 path, which only
 * cares about the project identity.
 */
export async function probeDaemonProject(target: string): Promise<string | null> {
  return (await probeDaemonStatus(target)).projectRoot;
}

/** Build a fetch URL + init for a path against a unix-socket or http(s) target. */
function buildTargetRequest(
  target: string,
  path: string,
): { url: string; init: RequestInit & { unix?: string } } {
  if (target.startsWith('http://') || target.startsWith('https://')) {
    return { url: `${target}${path}`, init: {} };
  }
  return { url: `http://localhost${path}`, init: { unix: target } };
}

/**
 * Actionable message for a 401 from the daemon MCP endpoint.
 *
 * A 401 reaching this point means the refresh already ran and the mounted
 * credential file still doesn't authenticate — so the daemon this builder is
 * pointed at is not this project's daemon (or it is running code too old to
 * refresh the file). The bare "Unauthorized" the daemon returns gives the user
 * nothing to act on; this replaces it with the cause and the fix.
 *
 * `diagnosis` carries the observed cause when we could determine it (e.g. the
 * port is now owned by a DIFFERENT lazy project's daemon).
 */
export function daemonUnauthorizedMessage(toolName: string, diagnosis?: string): string {
  return (
    `lazy MCP call '${toolName}' was rejected by the daemon (401 Unauthorized). ` +
    (diagnosis ? `${diagnosis} ` : '') +
    `This builder's daemon credentials are stale — the daemon was very likely ` +
    `restarted or replaced since this builder launched, so the bearer token it ` +
    `holds no longer matches. lazy already re-read the mounted daemon config and ` +
    `retried; it still does not authenticate, so every lazy tool (including ` +
    `read-only ones like lazy_list) will keep failing until you relaunch. ` +
    `Recover by exiting this builder and relaunching it — ` +
    `'lazy builder --resume <session-id>' — which mints fresh daemon credentials ` +
    `for the new session.`
  );
}

/**
 * Explain a 401 that came from another project's daemon squatting our port.
 *
 * This is the failure mode observed in the field: daemons for different
 * projects share one port window, so a restart that cannot re-bind its previous
 * port moves up — and the port a running container still targets is answered by
 * a stranger, which rejects our token forever.
 */
export function foreignDaemonDiagnosis(
  target: string,
  ourProject: string,
  theirProject: string,
): string {
  return (
    `The daemon answering at ${target} serves a DIFFERENT project ` +
    `('${theirProject}', not '${ourProject}') — it moved onto this port while ` +
    `this project's daemon was restarting, so it rejects this project's token.`
  );
}

/**
 * Actionable message for an unreachable daemon (fetch threw before any HTTP
 * response — the socket/port refused the connection). This is what a moved port
 * or a stopped daemon looks like from inside the container.
 */
export function daemonUnreachableMessage(toolName: string, target: string, detail: string): string {
  return (
    `lazy MCP call '${toolName}' could not reach the daemon at ${target} (${detail}). ` +
    `lazy then probed ${target}/daemon/status and got no answer either, so the ` +
    `daemon really is unreachable from here. ` +
    `The daemon appears to be down, or listening on a different address than when ` +
    `this builder launched (a daemon restart can move the port). Ensure the daemon ` +
    `is running ('lazy daemon status' / 'lazy daemon start'), then exit and relaunch ` +
    `this builder — 'lazy builder --resume <session-id>' — so it picks up the ` +
    `daemon's current address and credentials.`
  );
}

/**
 * Did this transport failure happen AFTER the connection was established?
 *
 * The two cases need opposite advice, and conflating them is how a healthy
 * daemon got reported as down: a `lazy_wait` whose connection was reaped by the
 * listener's idle timer surfaced as "the daemon appears to be down ... relaunch
 * this builder", sending the engineer to a recovery path that could not help
 * (the daemon was up and answered every other call in the same window).
 *
 * "Connection refused" / "failed to connect" mean nothing was listening —
 * genuinely unreachable. A socket that closed, reset, or timed out means we DID
 * reach the daemon and lost it mid-request.
 *
 * Exported for tests: this classification is the difference between actionable
 * and misleading, so it is asserted directly.
 */
export function isMidFlightTransportFailure(detail: string): boolean {
  const lower = detail.toLowerCase();
  const neverConnected = [
    'econnrefused',
    'connection refused',
    'failed to connect',
    'unable to connect',
    'enotfound',
    'eai_again',
    'enoent',
  ];
  if (neverConnected.some(needle => lower.includes(needle))) return false;

  const lostMidFlight = [
    'closed unexpectedly',
    'econnreset',
    'connection reset',
    'socket closed',
    'operation timed out',
    'timed out',
    'timeout',
    'epipe',
  ];
  return lostMidFlight.some(needle => lower.includes(needle));
}

/**
 * Turn a transport-level fetch failure into the error the caller should see.
 *
 * The string match in {@link isMidFlightTransportFailure} only recognises the
 * failures we have already seen; a runtime upgrade, a new proxy, or a different
 * platform can word the same failure differently. That left an unrecognised
 * string defaulting to "the daemon appears to be down ... relaunch this
 * builder" — advice that is actively harmful when the daemon is up: it was
 * emitted for a `lazy_wait` while the same daemon answered every other call in
 * the same window, and it sent the operator to a recovery path that could not
 * possibly help.
 *
 * So we stop guessing and ASK. Anything but a recognised mid-flight failure
 * gets a /daemon/status probe, and a daemon that answers is by definition not
 * down — the call was lost in flight, whatever the wording of the error. Only a
 * probe that ALSO fails earns the "down / moved / relaunch" message.
 */
export async function classifyTransportFailure(
  toolName: string,
  config: DaemonMcpConfig,
  detail: string,
): Promise<Error> {
  if (isMidFlightTransportFailure(detail)) {
    return new DaemonConnectionLostError(toolName, detail);
  }

  const probe = await probeDaemonStatus(config.target);
  if (!probe.responded) {
    return new Error(daemonUnreachableMessage(toolName, config.target, detail));
  }

  if (probe.projectRoot && probe.projectRoot !== config.projectRoot) {
    return new Error(
      `lazy MCP call '${toolName}' failed (${detail}). ` +
      foreignDaemonDiagnosis(config.target, config.projectRoot, probe.projectRoot) +
      ` Exit and relaunch this builder — 'lazy builder --resume <session-id>' — ` +
      `so it picks up this project's current daemon address and credentials.`,
    );
  }

  return new DaemonConnectionLostError(
    toolName,
    `${detail}; the daemon answered /daemon/status immediately afterwards, so it is up`,
  );
}

export interface DaemonProxyOptions {
  /**
   * Re-read credentials on 401. Defaults to a refresher over `config.sourcePath`.
   * Pass a shared instance so all tools coordinate one re-read per burst.
   */
  refresh?: DaemonCredentialRefresh | null;
  /** Where to log refresh/retry activity. Defaults to console.error. */
  log?: (message: string) => void;
}

/**
 * Create an HTTP proxy handler for a single tool.
 * Returns an McpToolHandler that forwards calls to the daemon.
 */
export function createDaemonProxyHandler(
  config: DaemonMcpConfig,
  toolName: string,
  options?: DaemonProxyOptions,
): McpToolHandler {
  // stderr, not stdout: stdout is the MCP stdio protocol channel.
  const log = options?.log ?? ((m: string) => console.error(m));
  const refresh = options?.refresh === undefined
    ? createDaemonConfigRefresher(config, log)
    : options.refresh;

  const send = async (args: Record<string, unknown>): Promise<Response> => {
    const encodedTool = encodeURIComponent(toolName);
    const encodedTask = encodeURIComponent(config.taskId || '_');
    const { url: base, init } = buildTargetRequest(
      config.target,
      `/mcp/${encodedTask}/${encodedTool}`,
    );
    const fetchOptions: RequestInit & { unix?: string } = {
      ...init,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.token}`,
        'X-Lazy-Project': config.projectRoot,
        // Ask for heartbeat framing. Without it, any tool call that outlives the
        // daemon listener's idle timer (lazy_wait's long-poll, lazy_accept's
        // merge) has its connection reaped mid-flight — the exact failure this
        // proxy used to report as "the daemon appears to be down".
        ...heartbeatRequestHeaders(),
      },
      body: JSON.stringify({ arguments: args }),
    };

    try {
      return await fetch(base, fetchOptions);
    } catch (err) {
      // fetch throws (rather than returning a non-2xx) when the connection could
      // not be established OR when an established connection died. Those need
      // different advice, so classify instead of blaming a down daemon for both.
      const detail = err instanceof Error ? err.message : String(err);
      throw await classifyTransportFailure(toolName, config, detail);
    }
  };

  return async (args: Record<string, unknown>, ctx?: McpToolCallContext): Promise<unknown> => {
    let response = await send(args);

    // A 401 is recoverable when the daemon has rewritten the mounted config
    // with current credentials since launch. Re-read that trusted local file
    // and retry EXACTLY ONCE — never loop, never relax the auth check.
    if (response.status === 401 && refresh) {
      log(`[daemon-mcp] '${toolName}' got 401 — re-reading daemon credentials`);
      if (await refresh()) {
        response = await send(args);
      }
    }

    if (response.status === 401) {
      // Still rejected. Work out whether a foreign daemon owns our port so the
      // error names the real cause instead of guessing.
      const theirProject = await probeDaemonProject(config.target);
      const diagnosis = theirProject && theirProject !== config.projectRoot
        ? foreignDaemonDiagnosis(config.target, config.projectRoot, theirProject)
        : undefined;
      throw new Error(daemonUnauthorizedMessage(toolName, diagnosis));
    }

    // Heartbeat-framed replies are always HTTP 200 with the real status inside.
    if (isHeartbeatEnvelope(response)) {
      // Relay the daemon's liveness to OUR client. Without this the frames stop
      // here: the daemon keeps the HTTP connection alive for a 30-minute accept
      // while the MCP client, which counts only responses and progress
      // notifications, gives up on the call at its own idle limit and abandons
      // the merge. Each frame is evidence the daemon's handler is still running
      // — never a locally-invented keepalive (see src/mcp/server.ts).
      const report = (message: string) => {
        try {
          ctx?.reportProgress(message);
        } catch (err) {
          // Reporting progress must never break the call it is reporting on: a
          // failed write means our own client is gone, and the result still has
          // to be read so the daemon's work is not misreported as lost.
          log(`[daemon-mcp] '${toolName}' could not report progress: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
      const { status, body } = await readHeartbeatEnvelope(
        response,
        toolName,
        (elapsedMs, phase) => {
          // Name the phase when the daemon is narrating one — "accept running
          // on the daemon (95s)" says only that something is alive; "Merge"
          // says what.
          const where = phase ? ` — ${phase}` : '';
          report(`${toolName} running on the daemon (${Math.round(elapsedMs / 1000)}s)${where}`);
        },
        // Phase transitions relay verbatim: the client sees the same phase
        // narration the CLI renders, from the same daemon-emitted events.
        event => report(`${toolName}: ${describeProgress(event)}`),
      );
      const envelope = (body ?? {}) as { result?: unknown; error?: string };
      if (status < 200 || status >= 300 || envelope.error) {
        throw new Error(envelope.error ?? `lazy MCP call '${toolName}' failed: HTTP ${status}`);
      }
      return envelope.result;
    }

    const body = await response.json().catch(() => ({})) as { result?: unknown; error?: string };

    if (!response.ok || body.error) {
      throw new Error(body.error ?? `lazy MCP call '${toolName}' failed: HTTP ${response.status}`);
    }

    return body.result;
  };
}

/**
 * Create proxy handlers for all tools.
 * Returns a Map<toolName, handler> that can be used by the MCP server.
 *
 * All handlers share ONE config object and ONE refresher, so a 401 on any tool
 * heals every other tool at the same time (and a burst of 401s triggers a
 * single re-read).
 */
export function createAllDaemonProxyHandlers(
  config: DaemonMcpConfig,
  toolNames: string[],
  options?: DaemonProxyOptions,
): Map<string, McpToolHandler> {
  const log = options?.log ?? ((m: string) => console.error(m));
  const refresh = options?.refresh === undefined
    ? createDaemonConfigRefresher(config, log)
    : options.refresh;

  const handlers = new Map<string, McpToolHandler>();
  for (const name of toolNames) {
    handlers.set(name, createDaemonProxyHandler(config, name, { refresh, log }));
  }
  return handlers;
}

/**
 * Signal the daemon that the session has ended.
 * Best effort — the daemon may already be gone.
 */
export async function signalDaemonShutdown(config: DaemonMcpConfig): Promise<void> {
  // The daemon doesn't need a per-session shutdown signal — it's long-lived.
  // This is a no-op placeholder that replaces the builder server's /shutdown.
  // Kept for API compatibility with supervisor code that calls signalShutdown.
}

/**
 * Build a DaemonMcpConfig from a config file (written by the host before
 * launching the container).
 */
export interface DaemonMcpConfigFile {
  /** Bearer token */
  token: string;
  /** Project root path */
  projectRoot: string;
  /** Task ID (empty for builder mode) */
  taskId: string;
  /**
   * Connection target:
   *   - Unix socket path for host-side
   *   - TCP URL (e.g., http://host.docker.internal:26024) for containers
   */
  target: string;
}

/**
 * Read a daemon MCP config file.
 *
 * Sync is intentional: this runs once during MCP server / supervisor startup,
 * before any event-loop work. `sourcePath` is retained so a later 401 can
 * re-read this same trusted file (see createDaemonConfigRefresher), which uses
 * the async API.
 */
export function readDaemonMcpConfig(configPath: string): DaemonMcpConfig {
  const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as DaemonMcpConfigFile;
  return {
    token: raw.token,
    projectRoot: raw.projectRoot,
    taskId: raw.taskId,
    target: raw.target,
    sourcePath: configPath,
  };
}
