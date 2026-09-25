/**
 * E2E: `lazy_ask` / `lazy_review` are ASYNCHRONOUS, have no ceiling, and never
 * strand the task.
 *
 * WHAT BROKE. A review used to be a synchronous RPC with a hardcoded 600s
 * ceiling. Real reviews of large diffs take 330–470s, so the ceiling was barely
 * above the normal cost — and when it hit, the handler tore the reviewer's
 * container down and then kept waiting for the answer that container was going
 * to write. The task sat in `working` with a live claim, no substate, and no
 * turn, until a human ran `lazy stop` (which then recorded a crash turn and
 * left it `interrupted`). Observed four times in one day.
 *
 * WHAT IS PINNED HERE, on the fake-binary seam so the real supervisor really
 * launches a real agent process:
 *   1. Starting returns immediately with the turn the answer will occupy.
 *   2. `lazy wait` returns when that turn settles, and the turn carries the
 *      report / answer.
 *   3. A reviewer that hangs is ended cleanly by `lazy stop`: status restored,
 *      an ending turn recorded at the reserved sequence, no claim left on the
 *      task, no review mailbox left on disk — and no `lazy resume` needed.
 *   4. The claim names the REVIEWER's own run, which is what lets `lazy stop`
 *      kill the right container. (Raise preservation is not asserted here: the
 *      fake agent files none. It falls out of the stop path never touching the
 *      task's raised items — see `stopClaimedTurn`.)
 *   5. A reviewer whose RUN DIES without answering is abandoned by the
 *      reconciler with NO human action at all — the third ending, and the one
 *      closest to the original bug. Afterwards the NEXT review runs.
 *   6. A claim left on a task that reads as PARKED is openable by `lazy stop`,
 *      which routes by the claim rather than by the status.
 *
 * ON THE THIRD ENDING. The other two both have somebody to finish the turn: an
 * answer settles it, a stop ends it. The dead run has nobody — which is exactly
 * the shape that stranded tasks, because the old timeout KILLED the reviewer and
 * then went on waiting for it. So the test kills the reviewer's run out from
 * under the daemon (via the host-process runner's pidfile, the same thing
 * `isRunning` consults) rather than asking lazy to do it: a run that lazy was
 * told about is not the case being pinned.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { existsSync } from 'fs';
import { join } from 'path';
import { readFileSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';
import { successScenario, goSilentScenario } from '../helpers/fake-claude';
import {
  readTurns, readTaskStatus, readTaskJson, writeTaskJson, findFullTaskId,
  writeRaisedItemsFile, taskFilePath, setTaskStatus,
} from '../helpers/storage';

const REVIEW_REPORT = [
  'Verdict: request changes',
  'Security: none found',
  'Data integrity: none found',
].join('\n');

const ASK_ANSWER = 'I dropped the retry because the caller already retries.';

function readTask(ctx: TestContext, shortId: string): Record<string, any> {
  return readTaskJson(ctx.root, shortId);
}

/** The review's own mailbox — a sibling of the task's, named `<taskId>-review`. */
function reviewMailbox(ctx: TestContext, shortId: string): string {
  return join(ctx.protocolBase, `${findFullTaskId(ctx.root, shortId)}-review`);
}

describe('asynchronous review (real supervisor, fake claude)', () => {
  let ctx: TestContext;
  let taskId: string;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
    taskId = await createTask(ctx, 'Review target', 'Do the work');
    await ctx.setClaudeScenario({
      sequence: [successScenario({ result: 'Work done.', sessionId: 'fake-sess-work' })],
    });
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
  }, 120_000);

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: the report lands as a `review` TURN, and waiting for the task is
  // how a caller learns it is there. This is the whole shape the ceiling used to
  // short-circuit: the answer is durable state, not an RPC return value.
  test('a reviewer that answers lands its report as a review turn', async () => {
    await ctx.setClaudeScenario({
      sequence: [successScenario({ result: REVIEW_REPORT, sessionId: 'fake-sess-review' })],
    });

    expectSuccess(await ctx.lazy(['review', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const review = readTurns(ctx.root, taskId).find(
      (t) => t.role === 'agent' && t.turn_type === 'review',
    );
    expect(review).toBeTruthy();
    expect(review?.content ?? '').toContain('request changes');
    expect((review?.review as { verdict?: string } | undefined)?.verdict ?? '')
      .toContain('request changes');

    // INVARIANT: a review is read-only — it leaves the task exactly as it found it.
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
    // And it leaves nothing behind: no claim holding the task, no mailbox.
    expect(readTask(ctx, taskId).in_flight_turn ?? null).toBeNull();
    expect(existsSync(reviewMailbox(ctx, taskId))).toBe(false);
  }, 180_000);

  // INVARIANT (fix-review-timeout-strands-task): a reviewer that never answers
  // does NOT strand the task, and `lazy stop` is the whole exit. Before this,
  // the only exit was a stop that killed the WRONG container (a review runs in
  // its own ephemeral run, never stamped on the session), recorded an
  // "[Agent crashed]" turn, and left the task `interrupted` — from which
  // `lazy resume` then refused on any pending protected file.
  test('a reviewer that hangs is ended cleanly by lazy stop', async () => {
    // Silent for far longer than the test: only an operator can end this.
    await ctx.setClaudeScenario({
      sequence: [goSilentScenario({ sessionId: 'fake-sess-hang', silentMs: 600_000 })],
    });

    expectSuccess(await ctx.lazy(['review', taskId, '--yes', '--no-wait']));

    // The start returned while the reviewer is still running: the task is
    // `working` and carries a claim naming the reviewer's own run.
    await waitFor(() => readTaskStatus(ctx.root, taskId) === 'working', 30_000);
    const claim = readTask(ctx, taskId).in_flight_turn as {
      owner?: string; run_name?: string; turn_sequence?: number;
    } | null;
    expect(claim?.owner).toBe('review');
    // The run on the claim is the REVIEWER's, not the implementer's — that
    // distinction is what made the old stop kill the wrong container.
    expect(claim?.run_name ?? '').toContain('review');
    const reservedSeq = claim!.turn_sequence!;

    // The SIBLING of the ask-stop case below: a claim carrying no captured
    // owner at all (every claim written before that field existed). The stop
    // row must give the SAME answer either way — the person who stopped it.
    // It did not: with no owner the stopper's identity survived, and with one
    // it was replaced, so the same row named two different people depending on
    // a field that has nothing to do with who pressed stop.
    const withoutOwner = readTask(ctx, taskId);
    delete withoutOwner.in_flight_turn.turn_owner_email;
    delete withoutOwner.in_flight_turn.turn_owner_name;
    writeTaskJson(ctx.root, taskId, withoutOwner);

    expectSuccess(await ctx.lazy(['stop', taskId, '--reason', 'taking too long']));

    // Restored, not interrupted, and not left `working`.
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
    // The stop IS the turn's ending, recorded at the reserved sequence so any
    // waiter returns instead of polling for an answer that will never come.
    const ending = readTurns(ctx.root, taskId).find((t) => t.sequence === reservedSeq);
    expect(ending?.role).toBe('agent');
    expect(ending?.turn_type).toBe('review');
    expect(ending?.content ?? '').toContain('Review stopped');
    expect(ending?.content ?? '').toContain('taking too long');
    // Same answer as the ask case below, which runs with an owner captured.
    expect(ending?.actor_email).toBe('test@lazy.test');
    // Nothing left holding the task, and no mailbox for a late response to
    // land in — the two things the old timeout path deliberately left behind
    // "so the reconciler can settle it", which nothing ever did.
    expect(readTask(ctx, taskId).in_flight_turn ?? null).toBeNull();
    expect(existsSync(reviewMailbox(ctx, taskId))).toBe(false);

    // No throwaway unblock needed to get usable again: the task is already
    // back where the review found it, so the next verb just works.
    expectSuccess(await ctx.lazy(['show', taskId]));
  }, 180_000);

  // INVARIANT (fix-review-timeout-strands-task): when the reviewer's RUN dies
  // without writing a response, the RECONCILER ends the turn on its own — no
  // human, no `lazy stop`. With no ceiling left, liveness is the only thing
  // standing between a dead reviewer and a task parked in `working` forever,
  // so this is the ending the whole no-ceiling design rests on.
  test('a reviewer whose run dies is abandoned by the reconciler, with no human action', async () => {
    // Something the reviewer "already filed" before dying. Seeded rather than
    // produced: the fake agent has no MCP channel, and what is being pinned is
    // that abandonment does not touch raised items, whoever wrote them.
    writeRaisedItemsFile(ctx.root, taskId, [{
      id: 'raised-before-death',
      task_id: findFullTaskId(ctx.root, taskId),
      content: 'The retry path swallows errors.',
      blocking: false,
      status: 'open',
      created_at: Date.now(),
    }]);

    await ctx.setClaudeScenario({
      sequence: [goSilentScenario({ sessionId: 'fake-sess-doomed', silentMs: 600_000 })],
    });

    expectSuccess(await ctx.lazy(['review', taskId, '--yes', '--no-wait']));
    await waitFor(() => readTaskStatus(ctx.root, taskId) === 'working', 30_000);

    const claim = readTask(ctx, taskId).in_flight_turn as {
      owner?: string; run_name?: string; turn_sequence?: number;
    } | null;
    expect(claim?.owner).toBe('review');
    const reservedSeq = claim!.turn_sequence!;
    const runName = claim!.run_name!;

    // How many times the agent had been launched before the run died. The
    // abandonment must not add to this (see the no-work-turn assertion below).
    const invocationsBeforeDeath = (await ctx.claudeInvocations()).length;

    // Kill the run behind lazy's back — the container vanishing, the host
    // rebooting, the supervisor being OOM-killed. Nothing writes a response.
    killRun(ctx, runName);

    // Nobody intervenes: the reconciler must notice the run is gone, wait out
    // CLAIMED_RUN_DEATH_GRACE_MS (10s), and end the turn itself.
    await waitFor(() => readTaskStatus(ctx.root, taskId) === 'blocked', 90_000);

    // The ending is RECORDED, at the reserved sequence, so a waiter returns
    // rather than polling for an answer nothing will ever write.
    const ending = readTurns(ctx.root, taskId).find((t) => t.sequence === reservedSeq);
    expect(ending?.role).toBe('agent');
    expect(ending?.turn_type).toBe('review');
    expect(ending?.content ?? '').toContain('[Review abandoned]');
    // It says WHY, naming the run — an abandonment that only said "it is gone"
    // would leave a human with nothing to act on.
    expect(ending?.content ?? '').toContain(runName);
    expect(ending?.content ?? '').toContain("Status restored to 'blocked'");

    // INVARIANT (engineer report, 2026-09-20): A REVIEWER THAT DIED IS A FAILED
    // REVIEW, not a missing one. Every surface that reads reviews keys on the
    // REPORT existing (`isSuccessfulReviewReport`), so an abandonment turn
    // without one left the task reading as simply un-reviewed: absent from
    // Reviews, gating nothing at accept, and for a cluster's child no handback
    // to its driver. It wears the CRASH prefix rather than the never-dispatched
    // one because this reviewer ran — the distinction is what a driver decides
    // "retry" from, and what keeps the catchup's own dedupe off this record.
    const abandonedReport = ending?.review as { verdict?: string } | undefined;
    expect(abandonedReport?.verdict ?? '').toStartWith('FAILED:');
    expect(abandonedReport?.verdict ?? '').toContain(runName);
    expect(abandonedReport?.verdict ?? '').not.toContain('FAILED TO START');

    // Nothing left holding the task, and no mailbox for a late response.
    expect(readTask(ctx, taskId).in_flight_turn ?? null).toBeNull();
    expect(existsSync(reviewMailbox(ctx, taskId))).toBe(false);

    // Raises filed before the death survive: a review that died is still a
    // review that found things.
    const raised = JSON.parse(
      readFileSync(taskFilePath(ctx.root, taskId, 'raised-items.json'), 'utf-8'),
    ) as { raised_items: Array<{ id: string }> };
    expect(raised.raised_items.map((r) => r.id)).toContain('raised-before-death');

    // INVARIANT: abandonment restores and RETURNS — it must never fall through
    // to interrupt + auto-resume. That path launches a WORK turn, which would
    // set the implementer running against a task the review was only visiting,
    // unasked. The agent must not have been launched again at all.
    expect((await ctx.claudeInvocations()).length).toBe(invocationsBeforeDeath);

    // And the task is usable with no `lazy resume` and no throwaway unblock.
    expectSuccess(await ctx.lazy(['show', taskId]));

    // INVARIANT (fix-reviewer-crash-releases-in-flight): THE NEXT REVIEW RUNS.
    // Releasing the record is only half the ending — what the wedge actually
    // cost was every later review, refused with "already has a synchronous turn
    // in flight (review)". So the recovery is pinned by the verb it unblocks,
    // not only by the field it clears.
    await ctx.setClaudeScenario({
      sequence: [successScenario({ result: REVIEW_REPORT, sessionId: 'fake-sess-review-after-death' })],
    });
    expectSuccess(await ctx.lazy(['review', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const later = readTurns(ctx.root, taskId).filter(
      (t) => t.role === 'agent' && t.turn_type === 'review' && t.sequence !== reservedSeq,
    );
    expect(later.length).toBe(1);
    expect((later[0]?.review as { verdict?: string } | undefined)?.verdict ?? '')
      .toContain('request changes');
  }, 240_000);

  // INVARIANT (fix-reviewer-crash-releases-in-flight): `lazy stop` is the
  // operator's door out of a claim on a PARKED task, and the claim outranks the
  // status when it decides that.
  //
  // This is the exact state `teams-raised-cluster-row-one-size` sat in on
  // 2026-09-20 — status `blocked`, a live review claim still on the record —
  // where `lazy_review` refused ("already has a synchronous turn in flight")
  // and `lazy_stop` refused ("blocked, not working") at the same moment, so the
  // only exit was a daemon restart. The status is forced here rather than
  // waited for because the launch race that produced it is fixed at its source
  // (`fix-review-dispatch-waits-for-park`); what must stay true regardless is
  // that the disagreement is openable.
  test('lazy stop clears a stale review claim on a task that reads as parked', async () => {
    await ctx.setClaudeScenario({
      sequence: [goSilentScenario({ sessionId: 'fake-sess-parked-claim', silentMs: 600_000 })],
    });

    expectSuccess(await ctx.lazy(['review', taskId, '--yes', '--no-wait']));
    await waitFor(() => readTaskStatus(ctx.root, taskId) === 'working', 30_000);

    const claim = readTask(ctx, taskId).in_flight_turn as {
      owner?: string; turn_sequence?: number;
    } | null;
    expect(claim?.owner).toBe('review');
    const reservedSeq = claim!.turn_sequence!;

    // Put the task back where the wedge had it: parked, claim still live.
    setTaskStatus(ctx.root, taskId, 'blocked');

    // The refusal that used to be the whole story.
    const refusedReview = await ctx.lazy(['review', taskId, '--yes', '--no-wait']);
    expect(refusedReview.exitCode).not.toBe(0);
    expect(`${refusedReview.stdout}${refusedReview.stderr}`).toContain('in flight');

    // And the door: stop routes by the claim, not by the status.
    const stopped = await ctx.lazy(['stop', taskId, '--reason', 'reviewer is wedged']);
    expectSuccess(stopped);

    // INVARIANT: it says WHICH ending ran. A stopped review is a visitor shown
    // out — the task's own status is restored and no user-stopped gate is set —
    // so printing the work-turn ending ("blocked (will not auto-resume)", "To
    // continue: lazy unblock") would tell the operator they owe an unblock they
    // do not. The daemon reports the ending; the CLI must not re-derive it.
    expect(stopped.stdout).toContain('Review on');
    expect(stopped.stdout).toContain('stopped');
    expect(stopped.stdout).toContain('restored');
    expect(stopped.stdout).not.toContain('will not auto-resume');
    expect(stopped.stdout).not.toContain('lazy unblock');

    expect(readTask(ctx, taskId).in_flight_turn ?? null).toBeNull();
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
    const ending = readTurns(ctx.root, taskId).find((t) => t.sequence === reservedSeq);
    expect(ending?.turn_type).toBe('review');
    expect(ending?.content ?? '').toContain('Review stopped');
    expect(existsSync(reviewMailbox(ctx, taskId))).toBe(false);

    // The point of clearing it: reviewing works again.
    await ctx.setClaudeScenario({
      sequence: [successScenario({ result: REVIEW_REPORT, sessionId: 'fake-sess-review-after-stop' })],
    });
    expectSuccess(await ctx.lazy(['review', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    const later = readTurns(ctx.root, taskId).find(
      (t) => t.role === 'agent' && t.turn_type === 'review' && t.sequence !== reservedSeq,
    );
    expect((later?.review as { verdict?: string } | undefined)?.verdict ?? '')
      .toContain('request changes');
  }, 240_000);
});

describe('asynchronous ask (real supervisor, fake claude)', () => {
  let ctx: TestContext;
  let taskId: string;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
    taskId = await createTask(ctx, 'Ask target', 'Do the work');
    await ctx.setClaudeScenario({
      sequence: [successScenario({ result: 'Work done.', sessionId: 'fake-sess-ask-work' })],
    });
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
  }, 120_000);

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('an agent that answers lands its answer as an ask turn', async () => {
    await ctx.setClaudeScenario({
      sequence: [successScenario({ result: ASK_ANSWER, sessionId: 'fake-sess-ask-work' })],
    });

    expectSuccess(await ctx.lazy(['ask', taskId, '-m', 'why did you drop the retry?']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const answer = readTurns(ctx.root, taskId).find(
      (t) => t.role === 'agent' && t.turn_type === 'ask',
    );
    expect(answer?.content ?? '').toContain(ASK_ANSWER);
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
    expect(readTask(ctx, taskId).in_flight_turn ?? null).toBeNull();
  }, 180_000);

  // Same ending as the review, for the same reason: an ask is a read-only
  // visitor, so stopping one restores the status it found rather than parking
  // the task with the implementer's `user_stopped` flag set.
  test('an agent that hangs on a question is ended cleanly by lazy stop', async () => {
    await ctx.setClaudeScenario({
      sequence: [goSilentScenario({ sessionId: 'fake-sess-ask-hang', silentMs: 600_000 })],
    });

    expectSuccess(await ctx.lazy(['ask', taskId, '-m', 'why?', '--no-wait']));
    await waitFor(() => readTaskStatus(ctx.root, taskId) === 'working', 30_000);

    const claim = readTask(ctx, taskId).in_flight_turn as {
      owner?: string; turn_sequence?: number;
    } | null;
    expect(claim?.owner).toBe('ask');
    const reservedSeq = claim!.turn_sequence!;

    // INVARIANT: the stop row names whoever STOPPED it. Its content is
    // "Stopped by user: …" — a human act — so it belongs to the person who
    // performed it, never to the person whose turn it ends. The claim here is
    // made to carry SOMEBODY ELSE (a one-person install cannot produce that by
    // itself, but a shared host can: the asker and the stopper are routinely
    // different members). Attributing the row to the claim's owner said ivan
    // stopped something he had not touched, on an append-only row.
    const withForeignOwner = readTask(ctx, taskId);
    withForeignOwner.in_flight_turn.turn_owner_email = 'ivan@example.com';
    withForeignOwner.in_flight_turn.turn_owner_name = 'Ivan';
    writeTaskJson(ctx.root, taskId, withForeignOwner);

    expectSuccess(await ctx.lazy(['stop', taskId, '--reason', 'never mind']));

    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
    const ending = readTurns(ctx.root, taskId).find((t) => t.sequence === reservedSeq);
    expect(ending?.turn_type).toBe('ask');
    expect(ending?.content ?? '').toContain('Ask stopped');
    // The stopper — this install's own git identity, which is who ran the CLI.
    expect(ending?.actor_email).toBe('test@lazy.test');
    expect(ending?.actor_email).not.toBe('ivan@example.com');
    expect(readTask(ctx, taskId).in_flight_turn ?? null).toBeNull();
  }, 180_000);

  // The dead-run ending for an ask. Same reconciler path as the review, and it
  // matters for the same reason — but the failure it prevents is worse here,
  // because an ask's restore_status is the status of a task somebody is mid-
  // review on, and a fall-through to auto-resume would set the implementer
  // running on it unasked.
  test('an agent whose run dies mid-question is abandoned by the reconciler', async () => {
    await ctx.setClaudeScenario({
      sequence: [goSilentScenario({ sessionId: 'fake-sess-ask-doomed', silentMs: 600_000 })],
    });

    expectSuccess(await ctx.lazy(['ask', taskId, '-m', 'why?', '--no-wait']));
    await waitFor(() => readTaskStatus(ctx.root, taskId) === 'working', 30_000);

    const claim = readTask(ctx, taskId).in_flight_turn as {
      owner?: string; run_name?: string; turn_sequence?: number;
    } | null;
    expect(claim?.owner).toBe('ask');
    const reservedSeq = claim!.turn_sequence!;
    const invocationsBeforeDeath = (await ctx.claudeInvocations()).length;

    killRun(ctx, claim!.run_name!);

    await waitFor(() => readTaskStatus(ctx.root, taskId) === 'blocked', 90_000);

    const ending = readTurns(ctx.root, taskId).find((t) => t.sequence === reservedSeq);
    expect(ending?.turn_type).toBe('ask');
    expect(ending?.content ?? '').toContain('[Ask abandoned]');
    expect(readTask(ctx, taskId).in_flight_turn ?? null).toBeNull();
    // INVARIANT: restore and RETURN — no work turn launched behind the human's back.
    expect((await ctx.claudeInvocations()).length).toBe(invocationsBeforeDeath);
  }, 180_000);
});

/**
 * Kill a run the way the world kills one: SIGKILL straight to the supervisor
 * process, with lazy never told.
 *
 * The host-process runner answers `isRunning(runName)` from a pidfile under
 * `$HOME/.lazy/run/<run>.json`, so that file is the only place a test can learn
 * which process IS this run. Going through `lazy stop` instead would exercise
 * the stop path, which is a different ending with a different test above.
 *
 * SIGKILL, not SIGTERM: a term handler could still write a response, and a run
 * that answers on its way out is precisely not the case being pinned.
 */
function killRun(ctx: TestContext, runName: string): void {
  if (!ctx.agentHome) throw new Error('killRun needs the private agent HOME (fakeClaude seam)');
  const pidFile = join(ctx.agentHome, '.lazy', 'run', `${runName}.json`);
  if (!existsSync(pidFile)) {
    throw new Error(`No pidfile for run '${runName}' at ${pidFile} — cannot simulate its death`);
  }
  const { pid } = JSON.parse(readFileSync(pidFile, 'utf-8')) as { pid: number };
  process.kill(pid, 'SIGKILL');
}

/** Poll `predicate` until true or `timeoutMs` elapses; throws on timeout. */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await Bun.sleep(200);
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}
