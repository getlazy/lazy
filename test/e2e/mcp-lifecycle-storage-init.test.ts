/**
 * E2E regression tests for the MCP lifecycle handlers and the daemon
 * "Daemon storage not initialized" bug.
 *
 * Companion to mcp-start.test.ts. The lazy_start fix routed that handler
 * through the query* RPC-fallback layer instead of calling launchTask()
 * directly. The SAME latent bug existed in every other MCP lifecycle handler
 * (lazy_unblock, lazy_accept, lazy_reject, lazy_close, lazy_stop, lazy_submit,
 * lazy_resume, lazy_sync, lazy_reparent, lazy_ask): each called a daemon
 * lifecycle function directly, and those functions obtain storage via
 * getOrCreateStorage(), which only works inside the daemon process. In a
 * builder/pairing MCP process they threw
 * "Daemon storage not initialized — call initDaemonStorage() first".
 *
 * These tests run the MCP server against a real daemon WITHOUT LAZY_TEST=1
 * (exactly like a pairing/builder session: reads/create/comment reach the
 * daemon via RemoteStorage, lifecycle ops must reach it via RPC). Each handler
 * is driven until it reaches its lifecycle call, and we assert the response
 * never carries the uninitialized-storage error. (Verified to fail against the
 * pre-fix direct-call path.)
 *
 * The confirmation-gated handlers (accept/reject/close) require the two-step
 * protocol — step 1 returns a code, step 2 executes — and the pending-code map
 * lives in the MCP process, so both steps must run in the SAME McpSession.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { resolve } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';

const AGENT_ENTRY = resolve(__dirname, '../../src/agent-entry.ts');

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: { content: Array<{ type: string; text: string }>; isError?: boolean };
  error?: { code: number; message: string; data?: unknown };
}

/** Extract a confirmation code (e.g. "ac-abcd") from guidance text. */
function extractConfirmationCode(text: string): string | null {
  const match = text.match(/\b([a-z]{2}-[0-9a-f]{4})\b/);
  return match ? match[1] : null;
}

/**
 * A persistent MCP session: one long-lived `lazy-agent mcp` subprocess driven
 * over stdio. Running in builder mode (--task-id '') WITHOUT LAZY_TEST=1, so it
 * reaches the daemon over RPC — the pairing scenario that surfaced the bug.
 */
class McpSession {
  private proc: ReturnType<typeof Bun.spawn>;
  private stdin: import('bun').FileSink;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer = '';
  private nextId = 1;

  constructor(root: string, worktreePath: string) {
    this.proc = Bun.spawn(
      ['bun', 'run', AGENT_ENTRY, 'mcp', '--task-id', '', '--worktree', worktreePath],
      { cwd: root, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...process.env } },
    );
    this.stdin = this.proc.stdin as import('bun').FileSink;
    this.reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
  }

  private async readResponse(id: number): Promise<JsonRpcResponse> {
    const decoder = new TextDecoder();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const nl = this.buffer.indexOf('\n');
      if (nl !== -1) {
        const line = this.buffer.substring(0, nl).trim();
        this.buffer = this.buffer.substring(nl + 1);
        if (line) {
          try {
            const parsed = JSON.parse(line) as JsonRpcResponse;
            if (parsed.id === id) return parsed;
          } catch {
            // not JSON; keep reading
          }
        }
        continue;
      }
      const { value, done } = await this.reader.read();
      if (done) throw new Error(`MCP process exited before response for id=${id}`);
      this.buffer += decoder.decode(value, { stream: true });
    }
    throw new Error(`Timeout waiting for MCP response id=${id}`);
  }

  private async request(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    this.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n');
    await this.stdin.flush();
    return this.readResponse(id);
  }

  async initialize(): Promise<void> {
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
  }

  /**
   * Call a tool and return the flattened text of its response — the tool's
   * success payload, its isError text, or a transport-level JSON-RPC error.
   * Callers assert on this combined text.
   */
  async callText(name: string, args: Record<string, unknown>): Promise<string> {
    const res = await this.request('tools/call', { name, arguments: args });
    if (res.error) return JSON.stringify(res.error);
    const result = res.result!;
    return (result.content?.map(c => c.text).join('\n') ?? '') + (result.isError ? ' [isError]' : '');
  }

  async close(): Promise<void> {
    this.stdin.end();
    this.reader.releaseLock();
    await this.proc.exited;
  }
}

const INIT_ERROR_FRAGMENTS = ['storage not initialized', 'initDaemonStorage'];

function expectNoInitError(text: string): void {
  for (const frag of INIT_ERROR_FRAGMENTS) {
    expect(text).not.toContain(frag);
  }
}

describe('MCP lifecycle handlers reach the daemon (storage-init regression)', () => {
  let ctx: TestContext;
  let session: McpSession;

  beforeEach(async () => {
    // INVARIANT: lifecycle ops require a real daemon for storage. The builder/
    // pairing MCP server runs WITHOUT LAZY_TEST, so it must reach the daemon
    // over RPC — the exact configuration that surfaced the storage-init bug.
    ctx = await setupTestLazy({ withDaemon: true });
    session = new McpSession(ctx.root, ctx.root);
    await session.initialize();
  });

  afterEach(async () => {
    await session.close();
    await ctx.cleanup();
  });

  // --- Single-call handlers: a backlog task reaches the lifecycle RPC call ---
  // INVARIANT: each of these handlers must route its lifecycle op through the
  // query* RPC layer, not a direct daemon-function call. On a backlog task the
  // daemon answers with a business error (wrong status / no session) — proving
  // the call reached the daemon — and NEVER the storage-init error.

  test('lazy_unblock reaches the daemon without the storage-init error', async () => {
    const id = await createTask(ctx, 'Unblock routing', 'Do the work');
    const text = await session.callText('lazy_unblock', { task_id: id, feedback: 'go on' });
    expectNoInitError(text);
  });

  test('lazy_stop reaches the daemon without the storage-init error', async () => {
    const id = await createTask(ctx, 'Stop routing', 'Do the work');
    const text = await session.callText('lazy_stop', { task_id: id, reason: 'halt' });
    expectNoInitError(text);
  });

  test('lazy_submit reaches the daemon without the storage-init error', async () => {
    const id = await createTask(ctx, 'Submit routing', 'Do the work');
    const text = await session.callText('lazy_submit', { task_id: id });
    expectNoInitError(text);
  });

  test('lazy_resume reaches the daemon without the storage-init error', async () => {
    const id = await createTask(ctx, 'Resume routing', 'Do the work');
    const text = await session.callText('lazy_resume', { task_id: id });
    expectNoInitError(text);
  });

  test('lazy_sync reaches the daemon without the storage-init error', async () => {
    const id = await createTask(ctx, 'Sync routing', 'Do the work');
    const text = await session.callText('lazy_sync', { task_id: id });
    expectNoInitError(text);
  });

  test('lazy_reparent reaches the daemon without the storage-init error', async () => {
    const id = await createTask(ctx, 'Reparent routing', 'Do the work');
    const text = await session.callText('lazy_reparent', { task_id: id, parent: 'main' });
    expectNoInitError(text);
  });

  // --- Confirmation-gated handlers: two-step protocol reaches the lifecycle ---
  // Step 1 (no code) returns guidance + a code WITHOUT touching the daemon
  // lifecycle op; step 2 (with code) executes it. Both steps share the same
  // MCP process so the in-memory pending-code map is shared. Step 2 is where
  // the pre-fix direct call threw the storage-init error.

  for (const tool of ['lazy_accept', 'lazy_reject', 'lazy_close'] as const) {
    test(`${tool} reaches the daemon without the storage-init error`, async () => {
      const id = await createTask(ctx, `${tool} routing`, 'Do the work');
      // close/reject require a reason; harmless extra arg for accept.
      const baseArgs = { task_id: id, reason: 'because' };

      const step1 = await session.callText(tool, baseArgs);
      expectNoInitError(step1);

      const code = extractConfirmationCode(step1);
      expect(code).not.toBeNull();

      const step2 = await session.callText(tool, { ...baseArgs, confirmation_code: code });
      // The daemon may answer with success or a business error (e.g. "must be
      // blocked", "no commits") — but never the uninitialized-storage error.
      expectNoInitError(step2);
    });
  }
});
