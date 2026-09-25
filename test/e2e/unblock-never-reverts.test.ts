/**
 * E2E: unblock never reverts a protected file, and accept is the one gate.
 *
 * THE CHANGE (move-file-approval-to-accept, engineer decision 2026-09-13).
 * Until now an unblock of a `conflict` task REQUIRED an approve/revert decision
 * and reverted every pending file it was not told to keep. Two failures on one
 * night killed that design:
 *
 *   - a loop task had to send a mid-review nudge before it had read the
 *     violated files, passed `approved_files: []` because the parameter was
 *     mandatory, and destroyed the agent's protected test edits;
 *   - the engineer, wanting one small thing fixed mid-review, was forced to
 *     approve or reject files they had not looked at yet.
 *
 * Tasks run 5–20 turns, not one or two. A decision that only matters at merge
 * time is now made at merge time. This file walks the whole new contract:
 * feedback flows freely, content survives every turn, and `lazy accept` refuses
 * until every violated file is named.
 *
 * This REPLACES test/e2e/violation-approval-sticky.test.ts, whose steps 4 and 5
 * (re-approving at unblock, and the silent revert when you did not) describe
 * calls that no longer exist. The stickiness half it pinned survives here as
 * "accept promotes pending → approved and reverts nothing".
 *
 * Harness notes as in permissions.test.ts: daemonless, so every followed turn is
 * `--follow` (wait for response.json) plus an explicit `runReconcile`.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { readFileSync, writeFileSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectError, expectOutputExcludes } from '../helpers/assertions';
import { createTask, disablePreAccept, MOCK_CLAUDE_SUCCESS, setProtectedPatterns } from '../helpers/fixtures';
import { runReconcile } from '../helpers/reconcile';
import { readTaskStatus, readTurns, writeTurns, worktreePathFor } from '../helpers/storage';
import { seedFinal } from '../helpers/final';

const ORIGINAL_A = 'describe("existing A", () => {});\n';
const ORIGINAL_B = 'describe("existing B", () => {});\n';
const AGENT_A = 'describe("agent coverage A", () => { /* the work at stake */ });\n';
const AGENT_B = 'describe("agent coverage B", () => { /* later work */ });\n';

describe('unblock never reverts a protected file', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    disablePreAccept(ctx.root);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function violations(taskId: string) {
    return readTurns(ctx.root, taskId).flatMap(t => t.violations ?? []);
  }

  function pendingFiles(taskId: string): string[] {
    return violations(taskId).filter(v => v.status === 'pending').map(v => v.file);
  }

  function fileInWorktree(taskId: string, file: string): string {
    return readFileSync(join(worktreePathFor(ctx.root, taskId), file), 'utf-8');
  }

  /** A task in `conflict` with one pending violation on `a.spec.ts`. */
  async function arrange(): Promise<string> {
    setProtectedPatterns(ctx.root, ['*.spec.*']);
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable protected patterns');

    writeFileSync(join(ctx.root, 'a.spec.ts'), ORIGINAL_A);
    writeFileSync(join(ctx.root, 'b.spec.ts'), ORIGINAL_B);
    ctx.git('add', 'a.spec.ts', 'b.spec.ts');
    ctx.git('commit', '-m', 'Add existing test files');

    const taskId = await createTask(ctx, 'Fix something', 'Fix the bug');

    const started = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      {
        env: {
          LAZY_MOCK_SHOULD_COMMIT: '1',
          LAZY_MOCK_FILES: JSON.stringify([{ path: 'a.spec.ts', content: AGENT_A }]),
        },
      },
    );
    await runReconcile(ctx.root, ctx.protocolBase);
    expectSuccess(started);
    expect(readTaskStatus(ctx.root, taskId)).toBe('conflict');
    expect(pendingFiles(taskId)).toEqual(['a.spec.ts']);

    // Fixture setup, not the subject (see test/helpers/final.ts): the suite's
    // accepts test the file-approval gate, which fires before the finality gate.
    seedFinal(ctx, taskId);

    return taskId;
  }

  // INVARIANT (approval-happens-at-accept): an unblock carrying no file
  // decision is a normal unblock. Pre-change this call was REFUSED ("has N file
  // permission violations... pass approvedFiles"), and the only accepted
  // spelling of "I am not ready to decide" reverted the file.
  test('a conflict task unblocks with plain feedback, and the content survives', async () => {
    const taskId = await arrange();

    const result = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Now update the docs', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      {},
    );
    await runReconcile(ctx.root, ctx.protocolBase);
    expectSuccess(result);

    expectOutputExcludes(result, 'Reverted');
    expect(fileInWorktree(taskId, 'a.spec.ts')).toBe(AGENT_A);
    // Still owed — deferred, not decided.
    expect(pendingFiles(taskId)).toEqual(['a.spec.ts']);
  });

  // The motivating failure: a reviewer (or a loop agent) nudging repeatedly
  // before reading the files. Every one of these used to need a decision, and
  // any wrong answer was unrecoverable.
  test('repeated unblocks leave the file untouched every time', async () => {
    const taskId = await arrange();

    for (const message of ['Keep going', 'Also check the CLI', 'Now write it up']) {
      const result = await ctx.lazyMocked(
        ['unblock', taskId, '--message', message, '--follow'],
        MOCK_CLAUDE_SUCCESS,
        {},
      );
      await runReconcile(ctx.root, ctx.protocolBase);
      expectSuccess(result);
      expect(fileInWorktree(taskId, 'a.spec.ts')).toBe(AGENT_A);
    }
    expect(pendingFiles(taskId)).toEqual(['a.spec.ts']);
  });

  // INVARIANT: the retired flags are REMOVED, not ignored. `--no-approve-files`
  // used to revert everything pending; a script still passing it must be told,
  // and told where the decision now lives.
  test('the retired unblock flags error and name accept', async () => {
    const taskId = await arrange();

    for (const flag of [['--approve-file', 'a.spec.ts'], ['--no-approve-files']]) {
      const refused = await ctx.lazyMocked(
        ['unblock', taskId, ...flag, '--message', 'decide now', '--follow'],
        MOCK_CLAUDE_SUCCESS,
        {},
      );
      expectFailure(refused);
      expectError(refused, 'lazy accept');
      expect(fileInWorktree(taskId, 'a.spec.ts')).toBe(AGENT_A);
    }
  });

  // INVARIANT: deferring the decision is not skipping it. Accept is
  // all-or-nothing and reverts nothing — an undecided file refuses the merge.
  test('accept refuses until the violated file is named, and touches nothing', async () => {
    const taskId = await arrange();

    const refused = await ctx.lazyMocked(['accept', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {});
    expectFailure(refused);
    expectError(refused, 'a.spec.ts');

    expect(fileInWorktree(taskId, 'a.spec.ts')).toBe(AGENT_A);
    expect(pendingFiles(taskId)).toEqual(['a.spec.ts']);
  });

  test('accept with the file approved merges the agent content', async () => {
    const taskId = await arrange();

    const accepted = await ctx.lazyMocked(
      ['accept', taskId, '--approve-file', 'a.spec.ts', '--yes'],
      MOCK_CLAUDE_SUCCESS,
      {},
    );
    expectSuccess(accepted);

    expect(violations(taskId).find(v => v.file === 'a.spec.ts')!.status).toBe('approved');
    expect(readFileSync(join(ctx.root, 'a.spec.ts'), 'utf-8')).toBe(AGENT_A);
  });

  // INVARIANT (the gate is whole-branch — move-file-approval-to-accept): an
  // earlier turn's protected edit still gates the merge, however many turns run
  // after it. Detection is per-TURN (turn-start-SHA..HEAD), so turn 2's record
  // is about turn 2 only; reading it as the whole story let `--approve-file
  // b.spec.ts` merge an `a.spec.ts` change nobody had looked at.
  //
  // This asserts what ACCEPT reads, through the CLI. An earlier version of this
  // test checked a helper that flattened `violations` across all turns — which
  // is not what the gate read, so it passed against the bug.
  test('an earlier turn\'s violated file still gates accept', async () => {
    const taskId = await arrange();

    const second = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Also touch B', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      {
        env: {
          LAZY_MOCK_SHOULD_COMMIT: '1',
          LAZY_MOCK_FILES: JSON.stringify([{ path: 'b.spec.ts', content: AGENT_B }]),
        },
      },
    );
    await runReconcile(ctx.root, ctx.protocolBase);
    expectSuccess(second);

    // The discriminating call: approve ONLY the newest file.
    const partial = await ctx.lazyMocked(
      ['accept', taskId, '--approve-file', 'b.spec.ts', '--yes'],
      MOCK_CLAUDE_SUCCESS,
      {},
    );
    expectFailure(partial);
    expectError(partial, 'a.spec.ts');
    // Nothing merged: the parent still has the original content of both.
    expect(readFileSync(join(ctx.root, 'a.spec.ts'), 'utf-8')).toBe(ORIGINAL_A);

    // And the other way round, for symmetry.
    // Fixture setup, not the subject (see test/helpers/final.ts): the
    // fully-approved accept below needs the gate's standing final.
    seedFinal(ctx, taskId);
    const other = await ctx.lazyMocked(
      ['accept', taskId, '--approve-file', 'a.spec.ts', '--yes'],
      MOCK_CLAUDE_SUCCESS,
      {},
    );
    expectFailure(other);
    expectError(other, 'b.spec.ts');

    const accepted = await ctx.lazyMocked(
      ['accept', taskId, '--approve-file', 'a.spec.ts', '--approve-file', 'b.spec.ts', '--yes'],
      MOCK_CLAUDE_SUCCESS,
      {},
    );
    expectSuccess(accepted);
    expect(readFileSync(join(ctx.root, 'a.spec.ts'), 'utf-8')).toBe(AGENT_A);
    expect(readFileSync(join(ctx.root, 'b.spec.ts'), 'utf-8')).toBe(AGENT_B);
  });

  // INVARIANT: a later turn's authoritative EMPTY re-detect cannot clear an
  // earlier pending file. A turn that touches no protected file records
  // `violations: []`, which storage persists as a real observation about that
  // turn's range — read as the whole story it parked the task `blocked`, showed
  // the reviewer nothing owed, and merged turn 1's protected edit in silence.
  //
  // The empty record is seeded rather than provoked: which later turn records
  // one depends on the push-back/nudge sequence, and the state itself is what
  // matters. Same technique as the nudge fixtures in permissions.test.ts.
  test('an empty re-detect on a later turn does not clear an earlier file', async () => {
    const taskId = await arrange();

    const turns = readTurns(ctx.root, taskId);
    const nextSeq = Math.max(...turns.map(t => Number(t.sequence ?? 0))) + 1;
    writeTurns(ctx.root, taskId, [
      ...turns,
      { role: 'human', content: 'carry on', sequence: nextSeq },
      { role: 'agent', content: 'nothing protected this time', sequence: nextSeq + 1, violations: [] },
    ]);

    const refused = await ctx.lazyMocked(['accept', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {});
    expectFailure(refused);
    expectError(refused, 'a.spec.ts');
    expect(readFileSync(join(ctx.root, 'a.spec.ts'), 'utf-8')).toBe(ORIGINAL_A);

    const accepted = await ctx.lazyMocked(
      ['accept', taskId, '--approve-file', 'a.spec.ts', '--yes'],
      MOCK_CLAUDE_SUCCESS,
      {},
    );
    expectSuccess(accepted);
    expect(readFileSync(join(ctx.root, 'a.spec.ts'), 'utf-8')).toBe(AGENT_A);
  });

  // The mirror of the two above: a file the AGENT reverted itself is not in the
  // branch diff any more, so the whole-branch scan drops it and accept must not
  // keep asking about a change that is no longer there.
  test('a file the agent reverted itself stops gating accept', async () => {
    const taskId = await arrange();

    const reverted = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Please put the tests back', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      {
        env: {
          LAZY_MOCK_SHOULD_COMMIT: '1',
          // Plus one ordinary file, so the branch still has something to merge
          // once the protected change is gone.
          LAZY_MOCK_FILES: JSON.stringify([
            { path: 'a.spec.ts', content: ORIGINAL_A },
            { path: 'fix.ts', content: 'export const fix = true;\n' },
          ]),
        },
      },
    );
    await runReconcile(ctx.root, ctx.protocolBase);
    expectSuccess(reverted);
    expect(fileInWorktree(taskId, 'a.spec.ts')).toBe(ORIGINAL_A);

    // Nothing named, nothing refused — there is no protected change left.
    // Fixture setup, not the subject (see test/helpers/final.ts).
    seedFinal(ctx, taskId);
    const accepted = await ctx.lazyMocked(['accept', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {});
    expectSuccess(accepted);
    expect(readFileSync(join(ctx.root, 'a.spec.ts'), 'utf-8')).toBe(ORIGINAL_A);
  });
});
