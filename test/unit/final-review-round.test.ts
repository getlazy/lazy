/**
 * Unit tests for the auto-review round counter (final-turn design §8.1).
 *
 * INVARIANT: an auto-review cycle gets FINitely many review rounds —
 * FINAL_REVIEW_CAP — before the task parks with its Raises outstanding
 * and accept stays gated. The counter counts COMPLETED rounds that filed
 * at least one non-blocking Raise; blocking findings never count (they
 * end the cycle on the first one, whatever the counter says).
 *
 * INVARIANT: the round counter resets wherever the auto-react counters
 * reset (human unblock, terminal state, crash recovery) PLUS when an
 * agent intervenes — for a loop's child the loop is "the human" (§8.2),
 * and the loop hands a capped child back by unblocking it over MCP with
 * actor `agent`, which must start a fresh cycle. Only a daemon round's
 * own auto-fix (actor `system`) leaves it standing.
 *
 * INVARIANT: `auto_review` is an AUTO_REACT_TRIGGERS member — the
 * dispatch consumes a daily-budget turn exactly like every other
 * daemon-started turn; removing it from the union would make the
 * dispatch unbudgeted while every reset site still skipped it.
 */

import { describe, test, expect } from 'bun:test';
import {
  AUTO_REACT_TRIGGERS,
  FINAL_REVIEW_CAP,
  FINAL_REVIEW_ROUND_KEY,
  getFinalReviewRound,
  incrementFinalReviewRound,
  resetFinalReviewRound,
  resetAutoReactCounters,
} from '../../src/daemon/auto-react-budget';
import type { Storage } from '../../src/storage/interface';

/**
 * Minimal in-memory storage mock — getTaskMetadata/updateTaskMetadata are
 * the only storage methods the round-counter functions use.
 */
function createMockStorage(): Storage {
  const metadata = new Map<string, Map<string, string>>();

  return {
    metadata,
    async getTaskMetadata(taskId: string, key: string): Promise<string | null> {
      return metadata.get(taskId)?.get(key) ?? null;
    },
    async updateTaskMetadata(taskId: string, key: string, value: string): Promise<void> {
      if (!metadata.has(taskId)) {
        metadata.set(taskId, new Map());
      }
      metadata.get(taskId)!.set(key, value);
    },
  } as any;
}

describe('final review round counter', () => {
  test('unset metadata reads as round 0', async () => {
    const storage = createMockStorage();
    expect(await getFinalReviewRound(storage, 't1')).toBe(0);
  });

  test('increment counts completed rounds: 0 → 1 → 2', async () => {
    const storage = createMockStorage();
    expect(await incrementFinalReviewRound(storage, 't1')).toBe(1);
    expect(await incrementFinalReviewRound(storage, 't1')).toBe(2);
    expect(await getFinalReviewRound(storage, 't1')).toBe(2);
    // Per-task, not global.
    expect(await getFinalReviewRound(storage, 't2')).toBe(0);
  });

  test('reset clears the counter back to 0', async () => {
    const storage = createMockStorage();
    await incrementFinalReviewRound(storage, 't1');
    await incrementFinalReviewRound(storage, 't1');
    await resetFinalReviewRound(storage, 't1');
    expect(await getFinalReviewRound(storage, 't1')).toBe(0);
  });

  test('non-numeric stored value reads as 0, not NaN', async () => {
    const storage = createMockStorage();
    await storage.updateTaskMetadata('t1', FINAL_REVIEW_ROUND_KEY, 'garbage');
    expect(await getFinalReviewRound(storage, 't1')).toBe(0);
  });

  test('resetAutoReactCounters also resets the round counter', async () => {
    // INVARIANT: the round counter rides every auto-react reset site —
    // a human taking over (or crash recovery re-arming the task) starts
    // a fresh review cycle, never a resumed stale one.
    const storage = createMockStorage();
    await incrementFinalReviewRound(storage, 't1');
    await incrementFinalReviewRound(storage, 't1');
    await resetAutoReactCounters(storage, 't1');
    expect(await getFinalReviewRound(storage, 't1')).toBe(0);
  });
});

describe('auto-review budget constants', () => {
  test('FINAL_REVIEW_CAP is 2 (design §8.1: two fix rounds)', () => {
    expect(FINAL_REVIEW_CAP).toBe(2);
  });

  test('auto_review is a budgeted trigger', () => {
    // INVARIANT: the daemon-dispatched review consumes a daily-budget
    // turn exactly like every other daemon-started turn. Dropping it
    // from AUTO_REACT_TRIGGERS would make the dispatch unbudgeted AND
    // leave every reset site blind to its counter.
    expect(AUTO_REACT_TRIGGERS).toContain('auto_review');
  });
});
/**
 * ONE PREDICATE decides "was this review clean", for the gate and for the
 * round accounting alike.
 *
 * The accounting used to spell its own test — `verdict === 'clean' &&
 * reviewIssueCount === 0` — which agreed with `reviewIsClean` until the clean
 * predicate learned about sweeps that name an issue no finding covers. Then the
 * two disagreed, in the one direction that strands a task: the accept gate held
 * the merge while the accounting had already declared the cycle finished, so
 * nothing reset, no fix turn had anything to act on, and no §8.2 hand-back was
 * journalled. A loop's child in that state is refused at accept with no entry
 * saying why, and the only override (`accept --allow-review-issues`) is CLI-only.
 *
 * A source scan, because `settleAutoReviewRound` is module-private and runs
 * inside the review settle — it stops the divergence coming back by the same
 * route it arrived: someone re-spelling the test at the call site.
 */
describe('the round accounting asks the gate its own question', () => {
  test('settleAutoReviewRound tests cleanliness with reviewIsClean', async () => {
    const { readFile } = await import('fs/promises');
    const { join } = await import('path');
    const src = await readFile(
      join(import.meta.dir, '../../src/daemon/task-lifecycle.ts'),
      'utf-8',
    );
    const start = src.indexOf('async function settleAutoReviewRound(');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\n}\n', start);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);

    expect(body).toContain('if (reviewIsClean(report))');
    // The re-spelling this replaced. Its return from the function is a RESET
    // with no journal, so a report the gate holds must never reach it.
    expect(body).not.toContain("verdict === 'clean'");
  });
});
