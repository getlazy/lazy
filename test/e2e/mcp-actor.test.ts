/**
 * E2E tests for the `builder` actor: turns originating at the MCP boundary must
 * be tagged actor='builder', while CLI-originated turns stay actor='human'.
 *
 * These exercise the REAL channel discriminator end-to-end through the daemon:
 * an MCP `lazy_start` call flows MCP handler → queryStartTask → RPC → daemon
 * handleStartTask → launchTask → createTurn, and the turn must carry the
 * builder actor even though it is persisted in the daemon process (where the
 * env-var `getActor()` default reports 'human'). This is why the actor is
 * threaded explicitly through the RPC layer rather than read from the daemon's
 * environment.
 *
 * INVARIANT (channel, not source): the actor reflects WHO SUBMITTED the command
 * — the channel — NOT who authored the content. A `lazy_unblock` that relays a
 * human's words is still actor='builder' because the builder pressed the button.
 * The human-feedback content itself is preserved verbatim in the turn; the actor
 * tag never gates persistence. (See CLAUDE.md: never lose human feedback.)
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { resolve } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

const AGENT_ENTRY = resolve(__dirname, '../../src/agent-entry.ts');

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: { content: Array<{ text: string }>; isError?: boolean };
  error?: { code: number; message: string; data?: unknown };
}

interface ShownTurn {
  role: string;
  actor?: string | null;
  content: string;
}

/** Extract the parsed turns array from a lazy_show tool response (JSON text). */
function turnsFromShow(response: JsonRpcResponse | undefined): ShownTurn[] {
  const text = response?.result?.content?.[0]?.text ?? '';
  try {
    return (JSON.parse(text).turns ?? []) as ShownTurn[];
  } catch {
    return [];
  }
}

/**
 * Drive a short MCP session against the running daemon in builder/pairing mode
 * (--task-id '' and NO LAZY_TEST=1, so lifecycle ops reach the daemon over RPC,
 * exactly like a real builder session). Mirrors mcp-start.test.ts.
 */
async function runMcpSession(
  root: string,
  worktreePath: string,
  messages: Array<{ method: string; id: number; params?: Record<string, unknown> }>,
): Promise<JsonRpcResponse[]> {
  const proc = Bun.spawn(['bun', 'run', AGENT_ENTRY, 'mcp', '--task-id', '', '--worktree', worktreePath], {
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
      // skip non-JSON banner lines
    }
  }
  return responses;
}

describe('builder actor (MCP channel)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // The channel discriminator only matters through the daemon: the MCP process
    // hands lifecycle ops to the daemon over RPC, and the turn is persisted
    // there. LAZY_TEST=1 would bypass the daemon, so we run a real one.
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: A turn created by an MCP-originated command carries actor='builder',
  // set at the MCP boundary (MCP_ACTOR) and threaded through the RPC layer so the
  // daemon records it correctly rather than defaulting to 'human'.
  test('lazy_start via MCP records the first turn as actor=builder', async () => {
    const taskShortId = await createTask(ctx, 'MCP channel start', 'Do the work');

    const responses = await runMcpSession(ctx.root, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_start', arguments: { task_id: taskShortId } } },
      { method: 'tools/call', id: 3, params: { name: 'lazy_show', arguments: { task_id: taskShortId, sections: ['turns'] } } },
    ]);

    const startResponse = responses.find(r => r.id === 2);
    expect(startResponse).toBeDefined();
    expect(startResponse!.result?.isError).toBeFalsy();
    expect(startResponse!.result?.content[0].text).toContain('Started task');

    const turns = turnsFromShow(responses.find(r => r.id === 3));
    const humanTurn = turns.find(t => t.role === 'human');
    expect(humanTurn).toBeDefined();
    // Channel = MCP → builder, even though the same start path from the CLI is 'human'.
    expect(humanTurn!.actor).toBe('builder');
  });

  // INVARIANT: The SAME start path from the CLI carries actor='human'. This is the
  // contrast that makes the channel discriminator meaningful: identical code path,
  // different channel → different actor.
  test('lazy start via CLI records the first turn as actor=human', async () => {
    const taskShortId = await createTask(ctx, 'CLI channel start', 'Do the work');

    const startResult = await ctx.lazyMocked(['start', taskShortId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // Read back through the same daemon via an MCP lazy_show session.
    const responses = await runMcpSession(ctx.root, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_show', arguments: { task_id: taskShortId, sections: ['turns'] } } },
    ]);

    const turns = turnsFromShow(responses.find(r => r.id === 2));
    const humanTurn = turns.find(t => t.role === 'human');
    expect(humanTurn).toBeDefined();
    expect(humanTurn!.actor).toBe('human');
  });
});
