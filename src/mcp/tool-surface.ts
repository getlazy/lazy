/**
 * The tool surface a role is actually served — the single source for anything
 * that needs to know "what does this caller see".
 *
 * Everything that answers that question goes through here: the MCP server's
 * advertisement policy, the runners' tool pre-approval lists, and the context
 * budget `lazy doctor` reports. Re-deriving it per surface is how the numbers
 * a human is shown drift away from what the model is actually sent.
 */

import type { McpTool } from './types';
import { allTools } from './tools';
import { isToolForRole, type McpRole } from './tool-roles';
import {
  isToolAllowedOnToolset,
  type McpToolset,
} from './tool-access';

export interface ToolSurfaceOpts {
  /**
   * Turn toolset. Prefer this over the legacy `readOnly` boolean.
   * Defaults to `full`.
   */
  toolset?: McpToolset;
  /**
   * Legacy ask-turn flag. When true and `toolset` is omitted, selects `read`.
   * Ignored when `toolset` is set.
   */
  readOnly?: boolean;
}

function resolveToolset(opts?: ToolSurfaceOpts): McpToolset {
  if (opts?.toolset) return opts.toolset;
  return opts?.readOnly === true ? 'read' : 'full';
}

/**
 * Arguments only the builder may pass, withheld from a task agent's schema so
 * it is neither offered them nor pays for them in context. The handlers refuse
 * them from an agent regardless — this is advertisement, not enforcement.
 * `past_usage_pause`: letting a task past the usage pause is a person's or the
 * builder's call, never a task agent's (src/daemon/usage-pause.ts).
 */
const BUILDER_ONLY_ARGS: readonly string[] = ['past_usage_pause'];

/** `tool`'s definition as `role` is served it (the MCP server registers this one). */
export function definitionForRole(tool: McpTool, role: McpRole): McpTool {
  return role === 'builder' ? tool : withoutBuilderOnlyArgs(tool);
}

function withoutBuilderOnlyArgs(tool: McpTool): McpTool {
  const props = tool.inputSchema.properties;
  if (!props || !BUILDER_ONLY_ARGS.some((k) => k in props)) return tool;
  const kept = Object.fromEntries(Object.entries(props).filter(([k]) => !BUILDER_ONLY_ARGS.includes(k)));
  return { ...tool, inputSchema: { ...tool.inputSchema, properties: kept } };
}

/** Tools advertised to `role` under the given toolset. */
export function toolsForRole(role: McpRole, opts?: ToolSurfaceOpts): McpTool[] {
  const toolset = resolveToolset(opts);
  const tools = allTools.filter(
    (t) => isToolForRole(t.name, role) && isToolAllowedOnToolset(t.name, toolset),
  );
  return tools.map((t) => definitionForRole(t, role));
}

/** Names of the tools advertised to `role`, in `allTools` order. */
export function toolNamesForRole(role: McpRole, opts?: ToolSurfaceOpts): string[] {
  return toolsForRole(role, opts).map((t) => t.name);
}

/**
 * The tool surface as it goes over the wire in a `tools/list` reply.
 *
 * This is what a session pays for before its first message, so it is measured
 * from the same list the server advertises — never from `allTools`, which no
 * caller is served in full.
 */
export function serializedToolSurface(
  role: McpRole,
  opts?: ToolSurfaceOpts,
): { count: number; text: string } {
  const tools = toolsForRole(role, opts);
  return { count: tools.length, text: JSON.stringify(tools) };
}
