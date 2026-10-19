/**
 * E2E: a comment on a task whose agent is parked in `lazy_wait` interrupts the
 * wait within a poll and is delivered exactly once.
 *
 * THE INCIDENT (2026-10-13): a cluster driver sat in `lazy_wait` from 09:20 to
 * 18:05 and none of the builder's ~10 comments reached it; a child asked the
 * engineer a question the engineer had already answered.
 *
 * The call goes through the real daemon MCP route with the waiting task's own
 * token, while both tasks' turns are held open (`LAZY_MOCK_HOLD_TURN_FILE`), so
 * the waiter has a genuinely live work turn.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, extractTaskId } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { findFullTaskId, readSessionJson, readTaskStatus } from '../helpers/storage';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { heartbeatRequestHeaders, readHeartbeatEnvelope } from '../../src/daemon/heartbeat';
import { mintMcpToken, clearMcpTokenCache } from '../../src/daemon/mcp-tokens';

describe('lazy_wait is interrupted by a comment on the waiting task', () => {
  let ctx: TestContext;
  let holdFile: string;

  beforeEach(async () => {
    clearMcpTokenCache();
    holdFile = join(process.env.TMPDIR ?? '/tmp', `lazy-hold-wci-${process.pid}-${Date.now()}`);
    ctx = await setupTestLazy({ withDaemon: true, daemonEnv: { LAZY_MOCK_HOLD_TURN_FILE: holdFile } });
    if (!readToken(ctx.root)) throw new Error('test daemon did not record a token');
  }, 90_000);

  afterEach(async () => {
    rmSync(holdFile, { force: true });
    await ctx.cleanup();
    clearMcpTokenCache();
  }, 90_000);

  /** The call the way the MCP proxy makes it: heartbeat-framed, so delivery is observable. */
  async function taskTool(fullTaskId: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ status: number; body: string }> {
    clearMcpTokenCache();
    const token = await mintMcpToken(ctx.root, { kind: 'task', taskId: fullTaskId }, 'e2e-agent');
    const target = getDaemonTcpTarget(ctx.root)!;
    const base = target.startsWith('http') ? target : `http://${target}`;
    const resp = await fetch(`${base}/mcp/${fullTaskId}/${tool}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'X-Lazy-Project': ctx.root, ...heartbeatRequestHeaders() },
      body: JSON.stringify({ arguments: args }),
      signal,
    } as any);
    const envelope = await readHeartbeatEnvelope(resp, tool);
    return { status: envelope.status, body: JSON.stringify(envelope.body) };
  }

  async function until(what: string, check: () => boolean, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (check()) return;
      await Bun.sleep(100);
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  async function liveParentAndChild() {
    const parentId = await createTask(ctx, 'Driver', 'Drive the children');
    const made = await ctx.lazy(['create', '--goal', 'Child', '--prompt', 'Child work', '--parent', parentId]);
    expectSuccess(made);
    const childId = extractTaskId(made.stdout);
    const fullParentId = findFullTaskId(ctx.root, parentId);

    writeFileSync(holdFile, 'hold');
    void ctx.lazyMocked(['start', parentId, '--yes'], MOCK_CLAUDE_SUCCESS);
    await until('parent turn live', () => readTaskStatus(ctx.root, parentId) === 'working');
    void ctx.lazyMocked(['start', childId, '--yes'], MOCK_CLAUDE_SUCCESS);
    await until('child turn live', () => readTaskStatus(ctx.root, childId) === 'working');
    return { parentId, childId, fullParentId };
  }

  async function commentState(parentId: string, text: string): Promise<{ delivered: boolean }> {
    const show = await ctx.lazy(['show', parentId, '--json']);
    const comment = (JSON.parse(show.stdout) as { comments: Array<{ content: string; created_at: number; delivered?: boolean }> })
      .comments.find(c => c.content.includes(text))!;
    const mark = readSessionJson(ctx.root, parentId)?.notes_delivered_through as number | undefined;
    const marked = mark !== undefined && comment.created_at <= mark;
    // The show projection and the raw mark must agree.
    if (comment.delivered !== undefined) expect(comment.delivered).toBe(marked);
    return { delivered: marked };
  }

  // INVARIANT: a builder/human comment on the waiting task ends the wait within a
  // poll, carries the text, and counts as delivered — the next wait is not
  // interrupted by it again, and the delivery mark (shared with the unblock
  // prompt and the show projection) covers it so an unblock will not repeat it.
  test('a comment returns the wait with its content, once', async () => {
    const { parentId, childId, fullParentId } = await liveParentAndChild();

    const started = Date.now();
    const waiting = taskTool(fullParentId, 'lazy_wait', { task_id: childId, timeout: 30 });
    await Bun.sleep(1000);
    expectSuccess(await ctx.lazy(['comment', parentId, '--message', 'Engineer decided: ship option B']));

    const first = await waiting;
    expect(first.status, first.body).toBe(200);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(first.body).toContain('comment_added');
    expect(first.body).toContain('Engineer decided: ship option B');
    // The nonce that proves receipt stays between the MCP layer and the daemon.
    expect(first.body).not.toContain('claim_id');

    // The ack follows the written answer; give it a moment.
    let delivered = false;
    for (let i = 0; i < 50 && !delivered; i++) {
      delivered = (await commentState(parentId, 'option B')).delivered;
      if (!delivered) await Bun.sleep(200);
    }
    expect(delivered).toBe(true);

    const second = await taskTool(fullParentId, 'lazy_wait', { task_id: childId, timeout: 3 });
    expect(second.status, second.body).toBe(200);
    expect(second.body).not.toContain('comment_added');
  }, 120_000);

  // INVARIANT: a wait whose client went away must not mark a comment delivered
  // — the daemon completes calls anyway, and nobody read that answer. The
  // comment stays queued and the next wait hands it over.
  test('a wait abandoned by its client does not swallow the comment', async () => {
    const { parentId, childId, fullParentId } = await liveParentAndChild();

    const abort = new AbortController();
    const orphan = taskTool(fullParentId, 'lazy_wait', { task_id: childId, timeout: 30 }, abort.signal).catch(() => null);
    await Bun.sleep(1000);
    abort.abort();
    await orphan;
    expectSuccess(await ctx.lazy(['comment', parentId, '--message', 'Do not lose this one']));
    await Bun.sleep(4000);
    expect((await commentState(parentId, 'Do not lose')).delivered).toBe(false);

    const next = await taskTool(fullParentId, 'lazy_wait', { task_id: childId, timeout: 30 });
    expect(next.body).toContain('Do not lose this one');
    expect((await commentState(parentId, 'Do not lose')).delivered).toBe(true);
  }, 120_000);
});
