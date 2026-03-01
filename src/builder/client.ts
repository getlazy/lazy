/**
 * Builder HTTP proxy client — thin HTTP client for tool calls.
 *
 * Used inside the container (or host-process supervisor) to forward MCP tool
 * calls to the host-side builder HTTP server over TCP.
 *
 * Each MCP tool handler becomes a simple HTTP POST to /tool/:name.
 */

import { readFileSync } from 'fs';
import type { BuilderConfigFile } from './server';
import type { McpToolHandler } from '../mcp/types';

/**
 * Read the builder config file.
 */
export function readBuilderConfig(configPath: string): BuilderConfigFile {
  return JSON.parse(readFileSync(configPath, 'utf-8')) as BuilderConfigFile;
}

/**
 * Create an HTTP proxy handler for a single tool.
 * Returns an McpToolHandler that forwards calls to the host server.
 */
export function createProxyHandler(
  host: string,
  port: number,
  token: string,
  toolName: string,
): McpToolHandler {
  return async (args: Record<string, unknown>): Promise<unknown> => {
    const response = await fetch(`http://${host}:${port}/tool/${toolName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ arguments: args }),
    });

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
export function createAllProxyHandlers(
  host: string,
  port: number,
  token: string,
  toolNames: string[],
): Map<string, McpToolHandler> {
  const handlers = new Map<string, McpToolHandler>();
  for (const name of toolNames) {
    handlers.set(name, createProxyHandler(host, port, token, name));
  }
  return handlers;
}

/**
 * Signal the host server that the builder session has ended.
 */
export async function signalShutdown(host: string, port: number, token: string): Promise<void> {
  try {
    await fetch(`http://${host}:${port}/shutdown`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });
  } catch {
    // Best effort — server may already be gone
  }
}
