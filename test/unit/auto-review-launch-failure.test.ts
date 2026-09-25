/**
 * A review that could not even START is recorded, and it GATES (final-turn
 * §8.3, as amended by the engineer's second-pass decision).
 *
 * This is the OTHER door into the silent-acceptance shape the pass closes. A
 * crashed reviewer lands as a failed review turn that gates; a dispatch that
 * never launched unwinds completely — no claim, no turn, nothing for a gate to
 * read — so the only thing that can make it visible is a record written by the
 * catchup itself. It now writes the SAME record a crash writes.
 *
 * TWO GROUPS OF TESTS. The first drives the report directly — a dispatch that
 * THREW. The second (`a review that was never DISPATCHED`, at the foot of this
 * file) drives the whole catchup through the real auto-react gates, because a
 * review can also fail to happen without anything throwing: auto-react paused,
 * the daily budget spent, no credential for a system turn. Those skips left no
 * record at all until raised item `a30bbb3d`.
 *
 * Five properties are pinned here, and all of them are failure-mode properties
 * rather than happy-path ones:
 *
 *   1. A failed review TURN is recorded, so the ordinary accept gate refuses
 *      and `lazy accept --allow-review-issues` is the override — the same outcome as every
 *      other way a review fails.
 *   2. That turn is marked as never-dispatched, so the catchup keeps RETRYING:
 *      gating a transient docker blip would otherwise hold a merge until a
 *      human overrode it by hand.
 *   3. The journals land on the TASK's own journal, not only a loop parent's.
 *      A non-loop task with a persistently broken runner otherwise carries the
 *      problem on one review turn and nowhere a person looks first.
 *   4. The dedupe marker is written AFTER the reports it suppresses. Written
 *      first, one storage hiccup silenced the mechanism permanently for that
 *      SHA — and a loop waiting on that child would wait forever, which is
 *      indistinguishable from the bug this exists to close.
 *   5. One record per OBSTACLE, not per final: a stable wall writes nothing on
 *      later ticks, and a DIFFERENT wall supersedes the record, so the newest
 *      one always names what is actually standing.
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { reviewIssuesAwaitingWork } from '../../src/review/success';
import { describeReviewFailureShort, reviewWasNeverDispatched } from '../../src/review/verdict';
import { getWorktreePathForRef, taskRef } from '../../src/task/identity';

const metadata = new Map<string, string>();
const journal: Array<{ taskId: string; content: string; actor: string }> = [];
let turns: any[] = [];

/** Task ids handed to `launchReviewTask`, i.e. the dispatches that happened. */
const launches: string[] = [];

await mockModule(resolve(import.meta.dir, '../../src/daemon/task-lifecycle.ts'), () => ({
  REVIEWABLE_STATUSES: new Set(['blocked']),
  launchReviewTask: async (_root: string, options: any) => {
    launches.push(options.taskId);
  },
}));

/** What `systemTurnBlock` answers for the catchup tests below. */
let systemBlock: string | null = null;
await mockModule(resolve(import.meta.dir, '../../src/daemon/turn-credentials.ts'), () => ({
  systemTurnBlock: async () => systemBlock,
}));

const { reportAutoReviewLaunchFailure, runAutoReviewCatchup } =
  await import('../../src/daemon/auto-review');

afterAll(() => restoreMockedModules());

const NOT_RUN_MARKER_KEY = 'auto_review_launch_failed_sha';

/** The turn carrying the final claim; the review turn must land after it. */
const FINAL_SEQ = 4;

function makeStorage(overrides: Record<string, unknown> = {}): any {
  let nextSequence = FINAL_SEQ + 1;
  return {
    getTaskMetadata: async (taskId: string, key: string) => metadata.get(`${taskId}:${key}`) ?? null,
    updateTaskMetadata: async (taskId: string, key: string, value: string) => {
      metadata.set(`${taskId}:${key}`, value);
    },
    appendJournalEntry: async (taskId: string, content: string, actor: string) => {
      journal.push({ taskId, content, actor });
    },
    getTask: async () => null,
    getSessionByTaskId: async () => ({ id: 'sess-1' }),
    getSessionTurns: async () => turns,
    reserveTurnSequences: async () => nextSequence++,
    createTurn: async (options: any) => {
      turns.push({
        sequence: options.sequence,
        role: options.role,
        turn_type: options.turnType,
        content: options.content,
        review: options.review,
      });
    },
    ...overrides,
  };
}

function task(parentId?: string): any {
  return {
    id: 'child-1',
    code: 'fix-thing',
    goal: 'Fix the thing',
    status: 'blocked',
    type: 'task',
    target: parentId ? { kind: 'task', parentTaskId: parentId } : { kind: 'branch', branch: 'main' },
  };
}

/** The call as the catchup makes it, with the final claim on turn #4. */
async function report(
  storage: any,
  t: any = task(),
  sha = 'abcdef1234567890',
  err: unknown = new Error('docker daemon not running'),
): Promise<void> {
  await reportAutoReviewLaunchFailure(storage, t, sha, FINAL_SEQ, err);
}

beforeEach(() => {
  metadata.clear();
  journal.length = 0;
  launches.length = 0;
  systemBlock = null;
  turns = [{ sequence: FINAL_SEQ, role: 'agent', turn_type: 'work' }];
});

describe('the failed review turn', () => {
  // INVARIANT (engineer decision, second pass): a review that never ran gates
  // accept exactly like one that ran and crashed. "This dispatch might be
  // transient" is not a reason to let unreviewed work merge silently — that is
  // the one shape this whole flow exists to close. The override is the same
  // one every failed review has: `lazy accept --allow-review-issues`.
  test('is recorded on the child, and GATES accept', async () => {
    await report(makeStorage());

    const review = turns.filter((t) => t.turn_type === 'review');
    expect(review).toHaveLength(1);
    expect(review[0].sequence).toBeGreaterThan(FINAL_SEQ);
    expect(review[0].role).toBe('agent');
    expect(review[0].content).toContain('Review not started');
    expect(review[0].content).toContain('docker daemon not running');
    expect(review[0].content).toContain('lazy accept --allow-review-issues');

    // The gate the accept pre-flight reads, called exactly as it calls it.
    const awaiting = reviewIssuesAwaitingWork(turns, []);
    expect(awaiting).not.toBeNull();
    expect(awaiting!.verdict).toBe('unparsed');
  });

  // INVARIANT: the recorded turn says the review never STARTED, and the
  // dispatch side reads that mark to keep retrying. Without it, gating a
  // docker daemon that was restarting for four seconds would hold the merge
  // until a human overrode it by hand.
  test('is marked never-dispatched, so the catchup can retry', async () => {
    await report(makeStorage());
    const review = turns.find((t) => t.turn_type === 'review');
    expect(reviewWasNeverDispatched(review.review)).toBe(true);
  });

  // Once per OBSTACLE, derived from the record itself rather than from a
  // marker: the catchup retries every tick, and a turn per tick would bury the
  // task's own history. The same failure twice is one obstacle.
  test('is written once per obstacle, whatever the dedupe marker says', async () => {
    const storage = makeStorage();
    await report(storage);
    metadata.clear(); // as if the marker write had been lost
    await report(storage);
    expect(turns.filter((t) => t.turn_type === 'review')).toHaveLength(1);
  });

  // A real review that landed later is the answer for this final; a second
  // "could not start" turn after it would re-gate work that HAS been reviewed.
  test('is not written when a review already ran for this final', async () => {
    turns.push({
      sequence: FINAL_SEQ + 1,
      role: 'agent',
      turn_type: 'review',
      review: { verdict: 'clean', security: 'none found', data_integrity: 'none found', findings: [] },
    });
    await report(makeStorage());
    expect(turns.filter((t) => t.turn_type === 'review')).toHaveLength(1);
  });

  // Never throws: this runs inside the catchup's per-task loop, and the
  // journals below must still be written when the turn cannot be.
  test('a storage that cannot record the turn still journals', async () => {
    const storage = makeStorage({
      createTurn: async () => { throw new Error('store down'); },
    });
    await report(storage);
    expect(journal).toHaveLength(1);
  });
});

describe('reportAutoReviewLaunchFailure', () => {
  test('records it on the task itself, even with no loop parent', async () => {
    await report(makeStorage());

    expect(journal).toHaveLength(1);
    expect(journal[0]!.taskId).toBe('child-1');
    expect(journal[0]!.actor).toBe('system');
    expect(journal[0]!.content).toContain('could not START');
    expect(journal[0]!.content).toContain('docker daemon not running');
    expect(journal[0]!.content).toContain('abcdef12');
    // It says plainly that accept IS gated, and names the override — the
    // engineer's second-pass decision, stated where somebody affected by it
    // will read it.
    expect(journal[0]!.content).toContain('Accept IS gated');
    expect(journal[0]!.content).toContain('lazy accept --allow-review-issues');
  });

  test('also tells a LOOP parent, which is waiting on the child', async () => {
    const storage = makeStorage({
      getTask: async (id: string) => (id === 'loop-1' ? { id, code: 'the-loop', type: 'cluster' } : null),
    });
    await report(storage, task('loop-1'), 'abcdef1234567890', new Error('provider unavailable'));

    expect(journal.map((e) => e.taskId)).toEqual(['child-1', 'loop-1']);
    expect(journal[1]!.content).toContain('Auto-review could not START on');
    expect(journal[1]!.content).toContain('review-issues-unaddressed');
  });

  // INVARIANT: the loop's entry names only actions the LOOP can take. Accept is
  // gated by the failed review and the override is CLI/TTY-only (no MCP
  // surface, deliberately — an agent may not overrule a review for a human), so
  // a hand-back offering step 5's full menu sends an unattended loop to spend
  // turns discovering the refusal, or to retry accept forever, while the one
  // action that ends a broken reviewer — telling the operator — goes unfiled.
  test('tells the loop it cannot accept, and what to do instead', async () => {
    const storage = makeStorage({
      getTask: async (id: string) => (id === 'loop-1' ? { id, code: 'the-loop', type: 'cluster' } : null),
    });
    await report(storage, task('loop-1'), 'abcdef1234567890', new Error('provider unavailable'));

    const entry = journal[1]!.content;
    expect(entry).toContain('cannot accept');
    expect(entry).toContain('Do not retry accept');
    // The routes that DO work, and the one that looks like a route but is not.
    expect(entry).toContain('RAISE one blocking item');
    expect(entry).toContain('CLOSE/defer');
    expect(entry).toContain('Unblocking the child changes nothing');
  });

  test('a non-loop parent gets nothing; only the child is told', async () => {
    const storage = makeStorage({
      getTask: async (id: string) => (id === 'plain-1' ? { id, code: 'plain', type: 'task' } : null),
    });
    await report(storage, task('plain-1'), 'abcdef1234567890', new Error('boom'));
    expect(journal.map((e) => e.taskId)).toEqual(['child-1']);
  });

  // Once per FINAL, not once per tick: the catchup retries every tick by
  // design, and a per-tick entry would bury the loop's own notes.
  test('repeats nothing for the same final, and reports again for a new one', async () => {
    const storage = makeStorage();
    await report(storage, task(), 'sha-one', new Error('boom'));
    await report(storage, task(), 'sha-one', new Error('boom'));
    expect(journal).toHaveLength(1);

    await report(storage, task(), 'sha-two', new Error('boom'));
    expect(journal).toHaveLength(2);
  });

  // INVARIANT: the marker is written AFTER the journal it suppresses. Written
  // first, a single failed write disarmed the mechanism for that SHA forever —
  // and a mechanism that silences itself on its first bad day is the bug it was
  // built to prevent, not a degraded version of the fix.
  test('a failed journal write is retried on the next tick, not suppressed', async () => {
    let failNext = true;
    const storage = makeStorage({
      appendJournalEntry: async (taskId: string, content: string, actor: string) => {
        if (failNext) {
          failNext = false;
          throw new Error('store down');
        }
        journal.push({ taskId, content, actor });
      },
    });

    await report(storage, task(), 'sha-one', new Error('boom'));
    expect(journal).toHaveLength(0);
    expect(metadata.get(`child-1:${NOT_RUN_MARKER_KEY}`)).toBeUndefined();

    await report(storage, task(), 'sha-one', new Error('boom'));
    expect(journal).toHaveLength(1);
    // The marker carries the OBSTACLE with the SHA, so a final whose blocker
    // changes journals the new one instead of staying pinned to the first.
    expect(metadata.get(`child-1:${NOT_RUN_MARKER_KEY}`))
      .toBe('sha-one|the reviewer could not be launched');
  });

  // Never throws: this runs inside the catchup's per-task loop, and one task's
  // reporting failure must not stop the others being dispatched.
  test('a storage that fails entirely does not propagate', async () => {
    const storage = makeStorage({
      getTaskMetadata: async () => { throw new Error('store gone'); },
    });
    await report(storage, task(), 'sha-one', new Error('boom'));
  });
});

/**
 * THE OTHER WAY A REVIEW NEVER RUNS: the catchup returns before dispatching.
 *
 * The dispatch-failure record above closed the case where `launchReviewTask`
 * THROWS. `maybeAutoReview` also returns without dispatching on several gates,
 * and three of them stand for hours rather than ticks: no credential for a
 * system turn, the daily auto-react budget spent, and auto-react paused (for
 * the task or the project). Nothing threw on those paths, so nothing was
 * recorded, so `acceptTaskPreflight` had nothing to hold the merge on — work
 * nobody reviewed could be accepted with no sign anywhere that its review never
 * happened, while the journal and the design doc both said an un-run review
 * gates (raised item `a30bbb3d`).
 *
 * These drive the REAL gates through `shouldAutoReact` — a paused flag in
 * metadata, a spent budget file, a backoff timestamp — rather than mocking the
 * decision, because the mapping from "which gate refused" to "is this worth
 * recording" is exactly what regressed.
 */
describe('a review that was never DISPATCHED', () => {
  const FINAL_SHA = 'abcdef1234567890';
  let lazyRoot: string;

  const parkedTask = (): any => ({
    id: 'child-1',
    code: 'fix-thing',
    goal: 'Fix the thing',
    status: 'blocked',
    type: 'task',
    target: { kind: 'branch', branch: 'main' },
    // SEPARATE mode, explicitly: everything in this describe is about the
    // daemon dispatching a reviewer of its own, and since 2026-09-21 that is
    // only what a `separate` task does. The pinned mode is what the catchup
    // reads (never the project default), so the fixture states it.
    metadata: { review_mode: 'separate' },
  });

  function catchupStorage(overrides: Record<string, unknown> = {}): any {
    const t = parkedTask();
    return makeStorage({
      listTasks: async () => [t],
      getTask: async () => t,
      getTaskRaisedItems: async () => [],
      ...overrides,
    });
  }

  /** The review turn the catchup recorded for this final, if any. */
  const recorded = () => turns.find((t) => t.turn_type === 'review');

  beforeEach(async () => {
    lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-auto-review-'));
    // The worktree has to exist and be unlocked, or the catchup skips for a
    // reason that IS transient and deliberately records nothing.
    await mkdir(getWorktreePathForRef(lazyRoot, taskRef(parkedTask())), { recursive: true });
    await mkdir(join(lazyRoot, '.lazy'), { recursive: true });
    turns = [{
      sequence: FINAL_SEQ,
      role: 'agent',
      turn_type: 'work',
      final: { sha: FINAL_SHA, actor: 'agent', at: Date.now() },
    }];
  });

  afterAll(async () => {
    if (lazyRoot) await rm(lazyRoot, { recursive: true, force: true });
  });

  /** Spend today's whole daily budget. */
  async function spendDailyBudget(): Promise<void> {
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    await writeFile(
      join(lazyRoot, '.lazy', 'auto-react-budget.json'),
      JSON.stringify({ date, used: 50, capOverride: 50 }),
    );
  }

  test('the happy path still dispatches, and records nothing', async () => {
    await runAutoReviewCatchup(catchupStorage(), lazyRoot);
    expect(launches).toEqual(['child-1']);
    expect(recorded()).toBeUndefined();
    expect(journal).toHaveLength(0);
  });

  /*
   * INVARIANT: a task NOT in `separate` mode is not owed a review at all, so
   * the catchup returns before anything is recorded — no dispatch, no failed
   * review turn, no journal, and therefore nothing holding accept.
   *
   * This is the one skip that must NOT produce the "nothing has read this work"
   * record the rest of this describe is about. The other skips mean a review
   * lazy intended to run did not; this one means none was ever owed. Recording
   * a gating failed-review turn for it would hold every finished task in a
   * project that had deliberately chosen the fast default, with the only
   * override being CLI-only.
   */
  for (const mode of ['low_high', 'off']) {
    test(`${mode}: no dispatch, and nothing recorded to gate on`, async () => {
      await runAutoReviewCatchup(
        catchupStorage({
          listTasks: async () => [{ ...parkedTask(), metadata: { review_mode: mode } }],
          getTask: async () => ({ ...parkedTask(), metadata: { review_mode: mode } }),
        }),
        lazyRoot,
      );
      expect(launches).toEqual([]);
      expect(recorded()).toBeUndefined();
      expect(journal).toHaveLength(0);
    });
  }

  // INVARIANT (raised item `a30bbb3d`): a review the daemon could not pay for
  // gates exactly like one that crashed. The three skips below and the dispatch
  // failure above produce the SAME record, because from the reader's side they
  // are the same fact: nothing has read this work.
  test('no system credential: recorded, gating, and named', async () => {
    systemBlock = 'No service credential for automated turns: this project runs per-user credentials';
    await runAutoReviewCatchup(catchupStorage(), lazyRoot);

    expect(launches).toEqual([]);
    const review = recorded();
    expect(review).toBeDefined();
    expect(reviewWasNeverDispatched(review.review)).toBe(true);
    expect(review.review.verdict).toContain('No service credential for automated turns');

    // The gate the accept pre-flight reads, called exactly as it calls it.
    const awaiting = reviewIssuesAwaitingWork(turns, []);
    expect(awaiting).not.toBeNull();
    expect(awaiting!.verdict).toBe('unparsed');

    // And the task's own journal says so, with the reason.
    expect(journal).toHaveLength(1);
    expect(journal[0]!.content).toContain('could not START');
    expect(journal[0]!.content).toContain('No service credential');
    expect(journal[0]!.content).toContain('Accept IS gated');
  });

  test('daily budget exhausted: recorded, and it says the budget resets', async () => {
    await spendDailyBudget();
    await runAutoReviewCatchup(catchupStorage(), lazyRoot);

    expect(launches).toEqual([]);
    const review = recorded();
    expect(reviewWasNeverDispatched(review.review)).toBe(true);
    expect(review.review.verdict).toContain('Daily auto-react budget exhausted (50/50)');
    expect(reviewIssuesAwaitingWork(turns, [])).not.toBeNull();
    // Retry makes sense here, and the record says which kind of wait this is.
    expect(review.content).toContain('resets at local midnight');
  });

  // INVARIANT: a pause is not a transient failure, and the record must not
  // promise it will clear on its own — that is a guessed cause in a message
  // whose only job is the cause. It names who has to act instead.
  test('auto-react paused for the task: recorded, and it names the resume', async () => {
    const storage = catchupStorage();
    metadata.set('child-1:auto_react_paused', 'true');
    metadata.set('child-1:auto_react_paused_reason', 'Auto-turn budget exhausted (3/3).');

    await runAutoReviewCatchup(storage, lazyRoot);

    expect(launches).toEqual([]);
    const review = recorded();
    expect(reviewWasNeverDispatched(review.review)).toBe(true);
    expect(review.review.verdict).toContain('paused for this task');
    expect(review.content).toContain('lazy config set auto_react on --task fix-thing');
    expect(review.content).not.toContain('resets at local midnight');
  });

  test('auto-react paused for the project: recorded too', async () => {
    await writeFile(
      join(lazyRoot, '.lazy', 'auto-react-paused.json'),
      JSON.stringify({ paused: true, reason: 'Paused via lazy daemon auto-budget pause' }),
    );
    await runAutoReviewCatchup(catchupStorage(), lazyRoot);

    expect(launches).toEqual([]);
    const review = recorded();
    expect(reviewWasNeverDispatched(review.review)).toBe(true);
    expect(review.review.verdict).toContain('paused for this project');
    expect(review.content).toContain('lazy daemon auto-budget resume');
  });

  // INVARIANT: backoff is NOT recorded. It is seconds-to-minutes long by
  // construction, so the dispatch it delays lands while the same person is
  // still looking at the task; a gate that flickers on and off teaches a reader
  // to ignore the ones that mean something.
  test('backoff records nothing — it clears within a tick or two', async () => {
    metadata.set('child-1:auto_react_count_auto_review', '1');
    metadata.set('child-1:auto_react_last_auto_review', String(Date.now()));

    await runAutoReviewCatchup(catchupStorage(), lazyRoot);

    expect(launches).toEqual([]);
    expect(recorded()).toBeUndefined();
    expect(journal).toHaveLength(0);
  });

  // INVARIANT: the record GATES but does not stop the RETRY — the same property
  // that makes the dispatch-failure record cheap. A skipped review is still
  // owed, so the tick after the gate clears dispatches for real and the fresh
  // review supersedes the record.
  test('the dispatch is retried once the gate clears', async () => {
    const storage = catchupStorage();
    metadata.set('child-1:auto_react_paused', 'true');
    await runAutoReviewCatchup(storage, lazyRoot);
    expect(launches).toEqual([]);
    expect(recorded()).toBeDefined();

    metadata.set('child-1:auto_react_paused', '');
    await runAutoReviewCatchup(storage, lazyRoot);
    expect(launches).toEqual(['child-1']);
  });

  // Once per final, exactly as the dispatch-failure path: the catchup runs
  // every tick and a turn per tick would bury the task's own history.
  test('a repeated skip does not pile up records', async () => {
    const storage = catchupStorage();
    metadata.set('child-1:auto_react_paused', 'true');

    await runAutoReviewCatchup(storage, lazyRoot);
    await runAutoReviewCatchup(storage, lazyRoot);
    await runAutoReviewCatchup(storage, lazyRoot);

    expect(turns.filter((t) => t.turn_type === 'review')).toHaveLength(1);
    expect(journal).toHaveLength(1);
  });

  // INVARIANT: the record names the obstacle that is standing NOW, not the
  // first one that ever stood. Both dedupe guards are keyed on the final's SHA
  // AND the obstacle's headline.
  //
  // Keyed on the SHA alone — which was right while a failed dispatch was the
  // only cause — the credential expiring overnight and being restored at 09:00,
  // by which time the day's budget is gone, left the operator reading a record
  // telling them to configure the credential they had just configured, with no
  // way to learn the real blocker short of the daemon log. The loop-parent
  // journal propagates that same stale reason to a human a second time, since
  // it tells a loop to raise a blocking item "naming the reason above".
  test('a DIFFERENT obstacle supersedes the record; the same one does not', async () => {
    const storage = catchupStorage();
    systemBlock = 'No service credential for automated turns: nothing to bill';
    await runAutoReviewCatchup(storage, lazyRoot);

    // The obstacle is cleared, and a different one has taken over by the time
    // the next tick runs.
    systemBlock = null;
    await spendDailyBudget();
    await runAutoReviewCatchup(storage, lazyRoot);

    const reviews = turns.filter((t) => t.turn_type === 'review');
    expect(reviews).toHaveLength(2);
    // The newest record — the one every gate and the Reviews tab read — names
    // the wall that is actually standing, and no longer the one that was.
    const newest = reviews[reviews.length - 1];
    expect(newest.review.verdict).toContain('daily auto-react budget is spent');
    expect(describeReviewFailureShort(newest.review))
      .toBe('never started — the daily auto-react budget is spent');
    expect(reviewIssuesAwaitingWork(turns, [])!.verdict).toBe('unparsed');

    // The journals follow the same key: one per obstacle, not one per final…
    expect(journal).toHaveLength(2);
    expect(journal[1]!.content).toContain('budget');

    // …and the new obstacle, now stable, still writes nothing on later ticks.
    await runAutoReviewCatchup(storage, lazyRoot);
    expect(turns.filter((t) => t.turn_type === 'review')).toHaveLength(2);
    expect(journal).toHaveLength(2);
  });

  // The detail moves while the obstacle does not: a provider error string that
  // flaps, a budget count that ticks. That is the same wall, and a record per
  // tick would bury the task's own history — which is what the dedupe is for.
  test('a changed DETAIL under the same headline records nothing new', async () => {
    const storage = catchupStorage();
    systemBlock = 'No service credential for automated turns: attempt 1';
    await runAutoReviewCatchup(storage, lazyRoot);
    systemBlock = 'No service credential for automated turns: attempt 2';
    await runAutoReviewCatchup(storage, lazyRoot);

    expect(turns.filter((t) => t.turn_type === 'review')).toHaveLength(1);
    expect(journal).toHaveLength(1);
  });

  // INVARIANT (raised item `a7d229a9`): the boilerplate may not promise a retry
  // the cause's own paragraph has just ruled out. Under a pause the fixed tail
  // "the dispatch is re-tried on every reconcile tick" sat directly beneath
  // "Nothing dispatches while the pause stands" — and the boilerplate is the
  // sentence that reads like the system's own promise, so an operator waits
  // instead of acting, which is the exact wait this record exists to prevent.
  // INVARIANT: a CONFIGURED allowance of zero is not a spent budget, and the
  // record must not tell the operator to wait for it.
  //
  // `isDailyBudgetExhausted` asks `used >= effectiveDailyLimit(...)`. Local
  // midnight resets `used` to 0 and drops any today-only override — but not the
  // configured value, so `0 >= 0` refuses on the first tick of the new day and
  // every tick after it. `auto_react_daily_budget = 0` is a supported setting
  // (the published review-paradigm page names it), so this is the one
  // configuration where "it clears itself at midnight" is both reachable and
  // false — the exact failure the `clearsItself` split exists to prevent.
  test('a configured allowance of ZERO says so, and does not promise midnight', async () => {
    await writeFile(
      join(lazyRoot, 'lazy.toml'),
      '[daemon]\nauto_react_daily_budget = 0\n',
    );
    await runAutoReviewCatchup(catchupStorage(), lazyRoot);

    expect(launches).toEqual([]);
    const review = recorded();
    expect(reviewWasNeverDispatched(review.review)).toBe(true);
    expect(review.review.verdict).toContain('self-started turns are switched off');
    expect(describeReviewFailureShort(review.review))
      .toBe('never started — self-started turns are switched off for this project');

    // The promise that would send them to wait for nothing, in both places it
    // could come from: the cause's own paragraph and the turn's fixed tail.
    expect(review.content).not.toContain('resets at local midnight');
    expect(review.content).not.toContain('re-tried on every reconcile tick');
    // …replaced by what is actually true, and by the two ways out.
    expect(review.content).toContain('resets the COUNT, not the limit');
    expect(review.content).toContain('auto_react_daily_budget');
    expect(review.content).toContain('lazy accept fix-thing --allow-review-issues');
  });

  // A today-only override of zero is the other case, and it DOES clear: the
  // override expires at midnight and the configured allowance comes back. The
  // configured value decides, never the effective one.
  test('a today-only cap of zero still clears at midnight', async () => {
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    await writeFile(
      join(lazyRoot, '.lazy', 'auto-react-budget.json'),
      JSON.stringify({ date, used: 0, capOverride: 0 }),
    );
    await runAutoReviewCatchup(catchupStorage(), lazyRoot);

    const review = recorded();
    expect(review.review.verdict).toContain('the daily auto-react budget is spent');
    expect(review.content).toContain('resets at local midnight');
  });

  test('the turn promises a retry only where one is coming', async () => {
    const storage = catchupStorage();
    metadata.set('child-1:auto_react_paused', 'true');
    await runAutoReviewCatchup(storage, lazyRoot);

    const paused = recorded().content;
    expect(paused).toContain('Nothing dispatches while the pause stands');
    expect(paused).not.toContain('re-tried on every reconcile tick');
    expect(paused).toContain('not before');
    expect(paused).toContain('lazy accept --allow-review-issues');

    // A spent budget genuinely does clear itself, and says so.
    metadata.set('child-1:auto_react_paused', '');
    await spendDailyBudget();
    await runAutoReviewCatchup(storage, lazyRoot);
    const budget = turns.filter((t) => t.turn_type === 'review').pop()!.content;
    expect(budget).toContain('re-tried on every reconcile tick');
  });
});

/*
 * ESCALATING A PARKED `low_high` TASK TO `separate` MUST DISPATCH A REVIEWER.
 *
 * The dispatch dedup skips when an agent review turn sits above the final
 * claim, and since the self-review is recorded as one, escalation dispatched
 * nothing — while the gate, under `always`, started holding accept on that same
 * old self-review. The escalation is a request for a different KIND of review,
 * so an in-session self-review (`review_dispatch: 'self'`) does not count as
 * "this final has been reviewed".
 */
describe('escalating a parked low-high task to separate', () => {
  const FINAL_SHA = 'abcdef1234567890';
  let lazyRoot: string;

  const escalated = (): any => ({
    id: 'child-1',
    code: 'fix-thing',
    goal: 'Fix the thing',
    status: 'blocked',
    type: 'task',
    target: { kind: 'branch', branch: 'main' },
    // The driver escalated it after it parked: the mode is now `separate`,
    // while the turns still carry the self-review its low-high run recorded.
    metadata: { review_mode: 'separate' },
  });

  beforeEach(async () => {
    lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-escalate-'));
    await mkdir(getWorktreePathForRef(lazyRoot, taskRef(escalated())), { recursive: true });
    await mkdir(join(lazyRoot, '.lazy'), { recursive: true });
  });

  afterAll(async () => {
    if (lazyRoot) await rm(lazyRoot, { recursive: true, force: true });
  });

  function storageWith(reviewTurn: Record<string, unknown>): any {
    const t = escalated();
    turns = [
      {
        sequence: FINAL_SEQ,
        role: 'agent',
        turn_type: 'work',
        final: { sha: FINAL_SHA, actor: 'agent', at: Date.now() },
      },
      reviewTurn,
    ];
    return makeStorage({
      listTasks: async () => [t],
      getTask: async () => t,
      getTaskRaisedItems: async () => [],
    });
  }

  const report = {
    verdict: 'needs_work',
    security: 'none found',
    data_integrity: 'none found',
    findings: [{ severity: 'high', category: 'correctness', summary: 'A real bug.' }],
  };

  test('a self-review above the final does not count as reviewed', async () => {
    await runAutoReviewCatchup(
      storageWith({
        sequence: FINAL_SEQ + 1,
        role: 'agent',
        turn_type: 'review',
        review_dispatch: 'self',
        review: report,
      }),
      lazyRoot,
    );
    expect(launches).toEqual(['child-1']);
  });

  // The other half: a review of the KIND being asked for still dedups, or the
  // daemon would re-dispatch a reviewer on every tick forever.
  test('a dispatched reviewer above the final still does', async () => {
    await runAutoReviewCatchup(
      storageWith({
        sequence: FINAL_SEQ + 1,
        role: 'agent',
        turn_type: 'review',
        review_dispatch: 'auto',
        review: report,
      }),
      lazyRoot,
    );
    expect(launches).toEqual([]);
  });
});
