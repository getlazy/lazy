/**
 * Shared driver for e2e tests that speak MCP to a real `lazy-agent mcp`
 * subprocess.
 *
 * Used by the suites whose calls are DEPENDENT (tag→untag, start→show,
 * memory save→recall). The important difference from the older per-file copies,
 * which are still in use where calls are independent: this driver sends one
 * request, WAITS for the reply carrying that id, and only then sends the next.
 *
 * Why that matters: the MCP stdio server dispatches requests concurrently (see
 * the invariant in src/mcp/server.ts — a long `lazy_accept` must not stall a
 * `lazy_active`). "Write the next line 50ms later and hope" therefore no longer
 * orders dependent calls: a `lazy_tag` whose daemon round-trip takes longer than
 * that sleep could land AFTER the `lazy_untag` that was supposed to follow it.
 * Waiting for each reply is also exactly what a real MCP client does when it
 * issues dependent tool calls, so the tests now exercise the real sequencing
 * rather than an accident of the old serialized loop.
 *
 * Tests that deliberately want two calls IN FLIGHT at once must not use this —
 * see test/e2e/mcp-concurrency.test.ts, which drives the pipe directly.
 */

import { spawn } from '../../src/utils/spawn';
import { resolve } from 'path';

const AGENT_ENTRY = resolve(__dirname, '../../src/agent-entry.ts');

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  /**
   * `tools/call` replies carry `content`; `tools/list` and `initialize` carry
   * their own shapes, which callers narrow with a cast — hence the index
   * signature alongside the tool-call fields.
   */
  result?: { content?: Array<{ type?: string; text: string }>; isError?: boolean; [key: string]: unknown };
  error?: { code: number; message: string; data?: unknown };
}

export interface McpMessage {
  method: string;
  id: number;
  params?: Record<string, unknown>;
}

export interface McpSessionOptions {
  /** Per-request wait before failing with context. Default 30s. */
  timeoutMs?: number;
  /** Extra env for the MCP subprocess. */
  env?: Record<string, string | undefined>;
}

/**
 * Run an MCP session: send each message, await its reply, then send the next.
 * Returns every response line in the order it was received.
 */
export async function runMcpSession(
  root: string,
  taskId: string,
  worktreePath: string,
  messages: McpMessage[],
  options?: McpSessionOptions,
): Promise<JsonRpcResponse[]> {
  const timeoutMs = options?.timeoutMs ?? 30_000;

  const proc = spawn(['bun', 'run', AGENT_ENTRY, 'mcp', '--task-id', taskId, '--worktree', worktreePath], {
    cwd: root,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...options?.env },
  });

  const responses: JsonRpcResponse[] = [];
  let streamEnded = false;
  /** Woken on every new response line and on stream end. */
  const waiters: Array<() => void> = [];
  const notify = (): void => { while (waiters.length) waiters.pop()!(); };

  const reading = (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          responses.push(JSON.parse(line) as JsonRpcResponse);
        } catch {
          // Skip non-JSON lines (banners, stray logging)
        }
      }
      notify();
    }
    streamEnded = true;
    notify();
  })();

  const waitFor = async (id: number): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!responses.some(r => r.id === id)) {
      if (streamEnded) {
        throw new Error(
          `MCP session ended before replying to request id=${id}; ` +
          `stderr: ${await new Response(proc.stderr).text()}`,
        );
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out waiting ${timeoutMs}ms for MCP reply id=${id}`);
      await new Promise<void>(resolveWait => {
        const timer = setTimeout(resolveWait, Math.min(remaining, 50));
        waiters.push(() => { clearTimeout(timer); resolveWait(); });
      });
    }
  };

  const stdin = proc.stdin as import('bun').FileSink;
  let stdinEnded = false;
  const endStdin = (): void => {
    if (stdinEnded) return;
    stdinEnded = true;
    stdin.end();
  };

  try {
    for (const msg of messages) {
      stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
      stdin.flush();
      await waitFor(msg.id);
    }
    endStdin();
  } catch (err) {
    // A timeout means the subprocess is wedged; closing stdin may not be enough
    // to make it exit, and the finally below awaits that exit.
    endStdin();
    proc.kill();
    throw err;
  } finally {
    await reading.catch(() => { /* stream teardown races with stdin.end() */ });
    await proc.exited;
  }

  return responses;
}

/** Parse a tool response's JSON text payload; {} when it is not JSON. */
export function mcpPayload(response: JsonRpcResponse | undefined): Record<string, unknown> {
  const text = response?.result?.content?.[0]?.text ?? '';
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Raw text of a tool response (errors are returned as text, not JSON). */
export function mcpText(response: JsonRpcResponse | undefined): string {
  return response?.result?.content?.[0]?.text ?? JSON.stringify(response?.error ?? {});
}
