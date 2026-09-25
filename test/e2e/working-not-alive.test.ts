/**
 * E2E: a task that says `working(not-alive)` is one the reconciler acts on.
 *
 * Field report (2026-09-24, a daemon built from a recent main): "at least 4
 * tasks are just sitting there saying working(not-alive) for at least 5 minutes
 * now" — "how can a task be both working and not alive?"
 *
 * `not-alive` is DERIVED (src/utils/working-substate.ts): status `working`, no
 * live run, no response waiting. The design is that the reconciler acts on that
 * state within a tick of the 30s startup grace. These suites pin both halves:
 *
 *   1. The baseline: a work run that dies past the grace is acted on within one
 *      tick. (Green before this change too — it is what proves the plain crash
 *      path is not the gate.)
 *   2. A LIVE reviewer never renders `not-alive`. A review runs in its own run
 *      with its own mailbox, and every read surface probed the WORK run — so on
 *      a task whose work run was gone (a daemon restart reaps them), a reviewer
 *      working for minutes read as dead while the reconciler, correctly, waited
 *      for it. The two now ask one question (src/utils/working-run.ts).
 *   3. A claim whose launch died with the daemon that made it is abandoned. It
 *      has no run name — that is stamped only once the launch returns — and the
 *      reconciler skipped unstamped claims as "still launching" for the whole
 *      24-hour backstop, holding the task in `working(not-alive)`.
 *   4. A review the PREVIOUS daemon launched is stopped and abandoned after a
 *      restart. Neither the restart reaper nor the shutdown sweep sees a
 *      review's own run, so it survived, alive and stamped, pointed at a proxy
 *      that died with the old daemon — the one task the field evidence showed
 *      still stuck after an upgrade and restart.
 *   5. An ask in flight across a restart ends back where the ask found the
 *      task, never `interrupted` (which auto-resumes as an unasked work turn).
 *
 * Real supervisor, fake agent binary: the deaths are real SIGKILLs to real
 * supervisor processes, found through the host-process runner's pidfiles.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { goSilentScenario, successScenario } from '../helpers/fake-claude';
import {
  readTaskStatus, readTaskJson, writeTaskJson, readTurns, readSessionJson,
} from '../helpers/storage';

/** The daemon's startup grace (reconcile.ts getWorkingGracePeriodMs) — real in a test daemon. */
const WORKING_GRACE_MS = 30_000;
/**
 * One reconcile tick (5s) plus the probe and write latency around it. The
 * assertion is "within one tick", not "eventually": a gate that holds a dead
 * run for even two ticks fails here.
 */
const ONE_TICK_BUDGET_MS = 12_000;
/**
 * How long a claim a previous daemon made may survive the new one: one tick and
 * its probes, strictly under the 10s death grace of the ordinary dead-run path
 * (reconcile.ts CLAIMED_RUN_DEATH_GRACE_MS). Measured at ~4.5s.
 */
const PREVIOUS_DAEMON_CLAIM_BUDGET_MS = 10_000;

/** Every live supervisor pid the host-process runner has on record, by run name. */
function runPids(ctx: TestContext): Map<string, number> {
  const dir = join(ctx.agentHome!, '.lazy', 'run');
  const pids = new Map<string, number>();
  if (!existsSync(dir)) return pids;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const { pid } = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as { pid: number };
    pids.set(f.slice(0, -'.json'.length), pid);
  }
  return pids;
}

/** SIGKILL a run behind lazy's back — nothing gets to write a response. */
function killRun(ctx: TestContext, runName: string): void {
  const pid = runPids(ctx).get(runName);
  if (!pid) throw new Error(`No pidfile for run '${runName}' — cannot simulate its death`);
  process.kill(pid, 'SIGKILL');
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`);
}

async function agentPromptCount(ctx: TestContext): Promise<number> {
  return (await ctx.claudeInvocations()).filter(i => i.argv.includes('-p')).length;
}

describe('working(not-alive) is always something the reconciler acts on', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: a work run that dies without answering is acted on within ONE
  // reconcile tick once the startup grace has passed. `not-alive` is a promise
  // that the reconciler is about to do something; a task that says it for
  // minutes means a gate is holding a run nobody will ever finish.
  test('a supervisor killed mid-turn past the startup grace leaves working within one tick', async () => {
    const taskId = await createTask(ctx, 'Dead run is acted on', 'Do the work');
    await ctx.setClaudeScenario({
      sequence: [
        goSilentScenario({ sessionId: 'fake-sess-dead', silentMs: 600_000 }),
        successScenario({ result: 'Finished after the crash.', sessionId: 'fake-sess-dead' }),
      ],
    });
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    await waitFor(async () => (await agentPromptCount(ctx)) > 0, 60_000, 'the agent to be launched');

    // Past the grace, so the only thing left between the death and the
    // reconciler is whatever gate this test exists to catch.
    const launchedAt = Number(readSessionJson(ctx.root, taskId)?.last_interaction_at ?? Date.now());
    await Bun.sleep(Math.max(0, launchedAt + WORKING_GRACE_MS + 1_000 - Date.now()));
    expect(readTaskStatus(ctx.root, taskId)).toBe('working');

    const [runName] = [...runPids(ctx).keys()];
    killRun(ctx, runName!);
    const killedAt = Date.now();

    await waitFor(
      () => readTurns(ctx.root, taskId).some(t => String(t.content).includes('[Agent crashed]')),
      ONE_TICK_BUDGET_MS * 3,
      'the crash to be recorded',
    );
    const elapsed = Date.now() - killedAt;
    expect(elapsed).toBeLessThan(ONE_TICK_BUDGET_MS);
  }, 180_000);

  // INVARIANT: a live reviewer never renders `working(not-alive)`. The run that
  // speaks for a task with a live review claim is the REVIEWER's run, read from
  // the review's own mailbox — the same run the reconciler waits on. Probing the
  // work run instead made a reviewer on a task with no work container (a daemon
  // restart reaps them all) read as dead for its whole run, while nothing was
  // wrong and nothing would, or should, act on it.
  test('a live reviewer on a task whose work run is gone renders as reviewing, never not-alive', async () => {
    const taskId = await createTask(ctx, 'Review renders alive', 'Do the work');
    await ctx.setClaudeScenario({ sequence: [successScenario({ result: 'Work done.', sessionId: 'fake-sess-work' })] });
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');

    // The work run goes away while the task is parked — what the restart
    // reaper does to every warm container on a daemon restart.
    for (const runName of runPids(ctx).keys()) killRun(ctx, runName);

    await ctx.setClaudeScenario({ sequence: [goSilentScenario({ sessionId: 'fake-sess-review', silentMs: 600_000 })] });
    expectSuccess(await ctx.lazy(['review', taskId, '--yes', '--no-wait']));
    await waitFor(
      () => Boolean((readTaskJson(ctx.root, taskId).in_flight_turn as { run_name?: string } | null)?.run_name),
      60_000,
      'the review run to be stamped on its claim',
    );
    await waitFor(async () => (await agentPromptCount(ctx)) >= 2, 60_000, 'the reviewer to be launched');

    const status = await ctx.lazy(['status', taskId]);
    expectSuccess(status);
    expect(status.stdout).toContain('working(agent:reviewing)');
    expect(status.stdout).not.toContain('not-alive');

    const list = await ctx.lazy(['list']);
    expectSuccess(list);
    expect(list.stdout).not.toContain('not-alive');
    expect(list.stdout).not.toContain('[CRASHED]');

    // The JSON a person pastes to diagnose a stuck task carries the same answer,
    // and the claim that produced it (docs/working-not-alive.md).
    const json = await ctx.lazy(['show', taskId, '--json']);
    expectSuccess(json);
    const liveness = JSON.parse(json.stdout).liveness as { working_status: string; in_flight_turn: { owner: string; run_name: string } };
    expect(liveness.working_status).toBe('working(agent:reviewing)');
    expect(liveness.in_flight_turn.owner).toBe('review');
    expect(liveness.in_flight_turn.run_name).toContain('review');

    // And the reconciler agrees it is alive: it is still running, untouched.
    expect(readTaskStatus(ctx.root, taskId)).toBe('working');

    expectSuccess(await ctx.lazy(['stop', taskId, '--yes']));
  }, 180_000);

  // INVARIANT: a claim whose launcher is gone is abandoned like a dead run. The
  // run name is stamped by the process that made the claim, once its launch
  // returns; a daemon that dies mid-launch (an upgrade restarting it during an
  // image build) leaves a claim nothing will ever stamp. Treating "no run name"
  // as "still launching" regardless of WHO was launching held such a task in
  // `working(not-alive)` for the full 24-hour claim backstop.
  test('a review claim left unlaunched by a previous daemon is abandoned, restoring the task', async () => {
    const taskId = await createTask(ctx, 'Orphaned claim', 'Do the work');
    await ctx.setClaudeScenario({ sequence: [successScenario({ result: 'Work done.', sessionId: 'fake-sess-work' })] });
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');

    // What a daemon killed between `claimSyncTurn` and the launch returning
    // leaves behind: a live claim with no run name, the task moved to working.
    // No `claimed_by_process` — like every claim made by a daemon other than
    // this one (a pre-fix record included), which is what marks it foreign.
    const session = readSessionJson(ctx.root, taskId)!;
    const turns = readTurns(ctx.root, taskId);
    const nextSeq = Math.max(...turns.map(t => t.sequence ?? 0)) + 1;
    const claimedAt = Date.now() - 10 * 60_000;
    const task = readTaskJson(ctx.root, taskId);
    writeTaskJson(ctx.root, taskId, {
      ...task,
      status: 'working',
      in_flight_turn: {
        session_id: session.id,
        owner: 'review',
        turn_type: 'review',
        command_id: 'orphaned-review-command',
        turn_sequence: nextSeq + 1,
        human_turn_sequence: nextSeq,
        restore_status: 'blocked',
        started_at: claimedAt,
        expires_at: claimedAt + 24 * 60 * 60_000,
      },
    });
    const orphanedAt = Date.now();

    await waitFor(() => readTaskStatus(ctx.root, taskId) === 'blocked', 60_000, 'the orphaned claim to be abandoned');
    // A previous daemon's claim is abandoned on the FIRST tick that sees it
    // (abandonPreviousGenerationClaim) — no second sighting, no death grace.
    // The bound sits below CLAIMED_RUN_DEATH_GRACE_MS (10s), which the grace
    // path cannot beat, so a regression to it fails here; one tick is 5s.
    expect(Date.now() - orphanedAt).toBeLessThan(PREVIOUS_DAEMON_CLAIM_BUDGET_MS);
    expect(readTaskJson(ctx.root, taskId).in_flight_turn ?? null).toBeNull();

    const ending = readTurns(ctx.root, taskId).find(t => t.sequence === nextSeq + 1);
    expect(ending?.turn_type).toBe('review');
    expect(ending?.content ?? '').toContain('[Review abandoned]');
    expect(ending?.content ?? '').toContain('never started');
  }, 180_000);

  // INVARIANT: a restart ends every turn the previous daemon launched —
  // reviewers included. Each child's proxy address died with the daemon that
  // launched it (src/daemon/generation.ts), so a reviewer left running is
  // alive, stamped, and never going to answer. The restart reaper and the
  // shutdown sweep find runs by the WORK run's name and never see a review's own
  // run, so before this the claim was waited on for the 24-hour backstop — the
  // one shape the field evidence left standing: after an upgrade and restart,
  // three of four not-alive tasks went `interrupted` and one stayed.
  test('a review launched by the previous daemon is stopped and abandoned after a restart', async () => {
    const taskId = await createTask(ctx, 'Review survives restart', 'Do the work');
    await ctx.setClaudeScenario({ sequence: [successScenario({ result: 'Work done.', sessionId: 'fake-sess-work' })] });
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    await ctx.setClaudeScenario({ sequence: [goSilentScenario({ sessionId: 'fake-sess-review', silentMs: 600_000 })] });
    expectSuccess(await ctx.lazy(['review', taskId, '--yes', '--no-wait']));
    await waitFor(
      () => Boolean((readTaskJson(ctx.root, taskId).in_flight_turn as { run_name?: string } | null)?.run_name),
      60_000,
      'the review run to be stamped on its claim',
    );
    const claim = readTaskJson(ctx.root, taskId).in_flight_turn as { run_name: string; turn_sequence: number };
    await waitFor(async () => (await agentPromptCount(ctx)) >= 2, 60_000, 'the reviewer to be launched');
    const reviewerPid = runPids(ctx).get(claim.run_name);
    expect(reviewerPid).toBeGreaterThan(0);

    await ctx.restartDaemon();
    const restartedAt = Date.now();

    await waitFor(() => readTaskStatus(ctx.root, taskId) === 'blocked', 60_000, 'the pre-restart review to be abandoned');
    expect(Date.now() - restartedAt).toBeLessThan(30_000);
    expect(readTaskJson(ctx.root, taskId).in_flight_turn ?? null).toBeNull();

    const ending = readTurns(ctx.root, taskId).find(t => t.sequence === claim.turn_sequence);
    expect(ending?.content ?? '').toContain('[Review abandoned]');
    expect(ending?.content ?? '').toContain('restarted');

    // Not merely relabelled: the reviewer pointed at the dead daemon is gone.
    await waitFor(() => {
      try { process.kill(reviewerPid!, 0); return false; } catch { return true; }
    }, 20_000, 'the stale reviewer process to be stopped');
  }, 240_000);

  // INVARIANT: an ask the previous daemon was running ends in the status the
  // ask found — never `interrupted`, which auto-resume turns into a WORK turn
  // nobody asked for. An ask shares the task's work run, so the restart reaper
  // stops it with the rest; the claim, not the reaper, decides how it ends.
  test('an ask launched by the previous daemon restores the task after a restart, launching no work turn', async () => {
    const taskId = await createTask(ctx, 'Ask survives restart', 'Do the work');
    await ctx.setClaudeScenario({ sequence: [successScenario({ result: 'Work done.', sessionId: 'fake-sess-work' })] });
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    await ctx.setClaudeScenario({ sequence: [goSilentScenario({ sessionId: 'fake-sess-work', silentMs: 600_000 })] });
    expectSuccess(await ctx.lazy(['ask', taskId, '-m', 'Why did you do it that way?', '--no-wait']));
    await waitFor(
      () => Boolean((readTaskJson(ctx.root, taskId).in_flight_turn as { run_name?: string } | null)?.run_name),
      60_000,
      'the ask run to be stamped on its claim',
    );
    const claim = readTaskJson(ctx.root, taskId).in_flight_turn as { turn_sequence: number };
    await waitFor(async () => (await agentPromptCount(ctx)) >= 2, 60_000, 'the ask to reach the agent');
    const promptsBeforeRestart = await agentPromptCount(ctx);

    await ctx.restartDaemon();
    const restartedAt = Date.now();

    await waitFor(() => readTaskJson(ctx.root, taskId).in_flight_turn == null, 60_000, 'the pre-restart ask to be abandoned');
    expect(Date.now() - restartedAt).toBeLessThan(30_000);
    const ending = readTurns(ctx.root, taskId).find(t => t.sequence === claim.turn_sequence);
    expect(ending?.content ?? '').toContain('[Ask abandoned]');

    // Two more ticks: nothing launches a work turn behind the asker's back.
    await Bun.sleep(12_000);
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
    expect(await agentPromptCount(ctx)).toBe(promptsBeforeRestart);
  }, 240_000);
});
