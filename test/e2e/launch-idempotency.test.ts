/**
 * A retried turn launch with the same idempotency key is the SAME launch.
 *
 * Without a key, an unblock retried after the first turn had finished was
 * accepted: the feedback was recorded twice and a second turn ran (reproduced
 * while building this). These tests drive the daemon over its RPC port, the
 * surface Lazy Teams and the CLI both use.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { readTurns, findFullTaskId, readTaskStatus, readTaskJson, setTaskMetadata, taskFilePath } from '../helpers/storage';
import { readFileSync } from 'fs';
import { DaemonClient, RpcApplicationError } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';

describe('turn launches with an idempotency key', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function rpc(command: string, params: Record<string, unknown>): Promise<any> {
    const target = getDaemonTcpTarget(ctx.root);
    const token = readToken(ctx.root);
    if (!target || !token) throw new Error('test daemon did not record a TCP target and token');
    return await DaemonClient.fromTarget(target, token).rpc(command, ctx.root, params);
  }

  async function waitOut(id: string): Promise<void> {
    const waited = await ctx.lazy(['wait', id]);
    if (waited.exitCode !== 0) throw new Error(`wait failed for ${id}: ${waited.stderr}\n${waited.stdout}`);
  }

  function humanTurnsSaying(id: string, text: string): number {
    return readTurns(ctx.root, findFullTaskId(ctx.root, id)).filter((t: any) => t.role === 'human' && t.content === text).length;
  }

  async function blockedTask(goal: string): Promise<string> {
    const id = await createTask(ctx, goal, 'Some work');
    expectSuccess(await ctx.lazyMocked(['start', id, '--yes'], MOCK_CLAUDE_SUCCESS));
    await waitOut(id);
    return id;
  }

  test('an unblock retried after its turn finished replays the result and starts no second turn', async () => {
    // INVARIANT: the same key on the same task is the same request — a retry never
    // records the feedback twice or launches a second turn. A client that timed out
    // cannot tell "launched" from "failed", and a retry that ran again cost a turn.
    const id = await blockedTask('Unblock retry');
    const params = { taskId: id, message: 'please do X', actor: 'human', idempotencyKey: 'k-unblock-1' };

    const first = await rpc('unblockTask', params);
    expect(first.idempotentReplay).toBeUndefined();
    await waitOut(id);
    const turnsAfterFirst = readTurns(ctx.root, findFullTaskId(ctx.root, id)).length;

    const second = await rpc('unblockTask', params);
    expect(second.idempotentReplay).toBe(true);
    expect(second.sessionId).toBe(first.sessionId);
    expect(readTaskStatus(ctx.root, id)).not.toBe('working');
    expect(humanTurnsSaying(id, 'please do X')).toBe(1);
    expect(readTurns(ctx.root, findFullTaskId(ctx.root, id)).length).toBe(turnsAfterFirst);
  }, 120_000);

  test('a retry while the original turn is still running gets the original launch, not a refusal', async () => {
    // INVARIANT: a repeat while the task is `working` because of THIS key is not
    // "task is busy" — the person's request did go through.
    const id = await blockedTask('Unblock retry while working');
    const params = { taskId: id, message: 'please do Y', actor: 'human', idempotencyKey: 'k-unblock-2' };
    const first = await rpc('unblockTask', params);
    const second = await rpc('unblockTask', params);
    expect(second.idempotentReplay).toBe(true);
    expect(second.sessionId).toBe(first.sessionId);
    await waitOut(id);
    expect(humanTurnsSaying(id, 'please do Y')).toBe(1);
  }, 120_000);

  test('a key reused with a different payload is refused loudly', async () => {
    // INVARIANT: replaying a result for a request the caller did not make would be
    // a silent lie, so a mismatched payload is a 422 and launches nothing.
    const id = await blockedTask('Key mismatch');
    await rpc('unblockTask', { taskId: id, message: 'first words', actor: 'human', idempotencyKey: 'k-reused' });
    await waitOut(id);
    const err = await rpc('unblockTask', { taskId: id, message: 'other words', actor: 'human', idempotencyKey: 'k-reused' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(RpcApplicationError);
    expect((err as RpcApplicationError).status).toBe(422);
    expect((err as Error).message).toContain('different request');
    expect(humanTurnsSaying(id, 'other words')).toBe(0);
  }, 120_000);

  test('a start retried after its turn finished replays instead of refusing', async () => {
    const id = await createTask(ctx, 'Start retry', 'Some work');
    const params = { taskId: id, actor: 'human', idempotencyKey: 'k-start' };
    const first = await rpc('startTask', params);
    await waitOut(id);
    const second = await rpc('startTask', params);
    expect(second.idempotentReplay).toBe(true);
    expect(second.sessionId).toBe(first.sessionId);
    expect(readTaskStatus(ctx.root, id)).not.toBe('working');
  }, 120_000);

  test('the record survives a daemon restart', async () => {
    // INVARIANT: the key is durable — a retry often arrives after a restart.
    const id = await blockedTask('Restart retry');
    const params = { taskId: id, message: 'after restart', actor: 'human', idempotencyKey: 'k-restart' };
    await rpc('unblockTask', params);
    await waitOut(id);
    await ctx.restartDaemon({});
    const again = await rpc('unblockTask', params);
    expect(again.idempotentReplay).toBe(true);
    expect(humanTurnsSaying(id, 'after restart')).toBe(1);
  }, 180_000);

  test('a refused launch is re-attempted with the same key once the refusal is gone', async () => {
    // A refusal wrote no turn, so retrying it is safe — and it is what a client
    // healing a lost credential relies on. Here: resume refused while working.
    const id = await blockedTask('Refused then retried');
    await rpc('unblockTask', { taskId: id, message: 'keep going', actor: 'human' });
    const params = { taskId: id, actor: 'human', idempotencyKey: 'k-resume' };
    const refused = await rpc('resumeTask', params).catch((e) => e);
    expect(refused).toBeInstanceOf(RpcApplicationError);
    await waitOut(id);
    const retried = await rpc('resumeTask', params);
    expect(retried.idempotentReplay).toBeUndefined();
    expect(retried.sessionId).toBeTruthy();
    await waitOut(id);
  }, 120_000);

  test('two concurrent requests with the same key launch once and share one result', async () => {
    // INVARIANT: a repeat that arrives while the original is still launching JOINS
    // it — the claim and the in-flight launch are registered under one lock, so
    // two requests racing each other can never both launch.
    const id = await blockedTask('Concurrent same key');
    const params = { taskId: id, message: 'only once please', actor: 'human', idempotencyKey: 'k-concurrent' };
    const [a, b] = await Promise.all([rpc('unblockTask', params), rpc('unblockTask', params)]);
    expect([a.idempotentReplay, b.idempotentReplay].filter((v) => v === true)).toHaveLength(1);
    expect(a.sessionId).toBe(b.sessionId);
    await waitOut(id);
    expect(humanTurnsSaying(id, 'only once please')).toBe(1);
  }, 120_000);

  test('an ask retried with the same key replays the original start of the ask', async () => {
    // INVARIANT: ask is one of the keyed launches — a retried question is not asked twice.
    const id = await blockedTask('Ask retry');
    const params = { taskId: id, message: 'what changed?', actor: 'human', idempotencyKey: 'k-ask-replay' };
    const first = await rpc('askTask', params);
    await waitOut(id);
    const second = await rpc('askTask', params);
    expect(second.idempotentReplay).toBe(true);
    expect(second.outcome).toBe(first.outcome);
    expect(second.turnSequence).toBe(first.turnSequence);
  }, 120_000);

  test('a launch whose outcome was never recorded is refused as unknown, never re-run', async () => {
    // INVARIANT: a record left `launching` with nothing running it (its daemon died,
    // or the outcome write failed) may have started a turn; re-running it could
    // start a second one, so the daemon says the outcome is unknown instead.
    const id = await blockedTask('Outcome unknown');
    const params = { taskId: id, message: 'maybe started', actor: 'human', idempotencyKey: 'k-unknown' };
    await rpc('unblockTask', params);
    await waitOut(id);
    const raw = readTaskJson(ctx.root, id).metadata?.launch_idempotency as string;
    const records = JSON.parse(raw) as Record<string, Record<string, unknown>>;
    for (const r of Object.values(records)) { r.state = 'launching'; r.process = 'a-daemon-that-died'; delete r.result; }
    setTaskMetadata(ctx.root, id, 'launch_idempotency', JSON.stringify(records));
    const err = await rpc('unblockTask', params).catch((e) => e);
    expect(err).toBeInstanceOf(RpcApplicationError);
    expect((err as RpcApplicationError).status).toBe(409);
    expect((err as Error).message).toContain('unknown');
    expect(humanTurnsSaying(id, 'maybe started')).toBe(1);
  }, 120_000);

  test('a Teams question (reviewAsk) retried with the same key is posted and asked once', async () => {
    // INVARIANT: the question Lazy Teams posts is one of the keyed launches. A
    // repeat with the same key returns the original comment and never writes the
    // question again or launches a second ask turn.
    const id = await blockedTask('Review ask retry');
    const params = { taskId: id, content: 'why this approach?', idempotencyKey: 'k-review-ask' };
    const first = await rpc('reviewAsk', params);
    // The ask runs in the background after reviewAsk answers: wait until the
    // question is actually answered, so the first turn is counted and is real.
    const readComments = () => JSON.parse(readFileSync(taskFilePath(ctx.root, id, 'review-comments.json'), 'utf-8')).review_comments as Array<{ id: string; content: string; ask_state?: string }>;
    const deadline = Date.now() + 60_000;
    while (readComments().find((c) => c.id === first.comment.id)?.ask_state === 'pending') {
      if (Date.now() > deadline) throw new Error('the first question never left pending');
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(readComments().find((c) => c.id === first.comment.id)?.ask_state).toBe('answered');
    await waitOut(id);
    const turnsAfterFirst = readTurns(ctx.root, findFullTaskId(ctx.root, id)).length;
    const second = await rpc('reviewAsk', params);
    expect(second.idempotentReplay).toBe(true);
    expect(second.comment.id).toBe(first.comment.id);
    expect(readComments().filter((c) => c.content === 'why this approach?')).toHaveLength(1);
    expect(readTurns(ctx.root, findFullTaskId(ctx.root, id)).length).toBe(turnsAfterFirst);
  }, 120_000);
});
