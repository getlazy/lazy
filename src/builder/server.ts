/**
 * Builder HTTP server — serves tool call requests over TCP on localhost.
 *
 * The builder command (`lazy builder`) starts this server, then launches
 * Docker or a host-process supervisor. The supervisor connects MCP tool
 * handlers to this server via HTTP, so all tool execution happens on the
 * host side where storage, git, and Docker are available.
 *
 * Protocol:
 *   POST /tool/:name  — Execute a tool. Body is JSON { arguments: {...} }.
 *                        Returns { result: ... } or { error: "..." }.
 *   POST /shutdown     — Signal that the session ended. Server cleans up.
 *
 * Authentication: Bearer token in Authorization header (token from config file).
 */

import { randomUUID, randomBytes } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createAllHandlers, type McpToolContext } from '../mcp/tools';


export interface BuilderConfigFile {
  /** Host to connect to (127.0.0.1 for host-local, host.docker.internal for container) */
  host: string;
  /** TCP port the server is listening on */
  port: number;
  /** Bearer token */
  token: string;
  /** Lazy root directory */
  lazyRoot: string;
}

/**
 * Generate a builder config: random token + placeholder port (filled after server starts).
 * The config file is written to .lazy/tmp/ so both host and container can access it.
 */
export function generateBuilderConfig(lazyRoot: string, dataDir: string): {
  configPath: string;
  config: BuilderConfigFile;
  id: string;
} {
  const tmpDir = join(lazyRoot, dataDir, 'tmp');
  mkdirSync(tmpDir, { recursive: true });

  const id = randomUUID().split('-')[0];
  const configPath = join(tmpDir, `builder-${id}.json`);
  const token = randomBytes(32).toString('hex');

  const config: BuilderConfigFile = {
    host: '127.0.0.1',
    port: 0, // Filled after server starts
    token,
    lazyRoot,
  };

  return { configPath, config, id };
}

/**
 * Start the builder HTTP server on a random TCP port bound to 127.0.0.1.
 *
 * Reuses the existing MCP tool handler functions — the HTTP server is just
 * a transport layer. The McpToolContext has an empty taskId (builder mode)
 * and worktreePath pointing at the repo root.
 *
 * After starting, writes the config file with the actual port number.
 */
export function startBuilderServer(
  config: BuilderConfigFile,
  configPath: string,
): { server: ReturnType<typeof Bun.serve>; port: number; cleanup: () => void } {
  const ctx: McpToolContext = {
    taskId: '', // builder mode — no specific task
    worktreePath: config.lazyRoot,
  };

  const handlers = createAllHandlers(ctx);

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0, // Random available port

    async fetch(req: Request): Promise<Response> {
      // Auth check
      const authHeader = req.headers.get('authorization');
      if (authHeader !== `Bearer ${config.token}`) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }

      const url = new URL(req.url);

      // POST /shutdown — signal session ended
      if (url.pathname === '/shutdown' && req.method === 'POST') {
        return Response.json({ ok: true });
      }

      // POST /tool/:name — execute a tool
      const toolMatch = url.pathname.match(/^\/tool\/(.+)$/);
      if (toolMatch && req.method === 'POST') {
        const toolName = toolMatch[1];
        const handler = handlers.get(toolName);

        if (!handler) {
          return Response.json(
            { error: `Unknown tool: ${toolName}` },
            { status: 404 },
          );
        }

        try {
          const body = await req.json() as { arguments?: Record<string, unknown> };
          const args = body.arguments ?? {};
          const result = await handler(args);
          return Response.json({ result });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return Response.json({ error: message }, { status: 500 });
        }
      }

      return Response.json({ error: 'Not found' }, { status: 404 });
    },
  });

  const port = server.port!;

  // Write config with actual port
  config.port = port;
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  const cleanup = () => {
    server.stop();
  };

  return { server, port, cleanup };
}
