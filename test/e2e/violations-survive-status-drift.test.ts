/**
 * E2E regression test: a pending file-permission violation outlives the status
 * label — the SET is the source of truth, never `task.status`.
 *
 * THE INCIDENT (fix-ask-nukes-violations), observed live on task
 * `fix-cursor-action-required`:
 *
 *   1. the task sat in `conflict` with one pending violation;
 *   2. a `lazy_ask` — documented read-only — ran against it, and afterwards the
 *      task read `blocked` while the violation was still pending;
 *   3. every reviewer-facing guard keyed on the LABEL and so saw nothing to
 *      decide, while the daemon's revert read the SET and fired anyway,
 *      destroying the agent's committed test coverage.
 *
 * Since move-file-approval-to-accept there is no revert and no unblock-time
 * decision, so the destructive half of that incident cannot recur. The half
 * that still matters is the other one: a drifted label must not let a merge
 * through with an undecided protected file in it. That is what this file walks
 * now — the accept gate reads the violation set, whatever the label says.
 *
 * The drift of step 2 is seeded directly into storage rather than produced by a
 * real ask, deliberately: an ask is only ONE of the side-channel turns that can
 * park a paused task (sync, pairing teardown, stop, the reconciler's own flush
 * of an errored or timed-out ask all park too). Seeding the end state tests the
 * gate against the whole family, and against any future path that lets the
 * label drift again. `src/utils/paused-status.ts` and
 * test/unit/paused-status.test.ts cover the other half — deriving the label so
 * it does not drift in the first place.
 *
 * Harness notes as in permissions.test.ts: daemonless, so every followed turn is
 * `--follow` (wait for response.json) plus an explicit `runReconcile`.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { readFileSync, writeFileSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectError, expectOutputExcludes } from '../helpers/assertions';
import { createTask, disablePreAccept, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { runReconcile } from '../helpers/reconcile';
import { readTaskStatus, readTurns, setTaskStatus, worktreePathFor } from '../helpers/storage';
import { seedFinal } from '../helpers/final';

const ORIGINAL = 'describe("existing tests", () => {});\n';
const AGENT_WORK = 'describe("agent added coverage", () => { /* the work at stake */ });\n';

describe('violations survive a status-label drift', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    disablePreAccept(ctx.root);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /**
   * Drive a task into `conflict` with one pending violation on a protected
   * file, then seed the drift: park it as `blocked` with the violation still
   * pending — exactly the state the ask left behind.
   */
  async function driftedTask(): Promise<string> {
    // Edit the key init already wrote — appending a second [permissions] table
    // is a TOML redefinition error (see CLAUDE.md, "Storage and config in tests").
    const configPath = join(ctx.root, 'lazy.toml');
    const before = readFileSync(configPath, 'utf-8');
    const after = before.replace(
      /^# protected = \[.*\]$/m,
      'protected = ["*.spec.*"]',
    );
    expect(after).not.toBe(before);
    writeFileSync(configPath, after);
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable protected patterns');

    writeFileSync(join(ctx.root, 'test.spec.ts'), ORIGINAL);
    ctx.git('add', 'test.spec.ts');
    ctx.git('commit', '-m', 'Add existing test file');

    const taskId = await createTask(ctx, 'Fix something', 'Fix the bug');

    const mockFiles = JSON.stringify([{ path: 'test.spec.ts', content: AGENT_WORK }]);
    const startResult = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FILES: mockFiles } },
    );
    await runReconcile(ctx.root, ctx.protocolBase);
    expectSuccess(startResult);
    expect(readTaskStatus(ctx.root, taskId)).toBe('conflict');

    // Step 2 of the incident: the label is gone, the pending set is not.
    setTaskStatus(ctx.root, taskId, 'blocked');
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
    const pending = readTurns(ctx.root, taskId)
      .flatMap(t => t.violations ?? [])
      .filter(v => v.status === 'pending');
    expect(pending.map(v => v.file)).toEqual(['test.spec.ts']);

    return taskId;
  }
  // INVARIANT (approval-happens-at-accept): a drifted label changes nothing
  // about an unblock, because an unblock has no file decision to get wrong. The
  // agent's work survives, and what the reviewer owes survives with it.
  test('a drifted task unblocks normally and the agent work survives', async () => {
    const taskId = await driftedTask();

    const result = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Keep going', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      {},
    );
    await runReconcile(ctx.root, ctx.protocolBase);
    expectSuccess(result);
    expectOutputExcludes(result, 'Reverted');

    const content = readFileSync(join(worktreePathFor(ctx.root, taskId), 'test.spec.ts'), 'utf-8');
    expect(content).toBe(AGENT_WORK);

    const pending = readTurns(ctx.root, taskId)
      .flatMap(t => t.violations ?? [])
      .filter(v => v.status === 'pending');
    expect(pending.map(v => v.file)).toEqual(['test.spec.ts']);
  });

  // INVARIANT (violations-are-the-source-of-truth): the accept gate reads the
  // violation SET, not `task.status`. A task wearing `blocked` with a pending
  // violation must still be refused — otherwise the drift silently merges a
  // protected-file change nobody approved, which is the same incident with the
  // damage moved from the worktree to the target branch.
  test('accept is refused on a drifted task until the file is approved', async () => {
    const taskId = await driftedTask();
    // Fixture setup, not the subject (see test/helpers/final.ts). Daemonless
    // suite, so the final is seeded at the storage level.
    await seedFinal(ctx, taskId);

    const refused = await ctx.lazyMocked(['accept', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {});
    expectFailure(refused);
    expectError(refused, 'test.spec.ts');

    const content = readFileSync(join(worktreePathFor(ctx.root, taskId), 'test.spec.ts'), 'utf-8');
    expect(content).toBe(AGENT_WORK);

    const accepted = await ctx.lazyMocked(
      ['accept', taskId, '--approve-file', 'test.spec.ts', '--yes'],
      MOCK_CLAUDE_SUCCESS,
      {},
    );
    expectSuccess(accepted);
    expect(readFileSync(join(ctx.root, 'test.spec.ts'), 'utf-8')).toBe(AGENT_WORK);
  });
});
