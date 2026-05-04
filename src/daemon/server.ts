/**
 * Daemon HTTP server — dual-bind: unix socket + TCP port.
 *
 * The daemon binds to two listeners:
 *   1. Unix socket (for CLI/agent communication) — requires bearer token auth
 *   2. TCP port (for web browser access) — no auth required (localhost only)
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
import { writePid, generateToken, readToken, cleanupStaleFiles, acquireDaemonLock, releaseDaemonLock } from './lifecycle';
import { handleRpc, RpcError, openProjectStorage, initDaemonStorage, getOrCreateStorage, closeAllStorage } from './rpc-handlers';
import { handleMcpToolCall } from './mcp-routes';
import { reconcileTasks } from '../utils/reconcile';
import { createRunner } from '../runner';
import { logger, LogLevel } from '../utils/logger';
import { markLoggedToFile } from '../utils/logged-error';
import { createWebRequestHandler, tryBindTcpPort } from '../server';
import { getLogPath } from './paths';
import { loadConfig } from '../config/loader';
import { DEFAULT_WEB_PORT } from '../config/constants';
import { pushBranchAfterStateChange, retryFailedPushes } from './push';
import { setDaemonContext } from './context';
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
import { createDriver } from '../remote';
import { runSync, debugSyncLogger } from './remote-sync';
import { isOfflineMode } from '../utils/offline';

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

  // Start remote sync loop (independent from reconcile to avoid blocking task detection)
  const stopSyncLoop = startDaemonSyncLoop(projectRoot);

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
      // Auth check — all unix socket endpoints require bearer token
      const authHeader = req.headers.get('authorization');
      if (authHeader !== `Bearer ${token}`) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }

      const daemonResponse = await handleDaemonRequest(req, false);
      if (daemonResponse) return daemonResponse;

      return Response.json({ error: 'Not found' }, { status: 404 });
    },
  });

  // TCP web server — serves web dashboard + daemon routes
  let webServer: ReturnType<typeof Bun.serve> | undefined;
  let webPort: number | undefined;

  const shouldBindWeb =
    !options.noWeb && (options._forceBindWebInTest === true || !process.env.LAZY_TEST);

  if (shouldBindWeb) {
    // Port priority: explicit option > project config > global default
    let configPort: number | undefined;
    try {
      const config = await loadConfig(projectRoot);
      configPort = config.server.port;
    } catch { /* config load failure shouldn't prevent web server startup */ }
    const desiredPort = options.webPort ?? configPort ?? DEFAULT_WEB_PORT;
    const attempts = options.maxPortAttempts ?? 100;

    // Tear down partial startup state so a failed bind leaves nothing behind:
    // no stale PID/socket/lock, no leaked timers, no dangling unix listener.
    // After teardown, isDaemonRunning(projectRoot) returns false and the user
    // can start a fresh daemon as soon as they free the conflicting port.
    // Teardown contract: we are already throwing the primary bind-failure
    // error to the caller, so individual cleanup step failures must not mask
    // or replace that error. Each step is best-effort — if it fails, the
    // worst case is a stale file or timer, which is strictly no worse than
    // the pre-teardown state; the caller sees the hard failure and will not
    // treat the daemon as running. We log failures at debug level so a
    // persistent teardown bug is still discoverable without surfacing noise
    // to the user on every failed start.
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
      await safeStep('closeSignalDb', () => closeSignalDb());
      await safeStep('closeAllStorage', () => closeAllStorage());
      await safeStep('server.stop', () => server.stop());
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
    };

    let bindResult: ReturnType<typeof tryBindTcpPort> = null;
    let bindThrownError: unknown = null;
    try {
      bindResult = tryBindTcpPort(desiredPort, tcpHandler, attempts);
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
      const reason = bindThrownError
        ? `bind error: ${bindThrownError instanceof Error ? bindThrownError.message : String(bindThrownError)}`
        : `no free port in range ${desiredPort}–${lastPort} (tried ${attempts} port${attempts === 1 ? '' : 's'}, all busy)`;
      const errorMessage =
        `Daemon failed to bind web dashboard: ${reason}. ` +
        `The daemon cannot start without a reachable TCP port — containers call back via host.docker.internal:<port>.\n` +
        `\n` +
        `To fix:\n` +
        `  • Find what is holding the port: lsof -i :${desiredPort}\n` +
        `  • Stop a colliding daemon: lazy daemon stop --project <other-project>\n` +
        `  • Or pick a different port in lazy.toml:\n` +
        `      [server]\n` +
        `      port = <number>`;
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
    // Set daemon context so RPC handlers (e.g., task launcher) can access
    // the daemon's own webPort and token without health checks.
    setDaemonContext({ webPort: actualPort, token });

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

    logger.info(`Web dashboard: http://localhost:${webPort}`);
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
    stopSyncLoop();
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
      const offline = await isOfflineMode(join(projectRoot, '.lazy'));

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
        parentByTaskId.set(task.id, task.parent_task_id);
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
      if (await isOfflineMode(join(projectRoot, '.lazy'))) return;

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
