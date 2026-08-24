/**
 * E2E regression test: a pending file-permission violation outlives the status
 * label, and the reviewer can always express the decision it demands.
 *
 * THE INCIDENT (fix-ask-nukes-violations), observed live on task
 * `fix-cursor-action-required`:
 *
 *   1. the task sat in `conflict` with one pending violation;
 *   2. a `lazy_ask` — documented read-only — ran against it, and afterwards the
 *      task read `blocked` while the violation was still pending;
 *   3. `lazy_unblock` WITH the approval was REFUSED — "this task has no file
 *      permission violations" — because that guard read `task.status`;
 *   4. the reviewer dropped the approval, unblocked, and the daemon's revert
 *      (which reads the violation SET, not the status) destroyed the agent's
 *      committed test coverage. Silently: the response said success.
 *
 * Steps 3 and 4 are the destructive half, and they are what this file walks.
 * The drift of step 2 is seeded directly into storage rather than produced by a
 * real ask, deliberately: an ask is only ONE of the side-channel turns that can
 * park a paused task (sync, pairing teardown, stop, the reconciler's own flush
 * of an errored or timed-out ask all park too). Seeding the end state tests the
 * daemon gate against the whole family, and against any future path that lets
 * the label drift again. `src/utils/paused-status.ts` and
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
import { expectSuccess, expectFailure, expectError, expectOutput } from '../helpers/assertions';
import { createTask, disablePreAccept, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { runReconcile } from '../helpers/reconcile';
import { readTaskStatus, readTurns, setTaskStatus, worktreePathFor } from '../helpers/storage';

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

  // INVARIANT: an unblock can never revert a file the caller was refused
  // permission to approve. If violations are pending, the approval MUST be
  // expressible — whatever the status label happens to say. This is the exact
  // call the incident refused, and refusing it is what led to the destruction.
  test('the approval is accepted on a drifted task, and the agent work survives', async () => {
    const taskId = await driftedTask();

    const result = await ctx.lazyMocked(
      ['unblock', taskId, '--approve-file', 'test.spec.ts', '--message', 'Keep the coverage', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      {},
    );
    await runReconcile(ctx.root, ctx.protocolBase);

    // Pre-fix this failed with "has no file permission violations. The
    // approved_files parameter is only meaningful for conflict tasks."
    expectSuccess(result);

    const violations = readTurns(ctx.root, taskId).flatMap(t => t.violations ?? []);
    expect(violations.find(v => v.file === 'test.spec.ts')!.status).toBe('approved');

    // The whole point: the agent's committed work is still there.
    const content = readFileSync(join(worktreePathFor(ctx.root, taskId), 'test.spec.ts'), 'utf-8');
    expect(content).toBe(AGENT_WORK);
  });

  // INVARIANT: the protection model is NOT weakened to make the above easy.
  // Omitting a decision is still refused, on a drifted task as on a `conflict`
  // one — a protected file the reviewer never ruled on must not be destroyed on
  // their behalf. Pre-fix this call SUCCEEDED and reverted the file.
  test('omitting a decision on a drifted task is refused, and nothing is touched', async () => {
    const taskId = await driftedTask();

    const refused = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Fix it without touching tests', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      {},
    );

    expectFailure(refused);
    expectError(refused, 'file permission violation');
    expectError(refused, 'test.spec.ts');

    const content = readFileSync(join(worktreePathFor(ctx.root, taskId), 'test.spec.ts'), 'utf-8');
    expect(content).toBe(AGENT_WORK);
  });

  // INVARIANT: reverting committed work is never silent. The reviewer asked for
  // the revert here, and the response still has to say what it destroyed —
  // naming the files is the only record the reviewer gets.
  test('an explicit revert-all reverts, and says so by name', async () => {
    const taskId = await driftedTask();

    const result = await ctx.lazyMocked(
      ['unblock', taskId, '--no-approve-files', '--message', 'Revert them', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      {},
    );
    await runReconcile(ctx.root, ctx.protocolBase);
    expectSuccess(result);

    expectOutput(result, 'Reverted');
    expectOutput(result, 'test.spec.ts');

    const content = readFileSync(join(worktreePathFor(ctx.root, taskId), 'test.spec.ts'), 'utf-8');
    expect(content).toBe(ORIGINAL);
  });
});
