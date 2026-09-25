/**
 * The daemon reviews a task only once its supervisor has handed it back — and a
 * review dispatch that is REFUSED takes nothing from the one that is running.
 *
 * ENGINEER RULE (2026-09-20): the daemon must never act on a task before the
 * supervisor has returned control. The post-turn check, the wrap-up steps and
 * everything else the supervisor runs after the agent's last message are the
 * supervisor's own work.
 *
 * THE INCIDENT (`teams-raised-cluster-row-one-size`, 2026-09-20). The child
 * parked with a standing final while its post-turn check output (`bun install`,
 * typecheck, two binary builds) was being recorded; ~11 seconds later a second
 * review dispatch found the task `working` — a review had started in between —
 * and two things went wrong at once:
 *
 *   1. it recorded a `FAILED TO START` review, which GATES accept and whose only
 *      override is CLI-only, so the child's cluster driver could neither accept
 *      it nor get it reviewed; and
 *   2. its unwind put the status back to `blocked` from a `working` it had never
 *      set — the RUNNING review's `working`. That dropped the task out of the
 *      reconciler's working sweep, so the reviewer's answer was never settled and
 *      its claim suppressed every later retry for 24 hours.
 *
 * THE FAKE BINARY SEAM IS REQUIRED. What is under test is the ORDER of the
 * supervisor's own phases against the daemon's dispatch, and the module mock
 * replaces `launchSupervisorAsync` wholesale — post-turn checks, phase
 * checkpoints and a reviewer that is still running all live downstream of it.
 *
 * WHICH TEST BITES WHICH WAY. The first pins the rule end to end (nothing is
 * dispatched while a post-turn check runs, and exactly one real review lands
 * after the park) — it passed before this fix too, and its job is to keep
 * passing. The second is the regression test: before the fix the refused
 * dispatch reverted the running review's status and deleted its mailbox, and no
 * review turn was ever recorded. The refusal's own accounting — that a lost race
 * records no failed review — is pinned in
 * `test/unit/auto-review-waits-for-park.test.ts`.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import {
  findFullTaskId,
  readTaskStatus,
  readTurns,
  worktreePathFor,
  readTaskJson,
  type StoredTurn,
} from '../helpers/storage';
import {
  sessionStartEvent,
  resultEvent,
  crashScenario,
  type ClaudeScenario,
} from '../helpers/fake-claude';
import { protocolDir as getProtocolDir, reviewProtocolDir } from '../../src/protocol';
import { PRESENTATION_MARKER_FILE } from '../../src/protocol/presentation-marker';
import { getDaemonDir } from '../../src/daemon/paths';
import type { ReviewReport } from '../../src/types';

const TICK_POLL_MS = 200;
/** Generous against the daemon's 5s tick plus a slow check and a slow reviewer. */
const DEADLINE_MS = 120_000;

/** A verdict the closed set accepts, so a successful review is unambiguous. */
const CLEAN_REPORT = JSON.stringify({
  verdict: 'clean',
  security: 'none found',
  data_integrity: 'none found',
  findings: [],
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function daemonLogTail(ctx: TestContext): string {
  try {
    const dir = getDaemonDir(ctx.root);
    const parts: string[] = [];
    for (const name of ['test-startup.log', 'daemon.log']) {
      const logPath = join(dir, name);
      if (!existsSync(logPath)) continue;
      parts.push(`--- ${name} ---\n${readFileSync(logPath, 'utf-8').split('\n').slice(-120).join('\n')}`);
    }
    return parts.length ? parts.join('\n\n') : '(no daemon logs)';
  } catch (err) {
    return `(daemon log unreadable: ${err instanceof Error ? err.message : String(err)})`;
  }
}

async function waitFor<T>(
  read: () => T,
  predicate: (value: T) => boolean,
  what: string,
  logTail: () => string,
): Promise<T> {
  const deadline = Date.now() + DEADLINE_MS;
  for (;;) {
    const value = read();
    if (predicate(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}\n\n--- daemon log tail ---\n${logTail()}`);
    }
    await sleep(TICK_POLL_MS);
  }
}

function reviewTurns(ctx: TestContext, taskId: string): StoredTurn[] {
  return readTurns(ctx.root, taskId).filter((t) => t.role === 'agent' && t.turn_type === 'review');
}

function verdictsOf(turns: StoredTurn[]): string[] {
  return turns.map((t) => (t.review as ReviewReport | undefined)?.verdict ?? '(none)');
}

/** The supervisor's recorded phase for this task, or null when there is none. */
function supervisorPhase(fullId: string): string | null {
  const path = join(getProtocolDir(fullId), 'status.json');
  try {
    return (JSON.parse(readFileSync(path, 'utf-8')) as { phase?: string }).phase ?? null;
  } catch {
    return null;
  }
}

/**
 * ONE scenario for every invocation — the work turn, the wrap-up's present step
 * and the reviewer alike. Deliberately not a `{ sequence: [...] }`: a turn is not
 * one invocation, so counting them to aim a scenario at the reviewer is a guess
 * about how many times the wrap-up resumes the agent, and a wrong guess hands
 * the reviewer's script to the present step (which is how this suite first
 * failed — with no final claim, hence nothing to review).
 *
 * It therefore does all three jobs at once:
 *
 *   - declares final through the handoff file, the only route a scripted binary
 *     has (it cannot call `lazy_final` over MCP);
 *   - writes the presentation marker, without which a human-audience wrap-up's
 *     present step refuses to complete;
 *   - answers with a clean review report, which only a review turn parses.
 *
 * `thinkMs` is how long each invocation takes before answering — the window the
 * second test needs a reviewer to still be running in.
 */
function everyInvocationScenario(
  worktree: string,
  fullId: string,
  thinkMs: number,
): ClaudeScenario {
  return {
    steps: [
      { kind: 'emit', event: sessionStartEvent('sess-1') },
      {
        kind: 'write-file',
        path: join(worktree, '.lazy-task-sandbox', 'turn-handoff.jsonl'),
        content: JSON.stringify({ kind: 'final', content: 'Pencils down.' }) + '\n',
      },
      {
        kind: 'write-file',
        path: join(getProtocolDir(fullId), PRESENTATION_MARKER_FILE),
        content: JSON.stringify({ version: 1, declared_at: new Date().toISOString() }),
      },
      ...(thinkMs > 0 ? [{ kind: 'sleep' as const, ms: thinkMs }] : []),
      { kind: 'emit', event: resultEvent({ result: CLEAN_REPORT, sessionId: 'sess-1' }) },
    ],
  };
}

/**
 * Give the project a post-turn check that takes a while, by uncommenting the
 * template line `lazy init` wrote. Asserted to have changed something: a
 * `.replace()` that matches nothing is a silent no-op, and the whole test would
 * then observe a window that never opened.
 */
function setSlowPostTurnCheck(ctx: TestContext, command: string): void {
  const path = join(ctx.root, 'lazy.toml');
  const before = readFileSync(path, 'utf-8');
  const after = before.replace('# post_turn = "bun test --bail"', `post_turn = "${command}"`);
  if (after === before) {
    throw new Error(
      'could not uncomment [automation] post_turn in the init-produced lazy.toml — ' +
      'the template line this suite edits has changed',
    );
  }
  writeFileSync(path, after);
}

describe('review dispatch waits for the supervisor to hand back', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT (engineer rule, 2026-09-20): the daemon does not act on a task
  // before the supervisor has returned control. A post-turn check runs AFTER the
  // agent's last message and can be a whole build; nothing about the review may
  // start while it does, and the review that is owed must still happen after.
  test('nothing is dispatched while the post-turn check runs, and one review lands after', async () => {
    setSlowPostTurnCheck(ctx, 'sleep 12');

    const taskId = await createTask(ctx, 'Ship the thing', 'Do the work');
    const fullId = findFullTaskId(ctx.root, taskId);
    const worktree = worktreePathFor(ctx.root, taskId);

    await ctx.setClaudeScenario(everyInvocationScenario(worktree, fullId, 0));
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));

    // The window has to be observed, or the assertions inside it prove nothing.
    await waitFor(
      () => supervisorPhase(fullId),
      (phase) => phase === 'post_turn_check',
      'the supervisor to reach post_turn_check',
      () => daemonLogTail(ctx),
    );

    // Inside the window: the task is the supervisor's, and the daemon has not
    // touched it — no review mailbox, no review turn of any kind.
    while (supervisorPhase(fullId) === 'post_turn_check') {
      expect(readTaskStatus(ctx.root, taskId)).toBe('working');
      expect(existsSync(join(reviewProtocolDir(fullId), 'command.json'))).toBe(false);
      expect(reviewTurns(ctx, taskId)).toEqual([]);
      await sleep(TICK_POLL_MS);
    }

    expectSuccess(await ctx.lazy(['wait', taskId]));
    expect(readTurns(ctx.root, taskId).some((t) => t.final)).toBe(true);

    // And after the handback the review the task was owed does run — exactly
    // one, and a real one: a `FAILED TO START` record would mean the daemon
    // dispatched into a task it did not own.
    const reviews = await waitFor(
      () => reviewTurns(ctx, taskId),
      (turns) => turns.length > 0,
      'the automatic review to be recorded',
      () => daemonLogTail(ctx),
    );
    expect(reviews).toHaveLength(1);
    expect(verdictsOf(reviews)[0]).not.toContain('FAILED TO START');
    expect(verdictsOf(reviews)[0]).toContain('clean');
  }, 240_000);

  // INVARIANT: a refused review dispatch unwinds ONLY what it did itself. It
  // never puts the status back from a `working` it did not set, and never
  // deletes the per-task review mailbox it did not write — both belong to the
  // review that IS running. Getting this wrong stranded
  // `teams-raised-cluster-row-one-size`: the running reviewer's answer had
  // nowhere to land and its claim then suppressed every retry.
  test('a refused second review leaves the running one alone', async () => {
    const taskId = await createTask(ctx, 'Ship the thing', 'Do the work');
    const fullId = findFullTaskId(ctx.root, taskId);
    const worktree = worktreePathFor(ctx.root, taskId);

    // Phase 1: let the work turn and the daemon's own automatic review run to
    // completion, fast. A recorded review is what makes the rest of this test
    // deterministic: the catchup's trigger is "a final with no review after it",
    // so once one exists the daemon dispatches nothing more and the only
    // reviews in play are the two this test fires.
    await ctx.setClaudeScenario(everyInvocationScenario(worktree, fullId, 0));
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expect(readTurns(ctx.root, taskId).some((t) => t.final)).toBe(true);

    await waitFor(
      () => reviewTurns(ctx, taskId),
      (turns) => turns.length === 1,
      'the automatic review to be recorded',
      () => daemonLogTail(ctx),
    );
    await waitFor(
      () => readTaskStatus(ctx.root, taskId),
      (status) => status === 'blocked',
      'the task to park again after its automatic review',
      () => daemonLogTail(ctx),
    );

    // Phase 2: a reviewer that takes its time, and TWO reviews fired at once.
    // Both read the task as parked, the task lifecycle lock picks a winner, and
    // the loser discovers the task is `working` only on the authoritative
    // re-read inside that lock — which is exactly the position the daemon's
    // catchup was in during the incident, and the only position from which the
    // old unwind could stomp anything.
    await ctx.setClaudeScenario(everyInvocationScenario(worktree, fullId, 20_000));
    const [a, b] = await Promise.all([
      ctx.lazy(['review', taskId]),
      ctx.lazy(['review', taskId]),
    ]);

    // `lazy review` keeps a blocking UX — it waits for the verdict it asked for
    // — so by the time both calls have returned the winner's review has already
    // run, and its EXIT CODE is the assertion that matters: the loser took
    // nothing from it. Before the fix the loser's unwind put the status back and
    // deleted the per-task review mailbox (both paths name the same directory),
    // so the winner's reviewer wrote its answer into a deleted directory, on a
    // task the reconciler no longer swept — and the winner failed too.
    const outcomes = [a, b];
    const winner = outcomes.filter((r) => r.exitCode === 0);
    const loser = outcomes.filter((r) => r.exitCode !== 0);
    expect(winner).toHaveLength(1);
    expect(loser).toHaveLength(1);
    expect((loser[0]!.stdout + loser[0]!.stderr).toLowerCase()).toMatch(/busy|in flight/);

    const reviews = await waitFor(
      () => reviewTurns(ctx, taskId),
      (turns) => turns.length === 2,
      'the second (manually launched) review to be recorded',
      () => daemonLogTail(ctx),
    );
    expect(verdictsOf(reviews)[1]).toContain('clean');

    // And the task is back where it was: a review visits, it does not own.
    await waitFor(
      () => readTaskStatus(ctx.root, taskId),
      (status) => status === 'blocked',
      'the task to park again after the second review',
      () => daemonLogTail(ctx),
    );
    // And the refused dispatch left no record of its own: a race lost is not a
    // review that failed.
    expect(verdictsOf(reviews).some((v) => v.includes('FAILED TO START'))).toBe(false);
  }, 240_000);

  // INVARIANT (engineer report, 2026-09-20): a reviewer that CRASHES releases
  // the task. The claim must go, a FAILED review turn must name the crash, and
  // the next review must be able to start.
  //
  // The second half of the same incident. After the refused dispatch, the
  // child's real reviewer died on an org spend limit and its claim was never
  // released — so `lazy_review` refused ("already has a synchronous turn in
  // flight") while `lazy_stop` refused ("blocked, not working") and the child
  // sat wedged for hours with a `FAILED TO START` record as its only review.
  // A claim outliving its reviewer is the wedge; nothing else about the task
  // has to be wrong for it to happen.
  test('a reviewer that exits non-zero releases the task, and the next review runs', async () => {
    const taskId = await createTask(ctx, 'Ship the thing', 'Do the work');
    const fullId = findFullTaskId(ctx.root, taskId);
    const worktree = worktreePathFor(ctx.root, taskId);

    // Phase 1 as above: let the work turn and the automatic review complete, so
    // the catchup dispatches nothing more and every review below is this test's.
    await ctx.setClaudeScenario(everyInvocationScenario(worktree, fullId, 0));
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    await waitFor(
      () => reviewTurns(ctx, taskId),
      (turns) => turns.length === 1,
      'the automatic review to be recorded',
      () => daemonLogTail(ctx),
    );
    await waitFor(
      () => readTaskStatus(ctx.root, taskId),
      (status) => status === 'blocked',
      'the task to park after its automatic review',
      () => daemonLogTail(ctx),
    );

    // Phase 2: a reviewer that dies mid-turn. `lazy review` returns non-zero —
    // that is the point — so the assertion is on what it LEFT BEHIND.
    await ctx.setClaudeScenario(crashScenario({ stderr: 'Organization spend limit reached\n' }));
    await ctx.lazy(['review', taskId]);

    const afterCrash = await waitFor(
      () => reviewTurns(ctx, taskId),
      (turns) => turns.length === 2,
      'the crashed reviewer to be recorded as a failed review',
      () => daemonLogTail(ctx),
    );
    // A FAILED review, not a missing one: the report is what makes this a review
    // to the Reviews list, to the accept gate and to a driver's step 5.
    expect(verdictsOf(afterCrash)[1]).toStartWith('FAILED:');
    expect(verdictsOf(afterCrash)[1]).not.toContain('FAILED TO START');

    // The claim is gone and the task is parked — the two halves of "released".
    // Their disagreement is the wedge: a live claim on a task whose status says
    // parked refuses both `lazy review` and (before this task) `lazy stop`.
    await waitFor(
      () => readTaskStatus(ctx.root, taskId),
      (status) => status === 'blocked',
      'the task to park after the crashed review',
      () => daemonLogTail(ctx),
    );
    expect(readTaskJson(ctx.root, taskId).in_flight_turn ?? null).toBeNull();

    // And the proof that "released" means what it says: the next review runs.
    await ctx.setClaudeScenario(everyInvocationScenario(worktree, fullId, 0));
    expectSuccess(await ctx.lazy(['review', taskId]));
    const afterRetry = await waitFor(
      () => reviewTurns(ctx, taskId),
      (turns) => turns.length === 3,
      'the review after the crash to be recorded',
      () => daemonLogTail(ctx),
    );
    expect(verdictsOf(afterRetry)[2]).toContain('clean');
  }, 240_000);
});
