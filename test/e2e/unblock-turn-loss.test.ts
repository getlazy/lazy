/**
 * A turn the agent actually finished must never disappear.
 *
 * INVARIANT (CLAUDE.md's "never lose human feedback", mirrored for the agent):
 * the agent's output is evidence, and evidence is never destroyed to make room
 * for the next command. Observed in the wild on an `interrupted` task: the
 * human ran `lazy unblock`, watched a full turn stream to completion, and
 * afterwards the task had NO turn for it and `lazy pair` opened an empty agent
 * session. Both symptoms are one cause — `handleCompletedResponses` is the only
 * place that writes both the turn record and `agent_session_id`, and it never
 * ran, because `writeCommand` had `unlink`ed the response out from under it.
 *
 * This suite runs on the fake-binary seam deliberately (CLAUDE.md, "Two agent
 * seams"): the loss happens in the host↔supervisor protocol FILES — a real
 * `response.json` written by a real supervisor and removed by a real
 * `writeCommand`. The module mock replaces `launchSupervisorAsync`, so none of
 * those files exist under it and the bug is out of reach by construction.
 *
 * The two tests below do different jobs, deliberately. The second one is the
 * REPRODUCTION: it forces the destructive step (an unconsumed finished response,
 * then a command) and fails on the unfixed code. The first is the WILD SHAPE —
 * interrupted → unblock → full turn — which passes on the unfixed code too,
 * because the loss there depends on a sweep landing inside a sub-second window.
 * It is here as the regression guard for the end-to-end path a human walks, not
 * as evidence of the bug.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readdir } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { successScenario, goSilentScenario } from '../helpers/fake-claude';
import { setGuards, agentTurns, readSessionRecord, taskDir, waitForStatus } from '../helpers/agent-seam';
import { protocolDir as getProtocolDir, writeResponse } from '../../src/protocol';
import type { CompletedResponse } from '../../src/protocol';

/**
 * The protocol dir is keyed by the FULL task id; the CLI hands back a short one.
 * The storage directory name is the full id, so it is the cheapest lookup that
 * does not reach into the daemon.
 */
async function fullTaskId(root: string, shortId: string): Promise<string> {
  const dir = await taskDir(root, shortId);
  const parts = dir.split('/');
  return parts[parts.length - 1]!;
}

describe('an unblocked turn is never lost', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // The wild sequence, end to end: watchdog kill → `interrupted` → human
  // unblocks with new instructions → the agent runs a full turn. The turn must
  // be in the store afterwards, and the session id on the session must be the
  // one that turn ran in — that second assertion is what `lazy pair` reads, and
  // its absence is why pairing opened an empty session.
  test('a turn run after unblocking an interrupted task is recorded, with its session id', async () => {
    await setGuards(ctx, { noProgressMs: 3_000 });

    const taskId = await createTask(ctx, 'Unblock after interruption', 'Do the work');
    // NOT a sequence: a watchdog kill that captured no work is RETRIED inside
    // the same turn, so a second scenario entry would be eaten by the retry and
    // the task would end up blocked instead of interrupted. A repeating
    // go-silent scenario exhausts the retries, which is what produces the
    // `interrupted` precondition this test is about.
    await ctx.setClaudeScenario(goSilentScenario({ sessionId: 'fake-sess-silent', silentMs: 120_000 }));

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    // A watchdog kill ends the turn ungracefully, so `wait` exits nonzero and
    // the task lands in `interrupted` — that IS the precondition under test.
    const killed = await ctx.lazy(['wait', taskId]);
    expect(killed.exitCode).not.toBe(0);
    expectOutput(killed, 'interrupted');

    // The fake re-reads its scenario on every invocation, so the turn the human
    // is about to unblock into is a real, complete one.
    await ctx.setClaudeScenario(successScenario({
      result: 'The long turn the human watched: here is everything I concluded.',
      sessionId: 'fake-sess-after-unblock',
    }));
    expectSuccess(await ctx.lazy(['unblock', taskId, '--message', 'New instructions: carry on from here.']));

    // Not `lazy wait`: an interrupted task may already be auto-resuming, so the
    // end state has to be read from storage rather than from one turn's exit.
    await waitForStatus(ctx.root, taskId, ['blocked'], 120_000);

    const turns = await agentTurns(ctx.root, taskId);
    const recorded = turns.map(t => String(t.content));
    expect(recorded.some(c => c.includes('here is everything I concluded'))).toBe(true);

    const session = await readSessionRecord(ctx.root, taskId);
    expect(session.agent_session_id).toBe('fake-sess-after-unblock');
  }, 180_000);

  // The destructive step itself, forced rather than raced: a finished response
  // that nothing has consumed yet, and then a command. `writeCommand` used to
  // `unlink` that response, which is precisely how a full turn vanished with no
  // trace on any surface. It must be preserved and recorded instead.
  test('a finished response the next command displaces is still recorded as a turn', async () => {
    const taskId = await createTask(ctx, 'Displaced response', 'Do the work');
    await ctx.setClaudeScenario(successScenario({
      result: 'First turn done.',
      sessionId: 'fake-sess-displaced',
    }));

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    // Stand in for the supervisor having finished a turn whose response the
    // reconciler has not picked up yet — the exact state the wild race left
    // behind when `unblock` landed mid-sweep.
    const protoDir = getProtocolDir(await fullTaskId(ctx.root, taskId));
    const finished: CompletedResponse = {
      status: 'completed',
      result: 'The turn that used to vanish: conclusions, and what still remains.',
      session_id: 'fake-sess-displaced',
      usage: { input_tokens: 1_000, output_tokens: 250 },
    };
    writeResponse(protoDir, finished);

    // The command that displaces it.
    expectSuccess(await ctx.lazy(['unblock', taskId, '--message', 'Next instructions.']));
    await waitForStatus(ctx.root, taskId, ['blocked'], 120_000);

    const recorded = (await agentTurns(ctx.root, taskId)).map(t => String(t.content));
    expect(recorded.some(c => c.includes('The turn that used to vanish'))).toBe(true);

    // And nothing is left lying around: once recorded, the displaced file is
    // consumed, so it cannot be recorded a second time on a later tick.
    const leftovers = (await readdir(protoDir)).filter(f => f.startsWith('superseded-response-'));
    expect(leftovers).toEqual([]);
  }, 180_000);
});
