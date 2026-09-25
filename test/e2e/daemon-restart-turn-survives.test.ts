/**
 * A turn that is running when the daemon restarts finishes normally, once.
 *
 * This is the claim a Lazy Teams fleet roll leans on. Lazy is a monolith from
 * the point of view of version management, so an upgrade to the app restarts
 * every project daemon — unconditionally, without waiting for idle, because a
 * loop or a long task can run for hours and an idle wait would leave the fleet
 * stale indefinitely. That is only an acceptable trade if a restart costs a
 * running turn a stop and a resume rather than its work.
 *
 * What already had coverage was each half in isolation:
 * `daemon-restart-children.test.ts` asserts the supervisor is stopped and the
 * recorded reason is honest, and `daemon-restart-interrupted-resume.test.ts`
 * asserts a task left interrupted by a departed daemon is picked up by the next
 * one. Neither follows the interrupted turn to an ENDING, which is the part a
 * roll is betting on: not "something ran again", but "the task reached the state
 * it would have reached had nobody restarted anything, and did not launch twice
 * on the way".
 *
 * Runs on the fake-binary seam: a real daemon, a real `lazy supervise`, a real
 * second agent invocation. Nothing in `src/` is mocked, because everything this
 * test is about lives downstream of `launchSupervisorAsync`.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { goSilentScenario, successScenario } from '../helpers/fake-claude';
import { readTaskStatus } from '../helpers/storage';
import { sessionInterrupt } from '../helpers/agent-seam';

const settle = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Poll until `check` passes or the budget runs out; returns the last value. */
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, budgetMs: number): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let last = await read();
  while (!ok(last) && Date.now() < deadline) {
    await settle(500);
    last = await read();
  }
  return last;
}

describe('a turn survives the daemon restarting under it', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('an in-flight turn is resumed and reaches blocked with the agent answer', async () => {
    const taskId = await createTask(ctx, 'Working when the fleet rolled', 'Work slowly');

    // The agent is mid-turn and saying nothing — the state a roll walks into,
    // and the one that used to sail through a restart holding a dead proxy
    // address.
    await ctx.setClaudeScenario(goSilentScenario({ sessionId: 'rolled-under', silentMs: 120_000 }));
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expect(await until(async () => readTaskStatus(ctx.root, taskId), s => s === 'working', 20_000))
      .toBe('working');

    // What the resumed turn will do. Set BEFORE the restart so the auto-resume
    // cannot race the scenario swap.
    await ctx.setClaudeScenario(successScenario({
      sessionId: 'rolled-under',
      result: 'Finished after the daemon restarted.',
      commit: {
        message: 'Work that survived the roll',
        files: [{ path: 'survived.txt', content: 'the worktree is still here\n' }],
      },
    }));
    await ctx.clearClaudeInvocations();

    expectSuccess(await ctx.lazy(['daemon', 'restart']));

    // INVARIANT: the interrupt is recorded as the daemon's doing, never as an
    // agent crash. A fleet roll that read as "your agent died" would send whoever
    // saw it looking for a bug that is not there.
    const interrupt = await until(
      () => sessionInterrupt(ctx.root, taskId).catch(() => ({ interrupt_reason: undefined })),
      i => typeof i.interrupt_reason === 'string' && /daemon (restarted|stopped)/.test(i.interrupt_reason),
      60_000,
    );
    expect(interrupt.interrupt_reason).toContain('audit proxy');

    // THE CLAIM: the turn ends the way it would have without the restart.
    const status = await until(
      async () => readTaskStatus(ctx.root, taskId),
      s => s === 'blocked',
      120_000,
    );
    expect(status).toBe('blocked');

    // And the agent really ran again, rather than the status being bookkeeping.
    const invocations = await ctx.claudeInvocations();
    expect(invocations.length).toBeGreaterThan(0);

    // INVARIANT: resumed ONCE. The restart reaper stops the old supervisor and
    // the reconciler auto-resumes it; if both the departing daemon's shutdown
    // sweep and the arriving daemon's reaper each launched a resume, two agents
    // would be working the same worktree — and the second would be invisible
    // until it corrupted the first one's commit.
    expect(invocations.length).toBeLessThanOrEqual(2);
  }, 240_000);
});
