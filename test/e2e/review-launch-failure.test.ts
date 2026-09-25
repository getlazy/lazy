/**
 * A review that cannot run is VISIBLE (final-turn design §8.3).
 *
 * The failure this exists for: in the first loop to run under the final-turn
 * flow, the model provider died mid-run. The child declared final, the daemon
 * dispatched its automatic review, the reviewer agent exited without producing
 * anything — and the child then sat parked with a crash turn that no gate read,
 * no findings, and no word to its loop parent. The loop waited on it
 * indefinitely, because from the outside "no review yet" and "a review that
 * died" looked identical.
 *
 * What is pinned here, end to end through the REAL supervisor:
 *   - a review that produced no usable verdict lands as a `review` turn
 *     carrying a FAILED report, after the ONE re-ask, and GATES accept exactly
 *     as `needs_work` would;
 *   - a loop parent is journalled about it, so step 5 of its contract applies.
 *
 * THE FAKE BINARY SEAM is required, not a preference. The module mock replaces
 * `launchSupervisorAsync` wholesale, so the supervisor's own re-ask invocation
 * and its error response are both unreachable there. Here the daemon really
 * launches `lazy supervise`, which really spawns the fake agent.
 *
 * The scenario is swapped BETWEEN turns: the work turn must succeed (and
 * declare final, via the handoff file, since a scripted binary cannot call MCP)
 * before there is anything for a review to fail on.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess, extractTaskId } from '../helpers/assertions';
import {
  findFullTaskId,
  readJournal,
  readTurns,
  worktreePathFor,
  type StoredTurn,
} from '../helpers/storage';
import {
  crashScenario,
  sessionStartEvent,
  resultEvent,
  type ClaudeScenario,
} from '../helpers/fake-claude';
import { protocolDir as getProtocolDir } from '../../src/protocol';
import { PRESENTATION_MARKER_FILE } from '../../src/protocol/presentation-marker';
import { getDaemonDir } from '../../src/daemon/paths';
import type { ReviewReport } from '../../src/types';

const TICK_POLL_MS = 1_000;
/** Generous against the daemon's 5s tick: dispatch + crash + settle straddle several. */
const DEADLINE_MS = 90_000;

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

function reviewOf(turn: StoredTurn | undefined): ReviewReport | undefined {
  return turn?.review as ReviewReport | undefined;
}

/**
 * A work invocation that succeeds and declares final through the handoff file —
 * the only route a scripted binary has, since it cannot call `lazy_final` over
 * MCP. It also writes the presentation marker, because a human-audience
 * wrap-up's present step refuses to complete without one.
 */
function declaringWorkScenario(
  worktree: string,
  fullId: string,
  result = 'Done.',
): ClaudeScenario {
  return {
    steps: [
      { kind: 'emit', event: sessionStartEvent('sess-work') },
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
      { kind: 'emit', event: resultEvent({ result, sessionId: 'sess-work' }) },
    ],
  };
}

/**
 * A verdict word the closed set accepts, with a REQUIRED SWEEP MISSING.
 *
 * This is the shape that distinguishes the two candidate re-ask triggers:
 * `parseVerdictText(report.verdict)` reads `clean` and would not re-ask, while
 * `resolveReviewVerdict(report)` — the predicate the daemon fails a review by —
 * says `unparsed` and must.
 */
const MISSING_SWEEP_REVIEW = JSON.stringify({
  verdict: 'clean',
  data_integrity: 'none found',
  findings: [],
});

describe('a review that fails (real supervisor, fake claude)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
    // SEPARATE mode: this whole suite is about the reviewer the daemon
    // dispatches after a final, and since 2026-09-21 only `separate` does
    // that (the default, `low_high`, has the writer review itself in session).
    // Edited INTO the init-produced [review] section, with the replace
    // asserted — a silent no-op here would leave the suite waiting forever for
    // a review nothing was ever going to start.
    const configPath = join(ctx.root, 'lazy.toml');
    const before = readFileSync(configPath, 'utf-8');
    const after = before.replace('# mode = "low_high"', 'mode = "separate"');
    if (after === before) {
      throw new Error('could not uncomment [review] mode in the init-produced lazy.toml');
    }
    writeFileSync(configPath, after);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT (§8.3): a crashed reviewer is a FAILED review, not a missing one.
  // The crash turn used to carry no report at all, so every gate and every
  // Reviews surface read the task as simply un-reviewed — which is how a
  // provider outage produced a silently acceptable task.
  //
  // The reviewer here produces PROSE rather than crashing, and the two are the
  // same condition to every surface downstream: no usable verdict. It is used
  // for this test because the automatic dispatch cannot be aimed — it can land
  // on the same reconcile tick the work turn settles, so swapping in a crash
  // scenario would race the review it is meant to break. The crash proper is
  // driven in the loop test below, where the child's final is polled for first.
  test('a review with no usable verdict is recorded FAILED and holds accept', async () => {
    const taskId = await createTask(ctx, 'Ship the thing', 'Do the work');
    const fullId = findFullTaskId(ctx.root, taskId);
    const worktree = worktreePathFor(ctx.root, taskId);

    await ctx.setClaudeScenario(declaringWorkScenario(worktree, fullId));
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expect(readTurns(ctx.root, taskId).some((t) => t.final)).toBe(true);

    // The daemon dispatches the review itself. The reviewer replies "Done." —
    // not one of clean / needs_work / needs_human.
    const turns = await waitFor(
      () => readTurns(ctx.root, taskId),
      (t) => t.some((x) => x.role === 'agent' && x.turn_type === 'review'),
      'the automatic review to be recorded',
      () => daemonLogTail(ctx),
    );

    const review = turns.find((t) => t.role === 'agent' && t.turn_type === 'review')!;
    const report = reviewOf(review);
    expect(report).toBeDefined();
    expect(report!.security).toBe('unparsed');

    // THE ONE RE-ASK ran, in the same session, and is recorded on the turn —
    // so a reader can see why the review is marked failed rather than guessing.
    expect(String(review.content)).toContain('Re-asked for the verdict block');

    // It gates: a verdict nobody can act on may not read as a clean bill of
    // health. This is the exact case the first loop under this flow accepted.
    const refused = await ctx.lazy(['accept', taskId, '--yes']);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain('no readable security / data-integrity statement');

    // And the human has the override. It matters more than it used to: findings
    // are not Raises, so there are no rows to dismiss or promote instead —
    // without it a human facing a failed review could not accept at all except
    // by spending another agent turn.
    //
    // The EXIT CODE is asserted first, and that is not decoration: this call
    // used to name `--final`, and when that flag was retired the command
    // started dying in `parseFlags` with "Unknown flag" before accept ran.
    // Both "not contains" assertions passed on that output, so the test stayed
    // green while covering nothing. An argument-parse failure must never again
    // be mistaken for a working override.
    // Accept needs something to merge, and the scripted agent commits nothing
    // — so the test makes the one commit itself, AFTER the review has been
    // recorded. A bare git commit is not an agent work turn, so the final still
    // stands (it is merely labelled as having moved) and the failed review is
    // still what would refuse.
    const worktreeForMerge = worktreePathFor(ctx.root, taskId);
    writeFileSync(join(worktreeForMerge, 'shipped.txt'), 'the thing\n');
    expect(ctx.git('-C', worktreeForMerge, 'add', 'shipped.txt').exitCode).toBe(0);
    expect(ctx.git('-C', worktreeForMerge, 'commit', '-m', 'Ship the thing').exitCode).toBe(0);

    const overridden = await ctx.lazy(['accept', taskId, '--allow-review-issues', '--yes']);
    expect(overridden.stdout + overridden.stderr).not.toContain('Unknown flag');
    expectSuccess(overridden);
    expect(overridden.stdout + overridden.stderr).not.toContain('no readable security');
    expect(overridden.stdout + overridden.stderr).not.toContain('formal review');
  }, 180_000);

  // INVARIANT: the supervisor's re-ask TRIGGER is `resolveReviewVerdict` — the
  // same predicate the daemon fails a review by — not the verdict word alone.
  //
  // This test exists to notice a revert of that one line. A reviewer that emits
  // a well-formed verdict and forgets a required sweep statement parses its
  // WORD but not its report, so the narrow predicate skipped the recovery
  // entirely: no re-ask ran, the review was recorded FAILED, and the park
  // reason claimed "even after the one re-ask" about a re-ask that never
  // happened. A forgotten sweep line is the cheapest failure there is to
  // recover from, and it is exactly what one re-ask exists for.
  //
  // No scenario swap here, so nothing races: the SAME scenario serves the work
  // turn and the review, which makes the review's payload deterministic. The
  // re-ask replays it too, so the report stays unresolvable and the review is
  // still recorded FAILED — what is asserted is that the attempt was MADE.
  test('a review that forgets a required sweep is re-asked before it is failed', async () => {
    const taskId = await createTask(ctx, 'Sweep goes missing', 'Do the work');
    const fullId = findFullTaskId(ctx.root, taskId);
    const worktree = worktreePathFor(ctx.root, taskId);

    await ctx.setClaudeScenario(
      declaringWorkScenario(worktree, fullId, MISSING_SWEEP_REVIEW),
    );
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const turns = await waitFor(
      () => readTurns(ctx.root, taskId),
      (t) => t.some((x) => x.role === 'agent' && x.turn_type === 'review'),
      'the automatic review of a report with a missing sweep',
      () => daemonLogTail(ctx),
    );

    const review = turns.find((t) => t.role === 'agent' && t.turn_type === 'review')!;
    const report = reviewOf(review);
    // The verdict WORD was fine — which is why the narrow predicate missed it.
    expect(report!.verdict).toBe('clean');
    // The report was not: the sweep never parsed, so the review is FAILED.
    expect(report!.security).toBe('unparsed');

    // THE ASSERTION THIS TEST IS FOR: the re-ask ran. Under the narrow trigger
    // this heading is absent and the review is failed with no recovery offered.
    expect(String(review.content)).toContain('Re-asked for the verdict block');

    // And the failure still gates, as a failed review must.
    const refused = await ctx.lazy(['accept', taskId, '--yes']);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain('no readable security / data-integrity statement');
  }, 180_000);

  // INVARIANT (§8.2/§8.3): for a loop's child the loop is "the human", so a
  // failed review reaches it on the same journal channel as every other parked
  // cycle. Without it the loop's `lazy_wait` returns, it finds no review, and it
  // has nothing to decide on.
  test('a review that came back unusable is journalled back to its loop parent', async () => {
    const loopResult = await ctx.lazy([
      'create', '--goal', 'Drive the batch', '--prompt', 'Run the children.', '--type', 'cluster',
    ]);
    expectSuccess(loopResult);
    const loopId = extractTaskId(loopResult.stdout);

    // The loop needs a worktree before a child can start. Its own turn declares
    // nothing, so the daemon never reviews the loop itself.
    await ctx.setClaudeScenario({
      steps: [
        { kind: 'emit', event: sessionStartEvent('sess-loop') },
        { kind: 'emit', event: resultEvent({ result: 'Starting.', sessionId: 'sess-loop' }) },
      ],
    });
    expectSuccess(await ctx.lazy(['start', loopId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', loopId]));

    const childResult = await ctx.lazy([
      'create', '--goal', 'Child work', '--prompt', 'Do the child work', '--parent', loopId,
    ]);
    expectSuccess(childResult);
    const childId = extractTaskId(childResult.stdout);
    const childFullId = findFullTaskId(ctx.root, childId);

    await ctx.setClaudeScenario(
      declaringWorkScenario(worktreePathFor(ctx.root, childId), childFullId),
    );
    expectSuccess(await ctx.lazy(['start', childId, '--yes']));
    await waitFor(
      () => readTurns(ctx.root, childId),
      (t) => t.some((x) => x.final),
      "the child's work turn to declare final",
      () => daemonLogTail(ctx),
    );

    await ctx.setClaudeScenario(crashScenario({
      stderr: 'API Error: 500 upstream model provider unavailable\n',
    }));

    const loopFullId = findFullTaskId(ctx.root, loopId);
    const journal = await waitFor(
      () => readJournal(ctx.root, loopFullId),
      (entries) => entries.some((e) => e.content.includes('Auto-review parked')),
      'the failed-review hand-back on the loop task',
      () => daemonLogTail(ctx),
    );

    const entry = journal.find((e) => e.content.includes('Auto-review parked'))!;
    expect(entry.actor).toBe('system');
    // The loop is told WHY, in the terms its own contract uses, and what its
    // options are — not merely that something happened.
    expect(entry.content).toContain('FAILED');
    expect(entry.content).toContain('unblock the child');
    expect(entry.content).toContain('accept it');
  }, 240_000);
});
