/**
 * Daemon HTTP server — HTTP server on a unix socket.
 *
 * Provides:
 *   GET  /daemon/status   — health check / status endpoint
 *   POST /daemon/shutdown — graceful shutdown
 *   POST /rpc/{command}   — CLI command pass-through (Phase 1)
 *
 * Future phases will add:
 *   /mcp/*  — Agent MCP tool proxy
 *   /       — Web dashboard
 *   /api/*  — Web API
 *   /events — SSE stream
 *
 * Authentication: Bearer token in Authorization header.
 */

import { mkdirSync, existsSync, unlinkSync } from 'fs';
import { dirname } from 'path';
import { getSocketPath } from './paths';
import { writePid, generateToken, cleanupStaleFiles } from './lifecycle';
import { handleRpc, RpcError, openProjectStorage } from './rpc-handlers';
import { reconcileTasks } from '../utils/reconcile';
import { logger } from '../utils/logger';

export interface DaemonServerOptions {
  /** Use an existing token instead of generating a new one. For tests. */
  token?: string;
  /** Override socket path. For tests. */
  socketPath?: string;
  /** Override reconcile interval in seconds. For tests. */
  reconcileIntervalSeconds?: number;
}

export interface RunningDaemon {
  server: ReturnType<typeof Bun.serve>;
  socketPath: string;
  token: string;
  startedAt: number;
  /** Set of project roots the daemon is tracking for reconciliation. */
  activeProjects: Set<string>;
  /** Stop the daemon server and clean up files. Does NOT exit the process. */
  stop: () => void;
}

/**
 * Start the daemon HTTP server on a unix socket.
 *
 * Creates PID file, generates bearer token, binds to unix socket.
 * Returns the running server handle for lifecycle management.
 */
export function startDaemonServer(options: DaemonServerOptions = {}): RunningDaemon {
  // Mark this process as the daemon to prevent recursive RPC calls
  process.env.LAZY_IS_DAEMON = '1';

  const socketPath = options.socketPath ?? getSocketPath();
  const startedAt = Date.now();
  let stopped = false;
  let shutdownTimer: ReturnType<typeof setTimeout> | null = null;

  // Track active project roots for reconciliation
  const activeProjects = new Set<string>();

  // Start reconcile loop
  const reconcileInterval = options.reconcileIntervalSeconds ?? 5;
  const stopReconcileLoop = startDaemonReconcileLoop(activeProjects, reconcileInterval);

  // Ensure daemon directory exists
  mkdirSync(dirname(socketPath), { recursive: true });

  // Clean up stale socket file if it exists
  if (existsSync(socketPath)) {
    try { unlinkSync(socketPath); } catch { /* ignore */ }
  }

  // Write PID file
  writePid(process.pid);

  // Generate or use provided token
  const token = options.token ?? generateToken();

  const server = Bun.serve({
    unix: socketPath,

    async fetch(req: Request): Promise<Response> {
      // Auth check — all endpoints require bearer token
      const authHeader = req.headers.get('authorization');
      if (authHeader !== `Bearer ${token}`) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }

      const url = new URL(req.url);

      // GET /daemon/status — health check
      if (url.pathname === '/daemon/status' && req.method === 'GET') {
        const uptime = Date.now() - startedAt;
        let version = 'unknown';
        try {
          const mod = await import('../version');
          version = mod.VERSION;
        } catch { /* version file may not exist in tests */ }

        return Response.json({
          status: 'running',
          pid: process.pid,
          uptime,
          version,
          socketPath,
        });
      }

      // POST /daemon/shutdown — graceful shutdown
      if (url.pathname === '/daemon/shutdown' && req.method === 'POST') {
        // Schedule exit after responding so the client gets the response
        shutdownTimer = setTimeout(() => {
          stop();
          process.exit(0);
        }, 50);
        return Response.json({ ok: true, message: 'Shutting down' });
      }

      // POST /rpc/{command} — CLI command pass-through
      if (url.pathname.startsWith('/rpc/') && req.method === 'POST') {
        const command = url.pathname.slice(5); // strip '/rpc/'
        const projectRoot = req.headers.get('x-lazy-project');
        if (!projectRoot) {
          return Response.json({ error: 'Missing X-Lazy-Project header' }, { status: 400 });
        }

        // Track this project for background reconciliation
        activeProjects.add(projectRoot);

        try {
          const params = await req.json().catch(() => ({})) as Record<string, unknown>;
          const result = await handleRpc(command, projectRoot, params);
          return Response.json(result);
        } catch (err) {
          if (err instanceof RpcError) {
            return Response.json({ error: err.message }, { status: err.status });
          }
          const message = err instanceof Error ? err.message : 'Internal error';
          return Response.json({ error: message }, { status: 500 });
        }
      }

      return Response.json({ error: 'Not found' }, { status: 404 });
    },
  });

  function stop() {
    if (stopped) return;
    stopped = true;
    // Stop background reconcile loop
    stopReconcileLoop();
    // Cancel any pending shutdown timer (prevents process.exit in tests)
    if (shutdownTimer) {
      clearTimeout(shutdownTimer);
      shutdownTimer = null;
    }
    server.stop();
    cleanupStaleFiles();
    // Remove signal handlers so the process can exit normally
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
  }

  function onSignal() {
    stop();
    process.exit(0);
  }
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  return { server, socketPath, token, startedAt, activeProjects, stop };
}

/**
 * Start a periodic reconciliation loop for the daemon.
 * Iterates over all tracked project roots and reconciles each one.
 *
 * Follows the same pattern as src/server/index.ts startReconcileLoop:
 * - Skips a tick if the previous reconcile is still running
 * - Errors are logged but never crash the server
 * - First reconcile runs after 1s delay
 * - Subsequent reconciles every intervalSeconds
 */
function startDaemonReconcileLoop(activeProjects: Set<string>, intervalSeconds: number): () => void {
  let reconciling = false;
  let stopped = false;

  const doReconcile = async () => {
    if (stopped) return;
    if (reconciling) {
      logger.debug('Daemon reconcile: skipping tick, previous reconcile still running');
      return;
    }
    reconciling = true;
    try {
      for (const projectRoot of activeProjects) {
        if (stopped) break;
        let storage;
        try {
          storage = await openProjectStorage(projectRoot);
          await reconcileTasks(storage, projectRoot);
          logger.debug(`Daemon reconcile completed for ${projectRoot}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.debug(`Daemon reconcile error for ${projectRoot}: ${msg}`);
        } finally {
          if (storage) {
            await storage.close();
          }
        }
      }
    } finally {
      reconciling = false;
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
