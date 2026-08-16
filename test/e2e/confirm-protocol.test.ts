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
import { createTask, fullTaskId, startAndWait } from '../helpers/fixtures';
import { extractTaskId } from '../helpers/assertions';
import { writeFileSync } from 'fs';
import { MCP_SERVER_ENV_PINS } from '../helpers/mcp-env';

const AGENT_ENTRY = resolve(__dirname, '../../src/agent-entry.ts');

/**
 * MCP tool errors arrive as a JSON document in the content text
 * (`{"error": "<human-readable message>"}`). Return the inner message; fall
 * back to the raw text for tools that emit a bare string.
 */
function unwrapErrorText(text: string | undefined): string | undefined {
  if (!text) return text;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.error === 'string') return parsed.error;
  } catch {
    // Not JSON — the tool emitted a bare message; use it as-is.
  }
  return text;
}

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

  /**
   * `taskId` selects the server's scope:
   *  - a task UUID → AGENT mode, where every tool call is restricted to that
   *    task or one of its direct subtasks;
   *  - null → project-scoped BUILDER mode, the only mode where builder-only
   *    tools (lazy_redo, lazy_reparent, lazy_clone) are exposed at all.
   */
  constructor(root: string, taskId: string | null, worktreePath: string) {
    this.proc = Bun.spawn(
      ['bun', 'run', AGENT_ENTRY, 'mcp', ...(taskId ? ['--task-id', taskId] : []), '--worktree', worktreePath],
      {
        cwd: root,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, ...MCP_SERVER_ENV_PINS },
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
      // Return the error result so tests can inspect it. The tool encodes its
      // error as JSON (`{"error": "..."}`), so unwrap it — otherwise every
      // assertion runs against the JSON-escaped blob and the confirmation code
      // hides behind an escaped quote (`confirmation_code: \"ro-2f77\"`).
      return { _isError: true, _errorText: unwrapErrorText(result.content[0]?.text) };
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
    env: { ...process.env, ...MCP_SERVER_ENV_PINS },
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
    // The MCP server is spawned WITHOUT LAZY_TEST=1 (see runMcpSession /
    // McpSession — both pin it off, see MCP_SERVER_ENV_PINS), so every storage-backed tool it
    // exposes must reach a real daemon over RPC — exactly like the pairing and
    // builder MCP servers do in production. Daemonless, requireStorage() exits
    // with "Daemon is not running" and the server dies before answering the
    // first tool call ("MCP process exited before response"). Mirrors mcp.test.ts.
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: Abandon always requires confirmation via the two-step MCP protocol.
  // This prevents the builder from accidentally abandoning work instead of giving feedback.
  test('lazy_close requires confirmation (two-step)', async () => {
    const taskShortId = await createTask(ctx, 'Task to abandon', 'Do the work');
    await startAndWait(ctx, taskShortId, { env: { LAZY_PROMPT_DEFAULTS: 'accept' } });

    const session = new McpSession(ctx.root, await fullTaskId(ctx, taskShortId), ctx.root);
    try {
      await session.initialize();

      // Step 1: call without confirmation code -> get error with guidance
      const step1 = await session.callTool('lazy_close', {
        task_id: taskShortId,
        reason: 'Wrong approach',
      });

      expect(step1._isError).toBe(true);
      const errorText = step1._errorText as string;
      // The guidance must halt the agent and name the work at stake. (It used
      // to point at `lazy_unblock`; no close-* template mentions that tool now
      // — the wording moved on, the two-step gate it guards did not.)
      expect(errorText).toContain('Do NOT call lazy_close again yet');
      expect(errorText).toContain('will be lost');
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
    await startAndWait(ctx, taskShortId, { env: { LAZY_PROMPT_DEFAULTS: 'accept' } });

    const session = new McpSession(ctx.root, await fullTaskId(ctx, taskShortId), ctx.root);
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
    await startAndWait(ctx, taskShortId, { env: { LAZY_PROMPT_DEFAULTS: 'accept' } });

    // BUILDER mode (no --task-id): the subject here is the confirmation
    // protocol, not the agent ownership gate. An agent may not accept its OWN
    // task at all (that gate fires before any code check — see
    // test/e2e/mcp-agent-accept.test.ts), so the cross-operation code rejection
    // this test asserts is only reachable from the builder surface.
    const session = new McpSession(ctx.root, null, ctx.root);
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
    await startAndWait(ctx, taskShortId, { env: { LAZY_PROMPT_DEFAULTS: 'accept' } });

    // Make the diff genuinely uncomputable. This used to happen by accident
    // (the old harness could never compute a diff at all); now the daemon
    // computes it fine and a zero-diff task takes the `none` path and merges
    // straight through. Dropping the worktree AND the branch is the "worktree
    // gone" case the product names when it defaults to stern.
    const branch = `lazy/${taskShortId}`;
    ctx.git('worktree', 'remove', '--force', join(ctx.root, '.lazy', 'worktrees', taskShortId));
    ctx.git('branch', '-D', branch);

    // BUILDER mode (no --task-id): an agent may not accept its own task, so the
    // stern-by-default behaviour asserted here is only reachable from the
    // builder surface. See the note on the cross-operation test above.
    const session = new McpSession(ctx.root, null, ctx.root);
    try {
      await session.initialize();

      // With no computable diff, accept defaults to stern.
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

    const session = new McpSession(ctx.root, await fullTaskId(ctx, taskShortId), ctx.root);
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

    const session = new McpSession(ctx.root, await fullTaskId(ctx, taskShortId), ctx.root);
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
    await startAndWait(ctx, taskShortId, { env: { LAZY_PROMPT_DEFAULTS: 'accept' } });

    // BUILDER mode (no --task-id): lazy_redo is refused outright in agent mode
    // ("Agents cannot redo tasks" — redo would parent the replacement outside
    // the agent's subtree), so its confirmation flow only exists for the builder.
    const session = new McpSession(ctx.root, null, ctx.root);
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
    await startAndWait(ctx, taskShortId, { env: { LAZY_PROMPT_DEFAULTS: 'accept' } });

    // startAndWait already leaves the task 'blocked' — the state redo needs in
    // order to close it. The old extra `unblock` here was a workaround for the
    // start-leaves-it-working rot and now actively breaks the test by pushing
    // the task back to 'working' ("Invalid status transition: working → abandoned").

    // BUILDER mode (no --task-id): lazy_redo is refused outright in agent mode
    // ("Agents cannot redo tasks" — redo would parent the replacement outside
    // the agent's subtree), so its confirmation flow only exists for the builder.
    const session = new McpSession(ctx.root, null, ctx.root);
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

    const session = new McpSession(ctx.root, await fullTaskId(ctx, taskShortId), ctx.root);
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

    const session = new McpSession(ctx.root, await fullTaskId(ctx, taskShortId), ctx.root);
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
    await startAndWait(ctx, taskShortId, { env: { LAZY_PROMPT_DEFAULTS: 'accept' } });

    const session = new McpSession(ctx.root, await fullTaskId(ctx, taskShortId), ctx.root);
    try {
      await session.initialize();

      const closeResult = await session.callTool('lazy_close', {
        task_id: taskShortId,
        reason: 'test',
      });
      expect(closeResult._isError).toBe(true);
      expect(extractConfirmationCode(closeResult._errorText as string)).toMatch(/^cl-/);

      // Test redo prefix — builder-only tool, so it needs its own builder-mode
      // session (agent mode refuses lazy_redo outright).
      const builderSession = new McpSession(ctx.root, null, ctx.root);
      try {
        await builderSession.initialize();
        const redoResult = await builderSession.callTool('lazy_redo', {
          task_id: taskShortId,
        });
        expect(redoResult._isError).toBe(true);
        expect(extractConfirmationCode(redoResult._errorText as string)).toMatch(/^rd-/);
      } finally {
        await builderSession.close();
      }

      // Test reopen prefix — abandon a task first
      // Must be a DIRECT SUBTASK: the MCP server only lets an agent act on its
      // own task or a child of it.
      const reopenCreate = await ctx.lazy(['create', '--goal', 'Reopen prefix test', '--prompt', 'Do the work', '--parent', taskShortId]);
      const reopenTaskId = extractTaskId(reopenCreate.stdout);
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
