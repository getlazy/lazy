/**
 * E2E: a task that absorbed accepted subtasks is not re-asked about THEIR
 * protected files.
 *
 * THE REGRESSION (move-file-approval-to-accept, round 3). Moving the decision to
 * accept meant the gate had to stop reading one turn's record and re-detect over
 * git instead. The first cut of that scan took its range from
 * `resolveTaskDiffBase` — the WHOLE branch — and a parent's branch CONTAINS
 * every accepted child's squash. So a hub was gated on every protected file any
 * child had touched, each of which was already approved at that child's own
 * accept, on that child's own records. On a project protecting every `.ts` under `test/`
 * that is a refusal naming hundreds of files, on every release, plus a hub that
 * parks in `conflict` after every turn and a review page listing all of them.
 *
 * The gate now scans the task's DIRECT changes — `resolveTaskDirectDiff`, the
 * same range `lazy diff` and the review page show — so a reviewer is asked about
 * exactly what they are looking at. For a task with no accepted children the two
 * ranges are identical, which is why nothing else in this suite's siblings
 * changed.
 *
 * Needs a real daemon: accepting a child is what puts the child's squash on the
 * parent's branch, and only the reconciler moves a task out of `working`.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectError } from '../helpers/assertions';
import { createTask, disablePreAccept, MOCK_CLAUDE_SUCCESS, setProtectedPatterns } from '../helpers/fixtures';
import { seedFinal, markAgentLaunched } from '../helpers/final';
import { readTurns } from '../helpers/storage';

const ORIGINAL_A = 'describe("existing A", () => {});\n';
const ORIGINAL_B = 'describe("existing B", () => {});\n';
const CHILD_A = 'describe("the child changed this", () => {});\n';
const PARENT_B = 'describe("the parent changed this", () => {});\n';

describe('accept does not re-ask about an accepted child\'s protected files', () => {
  let ctx: TestContext;

  /** Existence declares final for the next mocked turn — the daemon reads the
   *  path from its own env, so the FILE is the per-turn switch. */
  let finalFlag: string;

  beforeEach(async () => {
    finalFlag = join(tmpdir(), `lazy-hub-pf-final-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    ctx = await setupTestLazy({
      // INVARIANT: mock switches ride the DAEMON env — the withDaemon mock runs
      // inside the daemon process, and per-invocation env never reaches it.
      withDaemon: true,
      // SHOULD_COMMIT because the push-back step only scans a turn that moved
      // HEAD — no work, no window. The default mock commit is a uniquely-named
      // .txt, which no protected pattern here matches, so it gives every turn a
      // window without adding a violation.
      daemonEnv: { LAZY_MOCK_FINAL: finalFlag, LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    disablePreAccept(ctx.root);

    setProtectedPatterns(ctx.root, ['*.spec.*']);
    writeFileSync(join(ctx.root, 'a.spec.ts'), ORIGINAL_A);
    writeFileSync(join(ctx.root, 'b.spec.ts'), ORIGINAL_B);
    ctx.git('add', 'lazy.toml', 'a.spec.ts', 'b.spec.ts');
    ctx.git('commit', '-m', 'Protect specs and seed two spec files');
  });

  afterEach(async () => {
    rmSync(finalFlag, { force: true });
    await ctx.cleanup();
  });

  /**
   * Run the task's own FINAL turn, so its wrap-up chain — and with it the
   * protected-file push-back — actually executes.
   *
   * Not `seedFinal`: that records a standing claim without running anything,
   * which is right for a fixture but cannot produce the push-back exchange a
   * test about the push-back needs. Declaring used to have a command of its
   * own that ran a wrap-up turn; it does not any more, so the only way to a
   * final turn is to take one.
   */
  async function takeFinalTurn(taskId: string, message: string): Promise<void> {
    writeFileSync(finalFlag, '');
    try {
      expectSuccess(await ctx.lazy(['unblock', taskId, '--message', message]));
      await waitForTask(taskId);
    } finally {
      rmSync(finalFlag, { force: true });
    }
  }

  async function waitForTask(taskId: string): Promise<void> {
    const result = await ctx.lazy(['wait', taskId]);
    if (result.exitCode !== 0) {
      throw new Error(`wait failed for ${taskId}: ${result.stderr}\n${result.stdout}`);
    }
  }

  function worktreeWrite(taskId: string, file: string, content: string, message: string): void {
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    writeFileSync(join(worktreePath, file), content);
    expect(ctx.git('-C', worktreePath, 'add', file).exitCode).toBe(0);
    expect(ctx.git('-C', worktreePath, 'commit', '-m', message).exitCode).toBe(0);
  }

  /**
   * A started parent with one started child that changed `a.spec.ts`, and the
   * child accepted into the parent with that file approved.
   */
  async function parentWithAcceptedChild(): Promise<string> {
    const parentId = await createTask(ctx, 'Hub', 'Parent work');
    expectSuccess(await ctx.lazyMocked(['start', parentId, '--yes'], MOCK_CLAUDE_SUCCESS));
    await waitForTask(parentId);

    const branched = await ctx.lazyMocked(
      ['branch', parentId, '--goal', 'Child', '--prompt', 'Child work', '--yes'],
      MOCK_CLAUDE_SUCCESS,
    );
    expectSuccess(branched);
    const childId = branched.stdout.match(/Created variant task ([a-f0-9]{8})/)![1];
    await waitForTask(childId);

    // The child's own protected change, committed on the child's branch.
    worktreeWrite(childId, 'a.spec.ts', CHILD_A, 'Child rewrites a protected spec');

    // Fixture setup, not the subject (see test/helpers/final.ts): both accepts
    // here are ordinary accepts the gate must let through.
    await seedFinal(ctx, childId);

    // Decided HERE, at the child's own accept, and nowhere else.
    const childAccept = await ctx.lazy(['accept', childId, '--approve-file', 'a.spec.ts', '--yes']);
    expectSuccess(childAccept);

    return parentId;
  }

  // INVARIANT (the gate scans the task's DIRECT changes): the child's approved
  // file is on the parent's branch, but it is not the parent's decision to make
  // twice. Pre-fix this accept was refused naming `a.spec.ts`.
  test('a parent whose only protected change came from a child accepts cleanly', async () => {
    const parentId = await parentWithAcceptedChild();

    // The parent needs a change of its own to have anything to merge.
    worktreeWrite(parentId, 'notes.txt', 'hub notes\n', 'Hub notes');

    // Fixture setup, not the subject (see test/helpers/final.ts).
    await seedFinal(ctx, parentId);

    const accepted = await ctx.lazy(['accept', parentId, '--yes']);
    expectSuccess(accepted);
    const output = accepted.stdout + accepted.stderr;
    expect(output).not.toContain('a.spec.ts');
    expect(output).not.toContain('file permission violation');

    // The child's content really did merge — this is not "clean because empty".
    expect(readFileSync(join(ctx.root, 'a.spec.ts'), 'utf-8')).toBe(CHILD_A);
  });

  /**
   * Same shape as `parentWithAcceptedChild`, but the child's work was launched
   * by an AGENT (the record an MCP start writes), so the child is
   * agent-audience (final-turn design §13.3). Its final runs no wrap-up steps
   * at all — nobody ever asked about its protected file.
   */
  async function parentWithAcceptedAgentChild(): Promise<string> {
    const parentId = await createTask(ctx, 'Hub', 'Parent work');
    expectSuccess(await ctx.lazyMocked(['start', parentId, '--yes'], MOCK_CLAUDE_SUCCESS));
    await waitForTask(parentId);

    const branched = await ctx.lazyMocked(
      ['branch', parentId, '--goal', 'Child', '--prompt', 'Child work', '--yes'],
      MOCK_CLAUDE_SUCCESS,
    );
    expectSuccess(branched);
    const childId = branched.stdout.match(/Created variant task ([a-f0-9]{8})/)![1];
    await waitForTask(childId);

    worktreeWrite(childId, 'a.spec.ts', CHILD_A, 'Child rewrites a protected spec');

    // The audience seed (see test/helpers/final.ts) — then the final.
    markAgentLaunched(ctx, childId);
    await seedFinal(ctx, childId);

    // This fixture seeds a claim directly rather than running another work
    // turn, so no push-back exchange has happened for a.spec.ts.
    const childTurns = readTurns(ctx.root, childId);
    expect(childTurns.some(t => String(t.content).includes('## Permission Violation Review'))).toBe(false);

    const childAccept = await ctx.lazy(['accept', childId, '--approve-file', 'a.spec.ts', '--yes']);
    expectSuccess(childAccept);

    return parentId;
  }

  // INVARIANT: an AGENT-audience child's protected-file record is not a human
  // approval, so the question is DEFERRED to the hub's review, not dropped. The hub changed
  // nothing itself, which is exactly the shape the pre-slice-4 shortcut
  // "a hub with no direct changes owes nothing" accepted silently: the
  // push-back asked the agent once during the hub's final, but the gate
  // cleared the question without any human decision. The deferred-child union
  // keeps it outstanding: the gate refuses until someone approves.
  test('an agent-audience child\'s protected file is deferred to the hub\'s accept', async () => {
    const parentId = await parentWithAcceptedAgentChild();

    // The hub's own FINAL TURN: its push-back step scans the whole branch
    // range and detects the child's deferred file — the agent gets its one
    // chance to revert or justify (design line 503), recorded on the hub's own
    // turns. A real turn, because the push-back is a wrap-up step and a seeded
    // claim runs no steps.
    await takeFinalTurn(parentId, 'Wrap it up');
    const parentTurns = readTurns(ctx.root, parentId);
    expect(parentTurns.some(t => String(t.content).includes('## Permission Violation Review'))).toBe(true);

    // The gate keeps the question alive where the shortcut would have cleared
    // it — the refusal names exactly the child's file, not the untouched one.
    const refused = await ctx.lazy(['accept', parentId, '--yes']);
    expectFailure(refused);
    expectError(refused, 'a.spec.ts');
    expect(refused.stdout + refused.stderr).not.toContain('b.spec.ts');

    // The human decides at the hub's accept, where the work is reviewed.
    // `--allow-review-issues` because the hub's final dispatched an auto-review
    // and the mock reviewer produces no readable verdict — the override a human
    // uses when they have read the work themselves, not part of this subject.
    const accepted = await ctx.lazy([
      'accept', parentId, '--approve-file', 'a.spec.ts', '--allow-review-issues', '--yes',
    ]);
    expectSuccess(accepted);

    // The child's content really merged — this is not "refused because empty".
    expect(readFileSync(join(ctx.root, 'a.spec.ts'), 'utf-8')).toBe(CHILD_A);
  });

  // The other half, and the reason this is scoped rather than switched off: a
  // protected file the PARENT changed is still its own decision, sitting right
  // next to the child's file that is not.
  test('a protected file the parent changed itself still gates its accept', async () => {
    const parentId = await parentWithAcceptedChild();

    worktreeWrite(parentId, 'b.spec.ts', PARENT_B, 'Hub rewrites its own protected spec');

    // Fixture setup, not the subject (see test/helpers/final.ts).
    await seedFinal(ctx, parentId);

    const refused = await ctx.lazy(['accept', parentId, '--yes']);
    expectFailure(refused);
    expectError(refused, 'b.spec.ts');
    // Named neither in the refusal nor in the command it suggests.
    expect(refused.stdout + refused.stderr).not.toContain('a.spec.ts');

    const accepted = await ctx.lazy(['accept', parentId, '--approve-file', 'b.spec.ts', '--yes']);
    expectSuccess(accepted);
    expect(readFileSync(join(ctx.root, 'b.spec.ts'), 'utf-8')).toBe(PARENT_B);
    expect(readFileSync(join(ctx.root, 'a.spec.ts'), 'utf-8')).toBe(CHILD_A);
  });
});
