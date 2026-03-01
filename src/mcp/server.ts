/**
 * Lightweight MCP (Model Context Protocol) server over stdio.
 *
 * Implements the JSON-RPC 2.0 based MCP protocol for tool exposure.
 * Uses stdio transport: reads newline-delimited JSON from stdin,
 * writes newline-delimited JSON to stdout.
 *
 * No external dependencies — the MCP protocol is simple enough to
 * implement directly, keeping the agent binary small.
 */

import type { McpTool, McpToolHandler } from './types';

const JSONRPC_VERSION = '2.0' as const;
const MCP_PROTOCOL_VERSION = '2024-11-05';

interface JsonRpcRequest {
  jsonrpc: typeof JSONRPC_VERSION;
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: typeof JSONRPC_VERSION;
  method: string;
  params?: Record<string, unknown>;
}

export class McpServer {
  private tools = new Map<string, { definition: McpTool; handler: McpToolHandler }>();
  private serverInfo: { name: string; version: string };

  constructor(info: { name: string; version: string }) {
    this.serverInfo = info;
  }

  /**
   * Register a tool with its definition and handler.
   */
  registerTool(definition: McpTool, handler: McpToolHandler): void {
    this.tools.set(definition.name, { definition, handler });
  }

  /**
   * Start the stdio server loop. Reads JSON-RPC messages from stdin,
   * dispatches to handlers, and writes responses to stdout.
   */
  async run(): Promise<void> {
    const reader = Bun.stdin.stream().getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete lines (newline-delimited JSON)
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);

          if (!line) continue;

          try {
            const message = JSON.parse(line) as JsonRpcRequest;
            await this.handleMessage(message);
          } catch (err) {
            // Parse error
            this.sendResponse({
              jsonrpc: JSONRPC_VERSION,
              id: null,
              error: { code: -32700, message: 'Parse error' },
            });
          }
        }
      }
    } catch (err) {
      // Log unexpected errors to stderr (safe — MCP protocol uses stdout only).
      // "The stream is closed" is expected when Claude Code exits normally.
      if (err instanceof Error && err.message !== 'The stream is closed') {
        console.error(`[mcp] Server error: ${err.message}`);
      }
    }
  }

  private async handleMessage(message: JsonRpcRequest): Promise<void> {
    // Notifications (no id) don't need responses
    if (message.id === undefined || message.id === null) {
      // Handle notification methods
      if (message.method === 'notifications/initialized') {
        // Client acknowledges initialization — no response needed
        return;
      }
      if (message.method === 'notifications/cancelled') {
        // Cancellation — no response needed
        return;
      }
      return;
    }

    switch (message.method) {
      case 'initialize':
        this.sendResponse({
          jsonrpc: JSONRPC_VERSION,
          id: message.id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {
              tools: {},
            },
            serverInfo: this.serverInfo,
          },
        });
        break;

      case 'tools/list':
        this.sendResponse({
          jsonrpc: JSONRPC_VERSION,
          id: message.id,
          result: {
            tools: Array.from(this.tools.values()).map(t => t.definition),
          },
        });
        break;

      case 'tools/call':
        await this.handleToolCall(message);
        break;

      case 'ping':
        this.sendResponse({
          jsonrpc: JSONRPC_VERSION,
          id: message.id,
          result: {},
        });
        break;

      default:
        this.sendResponse({
          jsonrpc: JSONRPC_VERSION,
          id: message.id,
          error: { code: -32601, message: `Method not found: ${message.method}` },
        });
    }
  }

  private async handleToolCall(message: JsonRpcRequest): Promise<void> {
    const params = message.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
    const toolName = params?.name;

    if (!toolName) {
      this.sendResponse({
        jsonrpc: JSONRPC_VERSION,
        id: message.id!,
        error: { code: -32602, message: 'Missing tool name' },
      });
      return;
    }

    const tool = this.tools.get(toolName);
    if (!tool) {
      this.sendResponse({
        jsonrpc: JSONRPC_VERSION,
        id: message.id!,
        error: { code: -32602, message: `Unknown tool: ${toolName}` },
      });
      return;
    }

    try {
      const result = await tool.handler(params?.arguments ?? {});
      this.sendResponse({
        jsonrpc: JSONRPC_VERSION,
        id: message.id!,
        result: {
          content: [
            {
              type: 'text',
              text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
            },
          ],
        },
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.sendResponse({
        jsonrpc: JSONRPC_VERSION,
        id: message.id!,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: errorMessage }),
            },
          ],
          isError: true,
        },
      });
    }
  }

  private sendResponse(response: JsonRpcResponse): void {
    const line = JSON.stringify(response) + '\n';
    process.stdout.write(line);
  }
}
