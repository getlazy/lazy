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
 *
 * A MOVED PORT NEVER PRODUCES A 401. This healing was originally wired to the
 * 401 branch alone, and that left the common case unhandled: when the daemon
 * restarts onto a different port (the port window is shared across projects, so
 * a restart that cannot re-bind moves up), nothing is listening at the old
 * address and `fetch` fails at the TRANSPORT layer — ECONNREFUSED, not 401. The
 * refreshed address sat unread in the mounted file for the rest of the turn
 * while every tool call reported "the daemon appears to be down … relaunch",
 * which is how agents lost their lazy tools mid-turn and never got them back.
 * So a transport failure re-reads the same trusted file and retries once, on
 * exactly the same terms as a 401.
 *
 * A REBUILD+RESTART IS A GAP, NOT A MOVE. Re-reading once heals a daemon that
 * has already come back somewhere else, but a rebuild takes the daemon away for
 * seconds to minutes. A tool call landing in that window found nothing
 * listening, re-read an unchanged file, and died telling the human to relaunch
 * their builder — losing the whole conversation for a routine restart. So a
 * connection that was NEVER ESTABLISHED now waits, with backoff, for the daemon
 * to come back (bounded — see RECONNECT_WINDOW_MS), re-reading the mounted file
 * each round so a daemon that returns on a different port is picked up too.
 * Nothing ran daemon-side, so nothing is replayed; a call lost MID-flight is
 * still reported and never retried.
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

/** How many times a credential re-read is attempted before giving up. */
const CONFIG_READ_ATTEMPTS = 3;
/** Pause between credential re-read attempts — long enough for an in-place rewrite to land. */
const CONFIG_READ_RETRY_MS = 50;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long a tool call waits for a daemon that is not answering at all.
 *
 * Sized for the operation this exists to survive: rebuilding the daemon binary
 * and restarting it (`bun run ./src/index.ts daemon restart`, or an upgrade)
 * takes tens of seconds on a warm cache. Waiting through it costs the caller a
 * pause; NOT waiting costs the human their entire builder conversation, because
 * the failure message's only remedy is to exit and relaunch.
 *
 * It is a bound, not an invitation to spin: after this the call fails with the
 * same diagnosis it used to fail with immediately.
 */
const RECONNECT_WINDOW_MS = 90_000;

/**
 * How long a call waits for FRESH credentials once the daemon is answering but
 * rejecting our token (401 that a re-read did not fix).
 *
 * Short on purpose. The daemon is up, so either the session's owner re-issues a
 * token into the mounted file within a few seconds (the builder watches for a
 * restarted daemon and re-mints — see src/builder/mcp-reissue.ts), or the token
 * is genuinely gone and no amount of waiting will produce one.
 */
const REAUTH_WINDOW_MS = 20_000;

/** Backoff bounds for the reconnect loop. */
const RECONNECT_FIRST_DELAY_MS = 250;
const RECONNECT_MAX_DELAY_MS = 2_000;
/** How often the re-auth wait re-reads the mounted credential file. */
const REAUTH_POLL_MS = 500;

/**
 * Build a refresher bound to a config's `sourcePath`.
 *
 * Security: this re-reads the SAME trusted local file the config was minted
 * from — it never accepts credentials from the network and never relaxes the
 * auth check. Concurrent refreshes share one in-flight read so a burst of
 * simultaneous 401s causes one file read, not N.
 *
 * Torn reads are retried. The daemon rewrites these files with an in-place
 * truncate-and-write (`refreshDaemonMcpConfigs` in src/daemon/task-launcher.ts)
 * because a write-temp-then-rename would break the container's bind mount — so
 * a reader that lands mid-write legitimately sees a truncated file. Treating
 * that one bad parse as "nothing changed" would abandon the very refresh we
 * were woken up for, so we re-read a few times before giving up.
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
      let parsed: DaemonMcpConfigFile | null = null;
      for (let attempt = 1; attempt <= CONFIG_READ_ATTEMPTS; attempt++) {
        const last = attempt === CONFIG_READ_ATTEMPTS;
        let raw: string;
        try {
          raw = await readFile(sourcePath, 'utf-8');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (last) {
            log?.(`[daemon-mcp] could not re-read credentials from ${sourcePath}: ${msg}`);
            return false;
          }
          await delay(CONFIG_READ_RETRY_MS);
          continue;
        }
        try {
          parsed = JSON.parse(raw) as DaemonMcpConfigFile;
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (last) {
            log?.(`[daemon-mcp] credential file ${sourcePath} is not valid JSON: ${msg}`);
            return false;
          }
          // Most likely a torn read: the daemon truncates this file in place.
          await delay(CONFIG_READ_RETRY_MS);
        }
      }
      if (!parsed) return false;
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
    `lazy retried until its reconnect window ran out — re-reading the mounted daemon ` +
    `config each round, so a daemon that came back on another port would have been ` +
    `picked up — then probed ${target}/daemon/status and got no answer either, so the ` +
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
  /**
   * How long to keep retrying a daemon that is not answering at all.
   * Defaults to {@link RECONNECT_WINDOW_MS}. 0 disables the wait (fail on the
   * first unreachable attempt, after the one credential re-read).
   */
  reconnectWindowMs?: number;
  /**
   * How long to wait for fresh credentials after a 401 that a re-read did not
   * fix. Defaults to {@link REAUTH_WINDOW_MS}. 0 disables the wait.
   */
  reauthWindowMs?: number;
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
  const reconnectWindowMs = options?.reconnectWindowMs ?? RECONNECT_WINDOW_MS;
  const reauthWindowMs = options?.reauthWindowMs ?? REAUTH_WINDOW_MS;

  const sendOnce = async (args: Record<string, unknown>): Promise<Response> => {
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

    return await fetch(base, fetchOptions);
  };

  /**
   * Relay a status line to our own MCP client.
   *
   * Progress must never be invented (see src/mcp/server.ts). These frames are
   * not a keepalive standing in for absent work: each one states something this
   * proxy is observably doing right now — retrying a connection that never
   * established, or waiting on the credential file — and says plainly that the
   * daemon is not answering. Nor are they load-bearing for the client's idle
   * budget: both waits are capped well below it. They exist so the human sees
   * "waiting for the daemon" instead of an unexplained pause.
   */
  const reporter = (ctx?: McpToolCallContext) => (message: string) => {
    try {
      ctx?.reportProgress(message);
    } catch (err) {
      // Reporting progress must never break the call it is reporting on.
      log(`[daemon-mcp] '${toolName}' could not report progress: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const send = async (
    args: Record<string, unknown>,
    ctx?: McpToolCallContext,
  ): Promise<Response> => {
    const report = reporter(ctx);
    const startedAt = Date.now();
    const deadline = startedAt + reconnectWindowMs;
    let backoff = RECONNECT_FIRST_DELAY_MS;
    let rounds = 0;

    for (;;) {
      try {
        return await sendOnce(args);
      } catch (err) {
        // fetch throws (rather than returning a non-2xx) when the connection
        // could not be established OR when an established connection died.
        // Those need opposite handling, so classify instead of blaming a down
        // daemon for both.
        const detail = err instanceof Error ? err.message : String(err);

        // A call lost MID-flight may already have run on the daemon, and lazy
        // tools are not idempotent (a retried lazy_commit would commit twice).
        // Report it — never replay it.
        if (isMidFlightTransportFailure(detail)) {
          throw await classifyTransportFailure(toolName, config, detail);
        }

        // Nothing was listening, so nothing executed: retrying is safe.
        //
        // Re-read the mounted config first — a daemon that came back on a
        // different port has already rewritten it in place (see
        // refreshDaemonMcpConfigs), and that is the only way this container can
        // learn the new address. Then keep trying until the window is spent:
        // during a rebuild the daemon is simply ABSENT for a while, and failing
        // in that gap is what cost sessions their lazy tools for good.
        if (refresh) {
          if (rounds === 0) {
            log(`[daemon-mcp] '${toolName}' could not reach ${config.target} (${detail}) — re-reading daemon credentials`);
          }
          await refresh();
        }

        if (Date.now() >= deadline) {
          if (rounds > 0) {
            log(`[daemon-mcp] '${toolName}' gave up after ${Math.round((Date.now() - startedAt) / 1000)}s waiting for the daemon at ${config.target}`);
          }
          throw await classifyTransportFailure(toolName, config, detail);
        }

        rounds++;
        report(
          `${toolName}: the daemon is not answering at ${config.target} — ` +
          `waiting for it to come back (${Math.round((Date.now() - startedAt) / 1000)}s)`,
        );
        await delay(Math.min(backoff, Math.max(0, deadline - Date.now())));
        backoff = Math.min(backoff * 2, RECONNECT_MAX_DELAY_MS);
      }
    }
  };

  /**
   * Wait for the mounted credential file to offer something new.
   *
   * The security posture is unchanged: this only ever re-reads the same trusted
   * local file the config was minted from, and a changed token still has to be
   * accepted by the daemon on its own merits. What it buys is time for the
   * session's owner to re-issue — the host-side builder watcher re-mints within
   * a few seconds of noticing a restarted daemon, and without this wait the
   * first tool call after the restart raced it and lost.
   */
  const awaitFreshCredentials = async (ctx?: McpToolCallContext): Promise<boolean> => {
    if (!refresh || reauthWindowMs <= 0) return false;
    const report = reporter(ctx);
    const startedAt = Date.now();
    const deadline = startedAt + reauthWindowMs;
    while (Date.now() < deadline) {
      await delay(Math.min(REAUTH_POLL_MS, Math.max(0, deadline - Date.now())));
      if (await refresh()) return true;
      report(
        `${toolName}: the daemon rejected this session's credentials — ` +
        `waiting for re-issued ones (${Math.round((Date.now() - startedAt) / 1000)}s)`,
      );
    }
    return false;
  };

  return async (args: Record<string, unknown>, ctx?: McpToolCallContext): Promise<unknown> => {
    let response = await send(args, ctx);

    // A 401 is recoverable when the daemon has rewritten the mounted config
    // with current credentials since launch. Re-read that trusted local file
    // and retry EXACTLY ONCE — never loop, never relax the auth check.
    if (response.status === 401 && refresh) {
      log(`[daemon-mcp] '${toolName}' got 401 — re-reading daemon credentials`);
      if (await refresh()) {
        response = await send(args, ctx);
      }
    }

    // Still 401, and the file had nothing new the moment we looked. A daemon
    // that restarted without its token registry (moved, wiped by a repair, or
    // evicted) will never accept the token this session holds — but its owner
    // can mint a replacement bound to the SAME identity, and does. Give that a
    // bounded moment to land rather than declaring the session unrecoverable.
    // A 401 means the call did not execute, so re-sending is always safe.
    if (response.status === 401 && refresh) {
      if (await awaitFreshCredentials(ctx)) {
        log(`[daemon-mcp] '${toolName}' picked up re-issued daemon credentials — retrying`);
        response = await send(args, ctx);
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
      // A failed progress write means our own client is gone; the result still
      // has to be read so the daemon's work is not misreported as lost — which
      // is what `reporter` guarantees.
      const report = reporter(ctx);
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
    handlers.set(name, createDaemonProxyHandler(config, name, {
      refresh,
      log,
      reconnectWindowMs: options?.reconnectWindowMs,
      reauthWindowMs: options?.reauthWindowMs,
    }));
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

/**
 * Read a daemon MCP config file, retrying a torn or momentarily-missing read.
 *
 * Use this wherever the read happens while a daemon may be REWRITING the file
 * (see refreshDaemonMcpConfigs, which truncates in place). The stdio MCP server
 * reads it at spawn time, and a throw there kills the process — which costs the
 * agent every lazy tool for the rest of the turn, with no client-side recovery,
 * because Claude Code does not respawn a server that died during startup.
 */
export async function readDaemonMcpConfigWithRetry(configPath: string): Promise<DaemonMcpConfig> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= CONFIG_READ_ATTEMPTS; attempt++) {
    try {
      const raw = JSON.parse(await readFile(configPath, 'utf-8')) as DaemonMcpConfigFile;
      return {
        token: raw.token,
        projectRoot: raw.projectRoot,
        taskId: raw.taskId,
        target: raw.target,
        sourcePath: configPath,
      };
    } catch (err) {
      lastErr = err;
      if (attempt < CONFIG_READ_ATTEMPTS) await delay(CONFIG_READ_RETRY_MS);
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(
    `Could not read daemon MCP config ${configPath} after ${CONFIG_READ_ATTEMPTS} attempts: ${msg}`,
  );
}
