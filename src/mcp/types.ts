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
 * Handler function for an MCP tool call.
 * Receives validated arguments and returns a result object or string.
 * Throw an Error to return an error response.
 */
export type McpToolHandler = (args: Record<string, unknown>) => Promise<unknown>;
