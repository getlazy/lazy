/**
 * The fake-`claude`-binary seam: end-to-end coverage of the REAL supervisor.
 *
 * Every other e2e suite mocks `src/capture/claude.ts` wholesale via Bun
 * `--preload`, which replaces `launchSupervisorAsync` itself. That put an
 * entire layer out of reach of e2e testing: `execWithWatchdog`, the no-progress
 * kill, the wind-down kill, stream-json parsing, and response capture are all
 * downstream of the function the mock replaces. `fix-turn-end-detection` had to
 * assert all of that at the unit layer for exactly this reason.
 *
 * `setupTestLazy({ fakeClaude: true })` moves the seam down to the agent binary
 * (see test/helpers/fake-claude.ts). Nothing in `src/` is mocked here: the
 * daemon launches a real `lazy supervise` subprocess through the host-process
 * runner, which spawns a scriptable fake `claude` from PATH. What these tests
 * assert is therefore the production code path, not a mock's behavior.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import {
  successScenario,
  hangAfterResultScenario,
  goSilentScenario,
  heartbeatOnlyScenario,
  crashScenario,
} from '../helpers/fake-claude';
import { setGuards, agentTurns, sessionInterrupt } from '../helpers/agent-seam';
import { sandboxSuiteSkipped } from '../helpers/sandbox-deps';

describe('agent binary seam (real supervisor, fake claude)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('a scripted stream-json turn flows through the real supervisor into a blocked task', async () => {
    const taskId = await createTask(ctx, 'Fake binary happy path', 'Do the work');
    await ctx.setClaudeScenario(successScenario({
      result: 'Fake agent finished the work.',
      sessionId: 'fake-sess-happy',
      commit: { message: 'Fake agent commit', files: [{ path: 'agent-output.txt', content: 'done\n' }] },
    }));

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const show = await ctx.lazy(['show', taskId]);
    expectOutput(show, 'blocked');

    // The summary the fake agent emitted on its `result` line — parsed by the
    // real ClaudeCodeAgent.parseResponse from the real watchdog's capture.
    const turns = await agentTurns(ctx.root, taskId);
    expect(turns.length).toBeGreaterThan(0);
    expect(String(turns[turns.length - 1].content)).toContain('Fake agent finished the work.');
  }, 90_000);

  // The argv lazy hands the agent is a production contract, not a mock detail:
  // stream-json + --verbose is what makes the activity stream (and therefore
  // both watchdog guards) work at all. Only this seam can observe it e2e.
  test('the supervisor launches the agent with stream-json and --verbose', async () => {
    const taskId = await createTask(ctx, 'Argv contract', 'Do the work');
    await ctx.setClaudeScenario(successScenario({ sessionId: 'fake-sess-argv' }));

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const invocations = await ctx.claudeInvocations();
    const turn = invocations.find(i => i.argv.includes('-p'));
    expect(turn).toBeDefined();
    expect(turn!.argv).toContain('--output-format');
    expect(turn!.argv[turn!.argv.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(turn!.argv).toContain('--verbose');
  }, 90_000);

  // Per-turn launch labels, end to end through the REAL supervisor and
  // reconciler. Only this seam can assert the `model_id` half: the module mock
  // replaces `launchSupervisorAsync`, so it never runs an agent and therefore
  // never learns a concrete model id — it deliberately emits none. Here a real
  // agent process reports one on its result line and it has to survive
  // parseResponse → response → turn.
  //
  // INVARIANT: `model` and `model_id` are DIFFERENT things and neither stands in
  // for the other. `model` is the tier alias the host requested; `model_id` is
  // the dated snapshot that actually answered. An experiment comparing arms
  // needs both — the alias to know which arm was asked for, the id to know what
  // it got.
  test('a turn records the requested model/effort and the concrete model id the agent reported', async () => {
    const taskId = await createTask(ctx, 'Per-turn launch labels', 'Do the work');
    await ctx.setClaudeScenario(successScenario({
      sessionId: 'fake-sess-labels',
      modelId: 'claude-opus-4-6-20260101',
      commit: { message: 'Labelled work', files: [{ path: 'labelled.txt', content: 'done\n' }] },
    }));

    expectSuccess(await ctx.lazy(['start', taskId, '--yes', '--model', 'opus', '--effort', 'high']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const turns = await agentTurns(ctx.root, taskId);
    expect(turns.length).toBeGreaterThan(0);
    const last = turns[turns.length - 1];
    expect(last.model).toBe('opus');
    expect(last.effort).toBe('high');
    expect(last.model_id).toBe('claude-opus-4-6-20260101');
  }, 90_000);

  // The other half of the same invariant: when the agent reports NO model
  // identity, the turn records the alias alone. `model_id` must stay absent
  // rather than being back-filled from `model` — "we only ever knew the tier"
  // has to stay distinguishable from "we know the exact snapshot".
  test('an agent that reports no model identity leaves model_id unset', async () => {
    const taskId = await createTask(ctx, 'No reported model id', 'Do the work');
    await ctx.setClaudeScenario(successScenario({ sessionId: 'fake-sess-no-id' }));

    expectSuccess(await ctx.lazy(['start', taskId, '--yes', '--model', 'opus']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const turns = await agentTurns(ctx.root, taskId);
    const last = turns[turns.length - 1];
    expect(last.model).toBe('opus');
    expect(last.model_id).toBeUndefined();
  }, 90_000);

  // INVARIANT (src/supervisor/watchdog.ts): a wind-down kill is NOT a failed
  // turn. Once the agent's final result is on the wire, the summary is safe;
  // killing the CLI that will not exit costs nothing. Before this seam existed
  // there was no way to assert that end to end — the mock never spawned a
  // process to kill.
  test('agent that emits its result then refuses to exit is killed, and the summary survives', async () => {
    await setGuards(ctx, { windDownMs: 2_000 });

    const taskId = await createTask(ctx, 'Wind-down kill', 'Do the work');
    await ctx.setClaudeScenario(hangAfterResultScenario({
      result: 'Summary emitted before the hang.',
      sessionId: 'fake-sess-winddown',
      hangMs: 120_000,
    }));

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const show = await ctx.lazy(['show', taskId]);
    expectOutput(show, 'blocked');

    const turns = await agentTurns(ctx.root, taskId);
    expect(String(turns[turns.length - 1].content)).toContain('Summary emitted before the hang.');
  }, 120_000);

  // INVARIANT: the no-progress guard kills an agent that has stopped advancing.
  // The turn must fail — there is no summary to keep — rather than hang forever.
  // A watchdog kill is an UNGRACEFUL interruption, so the task lands in
  // `interrupted` (auto-resumable), not `blocked` — see the comment on
  // stopTask in src/daemon/task-lifecycle.ts.
  test('agent that goes silent mid-turn is killed by the no-progress guard', async () => {
    await setGuards(ctx, { noProgressMs: 3_000 });

    const taskId = await createTask(ctx, 'No-progress kill', 'Do the work');
    await ctx.setClaudeScenario(goSilentScenario({ sessionId: 'fake-sess-silent', silentMs: 120_000 }));

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    // `wait` exits nonzero for a turn that ended ungracefully — that IS the
    // signal here, so it is asserted rather than treated as a harness failure.
    const wait = await ctx.lazy(['wait', taskId]);
    expect(wait.exitCode).not.toBe(0);
    expectOutput(wait, 'interrupted');

    const interrupt = await sessionInterrupt(ctx.root, taskId);
    expect(String(interrupt.interrupt_reason)).toMatch(/watchdog|no forward progress/i);
  }, 120_000);

  // INVARIANT (src/agent/activity-stream.ts): a heartbeat proves the PROCESS is
  // alive, not that the TURN is advancing. An agent that only heartbeats — a
  // wedged MCP tool call, empirically observed — must still be killed, or it
  // would be immortal.
  test('an agent that only heartbeats is still killed by the no-progress guard', async () => {
    await setGuards(ctx, { noProgressMs: 3_000 });

    const taskId = await createTask(ctx, 'Heartbeat-only kill', 'Do the work');
    await ctx.setClaudeScenario(heartbeatOnlyScenario({
      sessionId: 'fake-sess-heartbeat',
      beats: 200,
      intervalMs: 500,
    }));

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    const wait = await ctx.lazy(['wait', taskId]);
    expect(wait.exitCode).not.toBe(0);
    expectOutput(wait, 'interrupted');

    const interrupt = await sessionInterrupt(ctx.root, taskId);
    expect(String(interrupt.interrupt_reason)).toMatch(/watchdog|no forward progress/i);
  }, 120_000);

  // INVARIANT (src/supervisor/watchdog.ts, KILL_GRACE_MS): SIGTERM is a request,
  // not a guarantee. An agent that swallows SIGTERM must still die — the
  // watchdog escalates to SIGKILL after the grace window. The module mock could
  // not express this at all: there was no process to signal.
  test('an agent that swallows SIGTERM is escalated to SIGKILL', async () => {
    await setGuards(ctx, { windDownMs: 2_000 });

    const taskId = await createTask(ctx, 'SIGKILL escalation', 'Do the work');
    const scenario = hangAfterResultScenario({
      result: 'Summary emitted before the stubborn hang.',
      sessionId: 'fake-sess-sigkill',
      hangMs: 120_000,
    });
    await ctx.setClaudeScenario({ ...scenario, ignoreSigterm: true });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    expectOutput(await ctx.lazy(['show', taskId]), 'blocked');
    const turns = await agentTurns(ctx.root, taskId);
    expect(String(turns[turns.length - 1].content)).toContain('Summary emitted before the stubborn hang.');
  }, 120_000);

  // INVARIANT (src/supervisor/work.ts + retry-policy.ts): a non-fatal agent
  // crash is retried inside the same turn, on the backoff ladder — the task does
  // not fail and does not need a human. The module mock replaced the loop that
  // does this, so the retry ladder had never been exercised e2e; here a real
  // process really exits 1 and the real supervisor relaunches it.
  //
  // NOTE: a fake that crashes on EVERY invocation would spin forever (a
  // transient class never stops retrying, by design) — the sequence makes the
  // second attempt succeed so the assertion is about recovery, not about a cap.
  test('a crashed agent is retried within the turn and the turn then succeeds', async () => {
    const taskId = await createTask(ctx, 'Crash then recover', 'Do the work');
    await ctx.setClaudeScenario({
      sequence: [
        crashScenario({ stderr: 'API Error: 500 internal server error\n', exitCode: 1 }),
        successScenario({ result: 'Recovered after the crash.', sessionId: 'fake-sess-retry' }),
      ],
    });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    expectOutput(await ctx.lazy(['show', taskId]), 'blocked');
    const turnInvocations = (await ctx.claudeInvocations()).filter(i => i.argv.includes('-p'));
    expect(turnInvocations.length).toBeGreaterThanOrEqual(2);

    const turns = await agentTurns(ctx.root, taskId);
    expect(String(turns[turns.length - 1].content)).toContain('Recovered after the crash.');
  }, 150_000);

  // Session continuity is a real argv contract: turn 2 must resume turn 1's
  // session, using the id the agent itself reported on its `result` line. Only
  // this seam can observe both halves — the id going out and coming back.
  test('a second turn resumes the session id the agent reported', async () => {
    const taskId = await createTask(ctx, 'Resume contract', 'Do the work');
    await ctx.setClaudeScenario({
      sequence: [
        successScenario({ result: 'First turn done.', sessionId: 'fake-sess-turn-1' }),
        successScenario({ result: 'Second turn done.', sessionId: 'fake-sess-turn-1' }),
      ],
    });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    expectSuccess(await ctx.lazy(['unblock', taskId, '--message', 'keep going']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const turnInvocations = (await ctx.claudeInvocations()).filter(i => i.argv.includes('-p'));
    expect(turnInvocations.length).toBeGreaterThanOrEqual(2);
    const second = turnInvocations[turnInvocations.length - 1];
    expect(second.argv).toContain('--resume');
    expect(second.argv[second.argv.indexOf('--resume') + 1]).toBe('fake-sess-turn-1');

    const turns = await agentTurns(ctx.root, taskId);
    expect(String(turns[turns.length - 1].content)).toContain('Second turn done.');
  }, 150_000);
});

/**
 * The same seam under the PRODUCTION host posture.
 *
 * Every test above runs with `permission_mode = "bypass"`, so that a missing
 * sandbox dependency can never masquerade as a watchdog failure. That leaves
 * the posture users actually get — `"sandbox"`, the config default — untested
 * end to end on this seam: nothing proved that a real turn survives being run
 * inside the sandbox, or that the settings reaching the agent are the ones
 * host-sandbox.ts intends.
 *
 * Linux prerequisite: `bwrap` and `socat` on PATH. `failIfUnavailable: true` is
 * deliberate — the sandbox failing is a hard error, never a silent fallback to
 * an unsandboxed agent — so on a box without them `lazy start` refuses outright.
 * That refusal is correct product behavior, but as a TEST result it is noise:
 * it reports a missing package in the language of a sandbox failure, which
 * reads like a supervisor regression. The block is therefore gated on the deps
 * being present, and prints one line when it skips (never silently green — the
 * posture it covers is the production default).
 */
describe.skipIf(sandboxSuiteSkipped('agent binary seam under the sandbox posture'))('agent binary seam under the sandbox posture', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true, hostPermissionMode: 'sandbox' });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT (src/runner/host-sandbox.ts): under `permission_mode = "sandbox"`
  // the OS sandbox is the SOLE hard boundary. The three settings asserted here
  // are what make that true — enabled, no silent fallback when it is
  // unavailable, and no per-command escape hatch. Asserting them on the argv
  // the agent actually received is the only way to catch a posture that was
  // computed correctly and then dropped somewhere on the way to the process.
  test('a turn runs to completion inside the sandbox, with the sandbox settings the agent gets', async () => {
    const taskId = await createTask(ctx, 'Sandboxed turn', 'Do the work');
    await ctx.setClaudeScenario(successScenario({
      result: 'Sandboxed turn done.',
      sessionId: 'fake-sess-sandbox',
    }));

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    expectOutput(await ctx.lazy(['show', taskId]), 'blocked');
    const turns = await agentTurns(ctx.root, taskId);
    expect(String(turns[turns.length - 1].content)).toContain('Sandboxed turn done.');

    const turn = (await ctx.claudeInvocations()).find(i => i.argv.includes('-p'));
    expect(turn).toBeDefined();
    const settingsIndex = turn!.argv.indexOf('--settings');
    expect(settingsIndex).toBeGreaterThanOrEqual(0);

    const settings = JSON.parse(turn!.argv[settingsIndex + 1]) as {
      sandbox: { enabled: boolean; failIfUnavailable: boolean; allowUnsandboxedCommands: boolean };
    };
    expect(settings.sandbox.enabled).toBe(true);
    expect(settings.sandbox.failIfUnavailable).toBe(true);
    expect(settings.sandbox.allowUnsandboxedCommands).toBe(false);
  }, 90_000);
});
