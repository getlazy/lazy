/**
 * Lightweight MCP (Model Context Protocol) server over stdio.
 *
 * Implements the JSON-RPC 2.0 based MCP protocol for tool exposure.
 * Uses stdio transport: reads newline-delimited JSON from stdin,
 * writes newline-delimited JSON to stdout.
 *
 * No external dependencies — the MCP protocol is simple enough to
 * implement directly, keeping the agent binary small.
 *
 * LIVENESS: a tool call that runs for minutes must say so, or the client gives
 * up on it. Claude Code (measured against 2.1.220, not assumed) arms a watchdog
 * per tool call whose clock is reset ONLY by the response or by a
 * `notifications/progress` message — "sent no response or progress for Ns;
 * aborting" — with a 30-minute default for stdio servers
 * (CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT). Its hard ceiling is ~27.8h, so progress
 * is the whole game. This server emitted no progress at all, which is why a
 * `lazy_accept` whose pre-accept turn is itself bounded at 30 minutes was
 * guaranteed to straddle the limit and be abandoned mid-merge.
 *
 * See {@link McpServer.handleToolCall} for what we do and do NOT emit progress
 * for — it is deliberately evidence-driven, not a keepalive ticker.
 */

import type { McpTool, McpToolCallContext, McpToolHandler } from './types';
import { validateToolArgs, isPlainObject } from './validate-args';

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

/**
 * Transport seam for {@link McpServer.run}.
 *
 * Production always uses the defaults (stdin/stdout). Tests inject a pair so the
 * loop can be driven in-process without consuming the real stdin.
 */
export interface McpServerIo {
  input?: ReadableStream<Uint8Array>;
  /** Receives one complete newline-terminated JSON-RPC line per response. */
  output?: (line: string) => void;
}

export class McpServer {
  private tools = new Map<string, { definition: McpTool; handler: McpToolHandler; advertise: boolean }>();
  private serverInfo: { name: string; version: string };
  private instructions?: string;
  private write: (line: string) => void = line => { process.stdout.write(line); };

  constructor(info: { name: string; version: string }, options?: { instructions?: string }) {
    this.serverInfo = info;
    this.instructions = options?.instructions;
  }

  /**
   * Register a tool with its definition and handler.
   *
   * `advertise: false` registers the handler WITHOUT listing the tool in
   * `tools/list`. That combination exists for read-only turns: the write tools
   * are hidden from discovery, but a model working from stale context that
   * calls one anyway gets the handler's actionable refusal instead of a bare
   * "Unknown tool", which reads like the server is broken.
   */
  registerTool(definition: McpTool, handler: McpToolHandler, opts?: { advertise?: boolean }): void {
    this.tools.set(definition.name, { definition, handler, advertise: opts?.advertise !== false });
  }

  /**
   * Start the stdio server loop. Reads JSON-RPC messages from stdin,
   * dispatches to handlers, and writes responses to stdout.
   *
   * INVARIANT: requests are dispatched CONCURRENTLY, never awaited in the read
   * loop. JSON-RPC correlates replies by `id` and MCP explicitly allows multiple
   * in-flight requests, so the loop must keep draining stdin while a handler
   * runs. Awaiting here made the stdio server a global mutex over every lazy
   * tool: one `lazy_accept` (a merge can take minutes) stalled every subsequent
   * `lazy_active`/`lazy_blocked`/`lazy_wait` from the same session for its whole
   * duration, because their request lines sat unread in the stdin buffer. The
   * daemon was healthy throughout — it never saw the requests. Ordering between
   * genuinely conflicting mutations is enforced where it belongs, per task, by
   * the daemon's lifecycle mutex (src/daemon/task-lifecycle-lock.ts); reads must
   * never queue behind an unrelated write.
   */
  async run(io?: McpServerIo): Promise<void> {
    if (io?.output) this.write = io.output;
    const reader = (io?.input ?? Bun.stdin.stream()).getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // In-flight handlers. Tracked so run() resolves only after every dispatched
    // request has answered — otherwise a fast stdin EOF would drop replies.
    const inFlight = new Set<Promise<void>>();

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

          let message: JsonRpcRequest;
          try {
            message = JSON.parse(line) as JsonRpcRequest;
          } catch {
            // Parse error
            this.sendResponse({
              jsonrpc: JSONRPC_VERSION,
              id: null,
              error: { code: -32700, message: 'Parse error' },
            });
            continue;
          }

          this.dispatch(message, inFlight);
        }
      }
    } catch (err) {
      // Log unexpected errors to stderr (safe — MCP protocol uses stdout only).
      // "The stream is closed" is expected when Claude Code exits normally.
      if (err instanceof Error && err.message !== 'The stream is closed') {
        console.error(`[mcp] Server error: ${err.message}`);
      }
    }

    // stdin closed — let anything still running finish writing its reply.
    await Promise.all(inFlight);
  }

  /**
   * Start handling `message` without blocking the read loop, and keep the
   * promise in `inFlight` until it settles.
   */
  private dispatch(message: JsonRpcRequest, inFlight: Set<Promise<void>>): void {
    const task = this.handleMessage(message)
      .catch(err => {
        // handleToolCall already converts handler failures into tool-level
        // error results, so reaching here means the dispatch itself broke.
        // Never let it become an unhandled rejection: the client would wait
        // forever for a reply that is never coming.
        const detail = err instanceof Error ? err.message : String(err);
        if (message.id !== undefined && message.id !== null) {
          this.sendResponse({
            jsonrpc: JSONRPC_VERSION,
            id: message.id,
            error: { code: -32603, message: `Internal error: ${detail}` },
          });
        } else {
          console.error(`[mcp] Handler error for ${message.method}: ${detail}`);
        }
      })
      .finally(() => { inFlight.delete(task); });
    inFlight.add(task);
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
        // INVARIANT: a cancellation NEVER cancels work already in flight.
        //
        // The client sends this when its own idle/hard timeout fires or the
        // user interrupts. By then a `lazy_accept` may be half-way through a
        // merge, or a `lazy_start` may have a container running. The daemon —
        // not the client — owns those operations, and a half-applied merge is
        // far worse than an unread result (the same reasoning is written into
        // src/daemon/heartbeat.ts, which likewise keeps producing after the
        // HTTP client hangs up). So we let the handler finish; its reply is
        // still written, and a client that has moved on simply ignores an id
        // it no longer tracks.
        //
        // Logged to stderr (never stdout — that is the protocol channel) so a
        // "why did that tool call vanish?" investigation has a trace.
        const requestId = (message.params as { requestId?: unknown } | undefined)?.requestId;
        console.error(
          `[mcp] client cancelled request ${String(requestId ?? 'unknown')}; ` +
          'the operation continues on the daemon and is NOT aborted',
        );
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
            ...(this.instructions ? { instructions: this.instructions } : {}),
          },
        });
        break;

      case 'tools/list':
        this.sendResponse({
          jsonrpc: JSONRPC_VERSION,
          id: message.id,
          result: {
            tools: Array.from(this.tools.values()).filter(t => t.advertise).map(t => t.definition),
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

  /**
   * Run one tool and reply.
   *
   * PROGRESS: when the client supplied `_meta.progressToken` (Claude Code
   * always does — it passes an `onprogress` callback, which is what makes the
   * SDK attach the token), the handler is given a `reportProgress` channel and
   * every call becomes a `notifications/progress` message on stdout.
   *
   * INVARIANT: progress is emitted only from EVIDENCE that the work is alive —
   * for proxied tools, a heartbeat frame the daemon actually wrote (see
   * src/daemon/mcp-proxy.ts). It is deliberately NOT a timer of our own. A
   * self-driven keepalive would keep a hung or deadlocked handler looking
   * healthy forever, defeating the very client-side watchdog this exists to
   * satisfy. If the daemon goes quiet, our progress goes quiet with it and the
   * client aborts — which is the correct outcome.
   */
  private async handleToolCall(message: JsonRpcRequest): Promise<void> {
    const params = message.params as {
      name?: string;
      arguments?: Record<string, unknown>;
      _meta?: { progressToken?: string | number };
    } | undefined;
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

    // Validate arguments against the tool's declared inputSchema — unknown
    // parameters, missing required ones, wrong types, enum and length
    // violations. Shares one validator with the daemon's HTTP route and the
    // builder server so all three surfaces accept exactly the same calls
    // (see src/mcp/validate-args.ts).
    const rawArgs = params?.arguments;
    if (rawArgs !== undefined && rawArgs !== null && !isPlainObject(rawArgs)) {
      this.sendResponse({
        jsonrpc: JSONRPC_VERSION,
        id: message.id!,
        error: { code: -32602, message: `"arguments" must be an object mapping parameter names to values` },
      });
      return;
    }
    const args = (rawArgs as Record<string, unknown> | undefined) ?? {};

    const failure = validateToolArgs(tool.definition.inputSchema, args);
    if (failure) {
      this.sendResponse({
        jsonrpc: JSONRPC_VERSION,
        id: message.id!,
        error: { code: -32602, message: failure },
      });
      return;
    }

    const progress = this.progressChannel(params?._meta?.progressToken, toolName);

    try {
      const result = await tool.handler(args, progress.ctx);
      progress.settle();
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
      progress.settle();
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

  /**
   * Build the per-call progress channel for `progressToken`.
   *
   * Returns a no-op channel when the client did not ask for progress — the MCP
   * spec allows `notifications/progress` only for a request that carried a
   * token, and an unsolicited one is a protocol violation.
   *
   * `settle()` closes the channel: a handler that keeps a reference and reports
   * after it resolved must not interleave a notification behind the response.
   */
  private progressChannel(
    progressToken: string | number | undefined,
    toolName: string,
  ): { ctx: McpToolCallContext; settle: () => void } {
    let settled = false;
    // MCP requires `progress` to increase on every notification for a token.
    let sequence = 0;
    const started = Date.now();

    const ctx: McpToolCallContext = {
      reportProgress: (message?: string) => {
        if (settled || progressToken === undefined || progressToken === null) return;
        sequence += 1;
        this.sendNotification({
          jsonrpc: JSONRPC_VERSION,
          method: 'notifications/progress',
          params: {
            progressToken,
            progress: sequence,
            message: message ?? `${toolName} still running (${Math.round((Date.now() - started) / 1000)}s)`,
          },
        });
      },
    };

    return { ctx, settle: () => { settled = true; } };
  }

  /**
   * Write one JSON-RPC reply.
   *
   * Replies are emitted in completion order, not request order — that is the
   * point of concurrent dispatch, and JSON-RPC clients correlate by `id`. Each
   * reply is written with a single call so two concurrent responses can never
   * interleave within a line.
   */
  private sendResponse(response: JsonRpcResponse): void {
    this.write(JSON.stringify(response) + '\n');
  }

  /**
   * Write one JSON-RPC notification (no id, no reply expected).
   *
   * Same single-write discipline as {@link sendResponse}: a notification and a
   * response must never interleave within a line.
   */
  private sendNotification(notification: JsonRpcNotification): void {
    this.write(JSON.stringify(notification) + '\n');
  }
}

