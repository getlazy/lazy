/**
 * Lookup of every MCP tool definition a dispatcher can be asked for, and the
 * one-call "parse the envelope, then validate against the schema" entry point
 * the HTTP surfaces use.
 *
 * Split out from validate-args.ts so the pure validator stays importable by the
 * stdio MCP server (src/mcp/server.ts) without dragging in the daemon-side
 * handler graph that `internalGitTool` reaches.
 */

import type { McpTool } from './types';
import { allTools } from './tools';
import { internalGitTool } from './internal-git';
import {
  parseToolCallEnvelope,
  validateToolArgs,
  describeArgsFailure,
  type EnvelopeParse,
} from './validate-args';

/**
 * Every tool a dispatcher can be asked for, including the ones deliberately
 * absent from `allTools`.
 *
 * INVARIANT: lazy_internal_git appears HERE but never in `allTools` — it must be
 * VALIDATED (it is reachable over HTTP) without ever being ADVERTISED to an
 * agent. Coverage and discoverability are different questions; conflating them
 * would either leak an internal tool into tool lists or leave a reachable
 * surface unchecked.
 */
export function allDispatchableTools(): McpTool[] {
  return [...allTools, internalGitTool];
}

/** Find a tool definition by name, or undefined when the name is unknown. */
export function findToolDefinition(name: string): McpTool | undefined {
  return allDispatchableTools().find(t => t.name === name);
}

/**
 * Parse a tool-call request body and validate it against the tool's schema.
 *
 * For an unknown tool name the envelope is still enforced (so a malformed body
 * is reported as such) and the caller's own dispatcher answers 404 for the name.
 */
export function parseAndValidateToolCallBody(toolName: string, body: unknown): EnvelopeParse {
  const tool = findToolDefinition(toolName);
  const parsed = parseToolCallEnvelope(toolName, body, tool?.inputSchema);
  if (!parsed.ok || !tool) return parsed;

  const failure = validateToolArgs(tool.inputSchema, parsed.args);
  if (failure) {
    return { ok: false, error: describeArgsFailure(toolName, tool.inputSchema, failure) };
  }
  return parsed;
}
