/**
 * E2E: `lazy wait <a> <b>` races a set of tasks and returns as soon as the
 * FIRST one finishes.
 *
 * THE INCIDENT (2026-07-31): with two tasks running, an agent waited on one of
 * them, guessed wrong about which would finish first, and sat blocked on the
 * slow one while the fast one was already sitting ready for review. This suite
 * reproduces that exact shape — the SECOND-listed task finishes first — through
 * the real stack.
 *
 * The fake-binary seam is used (not the module mock) because the race needs one
 * agent that genuinely keeps running while the other finishes; the module mock
 * replaces `launchSupervisorAsync` wholesale and cannot express "still working".
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { successScenario, sessionStartEvent, toolUseEvent, resultEvent, type ClaudeScenario } from '../helpers/fake-claude';

/** A turn that stays silent for `ms` before finishing — "still working". */
function slowScenario(sessionId: string, ms: number): ClaudeScenario {
  return {
    steps: [
      { kind: 'emit', event: sessionStartEvent(sessionId) },
      { kind: 'emit', event: toolUseEvent('toolu_slow') },
      { kind: 'sleep', ms },
      { kind: 'emit', event: resultEvent({ result: 'Slow agent finally finished.', sessionId }) },
    ],
  };
}

describe('lazy wait — racing multiple tasks', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** Wait until the fake agent has been invoked at least `n` times. */
  async function awaitInvocations(n: number, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await ctx.claudeInvocations()).length >= n) return;
      await Bun.sleep(100);
    }
    throw new Error(`fake agent was invoked fewer than ${n} times within ${timeoutMs}ms`);
  }

  // INVARIANT: the race returns the task that actually finished, even when it
  // is not the first one listed. Do not "simplify" this into waiting on the
  // first argument — that is the bug this feature exists to fix.
  test('returns the SECOND-listed task when it finishes first', async () => {
    const slowId = await createTask(ctx, 'Slow task', 'Take a long time');
    const fastId = await createTask(ctx, 'Fast task', 'Finish quickly');

    // The fake reads its scenario file per invocation, so scripting between
    // starts gives each task its own behavior deterministically.
    await ctx.setClaudeScenario(slowScenario('fake-sess-slow', 15_000));
    expectSuccess(await ctx.lazy(['start', slowId, '--yes']));
    await awaitInvocations(1);

    await ctx.setClaudeScenario(successScenario({ result: 'Fast agent done.', sessionId: 'fake-sess-fast' }));
    expectSuccess(await ctx.lazy(['start', fastId, '--yes']));

    // Slow task listed FIRST — the incident's shape.
    const result = await ctx.lazy(['wait', slowId, fastId, '--json']);

    // Exit 0: the winner reached `blocked`, i.e. normal completion.
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      task_id: string;
      display_id: string;
      status: string;
      timed_out: boolean;
      tasks: Array<{ task_id: string; display_id: string; status: string }>;
      pending: Array<{ display_id: string; status: string }>;
    };

    expect(payload.timed_out).toBe(false);
    expect(payload.display_id).toBe(fastId);
    expect(payload.task_id.startsWith(fastId)).toBe(true);
    expect(payload.status).toBe('blocked');

    // Both tasks are reported; the slow one is still pending.
    expect(payload.tasks.map(t => t.display_id).sort()).toEqual([fastId, slowId].sort());
    expect(payload.pending.map(t => t.display_id)).toEqual([slowId]);
    expect(payload.pending[0].status).toBe('working');
  }, 90_000);

  // Human-readable output must name which task fired and what the others are
  // doing — the whole point is to remove the guessing.
  test('human output names the winning task and the still-pending set', async () => {
    const slowId = await createTask(ctx, 'Slow task', 'Take a long time');
    const fastId = await createTask(ctx, 'Fast task', 'Finish quickly');

    await ctx.setClaudeScenario(slowScenario('fake-sess-slow-2', 15_000));
    expectSuccess(await ctx.lazy(['start', slowId, '--yes']));
    await awaitInvocations(1);

    await ctx.setClaudeScenario(successScenario({ result: 'Fast agent done.', sessionId: 'fake-sess-fast-2' }));
    expectSuccess(await ctx.lazy(['start', fastId, '--yes']));

    const result = await ctx.lazy(['wait', slowId, fastId]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Waiting for the first of 2 tasks to finish');
    expect(result.stdout).toContain(`Task ${fastId} is now blocked`);
    expect(result.stdout).toContain(`Still pending: ${slowId} (working)`);
  }, 90_000);
});
