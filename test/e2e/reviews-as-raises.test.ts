/**
 * Reviews-as-raises: accept refuses while a successful review's raises are
 * unaddressed; Reviews tab / Review dialog / Accept formal-review choice show
 * on the task page; unparsed reviews never appear on Reviews.
 *
 * Seeds review turns via writeTurns (daemon already holds the storage lock, so
 * openProjectStorage/FileStorage cannot acquire it).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectError, expectOutput } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { seedFinal } from '../helpers/final';
import {
  findFullTaskId,
  readTurns,
  writeTurns,
  writeRaisedItemsFile,
  type StoredTurn,
} from '../helpers/storage';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';
import type { ReviewReport } from '../../src/types/review-report';

async function createStartedTaskWithCommit(ctx: TestContext, goal: string): Promise<string> {
  const taskId = await createTask(ctx, goal, 'Some work');
  expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
    env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
  }));
  const waitResult = await ctx.lazy(['wait', taskId]);
  if (waitResult.exitCode !== 0) {
    throw new Error(`wait failed for ${taskId}: ${waitResult.stderr}\n${waitResult.stdout}`);
  }
  const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
  writeFileSync(join(worktreePath, 'feature.txt'), 'feature content\n');
  expect(ctx.git('-C', worktreePath, 'add', 'feature.txt').exitCode).toBe(0);
  expect(ctx.git('-C', worktreePath, 'commit', '-m', 'Add feature').exitCode).toBe(0);
  // Fixture setup, not the subject (see test/helpers/final.ts). withDaemon
  // suite, so the final is declared through the daemon.
  await seedFinal(ctx, taskId);
  return taskId;
}

/**
 * A review that PARSED and filed a Raise — the `needs_human` decision, which is
 * the one thing a reviewer still raises. Named `cleanReview` for its SWEEPS,
 * which are clean; what gates here is the raise's own state, which is what
 * these tests are about.
 */
const cleanReview = (raisedIds: string[]): ReviewReport => ({
  verdict: 'needs_human',
  security: 'none found',
  data_integrity: 'none found',
  findings: [],
  raised_item_ids: raisedIds,
});

function appendReviewTurn(
  ctx: TestContext,
  taskId: string,
  review: ReviewReport,
  content: string,
): number {
  const turns = readTurns(ctx.root, taskId);
  const nextSeq = Math.max(0, ...turns.map((t) => Number(t.sequence ?? 0))) + 1;
  const seeded: StoredTurn = {
    id: randomUUID(),
    role: 'agent',
    content,
    turn_type: 'review',
    sequence: nextSeq,
    timestamp: Date.now(),
    review,
  };
  writeTurns(ctx.root, taskId, [...turns, seeded]);
  return nextSeq;
}

/**
 * Put the project in `separate` review mode — the mode whose verdict gates
 * accept, and the only one these tests are about. Since 2026-09-21 the default
 * is `low_high`, which records no review turn for the gate to read at all.
 *
 * Edited INTO the init-produced [review] section, with the replace asserted:
 * a silent no-op would leave the accept-gate tests passing for the wrong
 * reason (accept succeeding because nothing gates, not because nothing is
 * outstanding).
 */
function setSeparateReview(ctx: TestContext): void {
  const configPath = join(ctx.root, 'lazy.toml');
  const before = readFileSync(configPath, 'utf-8');
  const after = before.replace('# mode = "low_high"', 'mode = "separate"');
  if (after === before) {
    throw new Error('could not uncomment [review] mode in the init-produced lazy.toml');
  }
  writeFileSync(configPath, after);
}

describe('reviews as raises — accept gate (daemon)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    setSeparateReview(ctx);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('accept refuses when a successful review raised issues and no later work turn', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Review issues gate');
    const fullId = findFullTaskId(ctx.root, taskId);
    const raiseId = randomUUID();
    // Non-blocking so the open-raised accept gate is not what refuses —
    // the review-issues-unaddressed gate must still fire from raised_item_ids.
    writeRaisedItemsFile(ctx.root, taskId, [{
      id: raiseId,
      task_id: fullId,
      content: 'Fix the atomic write.',
      title: 'Writes must be atomic',
      blocking: false,
      created_at: Date.now(),
      triage_status: 'open',
    }]);
    appendReviewTurn(ctx, taskId, cleanReview([raiseId]), 'Review found issues.');

    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectFailure(result);
    expectError(result, 'formal review');
    expectError(result, 'no work turn');
  }, 120_000);

  // INVARIANT: a human who has demonstrably acted on a review's raise is never
  // told to unblock the agent to clear the gate. Reproduces the reported
  // sequence exactly: review raises a blocking issue → human promotes it to a
  // subtask → that subtask is accepted into the parent → the parent accepts.
  // Before the fix the last step refused with review-issues-unaddressed,
  // because the gate counted the review's raises without ever reading their
  // state.
  test('a raise promoted to a subtask and accepted lets the parent accept', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Promoted raise clears the gate');
    const fullId = findFullTaskId(ctx.root, taskId);
    const raiseId = randomUUID();
    writeRaisedItemsFile(ctx.root, taskId, [{
      id: raiseId,
      task_id: fullId,
      content: 'Review with Builder can still be started.',
      title: 'Leftover route',
      blocking: true,
      created_at: Date.now(),
      status: 'open',
      triage_status: 'open',
    }]);
    appendReviewTurn(ctx, taskId, cleanReview([raiseId]), 'Review found one issue.');

    // Nobody has acted yet — both gates must still refuse.
    expectFailure(await ctx.lazy(['accept', taskId, '--yes']));

    const promote = await ctx.lazy([
      'raised', 'promote', taskId, raiseId.slice(0, 8), '--subtask', '--code', 'promoted-child',
    ]);
    expectSuccess(promote);

    // Accept the promoted child into the parent, as the human did.
    expectSuccess(await ctx.lazyMocked(['start', 'promoted-child', '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    }));
    expectSuccess(await ctx.lazy(['wait', 'promoted-child']));
    const childWorktree = join(ctx.root, '.lazy', 'worktrees', 'promoted-child');
    writeFileSync(join(childWorktree, 'child.txt'), 'child work\n');
    expect(ctx.git('-C', childWorktree, 'add', 'child.txt').exitCode).toBe(0);
    expect(ctx.git('-C', childWorktree, 'commit', '-m', 'Child work').exitCode).toBe(0);
    // Fixture setup, not the subject (see test/helpers/final.ts): the child
    // needs its own standing final before its accept.
    await seedFinal(ctx, 'promoted-child');
    expectSuccess(await ctx.lazy(['accept', 'promoted-child', '--yes']));

    // The parent's only review raise is promoted and its work has landed. No
    // work turn has run on the parent since the review — and none is owed.
    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(result);
    expectOutput(result, 'accepted');
  }, 180_000);

  // INVARIANT: a FAILED review REFUSES accept. This assertion is inverted from
  // what it used to be, and the inversion is the point: under the raise-era
  // rule an unparsed review with no raises "never happened", so a task whose
  // only review was broken accepted clean. That is exactly what the first loop
  // to run under the final-turn flow did — it stored one unparsed review and
  // accepted the child anyway. Nobody knows what such a review concluded, and
  // "nobody knows" may not read as a pass.
  test('a failed review with no raises still refuses accept', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Unparsed review gates');
    appendReviewTurn(ctx, taskId, {
      verdict: 'Looks fine.',
      security: 'unparsed',
      data_integrity: 'unparsed',
      findings: [],
    }, 'Looks fine, ship it.');

    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectFailure(result);
    expectError(result, 'no readable security / data-integrity statement');

    // The human's override is the way out — there are no Raises to decide.
    // INVARIANT (this task): the override is its OWN flag. It used to ride on
    // `--final`, which also stood down the finality gate; that gate is gone and
    // the flag with it, but the capability had to survive — findings are fix
    // feedback, not rows a human can dismiss one at a time, so without it a
    // person facing a failed review would have to spend another agent turn.
    const overridden = await ctx.lazy(['accept', taskId, '--allow-review-issues', '--yes']);
    expectSuccess(overridden);
    expectOutput(overridden, 'accepted');
  }, 120_000);

  test('unparsed review that filed raises still refuses accept', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Unparsed with raises');
    const fullId = findFullTaskId(ctx.root, taskId);
    const raiseId = randomUUID();
    writeRaisedItemsFile(ctx.root, taskId, [{
      id: raiseId,
      task_id: fullId,
      content: 'Fix the race.',
      title: 'Race on write',
      blocking: false,
      created_at: Date.now(),
      triage_status: 'open',
    }]);
    appendReviewTurn(ctx, taskId, {
      verdict: 'Looks fine.',
      security: 'unparsed',
      data_integrity: 'unparsed',
      findings: [],
      raised_item_ids: [raiseId],
    }, 'Prose only but raised.');

    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectFailure(result);
    expectError(result, 'formal review');
    expectError(result, 'no work turn');
  }, 120_000);
});

describe('reviews as raises — web UI', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true, daemonEnv: { LAZY_MOCK_SHOULD_COMMIT: '1' } });
    setSeparateReview(ctx);
    const health = await checkDaemonHealth(ctx.root);
    expect(health.webPort).toBeGreaterThan(0);
    ({ base, fetch } = await signInToDashboard(ctx));
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function waitForBlockedId(shortId: string): Promise<string> {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const { queue } = await (await fetch(`${base}/api/review/queue`)).json();
      const hit = queue.find((e: { id: string }) => e.id.startsWith(shortId));
      if (hit) return hit.id;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`task ${shortId} never appeared in the review queue`);
  }

  test('Review dialog has auto-fix; Accept does not offer a review choice; Reviews tab lists successful reviews only', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Reviews UI surfaces');
    const fullId = await waitForBlockedId(taskId);

    const summary = await (await fetch(`${base}/tasks/${fullId}`)).text();
    expect(summary).toContain('lz-review-auto-fix');
    expect(summary).toContain('Automatically fix');
    expect(summary).not.toContain('Review with builder');

    // §8: declaring a task done starts a review automatically, so the Accept
    // dialog never offers a "review first?" choice — a review always exists
    // by the time a human opens this page.
    const current = await (await fetch(`${base}/tasks/${fullId}/review`)).text();
    expect(current).not.toContain('name="accept_path"');
    expect(current).not.toContain('Accept without a new formal review');

    const raiseId = randomUUID();
    writeRaisedItemsFile(ctx.root, taskId, [{
      id: raiseId,
      task_id: fullId,
      content: 'Optional tidy.',
      title: 'Tidy optional',
      blocking: false,
      created_at: Date.now(),
      triage_status: 'open',
    }]);
    const okSeq = appendReviewTurn(ctx, taskId, cleanReview([raiseId]), 'Clean review with one raise.');
    const badSeq = appendReviewTurn(ctx, taskId, {
      verdict: 'ship it',
      security: 'unparsed',
      data_integrity: 'unparsed',
      findings: [],
    }, 'Prose only — failed parse.');

    const reviewsPage = await (await fetch(`${base}/tasks/${fullId}/reviews`)).text();
    expect(reviewsPage).toContain('needs_human');
    expect(reviewsPage).toContain(`turn #${okSeq}`);
    expect(reviewsPage).toContain('/raised');
    // INVARIANT: a FAILED review IS a Reviews row, with its verdict text shown.
    // It gates accept, and a gate nobody can see on the page that exists to
    // explain the gates is the drift this asserts against — the row is how a
    // human finds out their reviewer produced nothing usable.
    expect(reviewsPage).toContain(`turn #${badSeq}`);
    expect(reviewsPage).toContain('ship it');

    // Current review must name the daemon gate — "Nothing is blocking" would
    // lie; accept still 409s. The gate reads the LATEST review, which here is
    // the failed one, and it says what is actually wrong with it rather than
    // "0 issues still unaddressed" — which on a failed review would read like
    // nothing is wrong at all.
    const afterReview = await (await fetch(`${base}/tasks/${fullId}/review`)).text();
    expect(afterReview).toContain(`Formal review (turn #${badSeq}) produced no readable security / data-integrity statement`);
    expect(afterReview).toContain('no work turn has run since');
    expect(afterReview).not.toContain('Nothing is blocking accept from this tab');
  }, 120_000);
});
