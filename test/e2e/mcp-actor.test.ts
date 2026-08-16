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
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, fullTaskId, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { runMcpSession, type JsonRpcResponse } from '../helpers/mcp-session';

interface ShownTurn {
  role: string;
  actor?: string | null;
  content: string;
}

interface ShownStatusChange {
  from: string | null;
  to: string;
  actor: string | null;
}

interface ShownJournalEntry {
  content: string;
  actor: string | null;
}

/** Parse the JSON payload of a lazy_show tool response. */
function showPayload(response: JsonRpcResponse | undefined): Record<string, unknown> {
  const text = response?.result?.content?.[0]?.text ?? '';
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Extract the parsed turns array from a lazy_show tool response (JSON text). */
function turnsFromShow(response: JsonRpcResponse | undefined): ShownTurn[] {
  return (showPayload(response).turns ?? []) as ShownTurn[];
}

function statusHistoryFromShow(response: JsonRpcResponse | undefined): ShownStatusChange[] {
  return (showPayload(response).status_history ?? []) as ShownStatusChange[];
}

function journalFromShow(response: JsonRpcResponse | undefined): ShownJournalEntry[] {
  return (showPayload(response).journal ?? []) as ShownJournalEntry[];
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

    const responses = await runMcpSession(ctx.root, '', ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_start', arguments: { task_id: taskShortId } } },
      { method: 'tools/call', id: 3, params: { name: 'lazy_show', arguments: { task_id: taskShortId, sections: ['turns'] } } },
    ]);

    const startResponse = responses.find(r => r.id === 2);
    expect(startResponse).toBeDefined();
    expect(startResponse!.result?.isError).toBeFalsy();
    expect(startResponse!.result?.content?.[0].text).toContain('Started task');

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
    const responses = await runMcpSession(ctx.root, '', ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_show', arguments: { task_id: taskShortId, sections: ['turns'] } } },
    ]);

    const turns = turnsFromShow(responses.find(r => r.id === 2));
    const humanTurn = turns.find(t => t.role === 'human');
    expect(humanTurn).toBeDefined();
    expect(humanTurn!.actor).toBe('human');
  });

  // INVARIANT: Task CREATION is attributed too. The initial 'backlog' entry in the
  // status changelog carries the channel that created the task, so "who created
  // this?" is answerable without guessing from surrounding turns.
  test('lazy_create via MCP stamps the initial backlog status change with actor=builder', async () => {
    const responses = await runMcpSession(ctx.root, '', ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_create', arguments: { goal: 'Created over MCP', code: 'mcp-made' } } },
      { method: 'tools/call', id: 3, params: { name: 'lazy_show', arguments: { task_id: 'mcp-made', sections: ['status-history'] } } },
    ]);

    expect(responses.find(r => r.id === 2)?.result?.isError).toBeFalsy();
    const history = statusHistoryFromShow(responses.find(r => r.id === 3));
    expect(history.length).toBeGreaterThan(0);
    expect(history[0].to).toBe('backlog');
    expect(history[0].actor).toBe('builder');
  });

  // INVARIANT: the CLI leaves the creation actor absent rather than writing a
  // literal 'human'. Absent has always meant "human/CLI" for status changes; only
  // the non-default channels (builder/agent) are stamped, so old records and new
  // CLI records read the same way.
  test('lazy create via CLI leaves the initial backlog status change unstamped', async () => {
    const taskShortId = await createTask(ctx, 'Created over CLI');

    const responses = await runMcpSession(ctx.root, '', ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_show', arguments: { task_id: taskShortId, sections: ['status-history'] } } },
    ]);

    const history = statusHistoryFromShow(responses.find(r => r.id === 2));
    expect(history.length).toBeGreaterThan(0);
    expect(history[0].to).toBe('backlog');
    expect(history[0].actor).toBeNull();
  });

  // INVARIANT: lifecycle commands that never launch an agent (close, reject,
  // submit, reparent) are attributed as well — closing a task over MCP must not
  // read back later as a human's decision. This is the class of paths that
  // silently fell back to the daemon's env-var default before.
  test('lazy_close via MCP records the abandoned status change as actor=builder', async () => {
    const taskShortId = await createTask(ctx, 'Closed over MCP');

    // The confirmation code is minted and validated IN the MCP process, so both
    // close calls must happen in ONE session — a second process rejects the code.
    const responses = await runMcpSession(ctx.root, '', ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_close', arguments: { task_id: taskShortId, reason: 'not needed' } } },
      {
        method: 'tools/call',
        id: 3,
        params: prior => {
          const guidance = JSON.stringify(prior.find(r => r.id === 2)?.result ?? {});
          const code = guidance.match(/([a-z]{2}-[0-9a-f]{4})/)?.[1];
          if (!code) throw new Error(`No confirmation code in lazy_close guidance: ${guidance}`);
          return { name: 'lazy_close', arguments: { task_id: taskShortId, reason: 'not needed', confirmation_code: code } };
        },
      },
      { method: 'tools/call', id: 4, params: { name: 'lazy_show', arguments: { task_id: taskShortId, sections: ['status-history'] } } },
    ]);
    expect(responses.find(r => r.id === 3)?.result?.isError).toBeFalsy();

    const history = statusHistoryFromShow(responses.find(r => r.id === 4));
    const abandoned = history.find(h => h.to === 'abandoned');
    expect(abandoned).toBeDefined();
    expect(abandoned!.actor).toBe('builder');
  });

  // INVARIANT: the SAME close from the CLI is 'human'.
  test('lazy close via CLI records the abandoned status change as actor=human', async () => {
    const taskShortId = await createTask(ctx, 'Closed over CLI');
    expectSuccess(await ctx.lazy(['close', taskShortId, '--reason', 'not needed', '--yes']));

    const responses = await runMcpSession(ctx.root, '', ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_show', arguments: { task_id: taskShortId, sections: ['status-history'] } } },
    ]);

    const history = statusHistoryFromShow(responses.find(r => r.id === 2));
    const abandoned = history.find(h => h.to === 'abandoned');
    expect(abandoned).toBeDefined();
    expect(abandoned!.actor).toBe('human');
  });

  // INVARIANT: the MCP channel has TWO callers, told apart by scope. A journal
  // entry written by a task agent (its tool context carries a task id) is 'agent',
  // not 'builder' — otherwise an agent's own note reads as the builder's.
  test('lazy_journal from a task-scoped MCP session records actor=agent', async () => {
    const taskShortId = await createTask(ctx, 'Agent journals on itself');
    const taskUuid = await fullTaskId(ctx, taskShortId);

    const responses = await runMcpSession(ctx.root, taskUuid, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_journal', arguments: { message: 'chose K=3 because of X' } } },
      { method: 'tools/call', id: 3, params: { name: 'lazy_show', arguments: { task_id: taskShortId, sections: ['journal'] } } },
    ]);

    expect(responses.find(r => r.id === 2)?.result?.isError).toBeFalsy();
    const journal = journalFromShow(responses.find(r => r.id === 3));
    expect(journal.length).toBe(1);
    expect(journal[0].actor).toBe('agent');
  });

  // INVARIANT: the same tool from the builder's project-wide session is 'builder'.
  test('lazy_journal from a project-wide MCP session records actor=builder', async () => {
    const taskShortId = await createTask(ctx, 'Builder journals on a task');

    const responses = await runMcpSession(ctx.root, '', ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_journal', arguments: { task_id: taskShortId, message: 'blocked on Y merging' } } },
      { method: 'tools/call', id: 3, params: { name: 'lazy_show', arguments: { task_id: taskShortId, sections: ['journal'] } } },
    ]);

    expect(responses.find(r => r.id === 2)?.result?.isError).toBeFalsy();
    const journal = journalFromShow(responses.find(r => r.id === 3));
    expect(journal.length).toBe(1);
    expect(journal[0].actor).toBe('builder');
  });
});
