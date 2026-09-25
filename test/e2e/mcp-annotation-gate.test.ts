/**
 * E2E tests for the agent-ownership gate on the ANNOTATION tools —
 * lazy_comment / lazy_tag / lazy_untag — and for the one
 * deliberate hole in it, lazy_journal.
 *
 * The rule the four share is DIRECT SUBTASKS ONLY — not a peer, and not the
 * agent's own task either.
 *
 * These live in their own file rather than in mcp.test.ts because the
 * comment/journal split is a design decision in its own right and reads better
 * stated once, in full, next to the tests that hold it.
 *
 * Same session mechanics as mcp.test.ts: spawn the MCP server as a subprocess
 * with a --task-id, speak JSON-RPC over stdin/stdout.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { resolve } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { extractTaskId } from '../helpers/assertions';
import { MCP_SERVER_ENV_PINS } from '../helpers/mcp-env';

const AGENT_ENTRY = resolve(__dirname, '../../src/agent-entry.ts');

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Run a short MCP session as the agent owning `taskId`; return parsed responses. */
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
  await new Response(proc.stderr).text();
  await proc.exited;

  const responses: JsonRpcResponse[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      responses.push(JSON.parse(line));
    } catch {
      // Non-JSON log line — skip.
    }
  }
  return responses;
}

/** Resolve a task's full UUID from its short id via `lazy show --full`. */
async function fullTaskId(ctx: TestContext, shortId: string): Promise<string> {
  const showResult = await ctx.lazy(['show', shortId, '--full']);
  const match = showResult.stdout.match(/ID:\s+([a-f0-9-]{36})/);
  if (!match) {
    throw new Error(`Could not extract full task id for ${shortId}: ${showResult.stdout}`);
  }
  return match[1];
}

/** Call one tool in a fresh session and return its parsed result envelope. */
async function callTool(
  ctx: TestContext,
  callerFullId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; parsed: Record<string, unknown> }> {
  const responses = await runMcpSession(ctx.root, callerFullId, ctx.root, [
    { method: 'initialize', id: 1, params: {} },
    { method: 'tools/call', id: 2, params: { name, arguments: args } },
  ]);
  const resp = responses.find(r => r.id === 2);
  expect(resp).toBeDefined();
  const result = resp!.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
  return { isError: result.isError === true, parsed: JSON.parse(result.content[0].text) };
}

describe('MCP annotation tools: ownership gate', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // Storage-backed tools reach the daemon over RPC — see the note in
    // mcp.test.ts's beforeEach. A daemonless setup leaves them with no backend.
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: annotating a task the agent does not own is a WRITE and is
  // refused server-side, same gate as unblock/reject/close.
  //
  // lazy_comment is the load-bearing one: a comment is DELIVERED into the target
  // task's next turn prompt, so commenting on a peer task can steer that agent's
  // work — or kick work off there. Peer reach on an instruct channel is out.
  // lazy_tag / lazy_untag are durable edits to work the caller does not own,
  // and regrouping a peer's task has no coherent meaning.
  //
  // These tools were UNGATED until 2026-08-07 and were gated by explicit engineer
  // decision on that date (task `agent-tree-read-access`), extending the
  // 2026-08-06 flywheel decision that opened READS tree-wide. Reads staying open
  // and these writes closing are the same rule, not opposite ones: an agent may
  // see anything and change only its own subtree.
  //
  // Their gate (`assertAgentMayAnnotate`) is narrower than the ordinary write
  // gate: DIRECT SUBTASKS ONLY, never the agent's own task either — see the
  // self-refusal tests below.
  const GATED_ANNOTATIONS: Array<{ name: string; extraArgs: Record<string, unknown> }> = [
    { name: 'lazy_comment', extraArgs: { message: 'steer yourself elsewhere' } },
    { name: 'lazy_tag', extraArgs: { tag: 'hijacked' } },
    { name: 'lazy_untag', extraArgs: { tag: 'hijacked' } },
  ];

  for (const tool of GATED_ANNOTATIONS) {
    test(`${tool.name} rejects an agent targeting a task it does not own`, async () => {
      const myShortId = await createTask(ctx, 'My agent task');
      const myFullId = await fullTaskId(ctx, myShortId);
      const otherShortId = await createTask(ctx, 'Unrelated task', 'Do work');

      const { isError, parsed } = await callTool(ctx, myFullId, tool.name, {
        task_id: otherShortId,
        ...tool.extraArgs,
      });

      expect(isError).toBe(true);
      expect(parsed.error).toContain('own direct subtasks');
    });
  }

  // INVARIANT: the same tools also refuse the agent's OWN task. The rule is
  // "direct subtasks only", the same shape as the accept gate — not the ordinary
  // own-task-or-direct-child write boundary.
  //
  // WHY, per engineer decision 2026-08-07 (task `agent-tree-read-access`):
  //   - A comment on your own task is circular. A comment is DELIVERED into the
  //     target's next turn prompt, which for your own task is your own prompt.
  //     lazy_journal (rationale, decisions, memory) and lazy_raise with
  //     blocking: false (orthogonal work spotted) are the tools for talking
  //     about your own work.
  //   - Tags on your own task are the human's and the builder's annotations
  //     ABOUT the work — which effort it groups under — not statements the
  //     worker makes about itself.
  //   - lazy_untag is refused on self outright rather than restricted to tags the
  //     agent itself applied: per-tag provenance is more machinery than the
  //     capability is worth.
  //
  // Note both directions are covered: the loop above proves a peer is refused,
  // this one proves self is refused, and the lazy_journal test below proves the
  // gate is a boundary and not a blanket outage of the write path.
  for (const tool of GATED_ANNOTATIONS) {
    test(`${tool.name} rejects an agent targeting its own task`, async () => {
      const myShortId = await createTask(ctx, 'My agent task');
      const myFullId = await fullTaskId(ctx, myShortId);

      const { isError, parsed } = await callTool(ctx, myFullId, tool.name, {
        task_id: myShortId,
        ...tool.extraArgs,
      });

      expect(isError).toBe(true);
      expect(parsed.error).toContain('their own task');
    });
  }

  // INVARIANT: omitting `task_id` must not be a way around the self-refusal.
  // lazy_comment / lazy_tag / lazy_untag default to "the current task" when
  // task_id is absent, which for an agent is exactly the self-annotation the gate
  // above refuses — so the omitted-argument path refuses too.
  for (const tool of GATED_ANNOTATIONS) {
    test(`${tool.name} rejects an agent omitting task_id (defaults to self)`, async () => {
      const myShortId = await createTask(ctx, 'My agent task');
      const myFullId = await fullTaskId(ctx, myShortId);

      const { isError, parsed } = await callTool(ctx, myFullId, tool.name, { ...tool.extraArgs });

      expect(isError).toBe(true);
      expect(parsed.error).toContain('their own task');
    });
  }

  // INVARIANT: the gate is a boundary, not a ban — annotating a DIRECT SUBTASK
  // works. Without this, every assertion above would pass just as happily if
  // lazy_comment were broken outright.
  test('lazy_comment works on a direct subtask', async () => {
    const myShortId = await createTask(ctx, 'My agent task');
    const myFullId = await fullTaskId(ctx, myShortId);
    const childRes = await ctx.lazy(['create', '--goal', 'Child work', '--prompt', 'do', '--parent', myShortId]);
    const childShortId = extractTaskId(childRes.stdout);

    const { isError, parsed } = await callTool(ctx, myFullId, 'lazy_comment', {
      task_id: childShortId,
      message: 'also handle the empty-input case',
    });

    expect(isError).toBe(false);
    expect(parsed.content).toBe('also handle the empty-input case');
  });

  // INVARIANT: lazy_journal is the ONE write that is NOT ownership-gated — an
  // agent may journal on ANY task in the project.
  //
  // The reason is precisely what distinguishes it from lazy_comment above:
  // journal entry TEXT is never injected into any agent prompt (that task's next
  // prompt carries at most a one-line count of new entries) and journaling never
  // triggers a turn. A note left on a peer task can be read later by a human or a
  // future run, but can never steer or start work there — it INFORMS without
  // INSTRUCTING. That makes peer journaling safe, and useful: it is how one agent
  // leaves a durable finding on work it does not own.
  //
  // Deliberate asymmetry, blessed by engineer decision 2026-08-07 (task
  // `agent-tree-read-access`; rationale in docs/surface-asymmetries.md §1). Do
  // NOT "fix" this into symmetry with lazy_comment. Note the coupling: injecting
  // journal entries into agent prompts would turn this into an instruct channel
  // and invalidate the reasoning — that is a decision to take deliberately, not
  // a side effect to land.
  test('lazy_journal succeeds on a task the agent does not own', async () => {
    const myShortId = await createTask(ctx, 'My agent task');
    const myFullId = await fullTaskId(ctx, myShortId);
    const otherShortId = await createTask(ctx, 'Unrelated task', 'Do work');

    const { isError, parsed } = await callTool(ctx, myFullId, 'lazy_journal', {
      task_id: otherShortId,
      message: 'peer finding: this task duplicates the retry logic in mine',
    });

    expect(isError).toBe(false);
    expect(parsed.content).toBe('peer finding: this task duplicates the retry logic in mine');
  });
});
