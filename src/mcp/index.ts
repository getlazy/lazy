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
import {
  isToolAllowedOnToolset,
  mcpToolsetFromFlags,
  type McpToolset,
} from './tool-access';
import { isToolForRole, roleForTaskId, type McpRole } from './tool-roles';
import type { McpTool, McpToolHandler } from './types';
import mcpServerInstructions from '../prompts/mcp-server-instructions.md' with { type: 'text' };

/** Options shared by every MCP server entry point. */
export interface McpServerOptions {
  /**
   * Serve only the read-only toolset (`--read-only`).
   *
   * Set for ask turns, which are read-only Q&A. This is the layer that actually
   * holds in daemon-proxy mode: there the tool HANDLERS execute inside the
   * daemon, which never sees the supervisor's `LAZY_MCP_READ_ONLY` env var, so
   * the in-handler guard alone would be a no-op for containerized agents. Here
   * the write tool is refused before it is ever proxied.
   *
   * Prefer {@link toolset} when both could apply; if omitted, derived from
   * `readOnly` / `review`.
   */
  readOnly?: boolean;

  /**
   * Agent-review toolset (`--review`): reads plus `lazy_raise`. Other writes
   * stay refused. Mutually exclusive with a plain ask `--read-only` in practice
   * — the supervisor passes one or the other.
   */
  review?: boolean;

  /** Explicit toolset. Wins over `readOnly` / `review` flags when set. */
  toolset?: McpToolset;

  /**
   * Which role this server serves — decides which tools are ADVERTISED.
   *
   * Defaults to 'builder', matching the empty task id an entry point falls back
   * to. Advertisement only; the handlers' own role guards are what refuse a
   * wrong-role call, and they stay reachable for a caller working from a stale
   * tool list.
   */
  role?: McpRole;
}

function resolveServerToolset(opts?: McpServerOptions): McpToolset {
  if (opts?.toolset) return opts.toolset;
  return mcpToolsetFromFlags({ readOnly: opts?.readOnly, review: opts?.review });
}

/**
 * The refusal a write tool returns on a restricted turn (ask or review).
 *
 * Actionable on purpose — a competent model corrects course in the same turn
 * instead of concluding lazy is broken and giving up on tools entirely.
 */
function restrictedToolRefusal(toolName: string, toolset: McpToolset): McpToolHandler {
  return async () => {
    if (toolset === 'review') {
      throw new Error(
        `${toolName} is not available on a review turn — file issues with lazy_raise, ` +
        `then write the verdict JSON as your final message. Read-only lazy tools ` +
        `(lazy_show, lazy_list, lazy_search, lazy_status, lazy_diff, …) work normally.`,
      );
    }
    throw new Error(
      `${toolName} is not available on a read-only turn — your final message is the answer. ` +
      `Write it directly as text. Read-only lazy tools (lazy_show, lazy_list, lazy_search, ` +
      `lazy_status, lazy_diff, …) are available and work normally.`,
    );
  };
}

/**
 * Register every tool on the server, applying the toolset and role policies.
 *
 * Both policies hide rather than remove: an unadvertised tool stays REGISTERED,
 * so a caller working from a stale tool list gets an actionable refusal (the
 * restricted-turn message above, or the handler's own "not available in builder
 * mode") rather than "Unknown tool". Toolset is checked first because its
 * refusal names the right correction for ask / review turns.
 *
 * Exported for `test/unit/mcp-read-only-toolset.test.ts`: the entry points that
 * use it block on stdin forever, so the policy is only testable on its own.
 */
export function registerTools(
  server: McpServer,
  handlers: Map<string, McpToolHandler>,
  tools: McpTool[],
  opts?: McpServerOptions,
): void {
  const role = opts?.role ?? 'builder';
  const toolset = resolveServerToolset(opts);
  for (const tool of tools) {
    if (!isToolAllowedOnToolset(tool.name, toolset)) {
      server.registerTool(tool, restrictedToolRefusal(tool.name, toolset), { advertise: false });
      continue;
    }
    const handler = handlers.get(tool.name);
    if (handler) {
      server.registerTool(tool, handler, { advertise: isToolForRole(tool.name, role) });
    }
  }
}

/**
 * Start the MCP server with the given task context.
 * This is a long-running process that reads from stdin and writes to stdout.
 *
 * LIVENESS BOUNDARY: tools here execute locally, so there is no heartbeat
 * stream to relay and long calls emit no `notifications/progress` — a call that
 * outlives the client's idle budget is abandoned by the client (the daemon-proxy
 * mode below does not have this gap). Every production agent and builder uses
 * the daemon proxy; this local mode is the no-daemon fallback. Closing the gap
 * here means threading a per-call progress channel through
 * tools.ts → rpc-fallback → daemon/client.ts, which is a bigger change on a
 * legacy path — deliberately not done, and stated rather than left implicit.
 */
export async function startMcpServer(ctx: McpToolContext, opts?: McpServerOptions): Promise<void> {
  const server = new McpServer(
    { name: 'lazy', version: '0.8.0' },
    { instructions: mcpServerInstructions },
  );

  registerTools(server, createAllHandlers(ctx), allTools, {
    ...opts,
    role: opts?.role ?? roleForTaskId(ctx.taskId),
  });

  // Run the server (blocks until stdin closes)
  await server.run();
}

/**
 * Start the MCP server in daemon proxy mode.
 * All tool calls are forwarded to the daemon's /mcp/:taskId/:toolName routes.
 *
 * @param daemonConfigPath - Path to the daemon MCP config file. It carries the
 *   caller's OWN token (bound server-side to one identity) and that identity's
 *   task id — `''` for the builder.
 * @param taskIdOverride - Optional task ID to override the config's taskId. The
 *   supervisor passes the real task ID via the --task-id CLI arg so the MCP
 *   server can scope tool calls without writing a task-specific config file
 *   (which would fail in read-only container filesystems). It must name the same
 *   task the token belongs to: the daemon derives identity from the token and
 *   refuses (403) a claim that disagrees.
 */
export async function startMcpServerDaemonProxy(
  daemonConfigPath: string,
  taskIdOverride?: string,
  opts?: McpServerOptions,
): Promise<void> {
  const { readDaemonMcpConfigWithRetry, createAllDaemonProxyHandlers } = await import('../daemon/mcp-proxy');
  // Retrying read: the daemon rewrites this file in place when it restarts onto
  // a new port, and a torn read here would kill the server process before it
  // ever serves a tool — costing the agent every lazy tool for the whole turn.
  const config = await readDaemonMcpConfigWithRetry(daemonConfigPath);

  // Override taskId from CLI arg if provided (normal for agent sessions)
  if (taskIdOverride) {
    config.taskId = taskIdOverride;
  }

  const server = new McpServer(
    { name: 'lazy', version: '0.8.0' },
    { instructions: mcpServerInstructions },
  );

  // Only mint proxy handlers for tools this server will actually serve — a
  // restricted (ask/review) server must not hold a live proxy handler for a
  // write tool outside its toolset.
  //
  // The ROLE filter deliberately does not narrow this set: an out-of-role tool
  // is hidden, not removed, and its refusal is produced by the handler running
  // inside the daemon — so it still needs a proxy handler to reach.
  const toolset = resolveServerToolset(opts);
  const served = allTools.filter((t) => isToolAllowedOnToolset(t.name, toolset));
  const handlers = createAllDaemonProxyHandlers(config, served.map((t) => t.name));

  registerTools(server, handlers, allTools, {
    ...opts,
    toolset,
    role: opts?.role ?? roleForTaskId(config.taskId),
  });

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

  // This mode only ever serves a builder session.
  registerTools(server, handlers, allTools, { role: 'builder' });

  // Run the server (blocks until stdin closes)
  await server.run();
}
