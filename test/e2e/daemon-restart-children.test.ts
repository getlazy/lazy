/**
 * A daemon restart stops the children the previous daemon launched.
 *
 * The bug: the audit proxy runs in-process with the daemon on an OS-assigned
 * port, every child gets that address baked into `ANTHROPIC_BASE_URL` at launch,
 * and Claude Code never re-reads it. So a restart left every running agent
 * talking to a port that no longer existed — silently, for the rest of its life.
 *
 * This runs on the fake-binary seam so the agent is a REAL supervisor process
 * with a real pidfile: the new daemon has to discover it the same way it would
 * discover a real one. Nothing in `src/` is mocked. See
 * src/daemon/restart-reaper.ts.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { goSilentScenario } from '../helpers/fake-claude';
import { sessionInterrupt } from '../helpers/agent-seam';
import { readTaskStatus } from '../helpers/storage';

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

describe('daemon restart stops the previous generation', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('a running task agent is stopped and recorded as interrupted by the restart', async () => {
    const taskId = await createTask(ctx, 'Survives a daemon restart', 'Work slowly');
    // The agent stays alive with nothing to say — exactly the state that used to
    // sail through a restart holding a dead proxy address.
    await ctx.setClaudeScenario(goSilentScenario({ sessionId: 'restart-victim', silentMs: 120_000 }));

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    const started = await until(
      async () => readTaskStatus(ctx.root, taskId),
      s => s === 'working',
      20_000,
    );
    expect(started).toBe('working');

    expectSuccess(await ctx.lazy(['daemon', 'restart']));

    // The new daemon reaps on its first reconcile tick.
    const interrupt = await until(
      // The session record may not exist for a beat after the stop.
      () => sessionInterrupt(ctx.root, taskId).catch(() => ({ interrupt_reason: undefined })),
      i => typeof i.interrupt_reason === 'string' && /daemon (restarted|stopped)/.test(i.interrupt_reason),
      40_000,
    );

    // INVARIANT: the recorded reason is honest. Left to the ordinary run-stopped
    // path this would read as an agent crash, which sends whoever reads it
    // looking for a bug in the agent.
    //
    // Either half of a restart may be the one that records it, so both wordings
    // satisfy the invariant. On a CLEAN restart the outgoing daemon stops the
    // supervisor in its shutdown sweep and records "the daemon stopped" there;
    // when the old daemon never ran that code — kill -9, OOM, reboot — the
    // incoming daemon's reaper finds the orphan and records "the daemon
    // restarted". What must never appear is an exit code blamed on the agent.
    expect(interrupt.interrupt_reason).toMatch(/daemon (restarted|stopped)/);
    expect(interrupt.interrupt_reason).toContain('audit proxy');
  }, 120_000);
});
