/**
 * E2E regression test: a reviewer's approval of protected-file violations
 * SURVIVES the next unblock.
 *
 * THE INCIDENT (fix-violation-approval-sticky), observed twice in two days on
 * task `harden-approval-passphrase` (21 protected test files):
 *
 *   1. a turn changed 21 protected files → 21 pending violations, `conflict`;
 *   2. the reviewer unblocked with all 21 approved → kept. Correct;
 *   3. the NEXT turn was verification-only — it changed no file, so it recorded
 *      no violations of its own, and `latestViolationTurn` still pointed at the
 *      already-decided set from step 1;
 *   4. the reviewer unblocked again, re-passing all 21 to keep them. REFUSED:
 *      "has no file permission violations" — the guard counted only `pending`;
 *   5. so they re-issued without the parameter, the only call left. It
 *      succeeded and reverted all 21 files: every approved record was
 *      recomputed as `rejected` because absence of the parameter was read as
 *      "revert everything".
 *
 * Steps 4 and 5 are the bug and both are walked here. The contract they now
 * satisfy: an unblock decides the PENDING violations only, a decision already
 * made is never undone by a later call that says nothing about it, and naming
 * an already-approved file is always accepted.
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
import { readTurns, worktreePathFor } from '../helpers/storage';

const ORIGINAL_A = 'describe("existing A", () => {});\n';
const ORIGINAL_B = 'describe("existing B", () => {});\n';
const AGENT_A = 'describe("agent coverage A", () => { /* the work at stake */ });\n';
const AGENT_B = 'describe("agent coverage B", () => { /* later work */ });\n';

describe('protected-file approval is sticky across unblocks', () => {
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

  function fileInWorktree(taskId: string, file: string): string {
    return readFileSync(join(worktreePathFor(ctx.root, taskId), file), 'utf-8');
  }

  /**
   * Steps 1–3 of the incident: the agent changes a protected file, the reviewer
   * approves it, and a further turn runs that touches no protected file at all.
   * Leaves the task with an APPROVED violation and nothing pending.
   */
  async function arrange(): Promise<string> {
    setProtectedPatterns(ctx.root, ['*.spec.*']);
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable protected patterns');

    writeFileSync(join(ctx.root, 'a.spec.ts'), ORIGINAL_A);
    writeFileSync(join(ctx.root, 'b.spec.ts'), ORIGINAL_B);
    ctx.git('add', 'a.spec.ts', 'b.spec.ts');
    ctx.git('commit', '-m', 'Add existing test files');

    const taskId = await createTask(ctx, 'Fix something', 'Fix the bug');

    // Step 1: the agent rewrites a protected test file → pending violation.
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
    expect(violations(taskId).filter(v => v.status === 'pending').map(v => v.file)).toEqual(['a.spec.ts']);

    // Step 2: the reviewer approves it. Step 3: the turn this launches is
    // verification-only — it commits nothing, so it records no violations and
    // the decided set from step 1 stays the latest violation turn.
    const approved = await ctx.lazyMocked(
      ['unblock', taskId, '--approve-file', 'a.spec.ts', '--message', 'Keep the coverage', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      {},
    );
    await runReconcile(ctx.root, ctx.protocolBase);
    expectSuccess(approved);
    expect(violations(taskId).find(v => v.file === 'a.spec.ts')!.status).toBe('approved');
    expect(fileInWorktree(taskId, 'a.spec.ts')).toBe(AGENT_A);

    return taskId;
  }

  // INVARIANT (approval-is-sticky): an unblock decides the PENDING violations
  // only. Silence about an already-approved file is NOT a decision to revert it.
  //
  // WHY: violations live on the violation TURN, and a turn that touches no
  // protected file records none — so `latestViolationTurn` still points at the
  // decided set. Recomputing every record from `approvedFiles` alone re-labelled
  // every APPROVED violation `rejected` and git-reverted the agent's committed
  // work, with the response reading as a plain success. This is step 5 of the
  // incident, and it fired twice on one real task.
  test('an unblock with no decision does not revert already-approved files', async () => {
    const taskId = await arrange();

    const result = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Now update the docs', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      {},
    );
    await runReconcile(ctx.root, ctx.protocolBase);
    expectSuccess(result);

    // Pre-fix: "Reverted 1 protected file(s): a.spec.ts".
    expectOutputExcludes(result, 'Reverted');
    expect(violations(taskId).find(v => v.file === 'a.spec.ts')!.status).toBe('approved');
    expect(fileInWorktree(taskId, 'a.spec.ts')).toBe(AGENT_A);
  });

  // INVARIANT: re-asserting a decision is always expressible. There must be no
  // state in which the daemon REFUSES approvedFiles and then reverts — that
  // pairing is what left the reviewer with the destructive call as their only
  // option. This is step 4 of the incident: pre-fix it failed with "has no file
  // permission violations", because the guard counted only pending records.
  test('re-approving an already-approved file is accepted and keeps it', async () => {
    const taskId = await arrange();

    const result = await ctx.lazyMocked(
      ['unblock', taskId, '--approve-file', 'a.spec.ts', '--message', 'Still approved', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      {},
    );
    await runReconcile(ctx.root, ctx.protocolBase);
    expectSuccess(result);

    expectOutputExcludes(result, 'Reverted');
    expect(violations(taskId).find(v => v.file === 'a.spec.ts')!.status).toBe('approved');
    expect(fileInWorktree(taskId, 'a.spec.ts')).toBe(AGENT_A);
  });

  // INVARIANT: stickiness does NOT weaken the pending gate (commit 8beef66b).
  // A file the reviewer has never ruled on still demands a decision, even when
  // the same task already has approved records sitting beside it.
  test('a NEW violation still refuses an unblock that gives no decision', async () => {
    const taskId = await arrange();

    // A later turn changes a DIFFERENT protected file → fresh pending violation.
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
    expect(violations(taskId).filter(v => v.status === 'pending').map(v => v.file)).toEqual(['b.spec.ts']);

    const refused = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Carry on', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      {},
    );
    expectFailure(refused);
    expectError(refused, 'b.spec.ts');

    // Nothing was touched by the refusal — neither the new file nor the old
    // approval.
    expect(fileInWorktree(taskId, 'a.spec.ts')).toBe(AGENT_A);
    expect(fileInWorktree(taskId, 'b.spec.ts')).toBe(AGENT_B);
  });

  // INVARIANT: `[]` / --no-approve-files still means "revert everything
  // PENDING" — the documented escape hatch. It reverts the undecided file and
  // leaves the earlier approval alone; a reviewer rejecting today's change is
  // not retracting yesterday's approval.
  test('--no-approve-files reverts only the pending file, not the approved one', async () => {
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

    const reverted = await ctx.lazyMocked(
      ['unblock', taskId, '--no-approve-files', '--message', 'Revert B', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      {},
    );
    await runReconcile(ctx.root, ctx.protocolBase);
    expectSuccess(reverted);

    expect(fileInWorktree(taskId, 'b.spec.ts')).toBe(ORIGINAL_B);
    expect(fileInWorktree(taskId, 'a.spec.ts')).toBe(AGENT_A);
    expect(violations(taskId).find(v => v.file === 'a.spec.ts')!.status).toBe('approved');
  });

  // INVARIANT: accept never re-labels or reverts an already-decided violation.
  // The unblock bug was "absence means revert"; accept's rule is different (it
  // only promotes `pending` → `approved`), and this proves it by execution
  // rather than by reading the tool description.
  test('accept with no --approve-file keeps the earlier approval and its content', async () => {
    const taskId = await arrange();

    // Mocked: accept generates a merge description via a one-shot agent call.
    const result = await ctx.lazyMocked(['accept', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {});
    expectSuccess(result);

    expect(violations(taskId).find(v => v.file === 'a.spec.ts')!.status).toBe('approved');
    // The approved content really merged — the accept did not quietly revert it.
    expect(readFileSync(join(ctx.root, 'a.spec.ts'), 'utf-8')).toBe(AGENT_A);
  });
});
