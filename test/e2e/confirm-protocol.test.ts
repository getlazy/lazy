/**
 * E2E tests for the MCP confirmation protocol.
 *
 * Tests the two-step confirmation pattern: tools that require confirmation
 * return guidance + a code on the first call, and execute on the second call
 * with the code. Tests call MCP tools directly via the JSON-RPC protocol.
 *
 * All two-step tests run within a single MCP session (single process) so that
 * the in-memory pending confirmation map is shared between step 1 and step 2.
 * This matches production usage where the MCP daemon is persistent.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { resolve, join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { writeFileSync } from 'fs';

const AGENT_ENTRY = resolve(__dirname, '../../src/agent-entry.ts');

/** Extract a confirmation code (e.g. "rj-abcd") from error text. */
function extractConfirmationCode(errorText: string): string {
  const match = errorText.match(/(?:confirmation_code[:\s]*"?|code:\s*")([a-z]{2}-[0-9a-f]{4})"?/);
  if (!match) throw new Error(`No confirmation code found in error text: ${errorText}`);
  return match[1];
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Interactive MCP session that keeps the subprocess alive between requests.
 * Allows sequential dependent calls within the same process (same pending map).
 */
class McpSession {
  private proc: ReturnType<typeof Bun.spawn>;
  private stdin: import('bun').FileSink;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer = '';
  private nextId = 1;

  constructor(root: string, taskId: string, worktreePath: string) {
    this.proc = Bun.spawn(
      ['bun', 'run', AGENT_ENTRY, 'mcp', '--task-id', taskId, '--worktree', worktreePath],
      {
        cwd: root,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env },
      },
    );
    this.stdin = this.proc.stdin as import('bun').FileSink;
    this.reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
  }

  /** Read lines from stdout until we find a JSON-RPC response with the given id. */
  private async readResponse(id: number): Promise<JsonRpcResponse> {
    const decoder = new TextDecoder();
    const deadline = Date.now() + 30_000; // 30s timeout

    while (Date.now() < deadline) {
      // Check if we already have a complete line in the buffer
      const newlineIdx = this.buffer.indexOf('\n');
      if (newlineIdx !== -1) {
        const line = this.buffer.substring(0, newlineIdx).trim();
        this.buffer = this.buffer.substring(newlineIdx + 1);

        if (line) {
          try {
            const parsed = JSON.parse(line) as JsonRpcResponse;
            if (parsed.id === id) {
              return parsed;
            }
            // Not our response (e.g., a notification); keep reading
          } catch {
            // Not JSON; keep reading
          }
        }
        continue;
      }

      // Need more data from the stream
      const { value, done } = await this.reader.read();
      if (done) {
        throw new Error(`MCP process exited before response for id=${id}`);
      }
      this.buffer += decoder.decode(value, { stream: true });
    }

    throw new Error(`Timeout waiting for MCP response id=${id}`);
  }

  /** Send a JSON-RPC request and wait for the matching response. */
  async request(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n';
    this.stdin.write(msg);
    await this.stdin.flush();
    return this.readResponse(id);
  }

  /** Initialize the MCP session. Must be called first. */
  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
    });
  }

  /** Call an MCP tool and return the parsed JSON result. */
  async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.request('tools/call', { name, arguments: args });
    if (response.error) {
      throw new Error(`Tool error: ${response.error.message}`);
    }
    const result = response.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    if (result.isError) {
      // Return the error result so tests can inspect it
      return { _isError: true, _errorText: result.content[0]?.text };
    }
    return JSON.parse(result.content[0].text);
  }

  /** Close the session. */
  async close(): Promise<void> {
    this.stdin.end();
    this.reader.releaseLock();
    await this.proc.exited;
  }
}

/**
 * Run a batch MCP session (send all messages, close stdin, collect output).
 * Use this for simple non-dependent calls. For two-step flows, use McpSession.
 */
async function runMcpSession(
  root: string,
  taskId: string,
  worktreePath: string,
  messages: Array<{ method: string; id: number; params?: Record<string, unknown> }>,
): Promise<JsonRpcResponse[]> {
  const proc = Bun.spawn(['bun', 'run', AGENT_ENTRY, 'mcp', '--task-id', taskId, '--worktree', worktreePath], {
    cwd: root,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  });

  const stdin = proc.stdin as import('bun').FileSink;

  for (const msg of messages) {
    const request = JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n';
    stdin.write(request);
    await Bun.sleep(50);
  }

  stdin.end();

  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  const responses: JsonRpcResponse[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      responses.push(JSON.parse(line));
    } catch {
      // Skip non-JSON lines
    }
  }

  return responses;
}

describe('MCP confirmation protocol', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: Abandon always requires confirmation via the two-step MCP protocol.
  // This prevents the builder from accidentally abandoning work instead of giving feedback.
  test('lazy_close requires confirmation (two-step)', async () => {
    const taskShortId = await createTask(ctx, 'Task to abandon', 'Do the work');
    const startResult = await ctx.lazyMocked(
      ['start', taskShortId, '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_PROMPT_DEFAULTS: 'accept' } },
    );
    expect(startResult.exitCode).toBe(0);

    const session = new McpSession(ctx.root, '00000000-0000-0000-0000-000000000001', ctx.root);
    try {
      await session.initialize();

      // Step 1: call without confirmation code -> get error with guidance
      const step1 = await session.callTool('lazy_close', {
        task_id: taskShortId,
        reason: 'Wrong approach',
      });

      expect(step1._isError).toBe(true);
      const errorText = step1._errorText as string;
      expect(errorText).toContain('lazy_unblock');
      const closeCode = extractConfirmationCode(errorText);
      expect(closeCode).toMatch(/^cl-[0-9a-f]{4}$/);

      // Step 2: call with confirmation code -> executes (same process, shared pending map)
      const step2 = await session.callTool('lazy_close', {
        task_id: taskShortId,
        reason: 'Wrong approach',
        confirmation_code: closeCode,
      });

      expect(step2.output).toBeDefined();
    } finally {
      await session.close();
    }
  });

  // INVARIANT: Confirmation codes are single-use. A consumed code cannot be replayed.
  test('confirmation code cannot be reused', async () => {
    const taskShortId = await createTask(ctx, 'Task for reuse test', 'Do the work');
    const startResult = await ctx.lazyMocked(
      ['start', taskShortId, '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_PROMPT_DEFAULTS: 'accept' } },
    );
    expect(startResult.exitCode).toBe(0);

    const session = new McpSession(ctx.root, '00000000-0000-0000-0000-000000000001', ctx.root);
    try {
      await session.initialize();

      // Step 1: get a confirmation code (returned in error)
      const step1 = await session.callTool('lazy_close', {
        task_id: taskShortId,
        reason: 'test',
      });
      expect(step1._isError).toBe(true);
      const code = extractConfirmationCode(step1._errorText as string);

      // Step 2: use it once (succeeds)
      const step2 = await session.callTool('lazy_close', {
        task_id: taskShortId,
        reason: 'test',
        confirmation_code: code,
      });
      expect(step2.output).toBeDefined();

      // Step 3: try to reuse the same code (fails — code was consumed)
      const step3 = await session.callTool('lazy_close', {
        task_id: taskShortId,
        reason: 'test',
        confirmation_code: code,
      });
      expect(step3._isError).toBe(true);
      expect(step3._errorText).toContain('Invalid or expired confirmation code');
    } finally {
      await session.close();
    }
  });

  // INVARIANT: An abandon code cannot be used to confirm an accept (cross-operation rejection).
  // Codes are scoped to (operation, taskId).
  test('abandon code cannot confirm accept', async () => {
    const taskShortId = await createTask(ctx, 'Task for cross-op test', 'Do the work');
    const startResult = await ctx.lazyMocked(
      ['start', taskShortId, '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_PROMPT_DEFAULTS: 'accept' } },
    );
    expect(startResult.exitCode).toBe(0);

    const session = new McpSession(ctx.root, '00000000-0000-0000-0000-000000000001', ctx.root);
    try {
      await session.initialize();

      // Get an abandon confirmation code (returned in error)
      const closeStep = await session.callTool('lazy_close', {
        task_id: taskShortId,
        reason: 'test',
      });
      expect(closeStep._isError).toBe(true);
      const closeCode = extractConfirmationCode(closeStep._errorText as string);
      expect(closeCode).toMatch(/^cl-/);

      // Try to use the abandon code for accept -> should fail
      const acceptStep = await session.callTool('lazy_accept', {
        task_id: taskShortId,
        confirmation_code: closeCode,
      });
      expect(acceptStep._isError).toBe(true);
      expect(acceptStep._errorText).toContain('Invalid or expired confirmation code');
    } finally {
      await session.close();
    }
  });

  // INVARIANT: Accept requires stern confirmation when diff stat is unavailable.
  // Unknown risk defaults to the safest option.
  test('accept requires stern confirmation when diff stat is unavailable', async () => {
    const taskShortId = await createTask(ctx, 'Unknown diff task', 'Do the work');
    const startResult = await ctx.lazyMocked(
      ['start', taskShortId, '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_PROMPT_DEFAULTS: 'accept' } },
    );
    expect(startResult.exitCode).toBe(0);

    const session = new McpSession(ctx.root, '00000000-0000-0000-0000-000000000001', ctx.root);
    try {
      await session.initialize();

      // With no computable diff (test env), accept defaults to stern.
      const result = await session.callTool('lazy_accept', {
        task_id: taskShortId,
      });

      expect(result._isError).toBe(true);
      expect(result._errorText).toContain('large merge');
    } finally {
      await session.close();
    }
  });

  // INVARIANT: Abandon scales confirmation with commit count.
  // Tasks with no work are light; tasks with commits are stern.
  test('abandon requires confirmation and scales with commits', async () => {
    const taskShortId = await createTask(ctx, 'Empty task to abandon', 'Do the work');

    const session = new McpSession(ctx.root, '00000000-0000-0000-0000-000000000001', ctx.root);
    try {
      await session.initialize();

      // Abandon a backlog task with no commits -> light level (returned as error)
      const step1 = await session.callTool('lazy_close', {
        task_id: taskShortId,
        reason: 'Not needed',
      });

      expect(step1._isError).toBe(true);
      const closeCode = extractConfirmationCode(step1._errorText as string);
      expect(closeCode).toMatch(/^cl-[0-9a-f]{4}$/);
    } finally {
      await session.close();
    }
  });

  // INVARIANT: Abandon can be confirmed with the returned code.
  test('abandon confirmation code allows execution', async () => {
    const taskShortId = await createTask(ctx, 'Task to abandon', 'Do the work');

    const session = new McpSession(ctx.root, '00000000-0000-0000-0000-000000000001', ctx.root);
    try {
      await session.initialize();

      // Step 1: get code (returned in error)
      const step1 = await session.callTool('lazy_close', {
        task_id: taskShortId,
        reason: 'Done',
      });
      expect(step1._isError).toBe(true);
      const closeCode = extractConfirmationCode(step1._errorText as string);
      expect(closeCode).toMatch(/^cl-[0-9a-f]{4}$/);

      // Step 2: use code to execute (same process, shared pending map)
      const step2 = await session.callTool('lazy_close', {
        task_id: taskShortId,
        reason: 'Done',
        confirmation_code: closeCode,
      });
      expect(step2.output).toBeDefined();
    } finally {
      await session.close();
    }
  });

  // INVARIANT: Redo always requires confirmation (at least standard level).
  test('redo requires confirmation', async () => {
    const taskShortId = await createTask(ctx, 'Task to redo', 'Do the work');
    const startResult = await ctx.lazyMocked(
      ['start', taskShortId, '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_PROMPT_DEFAULTS: 'accept' } },
    );
    expect(startResult.exitCode).toBe(0);

    const session = new McpSession(ctx.root, '00000000-0000-0000-0000-000000000001', ctx.root);
    try {
      await session.initialize();

      const step1 = await session.callTool('lazy_redo', {
        task_id: taskShortId,
      });

      expect(step1._isError).toBe(true);
      const errorText1 = step1._errorText as string;
      const redoCode1 = extractConfirmationCode(errorText1);
      expect(redoCode1).toMatch(/^rd-[0-9a-f]{4}$/);
      expect(errorText1).toContain(taskShortId);
    } finally {
      await session.close();
    }
  });

  // INVARIANT: Redo confirmation code allows execution.
  test('redo confirmation code allows execution', async () => {
    const taskShortId = await createTask(ctx, 'Task to redo and confirm', 'Do the work');
    const startResult = await ctx.lazyMocked(
      ['start', taskShortId, '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_PROMPT_DEFAULTS: 'accept' } },
    );
    expect(startResult.exitCode).toBe(0);

    // After mocked start, the task may still be in 'working' state.
    // Unblock it so it reaches 'blocked' — the state from which redo can close it.
    await ctx.lazy(['unblock', taskShortId, '--message', 'preparing redo'], { input: 'n\n' });

    const session = new McpSession(ctx.root, '00000000-0000-0000-0000-000000000001', ctx.root);
    try {
      await session.initialize();

      // Step 1: get code (returned in error)
      const step1 = await session.callTool('lazy_redo', {
        task_id: taskShortId,
      });
      expect(step1._isError).toBe(true);
      const redoCode = extractConfirmationCode(step1._errorText as string);

      // Step 2: confirm
      const step2 = await session.callTool('lazy_redo', {
        task_id: taskShortId,
        confirmation_code: redoCode,
      });
      expect(step2.old_task_id).toBe(taskShortId);
      expect(step2.new_task_id).toBeDefined();
      expect(step2.message).toContain('Call lazy_start');
    } finally {
      await session.close();
    }
  });

  // INVARIANT: Reopen always requires confirmation (at least light level).
  test('reopen requires confirmation', async () => {
    const taskShortId = await createTask(ctx, 'Task to reopen', 'Do the work');

    // Abandon the task so it can be reopened
    const closeResult = await ctx.lazy(['close', taskShortId, '--reason', 'test']);
    expect(closeResult.exitCode).toBe(0);

    const session = new McpSession(ctx.root, '00000000-0000-0000-0000-000000000001', ctx.root);
    try {
      await session.initialize();

      const step1 = await session.callTool('lazy_reopen', {
        task_id: taskShortId,
      });

      expect(step1._isError).toBe(true);
      const reopenCode1 = extractConfirmationCode(step1._errorText as string);
      expect(reopenCode1).toMatch(/^ro-[0-9a-f]{4}$/);
    } finally {
      await session.close();
    }
  });

  // INVARIANT: Reopen confirmation code allows execution.
  test('reopen confirmation code allows execution', async () => {
    const taskShortId = await createTask(ctx, 'Task to reopen and confirm', 'Do the work');

    const closeResult = await ctx.lazy(['close', taskShortId, '--reason', 'test']);
    expect(closeResult.exitCode).toBe(0);

    const session = new McpSession(ctx.root, '00000000-0000-0000-0000-000000000001', ctx.root);
    try {
      await session.initialize();

      // Step 1: get code (returned in error)
      const step1 = await session.callTool('lazy_reopen', {
        task_id: taskShortId,
      });
      expect(step1._isError).toBe(true);
      const reopenCode = extractConfirmationCode(step1._errorText as string);

      // Step 2: confirm
      const step2 = await session.callTool('lazy_reopen', {
        task_id: taskShortId,
        confirmation_code: reopenCode,
      });
      expect(step2.task_id).toBe(taskShortId);
      expect(step2.new_status).toBeDefined();
    } finally {
      await session.close();
    }
  });

  // INVARIANT: Tool schemas include confirmation_code as an optional parameter.
  test('confirmed tools have confirmation_code in their schemas', async () => {
    const responses = await runMcpSession(
      ctx.root,
      '00000000-0000-0000-0000-000000000001',
      ctx.root,
      [
        { method: 'initialize', id: 1, params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } },
        { method: 'tools/list', id: 2 },
      ],
    );

    const toolsResponse = responses.find(r => r.id === 2);
    const result = toolsResponse!.result as { tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }> };

    const confirmedTools = ['lazy_close', 'lazy_accept', 'lazy_redo', 'lazy_reopen', 'lazy_create'];

    for (const toolName of confirmedTools) {
      const tool = result.tools.find(t => t.name === toolName);
      expect(tool).toBeDefined();
      expect(tool!.inputSchema.properties).toHaveProperty('confirmation_code');
    }

    // Verify tools that should NOT have confirmation_code
    const unconfirmedTools = ['lazy_start', 'lazy_unblock', 'lazy_commit', 'lazy_search', 'lazy_show'];
    for (const toolName of unconfirmedTools) {
      const tool = result.tools.find(t => t.name === toolName);
      expect(tool).toBeDefined();
      expect(tool!.inputSchema.properties).not.toHaveProperty('confirmation_code');
    }
  });

  // INVARIANT: Confirmation codes have the correct verb prefix format.
  test('confirmation codes use correct verb prefixes', async () => {
    // Test reject prefix
    const taskShortId = await createTask(ctx, 'Prefix test task', 'Do the work');
    const startResult = await ctx.lazyMocked(
      ['start', taskShortId, '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_PROMPT_DEFAULTS: 'accept' } },
    );
    expect(startResult.exitCode).toBe(0);

    const session = new McpSession(ctx.root, '00000000-0000-0000-0000-000000000001', ctx.root);
    try {
      await session.initialize();

      const closeResult = await session.callTool('lazy_close', {
        task_id: taskShortId,
        reason: 'test',
      });
      expect(closeResult._isError).toBe(true);
      expect(extractConfirmationCode(closeResult._errorText as string)).toMatch(/^cl-/);

      // Test redo prefix
      const redoResult = await session.callTool('lazy_redo', {
        task_id: taskShortId,
      });
      expect(redoResult._isError).toBe(true);
      expect(extractConfirmationCode(redoResult._errorText as string)).toMatch(/^rd-/);

      // Test reopen prefix — abandon a task first
      const reopenTaskId = await createTask(ctx, 'Reopen prefix test', 'Do the work');
      await ctx.lazy(['close', reopenTaskId, '--reason', 'test']);
      const reopenResult = await session.callTool('lazy_reopen', {
        task_id: reopenTaskId,
      });
      expect(reopenResult._isError).toBe(true);
      expect(extractConfirmationCode(reopenResult._errorText as string)).toMatch(/^ro-/);
    } finally {
      await session.close();
    }
  });
});
