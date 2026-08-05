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
import { join } from 'path';
import { readFile, writeFile, readdir } from 'fs/promises';
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

/**
 * Set the two watchdog guards for the project, and COMMIT the change.
 *
 * Production defaults are 2h (no-progress) and 60s (wind-down) — far too long
 * for a test. These are the real config keys the daemon reads and puts on the
 * wire, so tightening them exercises the same plumbing a user would.
 *
 * The commit is not optional: the daemon resolves a turn's config from the
 * TASK WORKTREE (loadConfig(root, { cwd: worktreePath })), and the worktree is
 * branched from main. An uncommitted lazy.toml edit would simply never reach
 * the supervisor — the turn would run with the 2h default and the test would
 * time out with no useful signal.
 */
async function setGuards(
  ctx: TestContext,
  guards: { noProgressMs?: number; windDownMs?: number },
): Promise<void> {
  const configPath = join(ctx.root, 'lazy.toml');
  const existing = await readFile(configPath, 'utf-8');
  const lines = ['', '[agent]'];
  if (guards.noProgressMs !== undefined) lines.push(`watchdog_output_timeout_ms = ${guards.noProgressMs}`);
  if (guards.windDownMs !== undefined) lines.push(`wind_down_timeout_ms = ${guards.windDownMs}`);
  await writeFile(configPath, `${existing}\n${lines.join('\n')}\n`);
  ctx.git('add', 'lazy.toml');
  const commit = ctx.git('commit', '-m', 'Tighten watchdog guards for this test');
  if (commit.exitCode !== 0) {
    throw new Error(`Failed to commit watchdog guards: ${commit.stderr}`);
  }
}

/** Resolve a task's storage directory (external_path/tasks/<uuid…>). */
async function taskDir(root: string, shortId: string): Promise<string> {
  const toml = await readFile(join(root, 'lazy.toml'), 'utf-8');
  const m = toml.match(/^external_path\s*=\s*"(.+)"/m);
  const tasksDir = m && m[1] ? join(m[1], 'tasks') : join(root, '.lazy', 'tasks');
  const dirs = await readdir(tasksDir);
  const dir = dirs.find(d => d.startsWith(shortId));
  if (!dir) throw new Error(`No task directory for ${shortId} in ${tasksDir}`);
  return join(tasksDir, dir);
}

/** The interrupt diagnostics the daemon recorded on a task's session. */
async function sessionInterrupt(
  root: string,
  shortId: string,
): Promise<{ interrupt_reason?: string; interrupt_exit_code?: number | null }> {
  const raw = await readFile(join(await taskDir(root, shortId), 'session.json'), 'utf-8');
  return JSON.parse(raw) as { interrupt_reason?: string; interrupt_exit_code?: number | null };
}

/** The agent turns recorded for a task, in order. */
async function agentTurns(root: string, shortId: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(join(await taskDir(root, shortId), 'turns.json'), 'utf-8');
  const parsed = JSON.parse(raw) as { turns: Array<Record<string, unknown>> };
  return parsed.turns.filter(t => t.role === 'agent');
}

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
