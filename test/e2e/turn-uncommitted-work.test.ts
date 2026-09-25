/**
 * E2E: work a turn leaves in the worktree is REPORTED, not silently dropped.
 *
 * The failure this suite pins down happened four times in one cluster, in four
 * separate containers: the agent's main work committed fine, then the
 * end-of-turn maintained-files check wrote a doc and never committed it. The
 * task parked looking finished, the file was in no commit — so in no diff, no
 * walkthrough, and nothing accept would merge — and each time it was caught
 * only because a human ran `git status` by hand. In one case the loose file was
 * the published troubleshooting page, whose whole purpose was to stop
 * docs.getlazy.dev asserting a cause the same diff had walked back.
 *
 * The mock leaves the file (LAZY_MOCK_LEAVE_UNCOMMITTED simulates the AGENT,
 * not lazy); everything after that — the turn record, `lazy show`, the accept
 * refusal — runs for real against a genuinely dirty worktree.
 *
 * Daemonless, so each followed turn is the usual two-step: `--follow` waits for
 * the mock supervisor's response, `runReconcile` records it.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeFileSync, rmSync, readFileSync, existsSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS, disablePreAccept } from '../helpers/fixtures';
import { runReconcile } from '../helpers/reconcile';
import { readTurns, worktreePathFor } from '../helpers/storage';

describe('a turn that ends with uncommitted work', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    disablePreAccept(ctx.root);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function runTurnLeaving(paths: string): Promise<string> {
    const taskId = await createTask(ctx, 'Work with a loose file', 'Do the work');
    const result = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      {
        env: {
          LAZY_MOCK_SHOULD_COMMIT: '1',
          LAZY_MOCK_FILES: JSON.stringify([{ path: 'src/feature.ts', content: 'export const f = 1;\n' }]),
          LAZY_MOCK_LEAVE_UNCOMMITTED: paths,
        },
      },
    );
    expectSuccess(result);
    await runReconcile(ctx.root, ctx.protocolBase);
    return taskId;
  }

  // INVARIANT (turn-end-dirty-worktree-loss): the paths a turn left uncommitted
  // are ON THE TURN RECORD. Before this, the only way to learn that a task was
  // parked on top of work that would never merge was to open its container and
  // run `git status` — which is how all four losses were found, one at a time.
  test('records the loose paths on the turn, and the committed work is unaffected', async () => {
    const taskId = await runTurnLeaving('public-docs/troubleshooting.md');

    const workTurn = readTurns(ctx.root, taskId).find(t => t.role === 'agent');
    expect(workTurn).toBeDefined();
    expect(workTurn!.uncommitted).toEqual(['public-docs/troubleshooting.md']);
  });

  // A clean turn records NOTHING. The field's presence is the alarm, so a turn
  // that committed everything must not carry an empty one — a reader (or a
  // script) reading `uncommitted: []` as a checked-and-clean guarantee would be
  // trusting a `git status` that can also simply fail.
  test('a turn that commits everything records no field at all', async () => {
    const taskId = await createTask(ctx, 'Tidy work', 'Do the work');
    const result = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(result);
    await runReconcile(ctx.root, ctx.protocolBase);

    const workTurn = readTurns(ctx.root, taskId).find(t => t.role === 'agent');
    expect(workTurn!.uncommitted).toBeUndefined();
  });

  test('`lazy show --full` names the paths and says they are not on the branch', async () => {
    const taskId = await runTurnLeaving('public-docs/troubleshooting.md,notes/scratch.md');

    const show = await ctx.lazy(['show', taskId, '--full']);
    expectSuccess(show);
    expectOutput(show, 'public-docs/troubleshooting.md');
    expectOutput(show, 'notes/scratch.md');
    expectOutput(show, 'not on the branch');
    // The count rides on the turn header too, for a reader who is only skimming.
    expectOutput(show, '2 uncommitted');
  });

  test('accept refuses, naming the file the turn left behind', async () => {
    const taskId = await runTurnLeaving('public-docs/troubleshooting.md');

    const accept = await ctx.lazy(['accept', taskId]);
    expectFailure(accept, 1);
    expectError(accept, 'public-docs/troubleshooting.md');
    expectError(accept, 'None of it is on the branch');
  });

  /**
   * THE RESTORE, END TO END — the one path that exercises the whole chain at
   * once: the capture (including an untracked file's CONTENT), the trailing
   * newline `git apply` needs, and the staleness bound that decides whether the
   * patch may be replayed at all.
   *
   * Nothing covered this block before, which is how a dead restore shipped
   * green twice over: first because every stored patch was trimmed and
   * unappliable, then because the bound added to stop an OLD snapshot being
   * replayed counted the turn's own wrap-up nudge replies as later work and
   * made every snapshot stale the moment it was written.
   */
  test('a recreated worktree gets the loose file back, content and all', async () => {
    const taskId = await runTurnLeaving('public-docs/troubleshooting.md');
    const worktree = worktreePathFor(ctx.root, taskId);
    const loose = join(worktree, 'public-docs/troubleshooting.md');
    const saved = readFileSync(loose, 'utf-8');

    // The worktree goes clean, as a recreated container's would be. This is
    // the precondition the restore requires — it never overwrites live work.
    rmSync(join(worktree, 'public-docs'), { recursive: true, force: true });
    expect(existsSync(loose)).toBe(false);

    const unblock = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'You left a file behind — commit it.'],
      MOCK_CLAUDE_SUCCESS,
    );
    expectSuccess(unblock);

    // Back, and byte-identical: an untracked file's CONTENT is in the snapshot,
    // not just its name.
    expect(existsSync(loose)).toBe(true);
    expect(readFileSync(loose, 'utf-8')).toBe(saved);
  });

  /**
   * The step itself, on a DECLARED-FINAL turn — the only turn that runs it.
   *
   * The two tests above prove the RECORD is written; these prove the nudge
   * happens and that its outcome reaches the turn history the way every other
   * wrap-up step's does: a supervisor-authored prompt turn followed by the
   * agent's reply. Until the mock simulated this step, no e2e ran it at all,
   * and an e2e taking a final turn against a dirty worktree recorded a history
   * production would never produce.
   */
  describe('the uncommitted-work nudge on a final turn', () => {
    /** Existence declares final for the next mocked turn (see the wrap-up gate
     *  comment in test/mocks/claude.ts). Daemonless: per-invocation env reaches
     *  the mock directly. */
    let finalFlag: string;

    beforeEach(() => {
      finalFlag = join(tmpdir(), `lazy-final-flag-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      writeFileSync(finalFlag, '');
    });

    afterEach(() => {
      rmSync(finalFlag, { force: true });
    });

    async function runFinalTurnLeaving(paths: string, extraEnv: Record<string, string> = {}): Promise<string> {
      const taskId = await createTask(ctx, 'Work with a loose file', 'Do the work');
      const result = await ctx.lazyMocked(
        ['start', taskId, '--yes', '--follow'],
        MOCK_CLAUDE_SUCCESS,
        {
          env: {
            LAZY_MOCK_SHOULD_COMMIT: '1',
            LAZY_MOCK_FILES: JSON.stringify([{ path: 'src/feature.ts', content: 'export const f = 1;\n' }]),
            LAZY_MOCK_LEAVE_UNCOMMITTED: paths,
            LAZY_MOCK_FINAL: finalFlag,
            ...extraEnv,
          },
        },
      );
      expectSuccess(result);
      await runReconcile(ctx.root, ctx.protocolBase);
      return taskId;
    }

    test('records the nudge as its own turn pair under its own heading', async () => {
      const taskId = await runFinalTurnLeaving('public-docs/troubleshooting.md', {
        LAZY_MOCK_LEFTOVERS_RESPONSE: 'Left it: it is scratch, not part of the change.',
      });

      const turns = readTurns(ctx.root, taskId);
      const nudge = turns.find(t => typeof t.content === 'string' && t.content.includes('## Uncommitted Work'));
      expect(nudge).toBeDefined();
      // The supervisor asks, the agent answers — in that order, as a pair.
      const reply = turns[turns.indexOf(nudge!) + 1];
      expect(reply?.role).toBe('agent');
      expect(reply?.content).toContain('Left it: it is scratch');
    });

    // The nudge WORKING is the point of the step: the agent commits what it
    // left, so the turn ends clean and records no loose paths at all.
    test('a turn whose agent commits what it left records nothing loose', async () => {
      const taskId = await runFinalTurnLeaving('public-docs/troubleshooting.md', {
        LAZY_MOCK_LEFTOVERS_COMMIT: '1',
      });

      const workTurn = readTurns(ctx.root, taskId).find(t => t.role === 'agent');
      expect(workTurn!.uncommitted).toBeUndefined();

      // And it is on the branch now, which is the whole difference.
      const accept = await ctx.lazy(['accept', taskId]);
      expectSuccess(accept);
    });
  });
});
