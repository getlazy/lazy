/**
 * E2E test for the lazy_start MCP tool through the daemon path.
 *
 * Regression test for the bug where `lazy_start` failed with
 * "Daemon storage not initialized — call initDaemonStorage() first" during a
 * pairing/builder session, while lazy_create / lazy_comment / reads on the same
 * daemon succeeded.
 *
 * Root cause: the MCP start handler called `launchTask()` directly. launchTask
 * obtains storage via getOrCreateStorage(), which only works inside the daemon
 * process (where initDaemonStorage() has run). When the MCP server runs in a
 * builder/pairing process, ctx.storage is undefined — other tools reach the
 * daemon via RemoteStorage, but a direct launchTask() has no initialized
 * storage and throws. The fix routes the handler through queryStartTask (the
 * RPC layer), which forwards to the daemon when not in-daemon.
 *
 * This test reproduces that scenario: a real daemon is running, and the MCP
 * server is spawned WITHOUT LAZY_TEST=1 (so it talks to the daemon over RPC,
 * exactly like a pairing/builder session). lazy_create succeeds, then
 * lazy_start must succeed too — not throw the init error.
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

/**
 * Run a short MCP session against the running daemon: send messages, close
 * stdin, collect all stdout. The MCP server executes tools locally (builder
 * mode) and reaches the daemon over RPC for storage — note the absence of
 * LAZY_TEST=1, which would otherwise bypass the daemon entirely.
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

describe('lazy_start MCP tool', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // INVARIANT: `start` requires a real daemon. CLI/MCP processes go through
    // the daemon for storage; LAZY_TEST=1 would bypass it. The pairing/builder
    // MCP server runs WITHOUT LAZY_TEST, so it must reach the daemon over RPC.
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: lazy_start must obtain storage the same way the other MCP write
  // handlers do — via the daemon — so it works from a builder/pairing session.
  // It must NOT call launchTask() directly, which throws "Daemon storage not
  // initialized" outside the daemon process. Regression test for that bug.
  test('starts a task via the daemon without the "storage not initialized" error', async () => {
    const taskShortId = await createTask(ctx, 'MCP start regression', 'Do the work');

    // Builder/pairing mode: empty task scope, worktree is the project root.
    const responses = await runMcpSession(ctx.root, '', ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      {
        method: 'tools/call',
        id: 2,
        params: { name: 'lazy_start', arguments: { task_id: taskShortId } },
      },
    ]);

    const callResponse = responses.find(r => r.id === 2);
    expect(callResponse).toBeDefined();

    const result = callResponse!.result as { content: Array<{ text: string }>; isError?: boolean };
    const text = (result.content?.[0]?.text ?? '') + JSON.stringify(callResponse!.error ?? '');

    // The specific regression: must never surface the uninitialized-storage error.
    expect(text).not.toContain('storage not initialized');
    expect(text).not.toContain('initDaemonStorage');

    // And the start should actually succeed against the mocked daemon.
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Started task');
  });
});
