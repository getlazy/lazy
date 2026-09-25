/**
 * Autonomous crash recovery, driven by a REAL agent crash.
 *
 * test/e2e/auto-resume.test.ts covers the reconciler's auto-resume logic, but
 * it has to FABRICATE the crash: it flips task.json to `working`, deletes
 * response.json, and calls the reconcile pass by hand ("simulating a container
 * crash", four times over). It then asserts on the command.json that
 * auto-resume wrote — one layer short of the agent, because on the module-mock
 * seam there is no agent process to hand it to.
 *
 * On the fake-binary seam (`setupTestLazy({ fakeClaude: true })`) the crash is
 * real: a scripted agent goes silent, the real watchdog kills it, the real
 * daemon records the interrupt, and the real reconcile loop decides to resume.
 * And because the fake records its own argv, the assertion can be about the
 * prompt the AGENT ACTUALLY RECEIVED rather than the one lazy intended to send.
 * That last step is the part no mocked suite can reach, and it is where the
 * never-lose-human-feedback invariant actually lives.
 *
 * These tests complement auto-resume.test.ts rather than replace it: the
 * fabricated-crash suite covers branches (dirty worktree, circuit breaker,
 * counter resets) that would each cost a real multi-turn kill here.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { successScenario, goSilentScenario, type ClaudeScenario } from '../helpers/fake-claude';
import {
  setGuards,
  agentTurns,
  readSessionRecord,
  waitForStatus,
  turnPrompts,
  waitForTurnPrompt,
  allTurns,
} from '../helpers/agent-seam';

/** Long enough that the guard, not the script, decides when the turn dies. */
const SILENT_MS = 120_000;

/**
 * A turn that commits real work and THEN stops advancing.
 *
 * The distinction matters to every test in this file: `decideWatchdogRetry`
 * (src/supervisor/retry-policy.ts) relaunches a killed turn in place when it
 * captured nothing — the hung-first-model-call shape — and only ends the turn
 * when it captured something. Reaching the reconciler's auto-resume, which is
 * what this suite exists to exercise, therefore requires a kill on a turn that
 * got work onto disk first. A bare `goSilentScenario` is handled entirely
 * inside the supervisor and never becomes `interrupted`.
 */
function workedThenSilentScenario(opts: { sessionId: string; silentMs: number }): ClaudeScenario {
  const silent = goSilentScenario(opts);
  const [sessionStart, ...rest] = silent.steps;
  return {
    ...silent,
    steps: [
      sessionStart!,
      {
        kind: 'commit',
        message: 'partial work before the crash',
        files: [{ path: 'partial-work.txt', content: 'work in progress\n' }],
      },
      ...rest,
    ],
  };
}
/** Watchdog no-progress window for these tests. */
const NO_PROGRESS_MS = 3_000;
/**
 * Budget for "crash, get noticed, get resumed, finish". The reconcile loop
 * ticks every 5s and each turn spawns a real supervisor subprocess, so this is
 * several ticks of headroom rather than a tight bound.
 */
const RECOVERY_MS = 90_000;

describe('auto-resume after a real agent crash (real supervisor, fake claude)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: an ungracefully interrupted task recovers WITHOUT a human. The
  // full loop — watchdog kill → `interrupted` → reconciler → autoResumeTask →
  // a new supervisor → a new agent process — has to close, and every link in it
  // is production code here. auto-resume.test.ts can only assert the middle of
  // this chain because its crash and its reconcile pass are both hand-driven.
  test('a watchdog-killed turn is auto-resumed and the next turn completes the task', async () => {
    await setGuards(ctx, { noProgressMs: NO_PROGRESS_MS });

    const taskId = await createTask(ctx, 'Crash then auto-resume', 'Do the work');
    await ctx.setClaudeScenario({
      sequence: [
        // Turn 1: never advances, so the no-progress guard kills it.
        goSilentScenario({ sessionId: 'fake-sess-autoresume', silentMs: SILENT_MS }),
        // Turn 2 onwards: the resumed agent finishes normally.
        successScenario({ result: 'Finished after being auto-resumed.', sessionId: 'fake-sess-autoresume' }),
      ],
    });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));

    // `wait` is used only to let the turn run out; its exit code is
    // deliberately NOT asserted. It reports whatever status it happens to
    // sample, and auto-resume flips the task interrupted → working again within
    // one reconcile tick — so whether `wait` catches the interrupted window or
    // rides through to `blocked` is a race, not an invariant. Recovery is
    // asserted against storage instead.
    await ctx.lazy(['wait', taskId]);

    expect(await waitForStatus(ctx.root, taskId, ['blocked'], RECOVERY_MS)).toBe('blocked');

    // Two real agent processes: the one that was killed, and the resumed one.
    const prompts = await turnPrompts(ctx);
    expect(prompts.length).toBeGreaterThanOrEqual(2);

    const turns = await agentTurns(ctx.root, taskId);
    expect(String(turns[turns.length - 1].content)).toContain('Finished after being auto-resumed.');

    // A completed turn clears the interruption streak — otherwise three
    // unrelated crashes over a task's life would trip the circuit breaker.
    const session = await readSessionRecord(ctx.root, taskId);
    expect(session.consecutive_interruptions).toBe(0);
  }, 180_000);

/*
   * THE RECOVERY PATHS RUN THE SELF-REVIEW TOO — the round-4 HIGH.
   *
   * `low_high_loop` reached the command only from the three launch literals;
   * `autoResumeTask` builds its own and skipped it. Invisible while the loop
   * was opt-in, load-bearing once `low_high` became the default: a task whose
   * FINAL turn is an auto-resume ran single-phase, produced no self-review, and
   * parked with nothing recorded and nothing gating. CLAUDE.md names the class
   * — "the recovery paths are exactly the ones that forgot" — which is why this
   * is asserted on the real seam rather than at the resolver.
   */
  test('an auto-resumed turn still runs both low-high phases', async () => {
    await setGuards(ctx, { noProgressMs: NO_PROGRESS_MS });

    const taskId = await createTask(ctx, 'Crash then self-review', 'Do the work');
    await ctx.setClaudeScenario({
      sequence: [
        // Turn 1 dies on the watchdog, so turn 2 is the AUTO-RESUME — the path
        // under test. Its three invocations are the draft, the self-review and
        // the revise pass.
        goSilentScenario({ sessionId: 'fake-sess-resumeloop', silentMs: SILENT_MS }),
        successScenario({
          result: 'Draft after the resume.',
          sessionId: 'low-high-draft',
          commit: { message: 'Draft', files: [{ path: 'resumed.txt', content: 'draft\n' }] },
        }),
        successScenario({ result: 'LOW_HIGH_LOOP_APPROVED', sessionId: 'low-high-review' }),
      ],
    });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    await ctx.lazy(['wait', taskId]);
    expect(await waitForStatus(ctx.root, taskId, ['blocked'], RECOVERY_MS)).toBe('blocked');

    // The phase the resume path used to skip. The supervisor turn carries the
    // heading; the agent turn beside it carries what the self-review replied —
    // both are absent entirely when the resume runs single-phase, which is what
    // it did before this fix.
    const all = await allTurns(ctx.root, taskId);
    const content = all.map((t) => String(t.content)).join('\n');
    expect(content).toContain('## Low-High Loop Self-Review');
    expect(content).toContain('LOW_HIGH_LOOP_APPROVED');
  }, 180_000);

  // INVARIANT (src/utils/auto-resume.ts): the resumed agent is TOLD it is being
  // resumed after a crash, so it verifies its state instead of assuming its
  // previous work survived. The assertion is on the argv the fake agent
  // received — the prompt as delivered, not as composed.
  test('the resumed agent receives the crash context in its prompt', async () => {
    await setGuards(ctx, { noProgressMs: NO_PROGRESS_MS });

    const taskId = await createTask(ctx, 'Crash context delivery', 'Do the work');
    await ctx.setClaudeScenario({
      sequence: [
        workedThenSilentScenario({ sessionId: 'fake-sess-crashctx', silentMs: SILENT_MS }),
        successScenario({ result: 'Resumed with context.', sessionId: 'fake-sess-crashctx' }),
      ],
    });

    // Keep this assertion focused on crash recovery. The default low-high
    // review adds agent invocations of its own, while the final wrap-up still
    // exercises the ordering that originally made a "last prompt" assertion
    // observe the wrong invocation.
    expectSuccess(await ctx.lazy(['start', taskId, '--review', 'off', '--yes']));
    await ctx.lazy(['wait', taskId]);
    const resumedPrompt = await waitForTurnPrompt(
      ctx,
      prompt => prompt.includes('You are being resumed after a crash'),
      RECOVERY_MS,
    );
    await waitForStatus(ctx.root, taskId, ['blocked'], RECOVERY_MS);

    const prompts = await turnPrompts(ctx);
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    // The first turn got the ordinary task prompt; the resumed one is prefixed.
    expect(prompts[0]).not.toContain('You are being resumed after a crash');
    expect(resumedPrompt).toContain('You are being resumed after a crash');
  }, 180_000);

  // INVARIANT (CLAUDE.md — never lose human feedback): feedback stays `pending`
  // until an agent turn actually COMPLETES, so a turn that crashes after
  // receiving it must have it re-delivered verbatim, not silently dropped and
  // replaced by the generic "you were interrupted" prompt.
  //
  // This is the assertion the whole seam exists for: the module mock could show
  // that lazy wrote the right command.json, but only a real agent process can
  // show that the human's words reached it — twice, after a real crash ate the
  // first delivery.
  test('unconsumed feedback survives a real crash and is re-delivered verbatim', async () => {
    await setGuards(ctx, { noProgressMs: NO_PROGRESS_MS });

    const FEEDBACK = 'Rename the widget factory to WidgetForge before doing anything else.';

    const taskId = await createTask(ctx, 'Feedback survives a crash', 'Do the work');
    await ctx.setClaudeScenario({
      sequence: [
        // Turn 1: a normal turn, so the task lands in `blocked` and can be unblocked.
        successScenario({ result: 'First turn done.', sessionId: 'fake-sess-feedback' }),
        // The completed work turn runs its end-of-turn wrap-up before parking.
        successScenario({ result: 'First turn wrapped up.', sessionId: 'fake-sess-feedback' }),
        // Turn 2: the unblock turn — dies before completing, leaving the
        // feedback turn `pending`.
        workedThenSilentScenario({ sessionId: 'fake-sess-feedback', silentMs: SILENT_MS }),
        // Turn 3: the auto-resumed turn, which must carry the feedback again.
        successScenario({ result: 'Second turn done.', sessionId: 'fake-sess-feedback' }),
      ],
    });

    // Each scenario entry belongs to an agent invocation, not a logical turn.
    // Disable the default low-high review so this sequence models exactly the
    // initial work and wrap-up, the crashing feedback turn, and its resume.
    expectSuccess(await ctx.lazy(['start', taskId, '--review', 'off', '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    expectSuccess(await ctx.lazy(['unblock', taskId, '--message', FEEDBACK]));
    // Turn 2 is killed by the guard. As above, `wait` is a settle, not an
    // assertion — the recovery is observed from storage.
    await ctx.lazy(['wait', taskId]);

    const redeliveredPrompt = await waitForTurnPrompt(
      ctx,
      prompt => prompt.includes('## Re-delivered feedback — your previous turn was interrupted') &&
        prompt.includes(FEEDBACK),
      RECOVERY_MS,
    );
    await waitForStatus(ctx.root, taskId, ['blocked'], RECOVERY_MS);

    const prompts = await turnPrompts(ctx);
    expect(prompts.length).toBeGreaterThanOrEqual(3);

    const withFeedback = prompts.filter(p => p.includes(FEEDBACK));
    // Once when the human sent it, and once more because the crash consumed
    // nothing. Verbatim both times — the feedback is quoted, never paraphrased.
    expect(withFeedback.length).toBe(2);

    // And the re-delivery is the resumed turn, not a coincidental repeat.
    expect(redeliveredPrompt).toContain(FEEDBACK);

    const turns = await agentTurns(ctx.root, taskId);
    expect(String(turns[turns.length - 1].content)).toContain('Second turn done.');
  }, 240_000);
});
