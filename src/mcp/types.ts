/**
 * MCP tool type definitions.
 *
 * Follows the MCP specification for tool schemas using JSON Schema.
 */

/** JSON Schema property for MCP tool parameters. */
export interface McpToolPropertySchema {
  type: string;
  description?: string;
  enum?: string[];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  /** For array types: schema of each element. */
  items?: { type: string; enum?: string[] };
}

export interface McpToolInputSchema {
  type: 'object';
  properties?: Record<string, McpToolPropertySchema>;
  required?: string[];
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: McpToolInputSchema;
}

/**
 * Liveness channel handed to a tool handler for the duration of one call.
 *
 * A handler calls {@link McpToolCallContext.reportProgress} when it has fresh
 * EVIDENCE that the work is still alive — never on a timer of its own. The MCP
 * server turns each call into a `notifications/progress` message, which is what
 * keeps a long call inside a client's idle budget (see src/mcp/server.ts).
 *
 * Optional on purpose: the server always passes one, but every handler may
 * ignore it, and tests may call handlers with a single argument.
 */
export interface McpToolCallContext {
  /**
   * Report that the call is still running. `message` is shown by clients that
   * render progress. A no-op when the client did not ask for progress.
   */
  reportProgress: (message?: string) => void;
}

/**
 * Handler function for an MCP tool call.
 * Receives validated arguments and returns a result object or string.
 * Throw an Error to return an error response.
 */
export type McpToolHandler = (
  args: Record<string, unknown>,
  ctx?: McpToolCallContext,
) => Promise<unknown>;

/**
 * The supervisor's host-side git escape hatch (see src/mcp/internal-git.ts).
 *
 * Declared in this leaf module so the supervisor can name the tool without
 * importing the daemon-side handler (and the whole task-lifecycle graph with
 * it). INVARIANT: this tool is never listed in `allTools` — it is not an
 * agent-facing tool and must never be advertised or pre-approved as one.
 */
export const INTERNAL_GIT_TOOL_NAME = 'lazy_internal_git';
