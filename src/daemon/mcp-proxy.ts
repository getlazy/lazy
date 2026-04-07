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
 */

import { readFileSync } from 'fs';
import type { McpToolHandler } from '../mcp/types';

export interface DaemonMcpConfig {
  /** Daemon bearer token for authentication */
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
}

/**
 * Create an HTTP proxy handler for a single tool.
 * Returns an McpToolHandler that forwards calls to the daemon.
 */
export function createDaemonProxyHandler(
  config: DaemonMcpConfig,
  toolName: string,
): McpToolHandler {
  return async (args: Record<string, unknown>): Promise<unknown> => {
    const encodedTool = encodeURIComponent(toolName);
    const encodedTask = encodeURIComponent(config.taskId || '_');

    const fetchOptions: RequestInit & { unix?: string } = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.token}`,
        'X-Lazy-Project': config.projectRoot,
      },
      body: JSON.stringify({ arguments: args }),
    };

    let url: string;
    if (config.target.startsWith('http://') || config.target.startsWith('https://')) {
      // TCP mode: target is a full URL base
      url = `${config.target}/mcp/${encodedTask}/${encodedTool}`;
    } else {
      // Unix socket mode
      url = `http://localhost/mcp/${encodedTask}/${encodedTool}`;
      (fetchOptions as any).unix = config.target;
    }

    const response = await fetch(url, fetchOptions);
    const body = await response.json() as { result?: unknown; error?: string };

    if (!response.ok || body.error) {
      throw new Error(body.error ?? `HTTP ${response.status}`);
    }

    return body.result;
  };
}

/**
 * Create proxy handlers for all tools.
 * Returns a Map<toolName, handler> that can be used by the MCP server.
 */
export function createAllDaemonProxyHandlers(
  config: DaemonMcpConfig,
  toolNames: string[],
): Map<string, McpToolHandler> {
  const handlers = new Map<string, McpToolHandler>();
  for (const name of toolNames) {
    handlers.set(name, createDaemonProxyHandler(config, name));
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
 */
export function readDaemonMcpConfig(configPath: string): DaemonMcpConfig {
  const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as DaemonMcpConfigFile;
  return {
    token: raw.token,
    projectRoot: raw.projectRoot,
    taskId: raw.taskId,
    target: raw.target,
  };
}
