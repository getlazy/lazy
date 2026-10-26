/**
 * A Chat message sent while the task's agent is mid-turn WAITS for that turn to
 * end, then goes out as the same read-only ask — as the person who typed it —
 * instead of being answered by somebody else from the stored record.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { findFullTaskId, readSessionJson, readTaskStatus, readTurns, taskFilePath } from '../helpers/storage';
import { DaemonClient } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';

const QUESTION = 'QUEUE_MARKER: what are you doing right now?';

describe('a chat message sent mid-turn', () => {
  let ctx: TestContext;
  let holdFile: string;

  beforeEach(async () => {
    holdFile = join(process.env.TMPDIR ?? '/tmp', `lazy-chat-queue-hold-${process.pid}-${Date.now()}`);
    ctx = await setupTestLazy({ withDaemon: true, daemonEnv: { LAZY_MOCK_HOLD_TURN_FILE: holdFile } });
  });

  afterEach(async () => {
    rmSync(holdFile, { force: true });
    await ctx.cleanup();
  });

  function client(): DaemonClient {
    const target = getDaemonTcpTarget(ctx.root);
    const token = readToken(ctx.root);
    if (!target || !token) throw new Error('test daemon did not record a TCP target and token');
    return DaemonClient.fromTarget(target, token);
  }

  function reviewComments(shortId: string): Array<Record<string, unknown>> {
    try {
      return JSON.parse(readFileSync(taskFilePath(ctx.root, shortId, 'review-comments.json'), 'utf8')).review_comments ?? [];
    } catch {
      return [];
    }
  }

  async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 60_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!(await ok())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  // INVARIANT: a question asked mid-turn is QUEUED, never answered from the
  // record nor shown as a failure; once the task parks it goes out as an ASK
  // (never a work turn) that runs as the person who asked it.
  test('waits for the turn, then is answered by the agent as the asker', async () => {
    const taskId = await createTask(ctx, 'Chat queue', 'Do work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    expect(await ctx.lazy(['wait', taskId])).toHaveProperty('exitCode', 0);
    const fullId = findFullTaskId(ctx.root, taskId);

    // Hold the next work turn open, so the task is `working` while we ask.
    writeFileSync(holdFile, 'hold');
    const unblocked = ctx.lazyMocked(['unblock', taskId, '--message', 'Keep going', '--yes'], MOCK_CLAUDE_SUCCESS)
      .catch((err) => err);
    await until('the held turn', () => readTaskStatus(ctx.root, taskId) === 'working', 20_000);

    await client().rpc('reviewAsk', ctx.root, { taskId: fullId, content: QUESTION });
    await until('the question to be queued', () =>
      reviewComments(taskId).some((c) => c.content === QUESTION && c.ask_state === 'queued'));
    const queued = reviewComments(taskId).find((c) => c.content === QUESTION)!;
    // Captured from the request that asked: the daemon's git identity here.
    expect(queued.ask_owner_email).toBe('test@lazy.test');

    // Chat says it is waiting — not answered, not failed.
    const during = await client().rpc('show', ctx.root, { taskId: fullId, sections: ['chat'] }) as { chat: { text: string; state: string }[] };
    expect(during.chat.find((m) => m.text === QUESTION)?.state).toBe('queued');
    const turnsWhileHeld = readTurns(ctx.root, taskId).length;

    // Release the work turn; the task parks; the question goes out.
    rmSync(holdFile, { force: true });
    await unblocked;
    await until('the queued question to be answered', () =>
      reviewComments(taskId).some((c) => c.content === QUESTION && c.ask_state === 'answered'), 90_000);

    // What ran after the held turn: that turn's own pair, then ONE ask pair — no
    // other work turn.
    const after = readTurns(ctx.root, taskId).slice(turnsWhileHeld);
    const askTurns = after.filter((t) => t.turn_type === 'ask');
    // The held turn's own human row was written before `turnsWhileHeld`; nothing
    // after it may be a new work turn — a queued ask never becomes one.
    expect(after.filter((t) => t.role === 'human' && (t.turn_type ?? 'work') === 'work')).toEqual([]);
    expect(askTurns.map((t) => t.role)).toEqual(['human', 'agent']);
    expect(askTurns[0]!.content).toBe(QUESTION);
    // The ask ran inside the asker's request scope: its launch records them as
    // the turn owner (a launch with nobody would CLEAR it), and the answer row
    // names them.
    expect(readSessionJson(ctx.root, taskId)?.turn_owner_email).toBe('test@lazy.test');
    expect((askTurns[1] as unknown as { actor_email?: string }).actor_email).toBe('test@lazy.test');
    await until('the task to park again', () => readTaskStatus(ctx.root, taskId) === 'blocked', 30_000);

    const shown = await client().rpc('show', ctx.root, { taskId: fullId, sections: ['chat'] }) as { chat: { from: string; text: string; state: string | null }[] };
    expect(shown.chat.find((m) => m.text === QUESTION)?.state).toBe('answered');
    expect(shown.chat.at(-1)?.from).toBe('agent');
  }, 240_000);
});
