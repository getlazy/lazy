/**
 * INVARIANT (fix-empty-failed-turn): a turn that dies must always leave a
 * VISIBLE record.
 *
 * "Visible" means a turn in the task's turns list — the surface a human reads
 * in `lazy show` and the one lazy-teams renders. An interrupt reason buried on
 * the session is not enough: no turn list can show it, so from the outside the
 * task simply came back from `working` having done nothing.
 *
 * The field incident this pins: with a dead credential, the FIRST unblock
 * recorded a fatal_auth turn and the SECOND recorded nothing at all. A
 * `FatalAgentError` response carries no `duration_ms` and no `exit_code`, so
 * two consecutive fatal_auth failures produce byte-identical turn content — and
 * the reconciler's content-based idempotency was scoped to the whole session,
 * so it swallowed the repeat. The task came back in seconds with an empty turns
 * list and nothing to diagnose.
 *
 * This runs on the fake-binary seam on purpose: a mocked `launchSupervisorAsync`
 * never produces a real classified failure, so only here does a real supervisor
 * classify a real 401 and a real reconciler decide what to record.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { crashScenario } from '../helpers/fake-claude';
import { agentTurns, sessionInterrupt } from '../helpers/agent-seam';

/** What a credential Anthropic rejects looks like on the way out of the agent. */
const AUTH_401 = 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid bearer token"}}\n';

describe('a failed turn always leaves a visible record', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('a repeat unblock against the same dead credential records a SECOND failure turn', async () => {
    const taskId = await createTask(ctx, 'Dead credential', 'Do the work');
    // The same rejection on every invocation — exactly the field condition.
    await ctx.setClaudeScenario(crashScenario({ stderr: AUTH_401, exitCode: 1 }));

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const afterFirst = await agentTurns(ctx.root, taskId);
    expect(afterFirst.length).toBe(1);
    expect(String(afterFirst[0]!.content)).toContain('fatal_auth');

    // A classified failure blocks the task for a human, so the human unblocks —
    // against the still-dead credential.
    expectSuccess(await ctx.lazy(['unblock', taskId, '--message', 'try again']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const afterSecond = await agentTurns(ctx.root, taskId);
    expect(afterSecond.length).toBe(2);
    expect(String(afterSecond[1]!.content)).toContain('fatal_auth');

    // And the failure is legible from the task read, not just from the file.
    const show = await ctx.lazy(['show', taskId]);
    expectSuccess(show);
    expectOutput(show, 'fatal_auth');

    const interrupt = await sessionInterrupt(ctx.root, taskId);
    expect(interrupt.interrupt_reason).toContain('fatal_auth');
  }, 150_000);
});
