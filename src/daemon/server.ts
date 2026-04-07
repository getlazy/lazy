/**
 * Daemon HTTP server — dual-bind: unix socket + TCP port.
 *
 * The daemon binds to two listeners:
 *   1. Unix socket (for CLI/agent communication) — requires bearer token auth
 *   2. TCP port (for web browser access) — no auth required (localhost only)
 *
 * Unix socket endpoints:
 *   GET  /daemon/status          — health check / status endpoint
 *   GET  /events/stream?task_id= — SSE event stream for supervisors
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
import { dirname, join } from 'path';
import { getSocketPath } from './paths';
import { writePid, generateToken, readToken, cleanupStaleFiles, acquireDaemonLock, releaseDaemonLock } from './lifecycle';
import { handleRpc, RpcError, openProjectStorage, initDaemonStorage, getOrCreateStorage, closeAllStorage } from './rpc-handlers';
import { handleMcpToolCall } from './mcp-routes';
import { reconcileTasks } from '../utils/reconcile';
import { createRunner } from '../runner';
import { logger, LogLevel } from '../utils/logger';
import { createWebRequestHandler, tryBindTcpPort } from '../server';
import { getLogPath } from './paths';
import { loadConfig } from '../config/loader';
import { DEFAULT_WEB_PORT } from '../config/constants';
import { pushBranchAfterStateChange, retryFailedPushes } from './push';
import { setDaemonContext, signalPendingRequest, clearPendingRequest, hasPendingRequests } from './context';
import {
  registerConnection,
  removeConnection,
  sendCatchupEvents,
  stopAllConnections,
  routeStateChangeEvents,
  type StateChange,
} from './events';
import {
  createReconcileEventState,
  detectAndDeliverEvents,
  deliverStateChangeEvents,
  runBlockedTaskCatchup,
  type ReconcileEventState,
} from './auto-deliver';
import { runAutoReact } from './auto-react';
import { closeSignalDb, initSignalDb } from './signals';
import { startSyncRetryLoop } from './sync-retry';
import { createDriver } from '../remote';
import { runSync, debugSyncLogger } from './remote-sync';

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
  /** TCP web server instance, if bound. */
  webServer?: ReturnType<typeof Bun.serve>;
  /** TCP port the web dashboard is listening on, if bound. */
  webPort?: number;
  /** Stop the daemon server and clean up files. Does NOT exit the process. */
  stop: () => void;
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

  // Configure logger: write to daemon.log via appendFileSync (supports rotation),
  // suppress console to avoid duplicate writes (stdout is already redirected to
  // daemon.log in background mode). Errors still go to console as a safety net.
  if (!process.env.LAZY_TEST) {
    logger.setLogFile(getLogPath(projectRoot));
    logger.configure({ consoleLevel: LogLevel.ERROR });
    logger.enableRotation(10 * 1024 * 1024, 3); // 10MB, keep 3 rotated files
  }

  logger.info(`Daemon starting for project: ${projectRoot} (PID ${process.pid})`);

  // Initialize storage module with the project root so getOrCreateStorage()
  // doesn't need a parameter — the daemon is single-project.
  initDaemonStorage(projectRoot);

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

  // Reuse existing token so daemon restarts don't invalidate tokens held by
  // running containers/builders. Only generate a new token on first start.
  const existingToken = readToken(projectRoot);
  const token = options.token ?? existingToken ?? generateToken(projectRoot);

  // Mutable web port — set after TCP binding, read by status endpoint
  let boundWebPort: number | undefined;

  // Shared daemon-specific request handler (status, shutdown, RPC)
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
    if (url.pathname === '/daemon/status' && req.method === 'GET') {
      const uptime = Date.now() - startedAt;
      let version = 'unknown';
      try {
        const mod = await import('../version');
        version = mod.VERSION;
      } catch { /* version file may not exist in tests */ }

      // Auto-react budget: file-based read only (no storage, no lock).
      // tasksAtLimit is populated from a cache updated by the reconcile loop.
      let autoReactBudget: { project: string; used: number; limit: number; tasksAtLimit: string[] }[] | undefined;
      try {
        const { readDailyBudget } = await import('./auto-react-budget');
        const config = await loadConfig(projectRoot);
        const dataDir = join(projectRoot, '.lazy');
        const budget = await readDailyBudget(dataDir);
        const limit = config.daemon.auto_react_daily_budget;
        autoReactBudget = [{ project: projectRoot, used: budget.used, limit, tasksAtLimit: cachedTasksAtLimit }];
      } catch {
        // Auto-react budget info is optional
      }

      return Response.json({
        status: 'running',
        pid: process.pid,
        uptime,
        version,
        socketPath,
        webPort: boundWebPort,
        ...(autoReactBudget ? { autoReactBudget } : {}),
      });
    }

    // All remaining daemon routes require auth
    if (requireAuth) {
      const authHeader = req.headers.get('authorization');
      if (authHeader !== `Bearer ${token}`) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    // GET /events/stream?task_id=<taskId> — SSE event stream for supervisors
    if (url.pathname === '/events/stream' && req.method === 'GET') {
      const taskId = url.searchParams.get('task_id');
      if (!taskId) {
        return Response.json({ error: 'Missing task_id query parameter' }, { status: 400 });
      }

      const reqProject = req.headers.get('x-lazy-project');
      if (!reqProject) {
        return Response.json({ error: 'Missing X-Lazy-Project header' }, { status: 400 });
      }
      if (reqProject !== projectRoot) {
        return Response.json({ error: `Project mismatch: daemon serves ${projectRoot}, request is for ${reqProject}` }, { status: 400 });
      }

      const stream = new ReadableStream({
        start(controller) {
          // Register the SSE connection
          registerConnection(taskId, controller);

          // Send initial connected event
          controller.enqueue(`event: connected\ndata: ${JSON.stringify({ task_id: taskId })}\n\n`);

          // Run catchup asynchronously — don't block the stream setup
          (async () => {
            try {
              const catchupStorage = await openProjectStorage(projectRoot);
              try {
                await sendCatchupEvents(catchupStorage, taskId, projectRoot);
              } finally {
                await catchupStorage.close();
              }
            } catch (err) {
              logger.debug(`SSE catchup failed for ${taskId.substring(0, 8)}: ${err instanceof Error ? err.message : err}`);
            }
          })();
        },
        cancel() {
          // Client disconnected
          removeConnection(taskId);
        },
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }

    // POST /daemon/shutdown — graceful shutdown
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

      const mcpStart = Date.now();
      try {
        const body = await req.json().catch(() => ({})) as { arguments?: Record<string, unknown> };
        const args = body.arguments ?? {};
        // taskId '_' means project-wide mode (builder, no specific task)
        const taskId = taskIdParam === '_' ? '' : taskIdParam;
        const result = await handleMcpToolCall(projectRoot, taskId, toolName, args);
        const durationMs = Date.now() - mcpStart;
        logger.info(`MCP ${toolName} for task ${taskIdParam.substring(0, 8)} completed in ${durationMs}ms`);
        return Response.json({ result });
      } catch (err) {
        const durationMs = Date.now() - mcpStart;
        const message = err instanceof Error ? err.message : String(err);
        const status = err instanceof RpcError ? err.status : 500;
        logger.error(`MCP ${toolName} for task ${taskIdParam.substring(0, 8)} failed (${status}) in ${durationMs}ms: ${message}`);
        return Response.json({ error: message }, { status });
      }
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
      try {
        const params = await req.json().catch(() => ({})) as Record<string, unknown>;
        const rpcResult = await handleRpc(command, projectRoot, params);
        const durationMs = Date.now() - rpcStart;
        logger.debug(`RPC ${command} completed in ${durationMs}ms`);
        // Void methods return undefined — normalize to null for JSON serialization
        return Response.json(rpcResult ?? null);
      } catch (err) {
        const durationMs = Date.now() - rpcStart;
        if (err instanceof RpcError) {
          logger.info(`RPC ${command} failed (${err.status}) in ${durationMs}ms: ${err.message}`);
          return Response.json({ error: err.message }, { status: err.status });
        }
        const message = err instanceof Error ? err.message : 'Internal error';
        logger.error(`RPC ${command} error in ${durationMs}ms: ${message}`);
        return Response.json({ error: message }, { status: 500 });
      }
    }

    return null; // Not a daemon route
  };

  // Unix socket server — all requests require bearer token auth
  // Default idleTimeout is 10s — too short for RPC calls that may wait
  // for storage locks or reconcile yielding. 120s matches typical CLI
  // command timeout expectations. Bun's unix socket types don't include
  // idleTimeout but it works at runtime (same engine as TCP serve).
  const server = Bun.serve({
    unix: socketPath,
    idleTimeout: 120 as never,

    async fetch(req: Request): Promise<Response> {
      // Signal that a request is waiting so the reconcile loop can yield
      signalPendingRequest();
      try {
        // Auth check — all unix socket endpoints require bearer token
        const authHeader = req.headers.get('authorization');
        if (authHeader !== `Bearer ${token}`) {
          return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const daemonResponse = await handleDaemonRequest(req, false);
        if (daemonResponse) return daemonResponse;

        return Response.json({ error: 'Not found' }, { status: 404 });
      } finally {
        clearPendingRequest();
      }
    },
  });

  // TCP web server — serves web dashboard + daemon routes
  let webServer: ReturnType<typeof Bun.serve> | undefined;
  let webPort: number | undefined;

  if (!options.noWeb && !process.env.LAZY_TEST) {
    // Port priority: explicit option > project config > global default
    let configPort: number | undefined;
    try {
      const config = await loadConfig(projectRoot);
      configPort = config.server.port;
    } catch { /* config load failure shouldn't prevent web server startup */ }
    const desiredPort = options.webPort ?? configPort ?? DEFAULT_WEB_PORT;

    // Use the daemon's shared storage instance for the web dashboard
    const setupWebHandler = async () => {
      const storage = await getOrCreateStorage();
      return createWebRequestHandler(storage);
    };

    // Create handler immediately — the daemon is a long-lived process
    let handlerPromise = setupWebHandler();

    const webRequestHandler = async (req: Request) => {
      const handler = await handlerPromise;
      return handler(req);
    };

    const tcpHandler = async (req: Request): Promise<Response> => {
      // Signal that a request is waiting so the reconcile loop can yield
      signalPendingRequest();
      try {
        // Daemon routes on TCP — RPC requires auth, status does not
        const url = new URL(req.url);

        // /daemon/status is available without auth on TCP
        if (url.pathname === '/daemon/status') {
          const daemonResponse = await handleDaemonRequest(req, false);
          if (daemonResponse) return daemonResponse;
        }

        // /mcp/*, /rpc/*, and /daemon/shutdown require auth on TCP
        if (url.pathname.startsWith('/mcp/') || url.pathname.startsWith('/rpc/') || url.pathname === '/daemon/shutdown') {
          const authHeader = req.headers.get('authorization');
          if (authHeader !== `Bearer ${token}`) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 });
          }
          const daemonResponse = await handleDaemonRequest(req, false);
          if (daemonResponse) return daemonResponse;
        }

        // Web dashboard routes — no auth required
        return webRequestHandler(req);
      } finally {
        clearPendingRequest();
      }
    };

    const bindResult = tryBindTcpPort(desiredPort, tcpHandler, options.maxPortAttempts);
    if (bindResult) {
      webServer = bindResult.server;
      const actualPort = webServer.port!;
      webPort = actualPort;
      boundWebPort = actualPort;
      // Set daemon context so RPC handlers (e.g., task launcher) can access
      // the daemon's own webPort and token without health checks.
      setDaemonContext({ webPort: actualPort, token });
      logger.info(`Web dashboard: http://localhost:${webPort}`);
    } else {
      logger.warn(`Could not bind web dashboard to port ${desiredPort} (all ports busy)`);
    }
  }

  const result: RunningDaemon = {
    server,
    socketPath,
    token,
    startedAt,
    projectRoot,
    knownTaskIds,
    webServer,
    webPort,
    stop: () => {},
  };

  async function stop() {
    if (stopped) return;
    stopped = true;
    logger.info('Daemon shutting down...');

    // Terminate active supervisors before shutting down. Without this,
    // supervisors become orphans. discoverRunningRuns() is global (finds ALL
    // lazy-* containers/PIDs), so we filter to only stop supervisors whose
    // task IDs exist in this project's storage. knownTaskIds is populated
    // by the reconcile loop.
    try {
      const runner = await createRunner(projectRoot);
      const runs = runner.discoverRunningRuns();
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
          const ok = runner.stopRun(runName);
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
    } catch (err) {
      // Best-effort: if we can't create a runner (e.g., config deleted),
      // log and continue — don't block daemon shutdown.
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Could not enumerate supervisors for ${projectRoot}: ${msg}`);
    }

    stopReconcileLoop();
    stopSyncRetryLoop();
    stopAllConnections();
    closeSignalDb();
    // Close all long-lived Storage instances
    closeAllStorage().catch(() => {});
    if (shutdownTimer) {
      clearTimeout(shutdownTimer);
      shutdownTimer = null;
    }
    server.stop();
    if (webServer) {
      webServer.stop();
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

  // Timestamp of last upstream fetch (for rate limiting)
  let lastUpstreamFetchAt = 0;

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

      // --- Critical path: detect finished tasks and transition states ---
      // This must run before any network operations (push, auto-react) that
      // could hang and block the tick. Previously, retryFailedPushes ran here
      // and could stall the entire loop if a git push subprocess hung.

      // Periodic remote sync: upstream fetch, detect external changes (merged/closed PRs),
      // fetch comments, export branches, post turns/notes.
      // Replaces the standalone `lazy sync` (no task ID) command.
      // Only run if enough time has passed since last sync.
      try {
        const config = await loadConfig(projectRoot);
        const syncInterval = config.server.sync_interval;
        const now = Date.now();
        const elapsed = (now - lastUpstreamFetchAt) / 1000; // seconds

        if (syncInterval > 0 && elapsed >= syncInterval) {
          const driver = createDriver(config);

          // Skip if driver doesn't need remote sync (e.g., LocalDriver)
          if (driver.needsSync) {
            await runSync(projectRoot, storage, debugSyncLogger);
            lastUpstreamFetchAt = now;
          }
        }
      } catch (err) {
        // Log non-critical errors (e.g., "no remote driver" for local repos)
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('Sync requires a remote driver')) {
          logger.debug(`Remote sync error: ${msg}`);
        }
      }

      // Snapshot working tasks before reconciliation so we can detect
      // which ones transition to blocked/conflict (turn completed).
      const workingBefore = await storage.listTasksWithOptions({ workingOnly: true });
      const workingIds = new Set(workingBefore.map(t => t.id));
      const branchByTaskId = new Map<string, string>();
      const parentByTaskId = new Map<string, string | null>();

      for (const task of workingBefore) {
        parentByTaskId.set(task.id, task.parent_task_id);
        const session = await storage.getSessionByTaskId(task.id);
        if (session?.git_branch) {
          branchByTaskId.set(task.id, session.git_branch);
        }
      }

      await runPhase('reconcileTasks', async () => {
        const scheduling = { shouldAbort: hasPendingRequests };
        await reconcileTasks(storage, projectRoot, scheduling);
      });

      // After reconciliation, detect state changes and route events + push branches.
      // These are lower priority than serving HTTP requests, so check for pending
      // requests between major steps.
      const stateChanges: StateChange[] = [];

      await runPhase('detectStateChanges', async () => {
        for (const taskId of workingIds) {
          if (stopped || hasPendingRequests()) break;
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

            if (branch && (task.status === 'blocked' || task.status === 'conflict' || task.status === 'submitted')) {
              // Task completed a turn — push the branch
              pushBranchAfterStateChange(projectRoot, branch).catch(err => {
                const msg = err instanceof Error ? err.message : String(err);
                logger.debug(`Background push failed for ${branch}: ${msg}`);
              });
            }
          } catch (err) {
            logger.error(`detectStateChanges: failed for task ${taskId.substring(0, 8)}: ${err instanceof Error ? err.message : err}`);
          }
        }

        // Route events via SSE for detected state changes
        if (stateChanges.length > 0) {
          for (const sc of stateChanges) {
            logger.info(`Task ${sc.taskId.substring(0, 8)} state change: working → ${sc.currentStatus}`);
          }
          routeStateChangeEvents(storage, stateChanges);
        }
      });

      // Auto-deliver events to blocked parent tasks (auto-unblock)
      if (stateChanges.length > 0) {
        await runPhase('deliverStateChangeEvents', async () => {
          await deliverStateChangeEvents(storage, stateChanges, projectRoot);
        });
      }

      // Detect accepts and parent branch changes, deliver to blocked tasks
      if (!hasPendingRequests()) {
        await runPhase('detectAndDeliverEvents', async () => {
          await detectAndDeliverEvents(storage, projectRoot, eventState);
        });
      }

      // Stateless catchup: check all blocked tasks for conditions that
      // require action, regardless of whether a transition was detected.
      // This is the safety net that survives daemon restarts — it checks
      // current git/task state rather than relying on in-memory diffs.
      if (!hasPendingRequests()) {
        await runPhase('runBlockedTaskCatchup', async () => {
          await runBlockedTaskCatchup(storage, projectRoot);
        });
      }

      // --- Non-critical phases: network operations ---
      // These phases make network calls (git push, gh CLI) that can hang.
      // Subprocess-level timeouts (DEFAULT_SUBPROCESS_TIMEOUT_MS) kill hanging
      // processes, and phase isolation ensures failures don't cascade.

      // Retry any branches that failed to push on a previous tick.
      // Moved after reconcileTasks so a hanging push can't block task detection.
      if (!hasPendingRequests()) {
        await runPhase('retryFailedPushes', async () => {
          await retryFailedPushes(projectRoot);
        });
      }

      // Auto-react: check for CI failures and PR comments on blocked tasks.
      // Runs after reconciliation so newly-blocked tasks are included.
      if (!stopped && !hasPendingRequests()) {
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
