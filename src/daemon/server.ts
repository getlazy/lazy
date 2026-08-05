/**
 * Daemon HTTP server — dual-bind: unix socket + TCP port.
 *
 * The daemon binds to two listeners:
 *   1. Unix socket (for CLI/agent communication) — requires bearer token auth
 *   2. TCP port (for web browser access) — dashboard requires no auth; /mcp and
 *      /rpc require bearer token. Binds to loopback (127.0.0.1) by default;
 *      remote access is opt-in via [server] bind in lazy.toml.
 *
 * Unix socket endpoints:
 *   GET  /daemon/status          — health check / status endpoint
 *   POST /daemon/shutdown        — graceful shutdown
 *   POST /rpc/{command}          — CLI command pass-through
 *   POST /mcp/:taskId/:toolName  — MCP tool execution (agents in containers)
 *
 * TCP port endpoints (web dashboard):
 *   /             — Dashboard
 *   /tasks        — Task list
 *   /tasks/:id    — Task detail
 *   /api/*        — JSON API
 *   /search       — Full-text search
 *   /daemon/status — Health check (also available on TCP for convenience)
 *   /rpc/*         — RPC (requires bearer token, same as unix socket)
 *
 * Authentication: Bearer token in Authorization header (required for unix
 * socket, required for /rpc/* on TCP, not required for web dashboard routes).
 */

import { mkdirSync, existsSync, unlinkSync } from 'fs';
import { unlink, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { getSocketPath, getStartupErrorPath } from './paths';
import { writePid, generateToken, readToken, readWebPort, writeWebPort, cleanupStaleFiles, acquireDaemonLock, releaseDaemonLock, type AutoReactBudgetEntry } from './lifecycle';
import { writeDaemonRoot } from './registry';
import { assertDaemonCredentials } from './credential-gate';
import { handleRpc, openProjectStorage, initDaemonStorage, getOrCreateStorage, closeAllStorage } from './rpc-handlers';
import { initTracing, shutdownTracing } from '../tracing';
import { authorizeMcpCall, handleMcpToolCall, httpStatusForError } from './mcp-routes';
import {
  clientAcceptsHeartbeat,
  heartbeatEnvelopeResponse,
  DAEMON_IDLE_TIMEOUT_S,
  type EnvelopeResult,
} from './heartbeat';
import type { ProgressEmitter } from './progress';
import { reconcileTasks } from '../utils/reconcile';
import { createRunner } from '../runner';
import { logger, LogLevel } from '../utils/logger';
import { markLoggedToFile } from '../utils/logged-error';
import { createWebRequestHandler, tryBindTcpPort } from '../server';
import { formatDashboardUrl } from './dashboard-url';
import { getLogPath } from './paths';
import { loadConfig } from '../config/loader';
import type { RunnerType } from '../config/types';
import { DEFAULT_WEB_PORT, DEFAULT_SERVER_BIND, MAX_PORT_ATTEMPTS } from '../config/constants';
import {
  createProxyServer,
  ProxyAuditLog,
  auditLogPath,
  pruneLegacyAuditLog,
  formatSize,
  AUDIT_SEGMENT_MAX_BYTES,
  AUDIT_RETAINED_SEGMENTS,
} from '../proxy';
import { resolveDaemonBindHosts } from './bind-hosts';
import { pushBranchAfterStateChange, retryFailedPushes } from './push';
import { setDaemonContext, setDaemonProxyPort } from './context';
import {
  createReconcileEventState,
  detectAndDeliverEvents,
  deliverStateChangeEvents,
  runBlockedTaskCatchup,
  type ReconcileEventState,
  type StateChange,
} from './auto-deliver';
import { runAutoReact } from './auto-react';
import { closeSignalDb, initSignalDb } from './signals';
import { startSyncRetryLoop } from './sync-retry';
import { sweepConversations, createSweepCursor } from '../import/capture-sweep';
import { createDriver } from '../remote';
import { runSync, debugSyncLogger } from './remote-sync';
import { isOfflineMode } from '../utils/offline';
import { parentTaskIdOf } from '../task-target';

export interface DaemonServerOptions {
  /** Project root this daemon serves. Required — the daemon is per-project. */
  projectRoot: string;
  /** Use an existing token instead of generating a new one. For tests. */
  token?: string;
  /** Override socket path. For tests. */
  socketPath?: string;
  /** Override reconcile interval in seconds. For tests. */
  reconcileIntervalSeconds?: number;
  /** TCP port for web dashboard. 0 disables TCP binding. */
  webPort?: number;
  /** Maximum port attempts for auto-increment. */
  maxPortAttempts?: number;
  /** Disable web dashboard TCP binding entirely. For tests. */
  noWeb?: boolean;
  /**
   * Test-only: force web binding even when LAZY_TEST=1.
   * Used exclusively to exercise the web-bind failure path in tests.
   * Not part of the daemon's public contract.
   */
  _forceBindWebInTest?: boolean;
}

export interface RunningDaemon {
  server: ReturnType<typeof Bun.serve>;
  socketPath: string;
  token: string;
  startedAt: number;
  /** The single project root this daemon serves. */
  projectRoot: string;
  /** Cache of task short IDs, populated by the reconcile loop.
   *  Used by stop() to filter supervisors to only this project's tasks. */
  knownTaskIds: Set<string>;
  /** TCP web server instance (primary bind), if bound. */
  webServer?: ReturnType<typeof Bun.serve>;
  /**
   * Additional TCP listeners on the same port for other interfaces (e.g. the
   * docker bridge gateway on native Linux so containers can reach the daemon).
   * Tracked separately so stop() tears them all down.
   */
  extraWebServers?: ReturnType<typeof Bun.serve>[];
  /** TCP port the web dashboard is listening on, if bound. */
  webPort?: number;
  /** Interface the web dashboard bound to (= config.server.bind), if bound. */
  bindHost?: string;
  /** Anthropic passthrough proxy server, if [proxy] is configured. */
  proxyServer?: ReturnType<typeof Bun.serve>;
  /**
   * Stop the daemon server and clean up files. Does NOT exit the process.
   *
   * Async on purpose, and the signature says so: shutdown terminates
   * supervisors, closes storage and, crucially, removes the pidfile. A caller
   * that does not await it (an in-process daemon in a test, say) can race its
   * own teardown into reading a stale pidfile that still names the CURRENT
   * process — and then signal itself. Await it.
   */
  stop: () => Promise<void>;
}

/** The bearer credential a request presents, or null when it presents none. */
function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Start the daemon HTTP server on a unix socket, with optional TCP web server.
 *
 * Creates PID file, generates bearer token, binds to unix socket.
 * If web dashboard is enabled (default), also binds to a TCP port.
 * Returns the running server handle for lifecycle management.
 */
export async function startDaemonServer(options: DaemonServerOptions): Promise<RunningDaemon> {
  // Mark this process as the daemon to prevent recursive RPC calls
  process.env.LAZY_IS_DAEMON = '1';

  const projectRoot = options.projectRoot;

  // Configure logger: write to daemon.log via appendFileSync (supports rotation).
  //
  // In BACKGROUND mode (LAZY_DAEMON_BACKGROUND=1, set by auto-start.ts when
  // spawning the detached child), stdout and stderr are redirected to
  // daemon.log via O_APPEND. Anything written to console.* therefore also
  // lands in daemon.log — without a timestamp — and causes duplicate entries
  // whenever logger.* also echoes to console. Set consoleLevel to SILENT so
  // the logger writes *only* to the file, giving a single timestamped entry
  // per log call.
  //
  // In FOREGROUND mode (user ran `lazy daemon start --foreground` directly),
  // stdout/stderr are the user's terminal. Keep consoleLevel at ERROR so the
  // user sees errors on their terminal; the logger also writes them to the
  // file with a timestamp for post-mortem debugging. The two destinations
  // are different sinks so no duplication occurs.
  if (!process.env.LAZY_TEST) {
    logger.setLogFile(getLogPath(projectRoot));
    const background = process.env.LAZY_DAEMON_BACKGROUND === '1';
    logger.configure({ consoleLevel: background ? LogLevel.SILENT : LogLevel.ERROR });
    logger.enableRotation(10 * 1024 * 1024, 3); // 10MB, keep 3 rotated files
  }

  logger.info(`Daemon starting for project: ${projectRoot} (PID ${process.pid})`);

  // INVARIANT: a daemon never exists without a model credential.
  //
  // This is the AUTHORITATIVE enforcement point — the callers (auto-start,
  // `lazy daemon start`, `daemon restart`, `lazy upgrade`) pre-flight the same
  // gate so the refusal lands in the user's terminal, but this is the single
  // function that actually brings a daemon up, so enforcing here is what makes
  // the invariant structural instead of a convention each new caller has to
  // remember. A credential-less daemon is worse than no daemon: it runs,
  // answers RPC, and launches containers that can't reach the model API, so
  // tasks spin uselessly instead of failing fast.
  //
  // Runs BEFORE any side effect (storage, signal DB, loops, lock, PID file) so
  // a refusal leaves nothing behind to clean up.
  //
  // Skipped under LAZY_TEST=1, matching the daemon's other test carve-outs
  // (flock, chdir, logger). Suites that drive a daemon in-process would
  // otherwise depend on whether the developer happens to have a credential
  // exported — green on a laptop, red in CI. test/preload-generate.ts also
  // pins a hermetic fake credential for the test process, so this carve-out is
  // belt-and-braces rather than the only thing keeping those suites green.
  // The production path is covered end-to-end by
  // test/e2e/daemon-credential-gate.test.ts, which runs the real CLI as a
  // subprocess with LAZY_TEST=''.
  if (process.env.LAZY_TEST !== '1') {
    try {
      await assertDaemonCredentials(projectRoot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(message);
      // Write the startup-error marker so a detached child's refusal reaches
      // the caller's terminal (startDaemonBackground reads it after its
      // readiness poll) and `lazy daemon status` can explain why there is no
      // daemon. The parent pre-flight normally catches this first; the marker
      // is what covers the case where the child's environment differs from the
      // spawning process's. Best-effort — the throw below is the real signal.
      try {
        await writeFile(getStartupErrorPath(projectRoot), message, { mode: 0o644 });
      } catch (markerErr) {
        logger.warn(
          `Failed to write startup-error marker: ${markerErr instanceof Error ? markerErr.message : String(markerErr)}`,
        );
      }
      // Mark as already logged so the top-level CLI catch doesn't emit a second
      // untimestamped copy into daemon.log via the O_APPEND stderr redirect.
      throw markLoggedToFile(new Error(message));
    }
  }

  // Initialize storage module with the project root so getOrCreateStorage()
  // doesn't need a parameter — the daemon is single-project.
  initDaemonStorage(projectRoot);

  // Initialize request tracing (always on). Finished spans are persisted
  // through the daemon's own Storage as JSONL — no collector.
  initTracing('daemon', async (spans) => {
    const storage = await getOrCreateStorage();
    await storage.appendTraceSpans(spans);
  });

  // Initialize signal DB with the project root so signals are stored
  // per-project in .lazy/signals.db instead of globally.
  initSignalDb(projectRoot);

  // Set daemon cwd to the project root so all relative paths resolve correctly.
  // This eliminates the need for call sites to pass { cwd: projectRoot } everywhere.
  // Skip in tests — multiple daemons share the same process, and test cleanup
  // removes the temp directory, leaving cwd pointing at a deleted path.
  if (!process.env.LAZY_TEST) {
    process.chdir(projectRoot);
  }

  const socketPath = options.socketPath ?? getSocketPath(projectRoot);
  const startedAt = Date.now();
  let stopped = false;
  let shutdownTimer: ReturnType<typeof setTimeout> | null = null;

  // Cache of known task short IDs — populated by the reconcile loop,
  // used by stop() to filter supervisors to only this project's tasks.
  const knownTaskIds = new Set<string>();

  // Cache of tasks at their auto-react limit — populated by the reconcile loop,
  // read by the /daemon/status endpoint so it never blocks on storage.
  let cachedTasksAtLimit: string[] = [];

  // Start reconcile loop
  const reconcileInterval = options.reconcileIntervalSeconds ?? 5;
  const stopReconcileLoop = startDaemonReconcileLoop(projectRoot, reconcileInterval, knownTaskIds, (skipped) => {
    const pausedSet = new Set(cachedTasksAtLimit);
    for (const id of skipped) pausedSet.add(id);
    cachedTasksAtLimit = [...pausedSet];
  });

  // Start sync retry loop (runs alongside reconcile on same interval)
  const stopSyncRetryLoop = startSyncRetryLoop(projectRoot, reconcileInterval);

  // Start remote sync loop (independent from reconcile to avoid blocking task detection)
  const stopSyncLoop = startDaemonSyncLoop(projectRoot);

  // Start the live conversation capture sweep (host-side Claude sessions —
  // fidelity summaries, `lazy report`, memory compaction, a human's own
  // `claude` in the repo — plus a backstop for the in-container builder).
  const stopCaptureLoop = startConversationCaptureLoop(projectRoot);

  // Ensure daemon directory exists
  mkdirSync(dirname(socketPath), { recursive: true });

  // Singleton enforcement via flock(2).
  // The daemon ALWAYS acquires its own lock, regardless of how it was started
  // (foreground or background). Bun.spawn does not inherit arbitrary file
  // descriptors — only stdin/stdout/stderr — so fd-passing from parent to
  // child is not possible. The parent releases its lock before spawning so
  // the child can acquire it here.
  let daemonLockFd: number | null = null;
  // TODO(spike-rearchitecture): Remove LAZY_TEST skip once tests use isolated
  // daemon instances with their own lock files instead of sharing a process.
  if (!process.env.LAZY_TEST) {
    daemonLockFd = acquireDaemonLock(projectRoot);
    if (daemonLockFd === null) {
      logger.error('Failed to acquire daemon lock — another daemon is running');
      throw new Error(
        'Another daemon is already running (lock held). ' +
        "Stop it first with 'lazy daemon stop'."
      );
    }
  }

  // Clean up stale socket file if it exists (process is dead or doesn't exist)
  if (existsSync(socketPath)) {
    try { unlinkSync(socketPath); } catch { /* ignore */ }
  }

  // Write PID file
  writePid(projectRoot, process.pid);

  // Record the absolute project root this daemon serves. The slug is lossy, so
  // this marker is what lets `lazy daemon list/kill-stray` recover the real
  // path and detect a "stray" daemon whose root was deleted. Best-effort —
  // writeDaemonRoot swallows + logs failures so it can't block startup.
  await writeDaemonRoot(projectRoot);

  // Reuse existing token so daemon restarts don't invalidate tokens held by
  // running containers/builders. Only generate a new token on first start.
  const existingToken = readToken(projectRoot);
  const token = options.token ?? existingToken ?? generateToken(projectRoot);

  // Mutable web port — set after TCP binding, read by status endpoint
  let boundWebPort: number | undefined;
  // Actual interface the web server bound to (= config.server.bind). Set after
  // TCP binding, surfaced via /daemon/status so the CLI prints a URL that
  // points at the real interface instead of a hardcoded `localhost`.
  let boundBindHost: string | undefined;

  // Shared daemon-specific request handler (status, shutdown, RPC)
  //
  // ROUTE TABLE — every route is classified against DAEMON_IDLE_TIMEOUT_S.
  //
  // A Bun.serve handler that has not yet returned a Response writes no bytes, so
  // the connection's idle timer expires mid-operation and the request is reaped
  // (see src/daemon/heartbeat.ts). Every route must therefore be either FRAMED
  // (heartbeat envelope, so writes keep resetting the timer) or BOUNDED (an
  // argument, stated here, for why it cannot approach the timeout). "Unknown" is
  // not an allowed answer — when you add a route below, add its line here.
  //
  //   GET  /daemon/status          BOUNDED  — see the comment on the route.
  //   POST /daemon/shutdown        BOUNDED  — schedules a 50ms timer, returns at once.
  //   POST /mcp/:taskId/:toolName  FRAMED   — tool calls run for minutes (accept, sync).
  //   POST /rpc/{command}          FRAMED   — `wait` long-polls up to 600s.
  //   (no match) -> null -> 404    BOUNDED  — a constant JSON body, no I/O.
  //
  // Dashboard routes are not here: they are served by createWebRequestHandler in
  // src/server/index.ts, which cannot use the envelope (the client is a browser)
  // and bounds every one of its routes with an explicit deadline instead.
  const handleDaemonRequest = async (req: Request, requireAuth: boolean): Promise<Response | null> => {
    const url = new URL(req.url);

    // GET /daemon/status — health check (no auth required on TCP)
    //
    // CRITICAL: This endpoint must respond IMMEDIATELY (<100ms). It is the
    // liveness probe used by ensureDaemon/checkDaemonHealth. If it blocks on
    // storage, file locks, or the reconcile loop, the health check times out,
    // the caller thinks the daemon is dead, and spawns another one — causing
    // daemon accumulation (we've seen 28 daemon processes from this bug).
    //
    // NO storage access. NO file lock contention. Only synchronous/cached data.
    // Budget info comes from a plain JSON file read (no lock needed).
    //
    // BOUNDED (not heartbeat-framed), and the two halves of that are separate
    // claims:
    //
    // (a) It cannot approach DAEMON_IDLE_TIMEOUT_S. Exhaustively, the work below
    //     is: two dynamic imports of generated constants (../version,
    //     ../build-info); loadConfig (one small file read + parse); readDailyBudget
    //     and isGlobalAutoReactPaused (small unlocked JSON file reads);
    //     getRunningCodeSha (one `git rev-parse`, memoised after the first call);
    //     and reads of in-process variables. No Storage call, no lock acquisition,
    //     no network, and nothing proportional to project size — the only
    //     unbounded-in-principle step, the reconcile loop, deliberately publishes
    //     through a cache rather than being consulted here. Under storage pressure
    //     this route is unaffected, because it never touches storage.
    //
    // (b) It MUST NOT be framed even if (a) ever stopped holding. This is the
    //     liveness probe, and its callers include things that are not lazy: curl,
    //     browsers, and any health check a user wires up. NDJSON framing would
    //     break them, and it would defeat the purpose anyway — a probe that
    //     answers "still working on it" for two minutes is a probe that has
    //     already failed. If this route ever grows expensive work, the fix is to
    //     move that work behind a cache, not to frame it.
    if (url.pathname === '/daemon/status' && req.method === 'GET') {
      const uptime = Date.now() - startedAt;
      let version = 'unknown';
      try {
        const mod = await import('../version');
        version = mod.VERSION;
      } catch { /* version file may not exist in tests */ }

      // Build timestamp embedded at compile time (UTC ISO string), or 'dev'
      // when running from source (bun run ./src/index.ts) where there is no
      // build step. Falls back gracefully so status never crashes.
      let buildTime = 'dev';
      try {
        const mod = await import('../build-info');
        buildTime = mod.BUILD_TIME;
      } catch { /* build-info file may not exist in some contexts */ }

      // Auto-react budget: file-based read only (no storage, no lock).
      // tasksAtLimit is populated from a cache updated by the reconcile loop.
      let autoReactBudget: AutoReactBudgetEntry[] | undefined;
      try {
        const { readDailyBudget, effectiveDailyLimit, isGlobalAutoReactPaused } = await import('./auto-react-budget');
        const { nextLocalMidnight } = await import('../utils/local-day');
        const config = await loadConfig(projectRoot);
        const dataDir = join(projectRoot, '.lazy');
        const budget = await readDailyBudget(dataDir);
        const limit = effectiveDailyLimit(budget, config.daemon.auto_react_daily_budget);
        const pause = await isGlobalAutoReactPaused(dataDir);
        autoReactBudget = [{
          project: projectRoot,
          used: budget.used,
          limit,
          tasksAtLimit: cachedTasksAtLimit,
          resetAt: nextLocalMidnight().getTime(),
          paused: pause.paused,
          pauseExpiresAt: pause.expiresAt,
          capOverridden: budget.capOverride !== undefined,
        }];
      } catch {
        // Auto-react budget info is optional
      }

      // Git SHA of the source the daemon is RUNNING (captured at startup, cached).
      // Lets `lazy daemon status` detect a stale daemon serving code older than
      // the working tree. null for compiled/installed binaries (no source tree).
      let codeSha: string | null = null;
      try {
        const { getRunningCodeSha } = await import('./code-version');
        codeSha = getRunningCodeSha();
      } catch { /* code-version module optional; never block status */ }

      // Proxy status — so `lazy daemon status` can show where audited traffic
      // flows (the primary way to find the address now that the port is
      // OS-assigned by default). File read only; no storage/lock.
      let proxy: {
        enabled: boolean;
        running: boolean;
        bind: string;
        port: number | null;
        address: string | null;
        upstream: string;
        fallbacks: number;
        policyEnforce: boolean;
      } | undefined;
      try {
        const config = await loadConfig(projectRoot, { cwd: projectRoot });
        if (config.proxy) {
          const port = proxyServer?.port ?? null;
          proxy = {
            enabled: true,
            running: proxyServer !== undefined,
            bind: config.proxy.bind,
            port,
            address: port !== null ? `http://${config.proxy.bind}:${port}` : null,
            upstream: config.proxy.upstream,
            fallbacks: config.proxy.fallbacks.length,
            policyEnforce: config.proxy.policy.enforce,
          };
        } else {
          // Explicitly disabled. Report it rather than omitting the field: with
          // the proxy on by default, silence would be indistinguishable from
          // "running" and would hide that traffic is unaudited.
          proxy = {
            enabled: false, running: false, bind: '', port: null, address: null,
            upstream: '', fallbacks: 0, policyEnforce: false,
          };
        }
      } catch { /* proxy status is optional; never block the health probe */ }

      return Response.json({
        status: 'running',
        pid: process.pid,
        uptime,
        version,
        // The project this daemon serves. Daemons for different projects share
        // one TCP port window, so a client that gets a 401 needs this to tell
        // "my token rotated" from "a foreign daemon took my port" — the latter
        // being the real cause of permanently-dead MCP tools in a live builder.
        // No new exposure: the unauthenticated dashboard on this same port
        // already renders this project's data.
        projectRoot,
        buildTime,
        ...(codeSha ? { codeSha } : {}),
        socketPath,
        webPort: boundWebPort,
        bindHost: boundBindHost,
        ...(autoReactBudget ? { autoReactBudget } : {}),
        ...(proxy ? { proxy } : {}),
      });
    }

    // All remaining daemon routes require auth
    if (requireAuth) {
      const authHeader = req.headers.get('authorization');
      if (authHeader !== `Bearer ${token}`) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    // POST /daemon/shutdown — graceful shutdown
    //
    // BOUNDED: it schedules the actual teardown on a 50ms timer and returns
    // immediately, precisely so the reply reaches the client before the process
    // exits. The slow part (stop()) runs after the response, off the request.
    if (url.pathname === '/daemon/shutdown' && req.method === 'POST') {
      logger.info('Shutdown requested via RPC');
      shutdownTimer = setTimeout(async () => {
        await stop();
        process.exit(0);
      }, 50);
      return Response.json({ ok: true, message: 'Shutting down' });
    }

    // POST /mcp/:taskId/:toolName — MCP tool execution
    const mcpMatch = url.pathname.match(/^\/mcp\/([^/]+)\/(.+)$/);
    if (mcpMatch && req.method === 'POST') {
      const taskIdParam = decodeURIComponent(mcpMatch[1]);
      const toolName = decodeURIComponent(mcpMatch[2]);
      const reqProject = req.headers.get('x-lazy-project');
      if (!reqProject) {
        return Response.json({ error: 'Missing X-Lazy-Project header' }, { status: 400 });
      }
      if (reqProject !== projectRoot) {
        return Response.json({ error: `Project mismatch: daemon serves ${projectRoot}, request is for ${reqProject}` }, { status: 400 });
      }

      // INVARIANT: identity comes from the TOKEN, never from the URL. The
      // :taskId segment is a claim; authorizeMcpCall refuses (403) when it
      // disagrees with the identity the presented token is bound to, and 401s
      // an unknown/revoked token. The shared daemon token is deliberately NOT
      // accepted here — this is a security boundary, so there is no fallback
      // path that would let every agent share one identity again.
      //
      // It also performs the malformed-segment check (400 with what the path
      // should look like), so task resolution never sees garbage.
      let authorizedTaskId: string;
      try {
        authorizedTaskId = await authorizeMcpCall(
          projectRoot,
          taskIdParam,
          bearerToken(req),
        );
      } catch (err) {
        const status = httpStatusForError(err);
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`MCP ${toolName} refused (${status}) for claimed task ${taskIdParam.substring(0, 8)}: ${message}`);
        return Response.json({ error: message }, { status });
      }

      const mcpStart = Date.now();
      // One source of truth for the outcome, used by both the plain and the
      // heartbeat-framed reply below. A tool call can run for minutes (accept,
      // sync, a pre-accept turn launch), which is exactly the case Bun.serve's
      // idle timer kills — see src/daemon/heartbeat.ts.
      const produce = async (emit?: ProgressEmitter): Promise<EnvelopeResult> => {
        try {
          const body = await req.json().catch(() => ({})) as { arguments?: Record<string, unknown> };
          const args = body.arguments ?? {};
          // The token's own task id ('' for the builder surface) — never the
          // caller's claim, which has already been proven to agree with it.
          const result = await handleMcpToolCall(projectRoot, authorizedTaskId, toolName, args, emit);
          const durationMs = Date.now() - mcpStart;
          logger.info(`MCP ${toolName} for task ${taskIdParam.substring(0, 8)} completed in ${durationMs}ms`);
          return { status: 200, body: { result } };
        } catch (err) {
          const durationMs = Date.now() - mcpStart;
          const message = err instanceof Error ? err.message : String(err);
          // Preserve the error's own status (RpcError from a handler, or an
          // RpcApplicationError relayed from another daemon call). Both the
          // plain and the heartbeat-framed reply below read it from here, so
          // the enveloped {"status":N} line carries the real status too.
          const status = httpStatusForError(err);
          // A 4xx is the caller's mistake, not a daemon fault — log it at info,
          // matching how the /rpc route below treats an RpcError.
          const line = `MCP ${toolName} for task ${taskIdParam.substring(0, 8)} failed (${status}) in ${durationMs}ms: ${message}`;
          if (status >= 500) logger.error(line); else logger.info(line);
          return { status, body: { error: message } };
        }
      };

      if (clientAcceptsHeartbeat(req)) return heartbeatEnvelopeResponse(produce);
      const outcome = await produce();
      return Response.json(outcome.body, { status: outcome.status });
    }

    // POST /rpc/{command} — CLI command pass-through
    if (url.pathname.startsWith('/rpc/') && req.method === 'POST') {
      const command = url.pathname.slice(5);
      const reqProject = req.headers.get('x-lazy-project');
      if (!reqProject) {
        return Response.json({ error: 'Missing X-Lazy-Project header' }, { status: 400 });
      }
      if (reqProject !== projectRoot) {
        logger.warn(`RPC project mismatch: daemon serves ${projectRoot}, request for ${reqProject}`);
        return Response.json({ error: `Project mismatch: daemon serves ${projectRoot}, request is for ${reqProject}` }, { status: 400 });
      }

      const rpcStart = Date.now();
      // Same shape as the MCP route: produce the outcome once, then either send
      // it plainly or wrap it in a heartbeat envelope. `wait` alone long-polls
      // for up to 600s, which no Bun.serve idleTimeout can cover (max 255).
      const produce = async (emit?: ProgressEmitter): Promise<EnvelopeResult> => {
        try {
          const params = await req.json().catch(() => ({})) as Record<string, unknown>;
          const rpcResult = await handleRpc(command, projectRoot, params, emit);
          const durationMs = Date.now() - rpcStart;
          logger.debug(`RPC ${command} completed in ${durationMs}ms`);
          // Void methods return undefined — normalize to null for JSON serialization
          return { status: 200, body: rpcResult ?? null };
        } catch (err) {
          const durationMs = Date.now() - rpcStart;
          // Same status mapping as the /mcp route above — one helper, so the
          // two routes can never drift on what an error means.
          const status = httpStatusForError(err);
          if (status !== 500) {
            const message = err instanceof Error ? err.message : String(err);
            logger.info(`RPC ${command} failed (${status}) in ${durationMs}ms: ${message}`);
            return { status, body: { error: message } };
          }
          const message = err instanceof Error ? err.message : 'Internal error';
          logger.error(`RPC ${command} error in ${durationMs}ms: ${message}`);
          return { status: 500, body: { error: message } };
        }
      };

      if (clientAcceptsHeartbeat(req)) return heartbeatEnvelopeResponse(produce);
      const outcome = await produce();
      return Response.json(outcome.body, { status: outcome.status });
    }

    // BOUNDED: no match, no I/O. The caller turns this into a constant 404 (unix
    // listener) or hands off to the dashboard handler (TCP listener), which
    // applies its own deadline.
    return null; // Not a daemon route
  };

  // Unix socket server — all requests require bearer token auth
  // Bun's default idleTimeout is 10s — far too short for RPC calls that wait on
  // storage locks or reconcile yielding. Bun's unix socket types don't include
  // idleTimeout but it works at runtime (same engine as TCP serve).
  //
  // This value is NOT what keeps long operations alive: Bun caps idleTimeout at
  // 255s, and a handler that hasn't returned a Response writes no bytes, so the
  // idle timer expires mid-operation regardless. Long routes are kept alive by
  // the heartbeat envelope (src/daemon/heartbeat.ts). DAEMON_IDLE_TIMEOUT_S is
  // the floor for a request that produces nothing at all.
  const server = Bun.serve({
    unix: socketPath,
    idleTimeout: DAEMON_IDLE_TIMEOUT_S as never,

    async fetch(req: Request): Promise<Response> {
      // Auth check — all unix socket endpoints require the shared bearer token,
      // EXCEPT /mcp/*, which authenticates with a per-identity MCP token and
      // does so inside the route (see authorizeMcpCall). Accepting the shared
      // token here as well would reopen the impersonation hole on the socket.
      if (!new URL(req.url).pathname.startsWith('/mcp/')) {
        const authHeader = req.headers.get('authorization');
        if (authHeader !== `Bearer ${token}`) {
          return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }
      }

      const daemonResponse = await handleDaemonRequest(req, false);
      if (daemonResponse) return daemonResponse;

      return Response.json({ error: 'Not found' }, { status: 404 });
    },
  });

  // TCP web server — serves web dashboard + daemon routes
  let webServer: ReturnType<typeof Bun.serve> | undefined;
  let webPort: number | undefined;
  // Additional listeners on the same port (e.g. docker bridge gateway on Linux).
  const extraWebServers: ReturnType<typeof Bun.serve>[] = [];
  // Anthropic passthrough proxy — started after the web server if [proxy] is set.
  // Declared here (not in the start block below) so teardownPartialStart can stop
  // it if a LATER startup step fails.
  let proxyServer: ReturnType<typeof Bun.serve> | undefined;

  // Tear down partial startup state so a failed start leaves nothing behind:
  // no stale PID/socket/lock, no leaked timers, no dangling listeners. After
  // teardown, isDaemonRunning(projectRoot) returns false and the user can start
  // a fresh daemon as soon as they fix the cause.
  // Teardown contract: we are already throwing the primary startup error to the
  // caller, so individual cleanup step failures must not mask or replace that
  // error. Each step is best-effort — if it fails, the worst case is a stale
  // file or timer, strictly no worse than the pre-teardown state; the caller
  // sees the hard failure and will not treat the daemon as running. We log
  // failures at debug level so a persistent teardown bug stays discoverable
  // without surfacing noise to the user on every failed start.
  const safeStep = async (label: string, fn: () => unknown) => {
    try {
      await fn();
    } catch (err) {
      logger.debug(`teardown step '${label}' failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const teardownPartialStart = async () => {
    await safeStep('stopReconcileLoop', () => stopReconcileLoop());
    await safeStep('stopSyncRetryLoop', () => stopSyncRetryLoop());
    await safeStep('stopSyncLoop', () => stopSyncLoop());
    await safeStep('stopCaptureLoop', () => stopCaptureLoop());
    await safeStep('closeSignalDb', () => closeSignalDb());
    // Flush batched spans BEFORE storage closes — the span sink writes through
    // Storage, so it must still be open here.
    await safeStep('shutdownTracing', () => shutdownTracing());
    await safeStep('closeAllStorage', () => closeAllStorage());
    await safeStep('server.stop', () => server.stop());
    // Stop the TCP web listeners if they were already bound (they exist when a
    // LATER step — e.g. proxy start — fails; they are undefined/empty on an
    // early bind failure, where these are no-ops).
    if (proxyServer) await safeStep('proxyServer.stop', () => proxyServer!.stop());
    if (webServer) await safeStep('webServer.stop', () => webServer!.stop());
    for (const extra of extraWebServers) {
      await safeStep('extraWebServer.stop', () => extra.stop());
    }
    // The unix socket file we bound may not live at the default path
    // (tests pass an explicit socketPath). Remove it explicitly before
    // calling cleanupStaleFiles (which only touches default paths).
    // ENOENT is expected here: the socket may have been cleaned up by
    // server.stop() above, or never created if we teardown very early.
    await safeStep('unlink socket', async () => {
      try {
        await unlink(socketPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    });
    await safeStep('cleanupStaleFiles', () => cleanupStaleFiles(projectRoot));
    if (daemonLockFd !== null) {
      await safeStep('releaseDaemonLock', () => releaseDaemonLock(daemonLockFd!));
    }
  };

  const shouldBindWeb =
    !options.noWeb && (options._forceBindWebInTest === true || !process.env.LAZY_TEST);

  if (shouldBindWeb) {
    // Port priority: explicit option > non-default config port > last-bound
    // port > default. Preferring the last-bound port over the default keeps a
    // restart on the SAME port, so daemon MCP configs already mounted into
    // running containers/builders (target = host.docker.internal:<webPort>)
    // stay valid across the restart. A user who moves [server] port off the
    // default still wins — that's authoritative — so persistence only steers
    // the default case (see the movedConfigPort note below).
    let configPort: number | undefined;
    // Bind interface: defaults to loopback so the unauthenticated dashboard and
    // the /mcp + /rpc endpoints are not exposed to the LAN. Users opt into
    // remote access via [server] bind in lazy.toml.
    let bindHost: string = DEFAULT_SERVER_BIND;
    // Runner type decides whether containers need a bridge-reachable bind on
    // Linux. Defaults to 'docker' (the loader default) if config can't be read.
    let runnerType: import('../config/types').RunnerType = 'docker';
    try {
      const config = await loadConfig(projectRoot);
      configPort = config.server.port;
      bindHost = config.server.bind;
      runnerType = config.runner.type;
    } catch { /* config load failure shouldn't prevent web server startup */ }

    // A config port equal to the default is treated as "unset" for persistence:
    // the `lazy init` template writes `port = 26024` (the default) explicitly,
    // and the port always scans upward from here on EADDRINUSE — so pinning the
    // default is operationally identical to leaving it unset. Only a NON-default
    // config port expresses intent to move off the default, and it is honored
    // verbatim (above the persisted port). Everything else prefers the last-bound
    // port so a restart stays put and mounted MCP configs remain valid.
    const movedConfigPort =
      configPort !== undefined && configPort !== DEFAULT_WEB_PORT ? configPort : undefined;
    const desiredPort =
      options.webPort
      ?? movedConfigPort
      ?? readWebPort(projectRoot)
      ?? DEFAULT_WEB_PORT;
    const attempts = options.maxPortAttempts ?? MAX_PORT_ATTEMPTS;


    // Build a minimal TCP handler that can accept the bind BEFORE we touch
    // storage. Storage initialization is expensive and async — if we kicked
    // it off before bind and bind then failed, the in-flight promise would
    // race our teardown and reopen storage after we closed it. Defer the
    // real handler wiring until after bind succeeds; until then, refuse
    // requests so any client hitting the port during startup sees 503.
    // Bun.serve calls fetch() lazily so in practice this placeholder only
    // runs if a request slips in during the narrow bind→wire-up window.
    let webRequestHandler: (req: Request) => Promise<Response> = async () =>
      Response.json({ error: 'Daemon starting' }, { status: 503 });

    const tcpHandler = async (req: Request): Promise<Response> => {
      // Daemon routes on TCP — RPC requires auth, status does not
      const url = new URL(req.url);

      // /daemon/status is available without auth on TCP
      if (url.pathname === '/daemon/status') {
        const daemonResponse = await handleDaemonRequest(req, false);
        if (daemonResponse) return daemonResponse;
      }

      // /mcp/* authenticates with a per-identity MCP token, inside the route
      // (see authorizeMcpCall) — the shared daemon token is NOT accepted.
      if (url.pathname.startsWith('/mcp/')) {
        const daemonResponse = await handleDaemonRequest(req, false);
        if (daemonResponse) return daemonResponse;
      }

      // /rpc/* and /daemon/shutdown require the shared daemon token on TCP
      if (url.pathname.startsWith('/rpc/') || url.pathname === '/daemon/shutdown') {
        const authHeader = req.headers.get('authorization');
        if (authHeader !== `Bearer ${token}`) {
          return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const daemonResponse = await handleDaemonRequest(req, false);
        if (daemonResponse) return daemonResponse;
      }

      // Web dashboard routes — no auth required
      return webRequestHandler(req);
    };

    let bindResult: ReturnType<typeof tryBindTcpPort> = null;
    let bindThrownError: unknown = null;
    try {
      bindResult = tryBindTcpPort(desiredPort, tcpHandler, attempts, bindHost);
    } catch (err) {
      // tryBindTcpPort rethrows anything that isn't EADDRINUSE (e.g., EACCES
      // on privileged ports, unexpected Bun.serve failures). Surface these
      // with the same actionable messaging as the "all ports busy" case.
      bindThrownError = err;
    }

    if (!bindResult) {
      // INVARIANT: failing to bind the web port is a hard startup failure.
      // Containers (builder, sandbox runners) call back via
      // host.docker.internal:<webPort>, so a daemon without a reachable web
      // port would leave container-based RPCs (e.g., getDaemonMcpConfig)
      // throwing "Daemon context not initialized" — violating CLAUDE.md's
      // "fail hard on remote failures" and "principle of least surprise".
      const lastPort = desiredPort + attempts - 1;
      // Two distinct failure modes need different remediation. Only the
      // "range exhausted" case is plausibly caused by stray daemons, so only
      // it leads with `lazy daemon kill-stray` — pointing an EACCES (privileged
      // port) failure at kill-stray would be a misleading footgun and violate
      // the principle of least surprise.
      const isRangeExhausted = !bindThrownError;
      const reason = bindThrownError
        ? `bind error: ${bindThrownError instanceof Error ? bindThrownError.message : String(bindThrownError)}`
        : `no free port in range ${desiredPort}–${lastPort} (tried ${attempts} port${attempts === 1 ? '' : 's'}, all busy)`;
      const context = isRangeExhausted
        ? `The whole port range ${desiredPort}–${lastPort} is busy — this is almost always caused by ` +
          `stray daemons (e.g. left behind by crashed or interrupted runs) squatting the range.\n`
        : ``;
      const remediation = isRangeExhausted
        ? `To fix:\n` +
          `  • Reap stray daemons whose project no longer exists: lazy daemon kill-stray\n` +
          `  • See what is holding the ports: lazy daemon list  (or  lsof -i :${desiredPort})\n` +
          `  • Stop a specific colliding daemon: lazy daemon stop --project <other-project>\n` +
          `  • Or pick a different port in lazy.toml:\n` +
          `      [server]\n` +
          `      port = <number>`
        : `To fix:\n` +
          `  • Find what is holding the port: lsof -i :${desiredPort}\n` +
          `  • Stop a colliding daemon: lazy daemon stop --project <other-project>\n` +
          `  • Or pick a different port in lazy.toml:\n` +
          `      [server]\n` +
          `      port = <number>`;
      const errorMessage =
        `Daemon failed to bind web dashboard: ${reason}. ` +
        `The daemon cannot start without a reachable TCP port — containers call back via host.docker.internal:<port>.\n` +
        `\n` +
        context +
        `\n` +
        remediation;
      // Log via logger.error BEFORE teardown and throw. Logger uses
      // appendFileSync (O_APPEND), guaranteeing the message appears at the
      // END of daemon.log in chronological order with earlier startup lines.
      // This is the line users see via `tail daemon.log` — without it, the
      // error is only visible via the top-level process.exit handler's
      // console.error, which is easy to miss and was the direct cause of
      // the reported "silent hang" symptom (log appeared frozen at
      // "Daemon sync loop enabled" because the actual failure below was
      // being written to stderr before the logger had a chance to flush it).
      logger.error(errorMessage);
      // Write the startup-error marker so the parent process (the CLI that
      // spawned this detached daemon via startDaemonBackground) can read
      // the actionable message after its readiness poll times out and
      // surface it to the user's terminal. Without this, the user sees
      // only the generic "Daemon did not start within 5 seconds" message
      // and has to dig through daemon.log themselves. The parent cleared
      // any stale marker before spawning, so its presence means "this
      // child wrote it". Best-effort: if writing the marker fails, we
      // still throw — the file-backed log remains the source of truth.
      try {
        await writeFile(getStartupErrorPath(projectRoot), errorMessage, { mode: 0o644 });
      } catch (markerErr) {
        logger.warn(`Failed to write startup-error marker: ${markerErr instanceof Error ? markerErr.message : String(markerErr)}`);
      }
      await teardownPartialStart();
      // Mark the error so the top-level CLI catch in src/index.ts doesn't
      // re-emit it. In background mode, console.* writes land back in
      // daemon.log via O_APPEND — re-logging at the top level would add a
      // second untimestamped copy of the same message.
      throw markLoggedToFile(new Error(errorMessage));
    }

    webServer = bindResult.server;
    const actualPort = webServer.port!;
    webPort = actualPort;
    boundWebPort = actualPort;
    boundBindHost = bindHost;
    // Persist the bound port so the next start prefers it (see readWebPort),
    // keeping already-mounted daemon MCP configs valid across a restart.
    // Best-effort — never blocks startup.
    writeWebPort(projectRoot, actualPort);
    // Set daemon context so RPC handlers (e.g., task launcher) can access
    // the daemon's own webPort and token without health checks.
    setDaemonContext({ webPort: actualPort, token });

    // Persisting the port keeps a restart on the SAME port *when it can* — but
    // the port window is shared across projects, so another project's daemon
    // may already hold it and we land elsewhere. Containers launched before
    // that move still target the old port, where the foreign daemon answers
    // every call with 401. Rewrite their mounted configs in place (same inode,
    // so the change is visible inside running containers) with the current
    // target; the container-side proxy re-reads on 401 and retries.
    //
    // The per-identity MCP token in each config is PRESERVED: it is bound to
    // that container's identity in the token registry, which survives the
    // restart on disk. Only the address is corrected.
    // Best-effort: housekeeping must never prevent the daemon from starting.
    try {
      // Dynamic import: task-launcher pulls in runners/drivers, and server.ts
      // deliberately keeps those off the static startup path.
      const { refreshDaemonMcpConfigs } = await import('./task-launcher');
      await refreshDaemonMcpConfigs(
        projectRoot,
        { webPort: actualPort },
        { info: (m) => logger.info(m), warn: (m) => logger.warn(m) },
      );
    } catch (err) {
      logger.warn(
        `Could not refresh daemon MCP configs for running containers: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Bind succeeded — now wire up the real web request handler. Storage
    // initialization is kicked off eagerly so the first web request
    // doesn't pay the cold-start cost, but we're past the bind failure
    // window so there's no teardown race.
    const handlerPromise = (async () => {
      const storage = await getOrCreateStorage();
      return createWebRequestHandler(storage);
    })();
    webRequestHandler = async (req: Request) => {
      const handler = await handlerPromise;
      return handler(req);
    };

    logger.info(`Web dashboard: ${formatDashboardUrl(bindHost, webPort)}`);
    if (bindHost !== DEFAULT_SERVER_BIND) {
      // Make the exposure visible: the dashboard is unauthenticated, so binding
      // beyond loopback means anyone who can reach this interface can read it.
      logger.warn(
        `Daemon TCP server bound to ${bindHost}:${webPort} (not loopback). ` +
        `The web dashboard is unauthenticated and now reachable from other hosts ` +
        `on that interface. This was enabled via [server] bind in lazy.toml.`,
      );
    }

    // Container reachability on native Linux Docker/Podman.
    //
    // The primary bind above (loopback by default) lets the host CLI/browser
    // reach the daemon, but on native Linux a container reaches the host via
    // host.docker.internal -> the bridge gateway (a NON-loopback interface),
    // and a loopback-only daemon refuses that connection. So when the bind is
    // the loopback default AND a container runner is configured on Linux, we
    // ALSO bind the docker bridge gateway on the same port. This interface is
    // host-local + container-network only (not routable from the LAN), so it
    // does not widen the LAN exposure daemon-bind-localhost guards against.
    // On macOS/Windows host.docker.internal is proxied to loopback, so the
    // resolver returns loopback only and this loop is a no-op.
    const resolution = resolveDaemonBindHosts({
      configBind: bindHost,
      platform: process.platform,
      runnerType,
    });
    const extraHosts = resolution.hosts.slice(1);
    for (const host of extraHosts) {
      try {
        // Bind the SAME port (maxAttempts=1) on this interface. A different
        // local IP means this is a distinct socket, so the port is normally
        // free here even though the primary already holds it on loopback.
        const extra = tryBindTcpPort(actualPort, tcpHandler, 1, host);
        if (extra) {
          extraWebServers.push(extra.server);
          logger.info(`Daemon TCP server also bound to ${host}:${actualPort} (container reachability)`);
        } else {
          logger.warn(
            `Could not also bind the daemon to ${host}:${actualPort} (port busy on that interface). ` +
            `Containers reaching the daemon via host.docker.internal:${actualPort} may fail. ` +
            `If agents cannot reach the daemon, set a reachable interface via [server] bind in lazy.toml.`,
          );
        }
      } catch (err) {
        logger.warn(
          `Could not also bind the daemon to ${host}:${actualPort} (container reachability): ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          `If agents cannot reach the daemon, set a reachable interface via [server] bind in lazy.toml.`,
        );
      }
    }

    if (resolution.bridgeUnreachable) {
      // Linux + container runner, but no docker/podman bridge interface was
      // found — agents inside containers will silently fail to reach MCP/RPC.
      // Surface it loudly with an actionable remediation instead of letting the
      // failure show up later as opaque "Daemon context not initialized" errors.
      logger.warn(
        `Daemon is bound to loopback (${bindHost}:${actualPort}) but no docker/podman bridge ` +
        `interface was detected, and the configured runner is "${runnerType}". On native Linux ` +
        `Docker, containers reach the daemon via host.docker.internal -> the bridge gateway, which ` +
        `a loopback-only daemon refuses — agents/supervisor/MCP may fail to reach the daemon.\n` +
        `To fix, either ensure the docker bridge (docker0) is up, or set an explicit interface:\n` +
        `  [server]\n` +
        `  bind = "0.0.0.0"   # or the docker bridge gateway IP (e.g. 172.17.0.1)`,
      );
    }
  }

  // Start the Anthropic passthrough proxy. This is ON BY DEFAULT — `cfg.proxy`
  // is non-null unless the operator set `[proxy] enabled = false` — so the proxy
  // is part of a normal daemon start, like the web server.
  // The daemon owns the proxy: it announces its address at INFO next to the
  // dashboard. Audit records do NOT go through Storage — they are disposable
  // telemetry written to the project-local, size-capped
  // `.lazy/logs/proxy-audit.jsonl`.
  try {
    // Search from projectRoot explicitly — loadConfig otherwise defaults its
    // search to process.cwd(), which is the project root for a real daemon but
    // NOT for an in-process test daemon.
    const cfg = await loadConfig(projectRoot, { cwd: projectRoot });
    const dataDir = join(projectRoot, cfg.data.path);

    // Upgrade path: earlier versions appended the audit stream to the STORE
    // root with no cap, where it reached 677 MiB and broke a store push. Drop
    // it — telemetry, not durable state — and say so rather than letting data
    // disappear silently.
    //
    // Deliberately OUTSIDE the `cfg.proxy` check: this is cleanup of a file a
    // PREVIOUS version wrote, so whether the proxy runs now is irrelevant.
    // Gating it on the proxy would strand the oversized file forever on exactly
    // the machines that set `[proxy] enabled = false`, while `lazy doctor` told
    // them to restart the daemon to remove it.
    try {
      const storePath = (await getOrCreateStorage()).getStoragePath();
      const pruned = await pruneLegacyAuditLog(storePath);
      if (pruned) {
        logger.info(
          `Removed the legacy proxy audit log at ${pruned.path} (${formatSize(pruned.bytes)}). ` +
          `Audit records now live in ${auditLogPath(dataDir)}, capped at ` +
          `${formatSize(AUDIT_SEGMENT_MAX_BYTES * (AUDIT_RETAINED_SEGMENTS + 1))}. ` +
          `If that store is a git repo, the old blob is still in its history — ` +
          `use git filter-repo to purge it.`,
        );
      }
    } catch (err) {
      // Cleanup is best-effort housekeeping: a failure here must not stop the
      // daemon from starting. Say what happened so it is not silent.
      logger.warn(
        `Could not remove the legacy proxy audit log from the store root: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `It is safe to delete by hand.`,
      );
    }

    if (cfg.proxy) {
      proxyServer = createProxyServer(cfg.proxy, new ProxyAuditLog(dataDir));
      // Publish the ACTUAL bound port (OS-assigned when `[proxy] port` was
      // omitted) so per-launch env injection and `lazy daemon status` resolve
      // the real proxy address.
      if (proxyServer.port) setDaemonProxyPort(proxyServer.port);
      // Announce the proxy at INFO alongside the web-dashboard line, on start
      // and restart, so operators can see where audited traffic flows.
      const fbCount = cfg.proxy.fallbacks.length;
      logger.info(
        `Proxy: http://${cfg.proxy.bind}:${proxyServer.port} → ${cfg.proxy.upstream} ` +
        `(${fbCount} fallback${fbCount === 1 ? '' : 's'}, policy ${cfg.proxy.policy.enforce ? 'on' : 'off'})`,
      );
    }
  } catch (err) {
    // A proxy startup failure is a CONTROLLED startup error — never an unhandled
    // rejection that silently kills reconcile/sync/web (that was the ~6s-after-boot
    // daemon death), and never a silent fall-through to direct connections.
    //
    // Falling back to direct would be the WORST outcome: agent traffic would flow
    // straight to Anthropic while the audit trail recorded nothing, so the trail
    // would lie by omission and the connector deny-rules would silently not apply.
    // So we do NOT half-run: tear down the partial daemon and surface why + what
    // to do (CLAUDE.md: fail hard, cleanly and actionably — no silent fallback).
    const detail = err instanceof Error ? err.message : String(err);
    const errorMessage =
      `Daemon failed to start the [proxy] server: ${detail}\n` +
      `\n` +
      `lazy routes all agent model traffic through its local audit/policy proxy by default, ` +
      `and will not run half-configured: continuing without it would send agent traffic ` +
      `direct while the audit trail recorded nothing.\n` +
      `\n` +
      `To fix:\n` +
      `  • Port already in use: the proxy picks a free port automatically, so this means a\n` +
      `    pinned port is taken — drop or change it:\n` +
      `      [proxy]\n` +
      `      port = <number>   # or remove the line to auto-assign\n` +
      `  • Storage lock contention (another project's daemon holds the lock): two projects\n` +
      `    must not share one store — check [storage] external_path in lazy.toml, and run\n` +
      `    'lazy daemon list' to see which project each daemon serves.\n` +
      `  • To get unblocked right now, turn the proxy off and connect directly\n` +
      `    (no audit trail, no policy enforcement):\n` +
      `      [proxy]\n` +
      `      enabled = false`;
    logger.error(errorMessage);
    // Write the startup-error marker so the parent CLI (which spawned this
    // detached daemon) can surface the actionable message to the user's terminal
    // instead of a generic "did not start" timeout. Mirrors the web-bind path.
    try {
      await writeFile(getStartupErrorPath(projectRoot), errorMessage, { mode: 0o644 });
    } catch (markerErr) {
      logger.warn(`Failed to write startup-error marker: ${markerErr instanceof Error ? markerErr.message : String(markerErr)}`);
    }
    await teardownPartialStart();
    // markLoggedToFile so the top-level CLI catch in src/index.ts doesn't re-emit
    // a second untimestamped copy of the message.
    throw markLoggedToFile(new Error(errorMessage));
  }

  const result: RunningDaemon = {
    server,
    socketPath,
    token,
    startedAt,
    projectRoot,
    knownTaskIds,
    webServer,
    extraWebServers,
    webPort,
    bindHost: boundBindHost,
    proxyServer,
    stop: async () => {},
  };

  async function stop() {
    if (stopped) return;
    stopped = true;
    logger.info('Daemon shutting down...');

    // Terminate active supervisors before shutting down. Without this,
    // supervisors become orphans. discoverRunningRuns() is global (finds ALL
    // lazy-* containers/PIDs) but PER RUNNER TYPE — a docker runner can't see
    // host PIDs and vice versa. Since tasks may run on different runners
    // (per-task overrides), discover on each distinct runner type that this
    // project's sessions actually ran on (plus the global default), filtering
    // to supervisors whose task IDs belong to this project. knownTaskIds is
    // populated by the reconcile loop.
    try {
      const config = await loadConfig(projectRoot);
      const runnerTypes = new Set<RunnerType>([config.runner.type]);
      try {
        const storage = await getOrCreateStorage();
        for (const session of await storage.listSessions(undefined, true)) {
          if (session.runner_type) runnerTypes.add(session.runner_type);
        }
      } catch (err) {
        logger.debug(`Shutdown: could not list sessions for runner discovery: ${err instanceof Error ? err.message : err}`);
      }

      for (const runnerType of runnerTypes) {
        let runner;
        try {
          runner = await createRunner(projectRoot, runnerType);
        } catch (err) {
          // A configured-but-unavailable runner (e.g. docker not installed)
          // simply has no runs to stop — skip it.
          logger.debug(`Shutdown: skipping runner ${runnerType}: ${err instanceof Error ? err.message : err}`);
          continue;
        }
        const runs = await runner.discoverRunningRuns();
        for (const runName of runs) {
          // Extract task short ID from run name (e.g., "lazy-abcd1234" → "abcd1234")
          const taskShortId = runName.replace(/^lazy-/, '');
          if (!taskShortId) continue;

          // Only stop supervisors whose tasks belong to this project.
          // If knownTaskIds is empty (no reconcile tick yet), skip all — we can't
          // verify ownership, and a just-started daemon has no orphans to clean up.
          if (knownTaskIds.size === 0 || !knownTaskIds.has(taskShortId)) {
            logger.debug(`Skipping supervisor ${runName}: not owned by ${projectRoot}`);
            continue;
          }

          try {
            logger.info(`Stopping supervisor ${runner.runDisplayName(runName)}...`);
            const ok = await runner.stopRun(runName);
            if (ok) {
              logger.info(`Stopped supervisor ${runner.runDisplayName(runName)}`);
            } else {
              logger.warn(`Failed to stop supervisor ${runner.runDisplayName(runName)}`);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(`Error stopping supervisor ${runName}: ${msg}`);
          }
        }
      }
    } catch (err) {
      // Best-effort: if we can't create a runner (e.g., config deleted),
      // log and continue — don't block daemon shutdown.
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Could not enumerate supervisors for ${projectRoot}: ${msg}`);
    }

    stopReconcileLoop();
    stopSyncRetryLoop();
    stopSyncLoop();
    stopCaptureLoop();
    closeSignalDb();
    // Flush any batched spans BEFORE storage closes — the span sink writes
    // through Storage, so it must still be open here.
    await shutdownTracing().catch(() => {});
    // Close all long-lived Storage instances. Awaited: closing is what releases
    // .storage-lock, and a caller that awaits stop() (a new daemon starting, a
    // test tearing down) must be able to rely on the lock being free when stop()
    // resolves. Fire-and-forget left the lock held past shutdown, so the next
    // process to want it spent its whole retry budget waiting on a corpse.
    await closeAllStorage().catch(err => {
      logger.warn(`Shutdown: closing storage failed: ${err instanceof Error ? err.message : err}`);
    });
    if (shutdownTimer) {
      clearTimeout(shutdownTimer);
      shutdownTimer = null;
    }
    server.stop();
    if (webServer) {
      webServer.stop();
    }
    if (proxyServer) {
      proxyServer.stop();
    }
    for (const extra of extraWebServers) {
      extra.stop();
    }
    cleanupStaleFiles(projectRoot);
    // Release the exclusive daemon lock. Closing the fd releases the flock,
    // allowing a new daemon to start immediately.
    if (daemonLockFd !== null) {
      releaseDaemonLock(daemonLockFd);
    }
    logger.info('Daemon stopped');
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGINT', onSigint);
  }

  function onSigterm() {
    logger.info('Received signal: SIGTERM');
    stop().catch(() => {}); // Fire and forget - signal handlers can't await
    process.exit(0);
  }
  function onSigint() {
    logger.info('Received signal: SIGINT');
    stop().catch(() => {}); // Fire and forget - signal handlers can't await
    process.exit(0);
  }
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);

  result.stop = stop;

  logger.info(`Daemon ready (PID ${process.pid}, socket: ${socketPath}${webPort ? `, web: ${webPort}` : ''})`);

  return result;
}

/**
 * Start a periodic reconciliation loop for the daemon's single project.
 *
 * Follows the same pattern as src/server/index.ts startReconcileLoop:
 * - Skips a tick if the previous reconcile is still running
 * - Errors are logged but never crash the server
 * - First reconcile runs after 1s delay
 * - Subsequent reconciles every intervalSeconds
 */
function startDaemonReconcileLoop(
  projectRoot: string,
  intervalSeconds: number,
  knownTaskIds: Set<string>,
  onBudgetUpdate?: (tasksAtLimit: string[]) => void,
): () => void {
  let reconciling = false;
  let reconcileStartedAt = 0;
  let stopped = false;

  // Safety timeout: if a reconcile tick runs longer than this, the next tick
  // force-resets the guard and proceeds. This prevents a single hanging
  // subprocess (e.g., `gh` CLI, `git push`) from permanently blocking all
  // future reconciliation. The old tick continues in the background but the
  // critical path (detecting finished tasks) is no longer blocked.
  //
  // With subprocess-level timeouts (DEFAULT_SUBPROCESS_TIMEOUT_MS = 60s) and
  // withRemoteRetry (3 attempts × 60s + backoff), a single remote operation
  // can take up to ~190s. 300s gives headroom for multiple phases.
  const RECONCILE_TICK_TIMEOUT_MS = 300_000; // 5 minutes

  // Event state tracked across reconcile ticks
  const eventState = createReconcileEventState();

  /**
   * Run a reconcile phase with isolated error handling.
   * Each phase runs independently — a failure in one phase does not
   * prevent subsequent phases from executing.
   */
  async function runPhase(label: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Reconcile phase '${label}' failed: ${msg}`);
    }
  }

  const doReconcile = async () => {
    if (stopped) return;

    if (reconciling) {
      const elapsed = Date.now() - reconcileStartedAt;
      if (elapsed > RECONCILE_TICK_TIMEOUT_MS) {
        // Previous tick has been running too long — likely a hanging subprocess.
        // Force-reset and proceed. The old tick's finally block will be a no-op
        // because we use a generation check (reconcileStartedAt changes).
        logger.warn(
          `Daemon reconcile: previous tick exceeded ${RECONCILE_TICK_TIMEOUT_MS / 1000}s ` +
          `(${Math.round(elapsed / 1000)}s elapsed), force-resetting reconcile guard`
        );
        reconciling = false;
      } else {
        logger.debug('Daemon reconcile: skipping tick, previous reconcile still running');
        return;
      }
    }

    reconciling = true;
    const myStartTime = Date.now();
    reconcileStartedAt = myStartTime;

    // Check log rotation at the start of each tick
    logger.checkRotation();

    const reconcileStart = Date.now();
    try {
      const storage = await getOrCreateStorage();

      // Cache task short IDs so stop() can filter supervisors synchronously
      // without needing async storage access.
      try {
        const allTasks = await storage.listTasks();
        knownTaskIds.clear();
        for (const t of allTasks) {
          knownTaskIds.add(t.id.substring(0, 8));
        }
      } catch (err) {
        logger.debug(`Failed to cache task IDs: ${err instanceof Error ? err.message : err}`);
      }

      // --- Check offline mode once per tick ---
      // Load config to read the permanent-offline flag ([remote] offline). The
      // expiry check itself is just a timestamp comparison on offline.json; the
      // small config read here is what lets a permanent-offline project gate
      // remote ops without writing to the offline file.
      const reconcileConfig = await loadConfig(projectRoot);
      const offline = await isOfflineMode(join(projectRoot, '.lazy'), reconcileConfig.remote.offline);

      // --- Critical path: detect finished tasks and transition states ---
      // This must run before any network operations (push, sync, auto-react)
      // that could hang and block the tick. Sync alone can take 2-3 minutes
      // (pushing branches, fetching PR comments), and if it runs first the
      // working-task sweep gets preempted by pending HTTP requests every tick.

      // Snapshot working tasks before reconciliation so we can detect
      // which ones transition to blocked/conflict (turn completed).
      const workingBefore = await storage.listTasksWithOptions({ workingOnly: true });
      const workingIds = new Set(workingBefore.map(t => t.id));
      const branchByTaskId = new Map<string, string>();
      const parentByTaskId = new Map<string, string | null>();

      for (const task of workingBefore) {
        parentByTaskId.set(task.id, parentTaskIdOf(task));
        const session = await storage.getSessionByTaskId(task.id);
        if (session?.git_branch) {
          branchByTaskId.set(task.id, session.git_branch);
        }
      }

      await runPhase('reconcileTasks', async () => {
        await reconcileTasks(storage, projectRoot);
      });

      // After reconciliation, detect state changes and route events + push branches.
      // These are lower priority than serving HTTP requests, so check for pending
      // requests between major steps.
      const stateChanges: StateChange[] = [];

      await runPhase('detectStateChanges', async () => {
        for (const taskId of workingIds) {
          if (stopped) break;
          try {
            const branch = branchByTaskId.get(taskId);

            const task = await storage.getTask(taskId);
            if (!task) continue;

            // Detect state change from 'working' to something else
            if (task.status !== 'working') {
              stateChanges.push({
                taskId,
                previousStatus: 'working',
                currentStatus: task.status,
                parentTaskId: parentByTaskId.get(taskId) ?? null,
              });
            }

            if (!offline && branch && (task.status === 'blocked' || task.status === 'conflict' || task.status === 'submitted')) {
              // Task completed a turn — push the branch (skip when offline)
              pushBranchAfterStateChange(projectRoot, branch).catch(err => {
                const msg = err instanceof Error ? err.message : String(err);
                logger.debug(`Background push failed for ${branch}: ${msg}`);
              });
            }
          } catch (err) {
            logger.error(`detectStateChanges: failed for task ${taskId.substring(0, 8)}: ${err instanceof Error ? err.message : err}`);
          }
        }

        if (stateChanges.length > 0) {
          for (const sc of stateChanges) {
            logger.info(`Task ${sc.taskId.substring(0, 8)} state change: working → ${sc.currentStatus}`);
          }
        }
      });

      // Auto-deliver events to blocked parent tasks (auto-unblock)
      if (stateChanges.length > 0) {
        await runPhase('deliverStateChangeEvents', async () => {
          await deliverStateChangeEvents(storage, stateChanges, projectRoot);
        });
      }

      // Detect accepts and parent branch changes, deliver to blocked tasks
      await runPhase('detectAndDeliverEvents', async () => {
        await detectAndDeliverEvents(storage, projectRoot, eventState);
      });

      // Stateless catchup: check all blocked tasks for conditions that
      // require action, regardless of whether a transition was detected.
      // This is the safety net that survives daemon restarts — it checks
      // current git/task state rather than relying on in-memory diffs.
      await runPhase('runBlockedTaskCatchup', async () => {
        await runBlockedTaskCatchup(storage, projectRoot);
      });

      // --- Non-critical phases: network operations ---
      // These phases make network calls (git push, gh CLI) that can hang.
      // Subprocess-level timeouts (DEFAULT_SUBPROCESS_TIMEOUT_MS) kill hanging
      // processes, and phase isolation ensures failures don't cascade.
      //
      // Note: Remote sync (upstream fetch, PR comments, branch export) runs on
      // its own independent loop — see startDaemonSyncLoop(). This keeps the
      // reconcile tick fast and prevents slow network operations from blocking
      // task state detection.

      // Retry any branches that failed to push on a previous tick.
      // Moved after reconcileTasks so a hanging push can't block task detection.
      // Skip entirely when offline — no point retrying network operations.
      if (!offline) {
        await runPhase('retryFailedPushes', async () => {
          await retryFailedPushes(projectRoot);
        });
      }

      // Auto-react: check for CI failures and PR comments on blocked tasks.
      // Runs after reconciliation so newly-blocked tasks are included.
      if (!stopped) {
        await runPhase('runAutoReact', async () => {
          const config = await loadConfig(projectRoot);
          const autoReactResult = await runAutoReact(storage, projectRoot, config);

          if (autoReactResult) {
            if (autoReactResult.commentUnblocked.length > 0) {
              logger.info(`Auto-react: unblocked ${autoReactResult.commentUnblocked.length} task(s) for PR comments: ${autoReactResult.commentUnblocked.join(', ')}`);
            }
            if (autoReactResult.budgetSkipped.length > 0) {
              logger.info(`Auto-react: ${autoReactResult.budgetSkipped.length} task(s) skipped (budget exhausted): ${autoReactResult.budgetSkipped.join(', ')}`);
            }
            for (const err of autoReactResult.errors) {
              logger.error(`Auto-react error: ${err}`);
            }

            // Report budget-exhausted tasks to the status endpoint cache
            if (onBudgetUpdate && autoReactResult.budgetSkipped.length > 0) {
              onBudgetUpdate(autoReactResult.budgetSkipped);
            }
          }
        });
      }
    } catch (err) {
      // This catches failures in storage init or task snapshot — phases above
      // have their own isolated error handling via runPhase.
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Daemon reconcile error: ${msg}`);
    } finally {
      const durationMs = Date.now() - reconcileStart;
      logger.debug(`Daemon reconcile tick completed in ${durationMs}ms`);
      // Only reset the flag if this tick is still the active one.
      // If a newer tick force-reset us (timeout), don't clobber its flag.
      if (reconcileStartedAt === myStartTime) {
        reconciling = false;
      }
    }
  };

  // First reconcile shortly after server start
  const initialTimeout = setTimeout(doReconcile, 1_000);

  // Subsequent reconciles on interval
  const intervalId = setInterval(doReconcile, intervalSeconds * 1_000);

  logger.debug(`Daemon reconcile loop enabled: every ${intervalSeconds}s`);

  return () => {
    stopped = true;
    clearTimeout(initialTimeout);
    clearInterval(intervalId);
  };
}

/** How often the daemon sweeps Claude session JSONLs into the conversation store. */
const CAPTURE_SWEEP_INTERVAL_MS = 60_000;
/** Fast tick when a test explicitly arms the sweep, so an e2e can observe it. */
const CAPTURE_SWEEP_TEST_INTERVAL_MS = 1_000;

/**
 * Start the live conversation capture sweep.
 *
 * The in-container builder supervisor can only capture what it sees from inside
 * its container. Every OTHER Claude session for this project is written on the
 * host — lazy's own `claude -p` one-shots (fidelity summaries on accept, `lazy
 * report`, LLM memory compaction) and any `claude` a human runs in the repo.
 * Nothing captured those, so they only ever reached the store via an explicit
 * `lazy doctor --reimport-conversations`. The daemon is the one process that
 * can see every projects dir AND owns storage, so the sweep lives here.
 *
 * Local disk work only — no network — so it runs on its own timer rather than
 * inside the reconcile tick, which must stay fast. See src/import/capture-sweep.ts
 * for how it avoids re-parsing history on every pass.
 */
function startConversationCaptureLoop(projectRoot: string): () => void {
  // Under LAZY_TEST the sweep is off by default: it would race every test that
  // seeds session JSONLs and then asserts they are still unimported (the whole
  // `doctor --reimport-conversations` suite). `LAZY_FORCE_CAPTURE_SWEEP=1` arms
  // it — and speeds it up — for the tests that DO exercise it. Test-only, same
  // family as LAZY_FORCE_PREFLIGHT / LAZY_FORCE_PROXY_GATE.
  const forcedInTest = process.env.LAZY_FORCE_CAPTURE_SWEEP === '1';
  if (process.env.LAZY_TEST === '1' && !forcedInTest) {
    logger.debug('Conversation capture loop disabled under LAZY_TEST');
    return () => {};
  }
  const intervalMs = forcedInTest ? CAPTURE_SWEEP_TEST_INTERVAL_MS : CAPTURE_SWEEP_INTERVAL_MS;

  let sweeping = false;
  let stopped = false;
  const cursor = createSweepCursor();

  const doSweep = async () => {
    if (stopped || sweeping) return;
    sweeping = true;
    try {
      const config = await loadConfig(projectRoot);
      const storage = await getOrCreateStorage();
      const result = await sweepConversations({
        lazyRoot: projectRoot,
        dataDirAbs: join(projectRoot, config.data.path),
        storage,
        cursor,
      });
      if (result.captured.length > 0) {
        logger.debug(
          `Conversation capture: saved ${result.captured.length} session(s)` +
          (result.skippedMachineOneshots > 0
            ? `; skipped ${result.skippedMachineOneshots} machine-generated one-shot(s)`
            : ''),
        );
      }
      // Never swallowed: losing conversation history silently is the bug this
      // whole path exists to prevent.
      for (const { sessionId, error } of result.errors) {
        logger.error(`Conversation capture failed for ${sessionId}: ${error.message}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Conversation capture sweep failed: ${msg}`);
    } finally {
      sweeping = false;
    }
  };

  // First sweep shortly after start, then on interval.
  const initialTimeout = setTimeout(doSweep, forcedInTest ? 200 : 3_000);
  const intervalId = setInterval(doSweep, intervalMs);
  logger.debug(`Daemon conversation capture loop enabled: every ${intervalMs / 1000}s`);

  return () => {
    stopped = true;
    clearTimeout(initialTimeout);
    clearInterval(intervalId);
  };
}

/**
 * Start an independent sync loop that runs remote operations
 * (upstream fetch, PR comment fetching, branch export, CI checks)
 * on its own timer, decoupled from the reconcile loop.
 *
 * This prevents slow network operations (which can take 2-3 minutes
 * with many open PRs) from blocking task state detection. The reconcile
 * loop stays fast (~seconds) while sync runs at its own pace.
 */
function startDaemonSyncLoop(projectRoot: string): () => void {
  let syncing = false;
  let stopped = false;

  const doSync = async () => {
    if (stopped) return;
    if (syncing) {
      logger.debug('Daemon sync: skipping tick, previous sync still running');
      return;
    }

    syncing = true;
    const syncStart = Date.now();
    try {
      const config = await loadConfig(projectRoot);
      const syncInterval = config.server.sync_interval;

      // sync_interval = 0 disables sync
      if (syncInterval <= 0) return;

      // Skip sync entirely when offline — no network noise.
      if (await isOfflineMode(join(projectRoot, '.lazy'), config.remote.offline)) return;

      const driver = createDriver(config);

      // Skip if driver doesn't need remote sync (e.g., LocalDriver)
      if (!driver.needsSync) return;

      const storage = await getOrCreateStorage();
      await runSync(projectRoot, storage, debugSyncLogger);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('Sync requires a remote driver')) {
        logger.debug(`Daemon sync error: ${msg}`);
      }
    } finally {
      const durationMs = Date.now() - syncStart;
      logger.debug(`Daemon sync tick completed in ${durationMs}ms`);
      syncing = false;
    }
  };

  // First sync after a short delay (give the daemon time to fully initialize)
  const initialTimeout = setTimeout(doSync, 5_000);

  // Subsequent syncs: use the configured sync_interval.
  // Default is 60s — we check config once and use that for the interval.
  // If the user changes the config, they restart the daemon anyway.
  let intervalId: ReturnType<typeof setInterval>;
  loadConfig(projectRoot).then(config => {
    const syncIntervalMs = (config.server.sync_interval || 60) * 1_000;
    intervalId = setInterval(doSync, syncIntervalMs);
    logger.debug(`Daemon sync loop enabled: every ${config.server.sync_interval || 60}s`);
  }).catch(err => {
    // Fallback to default interval if config loading fails
    intervalId = setInterval(doSync, 60_000);
    logger.debug(`Daemon sync loop enabled: every 60s (config load failed: ${err instanceof Error ? err.message : err})`);
  });

  return () => {
    stopped = true;
    clearTimeout(initialTimeout);
    if (intervalId) clearInterval(intervalId);
  };
}
