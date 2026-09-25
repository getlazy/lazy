/**
 * E2E: accepting or rejecting a task with a pull request writes no review and
 * no comment to the forge.
 *
 * INVARIANT (engineer decision, 2026-09-21): lazy writes NOTHING to a PR/MR
 * that a human receives as a notification. "Description refresh is fine —
 * that's a single thing that gets updated. Intermittent comments are not fine
 * — we should just not post anything." Accept used to submit an approving
 * review on three paths and reject a requesting-changes review; both are
 * removed, and the reason now lives only on the task comment and in the merge
 * commit.
 *
 * These tests assert an ABSENCE, so they mock at the driver boundary and read
 * the mock's write log (`mock-forge-write-calls.jsonl`): every forge write the
 * driver makes is recorded with a `kind`, and only `body` (the lazy-owned
 * description section), `approve` (the `[remote] auto_approve` merge approval)
 * and `close` (reject closing the PR) may ever appear. A `comment` or `review`
 * kind means the removed posting paths came back.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { setTaskMetadata } from '../helpers/storage';
import { seedFinal } from '../helpers/final';

/** Write kinds that would mean lazy is notifying PR watchers again. */
const FORBIDDEN_KINDS = ['comment', 'review'];

describe('accept and reject write no review or comment to the forge', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // INVARIANT: `start` + `accept` need a real daemon — `start` launches the
    // supervisor asynchronously and the reconciler is what moves the task out
    // of `working`. Daemonless it stays `working` and accept refuses. Same
    // shape as test/e2e/accept-reason.test.ts.
    ctx = await setupTestLazy({ withDaemon: true });
    // Presence of this file is what turns the mock driver on, and the daemon
    // re-reads it per call — env cannot change after the daemon has started.
    writeFileSync(join(ctx.protocolBase, 'mock-forge-writes.json'), '{}');
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function forgeWrites(): Array<{ kind: string }> {
    const path = join(ctx.protocolBase, 'mock-forge-write-calls.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  /**
   * A started task carrying a PR, with a commit of its own and a final
   * declared — everything accept needs, plus the forge metadata that made the
   * old code post.
   */
  async function taskWithPullRequest(goal: string): Promise<string> {
    const taskId = await createTask(ctx, goal, 'Some work');

    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    }));
    const waitResult = await ctx.lazy(['wait', taskId]);
    if (waitResult.exitCode !== 0) {
      throw new Error(`wait failed for ${taskId}: ${waitResult.stderr}\n${waitResult.stdout}`);
    }

    // The in-daemon agent uses the daemon's own mock response, so the per-test
    // LAZY_MOCK_SHOULD_COMMIT never reaches it — make the commit here.
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    writeFileSync(join(worktreePath, 'feature.txt'), 'feature content\n');
    expect(ctx.git('-C', worktreePath, 'add', 'feature.txt').exitCode).toBe(0);
    expect(ctx.git('-C', worktreePath, 'commit', '-m', 'Add feature').exitCode).toBe(0);

    // This is what used to make accept and reject post: a task that HAS a PR.
    setTaskMetadata(ctx.root, taskId, 'github_remote_ref_id', '42');
    setTaskMetadata(ctx.root, taskId, 'github_remote_ref_url', 'https://github.com/o/r/pull/42');

    seedFinal(ctx, taskId);
    return taskId;
  }

  // INVARIANT: accept posts no approving review. It used to, unconditionally,
  // on both the pending-merge and committed-merge paths — the accept reason
  // went up as a PR review body. It now lives on the `[Accepted]` task comment
  // and in the merge commit, and the PR hears nothing.
  test('accepting a task with a PR posts no review and no comment', async () => {
    const taskId = await taskWithPullRequest('Accept with a PR');

    expectSuccess(await ctx.lazy(['accept', taskId, '--reason', 'Looks good to me']));

    const kinds = forgeWrites().map((w) => w.kind);
    for (const forbidden of FORBIDDEN_KINDS) {
      expect(kinds).not.toContain(forbidden);
    }
  }, 120_000);

  // INVARIANT: with `[remote] auto_approve` off — the DEFAULT — accept submits
  // no approval either. The one surviving forge review is gated on that key
  // and on a protected target; nothing else may reach `approveForMerge`.
  test('accepting with auto_approve off submits no approval', async () => {
    const taskId = await taskWithPullRequest('Accept without auto_approve');

    expectSuccess(await ctx.lazy(['accept', taskId, '--reason', 'Fine']));

    expect(forgeWrites().map((w) => w.kind)).not.toContain('approve');
  }, 120_000);

  // INVARIANT: reject posts no requesting-changes review and no reject
  // comment. GitLab never had a request-changes state and used a `[Lazy
  // Reject]` note instead — that note was the notification, and it is gone.
  // The reason is recorded as the `[Rejected]` task comment. Closing the PR
  // still happens and is logged under its own `close` kind, so this assertion
  // stays narrow.
  test('rejecting a task with a PR posts no review and no comment', async () => {
    const taskId = await taskWithPullRequest('Reject with a PR');

    expectSuccess(await ctx.lazy(['reject', taskId, '--reason', 'Wrong approach', '--yes']));

    const kinds = forgeWrites().map((w) => w.kind);
    for (const forbidden of FORBIDDEN_KINDS) {
      expect(kinds).not.toContain(forbidden);
    }
    // POSITIVE CONTROL, and it carries the whole suite: an assertion that
    // nothing was written proves nothing if the mock driver was never active
    // or the log never worked. Reject closes the PR, so this run MUST record
    // exactly one `close` — seeing it is what makes the three absence
    // assertions above evidence rather than a tautology. If this line starts
    // failing, fix the seam before trusting any "no forge write" result here.
    expect(kinds).toEqual(['close']);
  }, 120_000);
});
