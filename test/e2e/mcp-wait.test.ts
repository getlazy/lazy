/**
 * E2E tests for the lazy_wait MCP tool's multi-task race.
 *
 * `lazy_wait` accepts either a single task reference (the original shape — must
 * keep working, existing prompts and callers pass a bare string) or an ARRAY of
 * references, in which case the call returns as soon as the FIRST of them
 * finishes.
 *
 * The winning-task path is covered end-to-end in test/e2e/wait-race.test.ts and
 * at the unit layer in test/unit/wait-race.test.ts; what this suite pins is the
 * MCP surface — the schema, the array reaching the daemon handler intact, and
 * the single-string back-compat path.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { resolve } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { MCP_SERVER_ENV_PINS } from '../helpers/mcp-env';

const AGENT_ENTRY = resolve(__dirname, '../../src/agent-entry.ts');

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

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
    stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
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
      // skip non-JSON
    }
  }
  return responses;
}

function callText(responses: JsonRpcResponse[], id: number): string {
  const response = responses.find(r => r.id === id);
  expect(response).toBeDefined();
  const result = response!.result as { content: Array<{ text: string }> };
  return result.content[0].text;
}

describe('lazy_wait MCP tool', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // `lazy_wait` hands straight to the daemon's wait RPC (it never opens
    // storage itself), so a daemonless context answers every call with
    // "Daemon is not running" before the reference is ever resolved.
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('advertises a task_id that takes a string or an array, and says it races', async () => {
    const responses = await runMcpSession(ctx.root, '', ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/list', id: 2 },
    ]);

    const result = responses.find(r => r.id === 2)!.result as {
      tools: Array<{ name: string; description: string; inputSchema: { properties?: Record<string, { type?: string | string[] }> } }>;
    };
    const waitTool = result.tools.find(t => t.name === 'lazy_wait');

    expect(waitTool).toBeDefined();
    expect(waitTool!.inputSchema.properties?.task_id?.type).toEqual(['string', 'array']);
    // Agents only race if the description tells them they can.
    expect(waitTool!.description.toLowerCase()).toContain('array');
    expect(waitTool!.description.toLowerCase()).toContain('first');
  });

  // Back-compat: a bare string is the original shape and must keep working.
  test('accepts a single task_id string', async () => {
    const taskId = await createTask(ctx, 'Wait back-compat');

    const responses = await runMcpSession(ctx.root, '', ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_wait', arguments: { task_id: taskId } } },
    ]);

    // The task was never started, so the wait reports the missing session —
    // which proves the reference resolved and reached the daemon handler.
    const text = callText(responses, 2);
    expect(text).toContain('has no session');
    expect(text).toContain(taskId);
  });

  test('accepts an array of task_ids and resolves every one of them', async () => {
    const first = await createTask(ctx, 'Race member one');
    const second = await createTask(ctx, 'Race member two');

    const responses = await runMcpSession(ctx.root, '', ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_wait', arguments: { task_id: [first, second] } } },
    ]);

    // Both resolved; the first unstarted one is what the handler complains
    // about. A single-string-only handler would have thrown a type error here.
    const text = callText(responses, 2);
    expect(text).toContain('has no session');
    expect(text).toContain(first);
  });

  // INVARIANT: one bad reference fails the WHOLE call, naming it — the caller
  // must never be silently raced against a smaller set than it asked for.
  test('one unknown reference in the array fails the whole call and names it', async () => {
    const known = await createTask(ctx, 'Race member one');

    const responses = await runMcpSession(ctx.root, '', ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_wait', arguments: { task_id: [known, 'nosuchtask'] } } },
    ]);

    const text = callText(responses, 2);
    expect(text).toContain('Task not found: nosuchtask');
  });

  // A non-string array entry is now caught by the schema validator BEFORE the
  // handler runs (task_id declares `items: { type: 'string' }`), so it comes
  // back as a JSON-RPC -32602 invalid-params error rather than a tool result.
  // That is the point of the validation layer: a caller's malformed argument is
  // refused at the surface, naming the offending element, instead of being
  // dispatched and rejected somewhere downstream. The handler's own guard
  // (`taskId is required: task_id must be a task reference…`) stays in place as
  // defence in depth for callers that reach it by other paths.
  test('rejects a non-string array entry with an actionable message', async () => {
    const responses = await runMcpSession(ctx.root, '', ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_wait', arguments: { task_id: [42] } } },
    ]);

    const response = responses.find(r => r.id === 2);
    expect(response).toBeDefined();
    expect(response!.error?.code).toBe(-32602);
    expect(response!.error?.message).toContain("'task_id[0]' must be string, got number");
  });
});
