/**
 * E2E tests for the lazy_ask MCP tool.
 *
 * Covers error surfacing for the builder-facing read-only Q&A tool. The full
 * happy-path agent round-trip is not exercised here because it would require
 * a live daemon plus a real `blocked` session — both are exercised by the
 * existing `lazy review -i` integration paths, and `lazy_ask` reuses the
 * exact same daemon entry point (`launchAskTask`).
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { resolve } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';

const AGENT_ENTRY = resolve(__dirname, '../../src/agent-entry.ts');

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
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
    env: { ...process.env },
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

describe('lazy_ask MCP tool', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('is registered with task_id, message, effort parameters', async () => {
    const taskId = '00000000-0000-0000-0000-000000000001';

    const responses = await runMcpSession(ctx.root, taskId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/list', id: 2 },
    ]);

    const listResponse = responses.find(r => r.id === 2);
    const result = listResponse!.result as { tools: Array<{ name: string; description: string; inputSchema: { properties?: Record<string, unknown>; required?: string[] } }> };
    const askTool = result.tools.find(t => t.name === 'lazy_ask');

    expect(askTool).toBeDefined();
    expect(askTool!.description.toLowerCase()).toContain('read-only');
    expect(askTool!.inputSchema.properties).toHaveProperty('task_id');
    expect(askTool!.inputSchema.properties).toHaveProperty('message');
    expect(askTool!.inputSchema.properties).toHaveProperty('effort');
    expect(askTool!.inputSchema.required).toEqual(['task_id', 'message']);
  });

  test('returns actionable error when task is not found', async () => {
    // Create a task so the daemon/storage is initialized — we then ask about
    // an unrelated short id that won't match.
    await createTask(ctx, 'unrelated');
    const taskId = '00000000-0000-0000-0000-000000000001';

    const responses = await runMcpSession(ctx.root, taskId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      {
        method: 'tools/call',
        id: 2,
        params: { name: 'lazy_ask', arguments: { task_id: 'deadbeef', message: 'what?' } },
      },
    ]);

    const callResponse = responses.find(r => r.id === 2);
    expect(callResponse).toBeDefined();
    const result = callResponse!.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text.toLowerCase()).toContain('task not found');
  });

  test('returns actionable error when task has no session', async () => {
    // Create a task but don't start it — no session row exists yet.
    const taskShortId = await createTask(ctx, 'Ask without session');
    const taskId = '00000000-0000-0000-0000-000000000001';

    const responses = await runMcpSession(ctx.root, taskId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      {
        method: 'tools/call',
        id: 2,
        params: { name: 'lazy_ask', arguments: { task_id: taskShortId, message: 'still there?' } },
      },
    ]);

    const callResponse = responses.find(r => r.id === 2);
    expect(callResponse).toBeDefined();
    const result = callResponse!.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    // Should mention that the task has no session and tell the user how to fix it.
    const errText = result.content[0].text.toLowerCase();
    expect(errText).toContain('no session');
    expect(errText).toContain('lazy start');
  });
});
