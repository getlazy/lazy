/**
 * MCP server entry point.
 *
 * Starts a stdio-based MCP server that exposes all agent-facing operations
 * as typed tools. Called via `lazy-agent mcp --task-id <uuid> --worktree <path>`.
 *
 * Proxy modes:
 *   --daemon-config <path>:  Forward tool calls to the daemon over HTTP (preferred).
 *                            The daemon executes tools with full host access.
 *   --builder-config <path>: Legacy — forward to a per-session builder HTTP server.
 *                            Deprecated in favor of daemon proxy.
 *
 * When no proxy config is provided, tools execute locally (current behavior).
 */

export { McpServer } from './server';
export { allTools, createAllHandlers, type McpToolContext } from './tools';

import { McpServer } from './server';
import { allTools, createAllHandlers, type McpToolContext } from './tools';
import mcpServerInstructions from '../prompts/mcp-server-instructions.md' with { type: 'text' };

/**
 * Start the MCP server with the given task context.
 * This is a long-running process that reads from stdin and writes to stdout.
 */
export async function startMcpServer(ctx: McpToolContext): Promise<void> {
  const server = new McpServer(
    { name: 'lazy', version: '0.8.0' },
    { instructions: mcpServerInstructions },
  );

  // Register all tools
  const handlers = createAllHandlers(ctx);
  for (const tool of allTools) {
    const handler = handlers.get(tool.name);
    if (handler) {
      server.registerTool(tool, handler);
    }
  }

  // Run the server (blocks until stdin closes)
  await server.run();
}

/**
 * Start the MCP server in daemon proxy mode.
 * All tool calls are forwarded to the daemon's /mcp/:taskId/:toolName routes.
 *
 * @param daemonConfigPath - Path to daemon MCP config file (template with taskId='')
 * @param taskIdOverride - Optional task ID to override the config's taskId.
 *   The daemon config template has an empty taskId. The supervisor passes the
 *   real task ID via --task-id CLI arg so the MCP server can scope tool calls
 *   without writing a task-specific config file (which would fail in read-only
 *   container filesystems).
 */
export async function startMcpServerDaemonProxy(daemonConfigPath: string, taskIdOverride?: string): Promise<void> {
  const { readDaemonMcpConfig, createAllDaemonProxyHandlers } = await import('../daemon/mcp-proxy');
  const config = readDaemonMcpConfig(daemonConfigPath);

  // Override taskId from CLI arg if provided (normal for agent sessions)
  if (taskIdOverride) {
    config.taskId = taskIdOverride;
  }

  const server = new McpServer(
    { name: 'lazy', version: '0.8.0' },
    { instructions: mcpServerInstructions },
  );

  // Create proxy handlers for all tools
  const toolNames = allTools.map(t => t.name);
  const handlers = createAllDaemonProxyHandlers(config, toolNames);

  for (const tool of allTools) {
    const handler = handlers.get(tool.name);
    if (handler) {
      server.registerTool(tool, handler);
    }
  }

  // Run the server (blocks until stdin closes)
  await server.run();
}

/**
 * Start the MCP server in builder proxy mode (legacy).
 * All tool calls are forwarded to the host-side builder HTTP server.
 *
 * @deprecated Use startMcpServerDaemonProxy instead. The daemon MCP routes
 * replace the per-session builder HTTP server.
 */
export async function startMcpServerProxy(builderConfigPath: string): Promise<void> {
  const { readBuilderConfig, createAllProxyHandlers } = await import('../builder/client');
  const config = readBuilderConfig(builderConfigPath);

  const server = new McpServer(
    { name: 'lazy', version: '0.8.0' },
    { instructions: mcpServerInstructions },
  );

  // Create proxy handlers for all tools
  const toolNames = allTools.map(t => t.name);
  const handlers = createAllProxyHandlers(config.host, config.port, config.token, toolNames);

  for (const tool of allTools) {
    const handler = handlers.get(tool.name);
    if (handler) {
      server.registerTool(tool, handler);
    }
  }

  // Run the server (blocks until stdin closes)
  await server.run();
}
