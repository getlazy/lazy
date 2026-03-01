/**
 * MCP server entry point.
 *
 * Starts a stdio-based MCP server that exposes all agent-facing operations
 * as typed tools. Called via `lazy-agent mcp --task-id <uuid> --worktree <path>`.
 *
 * In builder proxy mode (--builder-config <path>), tool handlers forward calls
 * to the host-side builder HTTP server over TCP instead of executing locally.
 * This is how the container communicates with the host.
 */

export { McpServer } from './server';
export { allTools, createAllHandlers, type McpToolContext } from './tools';

import { McpServer } from './server';
import { allTools, createAllHandlers, type McpToolContext } from './tools';

/**
 * Start the MCP server with the given task context.
 * This is a long-running process that reads from stdin and writes to stdout.
 */
export async function startMcpServer(ctx: McpToolContext): Promise<void> {
  const server = new McpServer({
    name: 'lazy',
    version: '0.8.0',
  });

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
 * Start the MCP server in builder proxy mode.
 * All tool calls are forwarded to the host-side builder HTTP server.
 */
export async function startMcpServerProxy(builderConfigPath: string): Promise<void> {
  const { readBuilderConfig, createAllProxyHandlers } = await import('../builder/client');
  const config = readBuilderConfig(builderConfigPath);

  const server = new McpServer({
    name: 'lazy',
    version: '0.8.0',
  });

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
