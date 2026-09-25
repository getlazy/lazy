/**
 * A task left `interrupted` by a daemon that died must be resumed by the next
 * daemon.
 *
 * `interrupted` is documented — and shown in the UI — as the auto-resumable
 * status: "it resumes on its own". That was only ever true for a task the
 * RUNNING daemon interrupted itself, because `reconcileTasks` sweeps
 * `workingOnly` and auto-resume was reachable only from the transition that
 * created the interrupt. A task interrupted by a daemon that then went away —
 * the daemon crashed, the container vanished with it, the host rebooted — had
 * nobody left to make that call, and sat interrupted forever. Observed on a
 * live fleet: "Container disappeared (no exit code)", daemon restarted, task
 * never moved again.
 *
 * Runs on the fake-binary seam with a real daemon and a real `lazy supervise`
 * process, so the resume has to go all the way to a second agent invocation.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { goSilentScenario } from '../helpers/fake-claude';
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

describe('daemon restart resumes a task interrupted while it was down', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('an already-interrupted task is picked up and resumed by the new daemon', async () => {
    const taskId = await createTask(ctx, 'Interrupted while the daemon was down', 'Work slowly');
    await ctx.setClaudeScenario(goSilentScenario({ sessionId: 'stranded-victim', silentMs: 120_000 }));

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expect(await until(async () => readTaskStatus(ctx.root, taskId), s => s === 'working', 20_000)).toBe('working');

    // Take the daemon down. Its shutdown sweep stops the supervisor and records
    // why, so the turn is genuinely over — nothing will ever write response.json
    // for it — and the task is left in the auto-resumable status with nobody
    // around to act on it. That is the whole scenario, produced for real rather
    // than staged by writing a status.
    expectSuccess(await ctx.lazy(['daemon', 'stop']));
    await settle(500);

    expect(await readTaskStatus(ctx.root, taskId)).toBe('interrupted');
    const interrupt = await sessionInterrupt(ctx.root, taskId);
    // Honest reason, not an exit code blamed on the agent.
    expect(interrupt.interrupt_reason).toMatch(/daemon stopped/);

    await ctx.clearClaudeInvocations();

    // A fresh agent turn must actually run, so give it something to do.
    await ctx.setClaudeScenario(goSilentScenario({ sessionId: 'stranded-resume', silentMs: 120_000 }));

    expectSuccess(await ctx.lazy(['daemon', 'start']));

    const status = await until(
      async () => readTaskStatus(ctx.root, taskId),
      s => s === 'working',
      60_000,
    );
    expect(status).toBe('working');

    // Status alone would be satisfied by a bookkeeping change; the point is
    // that a supervisor and an agent are running again.
    const invocations = await until(
      () => ctx.claudeInvocations(),
      inv => inv.length > 0,
      60_000,
    );
    expect(invocations.length).toBeGreaterThan(0);
  }, 180_000);
});
