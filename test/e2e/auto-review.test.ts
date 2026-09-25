/**
 * Auto-review on every final (final-turn design §8, slice 5) — the REAL
 * dispatch path: the daemon's reconcile tick finds a task with a settled
 * final that no review turn follows, and starts one itself, nobody asking.
 *
 * The whole suite runs the production loop end to end:
 *
 *   agent work turn declares final (the mock's flag file)
 *     → daemon tick dispatches a review turn (`launchReviewTask`, actor system)
 *     → the review settles, `settleAutoReviewRound` does the §8.1 accounting
 *     → clean: reset, nothing else; non-blocking: round + auto-fix turn
 *       (whose re-declaration fires the next round); blocking: park at once;
 *       at the cap: park, and a loop child is journalled back to its loop.
 *
 * The mock's static `LAZY_MOCK_CLAUDE_RESPONSE` is read as the turn's `result`
 * TEXT by `getMockResponse()` — so the review report rides INSIDE it, as a
 * JSON string in the `result` field, which `parseReviewReport` then parses off
 * the recorded review turn.
 *
 * FINDINGS ARE FIX FEEDBACK, NOT RAISES. A `needs_work` review's findings stay
 * on the review turn and are delivered to the implementer as its next turn's
 * brief; no Raised row is created for them, which is what these assertions
 * check (`readRaisedItems` stays empty on the needs_work path). The verdict is
 * a closed set — `clean` / `needs_work` / `needs_human` — and anything else is
 * a FAILED review that gates accept like `needs_work`.
 *
 * Two gates the suite must not trip by accident, both edited into the
 * init-produced lazy.toml (never a second `[daemon]` table — a redefinition
 * error): `auto_react_backoff = "none"` (the default exponential puts a
 * task's SECOND auto-review 60s away — a suite-killer) and
 * `max_auto_turns = 8` (default 3 would park a task mid-cap-cycle).
 *
 * Timing: the dispatch is the daemon's tick (default 5s; `setupTestLazy`
 * spawns `daemon start --foreground` with no interval option, and the
 * `runReconcile` test seam runs only `reconcileTasks` — it cannot reach the
 * auto-review phase). Every wait polls the store against a generous deadline
 * instead of sleeping a fixed number of ticks.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess, expectOutput, extractTaskId } from '../helpers/assertions';
import {
  findFullTaskId,
  readJournal,
  readRaisedItems,
  readTaskJson,
  readTaskStatus,
  readTurns,
  type StoredTurn,
} from '../helpers/storage';
import { getDaemonDir } from '../../src/daemon/paths';
import type { ReviewReport } from '../../src/types';

// --- The three reports the mock reviewer produces ---

/**
 * `needs_work` — findings the fixer can address. They become the next turn's
 * brief and create NO Raise, however severe: a severity field is not a gate.
 */
const NEEDS_WORK_REPORT = {
  verdict: 'needs_work',
  security: 'none found',
  data_integrity: 'none found',
  findings: [
    {
      severity: 'critical',
      category: 'correctness',
      summary: 'The retry path swallows malformed rows instead of surfacing them.',
    },
  ],
};

/**
 * `needs_human` — the reviewer says no version of this can ship. The rounds end
 * on it whatever the counter says, because no fix turn can decide it.
 */
const NEEDS_HUMAN_REPORT = {
  verdict: 'needs_human',
  security: 'none found',
  data_integrity: 'none found',
  findings: [
    {
      severity: 'critical',
      category: 'correctness',
      summary: 'The goal asks for a migration that cannot preserve the existing rows.',
    },
  ],
};

/** A verdict outside the closed set — a FAILED review, which gates like needs_work. */
const UNPARSABLE_VERDICT_REPORT = {
  verdict: 'approve with minor nits',
  security: 'none found',
  data_integrity: 'none found',
  findings: [],
};

/** Nothing at all — the clean cycle that resets the counter. */
const CLEAN_REPORT = {
  verdict: 'clean',
  security: 'none found',
  data_integrity: 'none found',
  findings: [],
};

// --- Harness ---

const TICK_POLL_MS = 1_000;
/** Generous against the 5s tick: dispatch + settle can straddle several. */
const TURN_DEADLINE_MS = 75_000;
/** Long enough that two extra reconcile ticks have definitely run. */
const DEDUP_QUIET_MS = 12_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Relax the auto-react gates the suite's daemon turns would otherwise trip.
 * Keys are edited INSIDE the init-produced `[daemon]` section (uncommenting
 * the template lines) — never appended at the end of the file, where they
 * would land in the last section and mean something else entirely. Asserts
 * the replace changed something: a `.replace()` that matches nothing is a
 * silent no-op and the suite would run under the wrong budget.
 */
function relaxAutoReactBudget(ctx: TestContext): void {
  const path = join(ctx.root, 'lazy.toml');
  const before = readFileSync(path, 'utf-8');
  const after = before
    .replace('# auto_react_backoff = "exponential"', 'auto_react_backoff = "none"')
    .replace('# max_auto_turns = 3', 'max_auto_turns = 8');
  if (after === before) {
    throw new Error(
      'could not uncomment the [daemon] auto-react keys in the init-produced lazy.toml — ' +
      'the template lines this suite edits have changed',
    );
  }
  writeFileSync(path, after);
}

/**
 * Put the project in `separate` review mode — the mode this whole suite is
 * about, and no longer the default (engineer decision 2026-09-21: the default
 * is `low_high`, which runs no reviewer of its own at all).
 *
 * `autoFix` is the `[review] auto_fix` switch, off by default: a needs_work
 * review parks with its findings instead of starting a fix round unasked. The
 * round-cap arm below turns it ON, because the rounds are what it tests.
 *
 * Edits the keys INSIDE the init-produced `[review]` section (uncommenting the
 * template lines) and asserts the replace changed something — a `.replace()`
 * that matches nothing is a silent no-op, and the suite would run under a mode
 * it did not choose.
 */
function setSeparateReview(ctx: TestContext, opts: { autoFix?: boolean } = {}): void {
  const path = join(ctx.root, 'lazy.toml');
  const before = readFileSync(path, 'utf-8');
  let after = before.replace('# mode = "low_high"', 'mode = "separate"');
  if (opts.autoFix) after = after.replace('# auto_fix = false', 'auto_fix = true');
  if (after === before) {
    throw new Error(
      'could not uncomment the [review] keys in the init-produced lazy.toml — ' +
      'the template lines this suite edits have changed',
    );
  }
  writeFileSync(path, after);
}

/**
 * A suite whose every agent turn is served by ONE static report: the mock
 * reads `parsed.result` out of `LAZY_MOCK_CLAUDE_RESPONSE` as the turn's
 * result text, so the review report rides inside it as a JSON string. Work
 * turns record the same text as their content, which is harmless — only
 * review turns parse it.
 */
function reviewerResponse(report: typeof NEEDS_WORK_REPORT | typeof CLEAN_REPORT): string {
  return JSON.stringify({ result: JSON.stringify(report), session_id: 'mock-reviewer' });
}

/**
 * The parsed report on a stored review turn. `StoredTurn` has an index
 * signature, so the field arrives as `unknown` — named here once rather than
 * cast at every assertion.
 */
function reviewOf(turn: StoredTurn | undefined): ReviewReport | undefined {
  return turn?.review as ReviewReport | undefined;
}

function agentTurns(ctx: TestContext, taskId: string): StoredTurn[] {
  return readTurns(ctx.root, taskId).filter((t) => t.role === 'agent');
}

/**
 * Poll the task's turns until the predicate holds. Everything under test
 * happens on the daemon's 5s reconcile tick, so polling is the only honest
 * wait; the failure names the turns seen so far, or the timeout is just a
 * number.
 */
/**
 * The daemon's captured stdout/stderr — the only window into why the settle
 * side did (or did not) run: dispatch refusals, round accounting and
 * auto-fix launch failures all log there.
 */
function daemonLogTail(ctx: TestContext): string {
  try {
    const dir = getDaemonDir(ctx.root);
    const parts: string[] = [];
    for (const name of ['test-startup.log', 'daemon.log']) {
      const logPath = join(dir, name);
      if (!existsSync(logPath)) continue;
      const lines = readFileSync(logPath, 'utf-8').split('\n');
      parts.push(`--- ${name} ---\n${lines.slice(-120).join('\n')}`);
    }
    return parts.length ? parts.join('\n\n') : '(no daemon logs)';
  } catch (err) {
    return `(daemon log unreadable: ${err instanceof Error ? err.message : String(err)})`;
  }
}

async function waitForAgentTurns(
  ctx: TestContext,
  taskId: string,
  predicate: (turns: StoredTurn[]) => boolean,
  deadlineMs = TURN_DEADLINE_MS,
): Promise<StoredTurn[]> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const turns = agentTurns(ctx, taskId);
    if (predicate(turns)) return turns;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for agent turns on ${taskId}; saw:\n` +
        turns
          .map(
            (t) =>
              `  #${t.sequence ?? '?'} ${t.turn_type ?? 'work'} actor=${t.actor ?? '?'} ` +
              `final=${t.final ? 'yes' : 'no'} review=${t.review ? 'yes' : 'no'}`,
          )
          .join('\n') +
        `\n\n--- daemon log tail ---\n${daemonLogTail(ctx)}`,
      );
    }
    await sleep(TICK_POLL_MS);
  }
}

/** Poll any condition that lives in the store (raises, journal, metadata). */
async function waitFor<T>(
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  what: string,
  logTail?: () => string,
  deadlineMs = TURN_DEADLINE_MS,
): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}${logTail ? `\n\n--- daemon log tail ---\n${logTail()}` : ''}`);
    }
    await sleep(TICK_POLL_MS);
  }
}

/** A started task whose turn declared final via the mock's flag file. */
async function startedFinalTask(
  ctx: TestContext,
  goal: string,
  finalFlagPath: string,
): Promise<string> {
  const taskId = await createTask(ctx, goal, 'Do the work');
  // Existence is the whole signal; the contents are the claim's note.
  writeFileSync(finalFlagPath, 'Declaring this work done.');
  expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
  expectSuccess(await ctx.lazy(['wait', taskId]));
  return taskId;
}

/** Turn counts must survive extra reconcile ticks — the dedup, asserted. */
async function assertTurnsStable(
  ctx: TestContext,
  taskId: string,
  turns: StoredTurn[],
): Promise<void> {
  await sleep(DEDUP_QUIET_MS);
  const after = agentTurns(ctx, taskId);
  expect(after.length).toBe(turns.length);
  expect(after.map((t) => t.sequence)).toEqual(turns.map((t) => t.sequence));
}

function roundCounter(root: string, fullId: string): number {
  const raw = readTaskJson(root, fullId).metadata?.final_review_round;
  return raw ? parseInt(raw, 10) || 0 : 0;
}

// === The suite ===

describe('auto-review on every final (final-turn design §8)', () => {
  let ctx: TestContext;
  /** Existence makes the NEXT mocked turn declare final; contents are the note. */
  let finalFlag: string;

  describe('the clean cycle: reviewed once, nothing parks, accept proceeds', () => {
    beforeEach(async () => {
      finalFlag = join(
        process.env.TMPDIR ?? '/tmp',
        `lazy-auto-review-final-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      ctx = await setupTestLazy({
        withDaemon: true,
        daemonEnv: {
          LAZY_MOCK_SHOULD_COMMIT: '1',
          LAZY_MOCK_FINAL: finalFlag,
          LAZY_MOCK_CLAUDE_RESPONSE: reviewerResponse(CLEAN_REPORT),
        },
      });
      relaxAutoReactBudget(ctx);
      setSeparateReview(ctx);
    });

    afterEach(async () => {
      rmSync(finalFlag, { force: true });
      await ctx.cleanup();
    });

    test('the daemon reviews a settled final unprompted, and a clean review gates nothing', async () => {
      const taskId = await startedFinalTask(ctx, 'Ship the tidy-up', finalFlag);
      // The standing final is turn 1's. The flag file must NOT outlive it, or
      // the mocked REVIEW turn would declare final itself and re-arm the
      // dispatch forever (a reviewer never declares final; only the mock
      // does, and only while the file exists).
      rmSync(finalFlag, { force: true });

      // The daemon tick starts a review nobody asked for.
      const turns = await waitForAgentTurns(ctx, taskId, (t) => t.some((x) => x.turn_type === 'review'));
      const review = turns.find((x) => x.turn_type === 'review')!;
      expect(review.sequence).toBeGreaterThan(1);

      // Clean report → the counter resets (stays 0), no auto-fix turn, and
      // the dispatch dedup never re-reviews the same final: the tick can run
      // as often as it likes, the turn record does not grow.
      const fullId = findFullTaskId(ctx.root, taskId);
      expect(roundCounter(ctx.root, fullId)).toBe(0);
      expect(readRaisedItems(ctx.root, fullId)).toEqual([]);
      await assertTurnsStable(ctx, taskId, turns);

      // Nothing gates accept: the review found nothing to address.
      expectSuccess(await ctx.lazy(['accept', taskId, '--yes']));
      const show = await ctx.lazy(['show', taskId]);
      expectOutput(show, 'complete');
    }, 150_000);
  });

  describe('the two-round cap with findings (no Raises anywhere)', () => {
    beforeEach(async () => {
      finalFlag = join(
        process.env.TMPDIR ?? '/tmp',
        `lazy-auto-review-final-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      ctx = await setupTestLazy({
        withDaemon: true,
        daemonEnv: {
          LAZY_MOCK_SHOULD_COMMIT: '1',
          // KEPT for the whole test: the auto-fix turn must re-declare final
          // from it, which is what fires round 2's dispatch. The review
          // turns also carry the claim (the mock declares on every turn while
          // the file exists) — harmless, the cap guard parks regardless.
          LAZY_MOCK_FINAL: finalFlag,
          LAZY_MOCK_CLAUDE_RESPONSE: reviewerResponse(NEEDS_WORK_REPORT),
        },
      });
      relaxAutoReactBudget(ctx);
      // The rounds ARE what this arm tests, so it opts into auto-fix; the
      // default (off) is covered by its own arm at the bottom of the suite.
      setSeparateReview(ctx, { autoFix: true });
    });

    afterEach(async () => {
      rmSync(finalFlag, { force: true });
      await ctx.cleanup();
    });

    test('round 1 runs an auto-fix turn, round 2 parks at the cap, and accept stays gated', async () => {
      const taskId = await startedFinalTask(ctx, 'Fix the retry path', finalFlag);
      const fullId = findFullTaskId(ctx.root, taskId);

      // Round 1: the review records its findings on the review turn…
      const withRound1 = await waitForAgentTurns(ctx, taskId, (t) => t.some((x) => x.turn_type === 'review'));
      const review1 = withRound1.find((x) => x.turn_type === 'review')!;
      expect(reviewOf(review1)?.verdict).toBe('needs_work');
      expect(reviewOf(review1)?.findings).toHaveLength(1);

      // …the auto-fix turn runs (a work turn after the review, re-declaring
      // final — the mock's flag file is still there)…
      const withFix = await waitForAgentTurns(
        ctx,
        taskId,
        (t) => t.some((x) => (x.turn_type ?? 'work') === 'work' && (x.sequence ?? 0) > (review1.sequence ?? 0)),
      );
      const fixTurn = withFix.find(
        (x) => (x.turn_type ?? 'work') === 'work' && (x.sequence ?? 0) > (review1.sequence ?? 0),
      )!;

      // …and round 2 reviews the same report, then parks: the counter passes
      // the cap, so NO third review is ever dispatched.
      const parked = await waitForAgentTurns(
        ctx,
        taskId,
        (t) => t.filter((x) => x.turn_type === 'review').length >= 2,
      );
      const review2 = parked.filter((x) => x.turn_type === 'review')[1]!;
      expect((review2.sequence ?? 0)).toBeGreaterThan((fixTurn.sequence ?? 0));

      await waitFor(
        () => roundCounter(ctx.root, fullId),
        (n) => n >= 2,
        'the round counter to reach the cap',
        () => daemonLogTail(ctx),
      );
      expect(roundCounter(ctx.root, fullId)).toBe(2);

      // INVARIANT: NOT ONE RAISE was created, at any point in the cycle. The
      // findings are fix feedback — they live on the review turn and reach the
      // fixer as its next brief. Filing them as Raises cost two dead turns per
      // round (the fixer's `lazy_final` refused by the reviewer's own blocking
      // raise) and left a human triaging items for defects already fixed.
      expect(readRaisedItems(ctx.root, fullId)).toEqual([]);

      // Parked WITH its findings outstanding, on the review turn.
      expect(reviewOf(review2)?.findings).toHaveLength(1);
      expect(await ctx.lazy(['show', taskId])).toBeTruthy(); // stays readable
      expect(readTaskStatus(ctx.root, fullId)).toBe('blocked');

      await assertTurnsStable(ctx, taskId, parked);

      // The accept gate holds until the findings are addressed — the park is
      // not silence, it is a hand-off.
      const refused = await ctx.lazy(['accept', taskId, '--yes']);
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stdout + refused.stderr).toContain('unaddressed issue');
    }, 180_000);

    test('the auto-fix turn is launched with the findings themselves as its brief', async () => {
      const taskId = await startedFinalTask(ctx, 'Fix the retry path again', finalFlag);

      const withRound1 = await waitForAgentTurns(ctx, taskId, (t) => t.some((x) => x.turn_type === 'review'));
      const review1 = withRound1.find((x) => x.turn_type === 'review')!;

      // The auto-fix unblock's HUMAN turn carries the message the fixer reads.
      const feedback = await waitFor(
        () => readTurns(ctx.root, taskId).filter(
          (t) => t.role === 'human' && (t.sequence ?? 0) > (review1.sequence ?? 0),
        ),
        (turns) => turns.length > 0,
        'the auto-fix feedback turn',
        () => daemonLogTail(ctx),
      );
      const text = `${feedback[0]!.content ?? ''}\n${(feedback[0] as { prompt?: string }).prompt ?? ''}`;
      expect(text).toContain('The retry path swallows malformed rows instead of surfacing them.');
      expect(text).toContain('not Raises');
    }, 180_000);
  });

  describe('a failed review (a verdict outside the closed set)', () => {
    beforeEach(async () => {
      finalFlag = join(
        process.env.TMPDIR ?? '/tmp',
        `lazy-auto-review-final-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      ctx = await setupTestLazy({
        withDaemon: true,
        daemonEnv: {
          LAZY_MOCK_SHOULD_COMMIT: '1',
          LAZY_MOCK_FINAL: finalFlag,
          LAZY_MOCK_CLAUDE_RESPONSE: reviewerResponse(UNPARSABLE_VERDICT_REPORT),
        },
      });
      relaxAutoReactBudget(ctx);
      setSeparateReview(ctx);
    });

    afterEach(async () => {
      rmSync(finalFlag, { force: true });
      await ctx.cleanup();
    });

    // INVARIANT: a review whose verdict lands outside {clean, needs_work,
    // needs_human} is FAILED and GATES accept. The first loop to run under
    // this flow stored one such review and the loop accepted the child anyway
    // — a verdict nobody can act on may not read as a clean pass.
    test('parks with no auto-fix turn, and accept refuses naming the parse failure', async () => {
      const taskId = await startedFinalTask(ctx, 'Ship something reviewable', finalFlag);
      const fullId = findFullTaskId(ctx.root, taskId);
      rmSync(finalFlag, { force: true });

      const turns = await waitForAgentTurns(ctx, taskId, (t) => t.some((x) => x.turn_type === 'review'));
      const review = turns.find((x) => x.turn_type === 'review')!;
      expect(reviewOf(review)?.verdict).toBe('approve with minor nits');

      // No fix turn: there is nothing to fix that anyone could name.
      await assertTurnsStable(ctx, taskId, turns);
      expect(roundCounter(ctx.root, fullId)).toBe(0);
      expect(readRaisedItems(ctx.root, fullId)).toEqual([]);

      const refused = await ctx.lazy(['accept', taskId, '--yes']);
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stdout + refused.stderr).toContain('approve with minor nits');
      expect(refused.stdout + refused.stderr).toContain('not one of clean / needs_work / needs_human');
    }, 150_000);
  });

  describe('a needs_human verdict', () => {
    beforeEach(async () => {
      finalFlag = join(
        process.env.TMPDIR ?? '/tmp',
        `lazy-auto-review-final-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      ctx = await setupTestLazy({
        withDaemon: true,
        daemonEnv: {
          LAZY_MOCK_SHOULD_COMMIT: '1',
          LAZY_MOCK_FINAL: finalFlag,
          LAZY_MOCK_CLAUDE_RESPONSE: reviewerResponse(NEEDS_HUMAN_REPORT),
        },
      });
      relaxAutoReactBudget(ctx);
      setSeparateReview(ctx);
    });

    afterEach(async () => {
      rmSync(finalFlag, { force: true });
      await ctx.cleanup();
    });

    // INVARIANT: `needs_human` ends the rounds on the FIRST one, whatever the
    // counter says — no auto-fix turn can decide whether a self-contradicting
    // goal should ship. The counter is never touched, so a human who unblocks
    // gets a full fresh cycle rather than one round of it.
    test('parks on the first round — no auto-fix turn, counter untouched, dedup holds', async () => {
      const taskId = await startedFinalTask(ctx, 'Drop nothing in the migration', finalFlag);
      const fullId = findFullTaskId(ctx.root, taskId);
      rmSync(finalFlag, { force: true });

      const turns = await waitForAgentTurns(ctx, taskId, (t) => t.some((x) => x.turn_type === 'review'));
      const review = turns.find((x) => x.turn_type === 'review')!;
      expect(reviewOf(review)?.verdict).toBe('needs_human');

      expect(roundCounter(ctx.root, fullId)).toBe(0);
      expect(agentTurns(ctx, taskId).some((t) => (t.turn_type ?? 'work') === 'work' && (t.sequence ?? 0) > (review.sequence ?? 0)))
        .toBe(false);

      // The dispatch side parks too: extra ticks change nothing, because the
      // dedup never re-reviews the same final.
      await assertTurnsStable(ctx, taskId, turns);
      expect(readTaskStatus(ctx.root, fullId)).toBe('blocked');

      // And it gates accept — the park is a hand-off, not silence.
      const refused = await ctx.lazy(['accept', taskId, '--yes']);
      expect(refused.exitCode).not.toBe(0);
    }, 150_000);
  });

  describe('a loop child', () => {
    beforeEach(async () => {
      finalFlag = join(
        process.env.TMPDIR ?? '/tmp',
        `lazy-auto-review-final-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      ctx = await setupTestLazy({
        withDaemon: true,
        daemonEnv: {
          LAZY_MOCK_SHOULD_COMMIT: '1',
          LAZY_MOCK_FINAL: finalFlag,
          LAZY_MOCK_CLAUDE_RESPONSE: reviewerResponse(NEEDS_HUMAN_REPORT),
        },
      });
      relaxAutoReactBudget(ctx);
      setSeparateReview(ctx);
    });

    afterEach(async () => {
      rmSync(finalFlag, { force: true });
      await ctx.cleanup();
    });

    test('a parked cycle is journalled back to the loop, not left for a person', async () => {
      // The loop parent is never started — a loop drives its children; here
      // the daemon's tick plays the part the loop's own wait would.
      const loopResult = await ctx.lazy([
        'create', '--goal', 'Ship the batch', '--prompt', 'Drive the batch loop.', '--type', 'cluster',
      ]);
      expectSuccess(loopResult);
      const loopId = extractTaskId(loopResult.stdout);

      // The loop needs a worktree before any child can start, so its own
      // first turn runs — WITHOUT the flag file, so the loop declares nothing
      // and the daemon never reviews the loop itself. This cycle is about the
      // CHILD.
      expectSuccess(await ctx.lazy(['start', loopId, '--yes']));
      expectSuccess(await ctx.lazy(['wait', loopId]));

      const childResult = await ctx.lazy([
        'create', '--goal', 'Child work', '--prompt', 'Do the child work', '--parent', loopId,
      ]);
      expectSuccess(childResult);
      const childId = extractTaskId(childResult.stdout);

      writeFileSync(finalFlag, 'Declaring the child work done.');
      expectSuccess(await ctx.lazy(['start', childId, '--yes']));
      // The settle writes the turn row; a same-tick auto-review dispatch can
      // flip the status back to `working` before `lazy wait` samples it, so
      // wait on the recorded turn — it cannot race the dispatch.
      await waitForAgentTurns(ctx, childId, (t) => t.length > 0);
      // The review turn must not re-declare (only the child's work turn did).
      rmSync(finalFlag, { force: true });

      const childTurns = await waitForAgentTurns(ctx, childId, (t) =>
        t.some((x) => x.turn_type === 'review'),
      );
      const review = childTurns.find((x) => x.turn_type === 'review')!;

      // §8.2/§12.3: the loop decides, so the hand-back lands on the PARENT's
      // journal — never a comment (it would start a turn), never on the child
      // (its review turn already carries the findings for the loop to read).
      // The entry CARRIES the findings: the loop is told what to decide about,
      // not merely that something happened.
      const loopFullId = findFullTaskId(ctx.root, loopId);
      const journal = await waitFor(
        () => readJournal(ctx.root, loopFullId),
        (entries) => entries.some((e) => e.content.includes('Auto-review parked')),
        'the auto-review hand-back journal entry on the loop task',
        () => daemonLogTail(ctx),
      );
      const entry = journal.find((e) => e.content.includes('Auto-review parked'))!;
      expect(entry.actor).toBe('system');
      expect(entry.content).toContain('needs_human');
      expect(entry.content).toContain('cannot preserve the existing rows');
      expect(entry.content).toContain('unblock the child');

      // The child itself: parked, no auto-fix turn, round counter never
      // touched — and no Raise was invented for a finding.
      const childFullId = findFullTaskId(ctx.root, childId);
      expect(readRaisedItems(ctx.root, childFullId)).toEqual([]);
      expect(roundCounter(ctx.root, childFullId)).toBe(0);
      expect(agentTurns(ctx, childId).some((t) => (t.turn_type ?? 'work') === 'work' && (t.sequence ?? 0) > (review.sequence ?? 0)))
        .toBe(false);
    }, 180_000);
  });

  /*
   * THE REVIEW MODE DECIDES WHETHER ANY OF THE ABOVE HAPPENS.
   *
   * Engineer decision, 2026-09-21, reversing the 2026-09-19 default after the
   * first cluster run under it:
   *
   *   "The performance per token is just down the drain. […] Low-high should be
   *    the default option if reviewing is enabled: less token usage and less
   *    re-reading of what is already in context. Fast first, ponderously slow
   *    as an optimization on quality."
   *
   * A cluster running 8–12 children under the separate-reviewer cycle took
   * three or more rounds per child at ~30 minutes each, hit the org spend limit
   * twice, and landed 2 of 13 children in four hours.
   */
  describe('the review mode decides whether a reviewer is dispatched at all', () => {
    function setMode(ctx: TestContext, mode: string): void {
      const path = join(ctx.root, 'lazy.toml');
      const before = readFileSync(path, 'utf-8');
      const after = before.replace('# mode = "low_high"', `mode = "${mode}"`);
      if (after === before) {
        throw new Error('could not uncomment [review] mode in the init-produced lazy.toml');
      }
      writeFileSync(path, after);
    }

    async function setup(): Promise<void> {
      finalFlag = join(
        process.env.TMPDIR ?? '/tmp',
        `lazy-auto-review-final-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      ctx = await setupTestLazy({
        withDaemon: true,
        daemonEnv: {
          LAZY_MOCK_SHOULD_COMMIT: '1',
          LAZY_MOCK_FINAL: finalFlag,
          // If a reviewer DID run, it would come back needs_work and gate —
          // so a passing accept below is positive evidence none ran.
          LAZY_MOCK_CLAUDE_RESPONSE: reviewerResponse(NEEDS_WORK_REPORT),
        },
      });
      relaxAutoReactBudget(ctx);
    }

    afterEach(async () => {
      rmSync(finalFlag, { force: true });
      await ctx.cleanup();
    });

    // INVARIANT: `off` dispatches NOTHING and gates NOTHING. No review turn is
    // recorded, so there is nothing for the accept gate to read — which is why
    // `off` needs no separate gate carve-out to be acceptable.
    test('off: a final dispatches no review, and accept proceeds', async () => {
      await setup();
      setMode(ctx, 'off');
      const taskId = await startedFinalTask(ctx, 'Ship it unreviewed', finalFlag);
      rmSync(finalFlag, { force: true });

      const before = agentTurns(ctx, taskId);
      // Several ticks pass and no review turn appears. The dedup helper is
      // exactly the right wait: it asserts the turn record does not grow.
      await assertTurnsStable(ctx, taskId, before);
      expect(before.some((t) => t.turn_type === 'review')).toBe(false);

      expectSuccess(await ctx.lazy(['accept', taskId, '--yes']));
      expectOutput(await ctx.lazy(['show', taskId]), 'complete');
    }, 150_000);

    // INVARIANT: `low_high` dispatches no SEPARATE reviewer either. The review
    // happened inside the writer's own session (asserted on the supervisor seam
    // in test/e2e/low-high-loop.test.ts — the module mock here replaces the
    // supervisor wholesale and cannot see those phases), so a second reviewer
    // would be the re-reading of an already-warm diff this default exists to
    // stop paying for.
    test('low_high: a final dispatches no separate reviewer, and accept proceeds', async () => {
      await setup();
      setMode(ctx, 'low_high');
      const taskId = await startedFinalTask(ctx, 'Ship it self-reviewed', finalFlag);
      rmSync(finalFlag, { force: true });

      const before = agentTurns(ctx, taskId);
      await assertTurnsStable(ctx, taskId, before);
      expect(before.some((t) => t.turn_type === 'review')).toBe(false);

      expectSuccess(await ctx.lazy(['accept', taskId, '--yes']));
      expectOutput(await ctx.lazy(['show', taskId]), 'complete');
    }, 150_000);

    // INVARIANT: with `auto_fix` off — the DEFAULT — a needs_work review parks
    // the task with its findings and starts NO fix turn. Whether another
    // ~30-minute round is worth it is a judgement made by whoever can see the
    // whole board, not by the daemon; the run that produced this default spent
    // most of four hours on rounds nobody asked for.
    test('separate with auto_fix off: needs_work parks with its findings, no fix turn', async () => {
      await setup();
      setMode(ctx, 'separate');
      const taskId = await startedFinalTask(ctx, 'Fix the retry path', finalFlag);
      const fullId = findFullTaskId(ctx.root, taskId);
      rmSync(finalFlag, { force: true });

      const turns = await waitForAgentTurns(ctx, taskId, (t) => t.some((x) => x.turn_type === 'review'));
      const review = turns.find((x) => x.turn_type === 'review')!;
      expect(reviewOf(review)?.verdict).toBe('needs_work');
      expect(reviewOf(review)?.findings).toHaveLength(1);

      // No fix turn ran, and the record stops growing — the task is parked.
      await assertTurnsStable(ctx, taskId, turns);
      expect(
        turns.some((t) => (t.turn_type ?? 'work') === 'work' && (t.sequence ?? 0) > (review.sequence ?? 0)),
      ).toBe(false);

      // NO ROUND WAS COUNTED. The per-child budget bounds rounds that actually
      // RAN; spending one on a round nobody started would shorten the budget of
      // a driver that later decides to fix by hand.
      expect(roundCounter(ctx.root, fullId)).toBe(0);
      // Findings stay findings — no Raised row is invented for one.
      expect(readRaisedItems(ctx.root, fullId)).toEqual([]);

      // The finding is critical, so it still gates: the relaxation is about
      // medium and below, not about turning the gate off.
      const accept = await ctx.lazy(['accept', taskId, '--yes']);
      expect(accept.exitCode).not.toBe(0);
      expect(accept.stderr + accept.stdout).toContain('--allow-review-issues');
    }, 180_000);
  });
});
