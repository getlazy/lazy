import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { createTask, disablePreAccept, startAndReconcile, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
// setTaskStatus lives in the shared helper, which is the ONE place that knows
// tasks live at lazy.toml's external_path — the local copy this suite carried
// hardcoded <root>/.lazy/tasks and died with ENOENT once storage moved.
import { setTaskStatus, setTaskMetadata, readTaskStatus, readTaskJson, taskFilePath, worktreePathFor, readSessionJson, writeSessionJson, writeRaisedItemsFile } from '../helpers/storage';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { runReconcile } from '../helpers/reconcile';
import { seedFinal } from '../helpers/final';

/**
 * Seed the exact field wedge: a task in `merging` carrying the in-flight marker
 * a LOCAL merge phase stamps, with no accept running anywhere. That is what a
 * daemon killed mid-accept leaves behind.
 */
function strandInMerging(root: string, taskId: string, priorStatus = 'blocked'): void {
  setTaskStatus(root, taskId, 'merging');
  setTaskMetadata(root, taskId, 'accept_in_flight_from', priorStatus);
}

/** The accept decision a dead accept persisted before it died. */
function persistIntent(root: string, taskId: string, reason: string, actor = 'builder'): void {
  setTaskMetadata(root, taskId, 'accept_intent', JSON.stringify({ reason, actor, recordedAt: new Date().toISOString() }));
}

/** The daemon already tried (and failed) to resume this accept as often as it will. */
function exhaustResumes(root: string, taskId: string): void {
  setTaskMetadata(root, taskId, 'accept_resume_attempts', '3');
}

function readComments(root: string, taskId: string): Array<{ content: string; actor?: string }> {
  return JSON.parse(readFileSync(taskFilePath(root, taskId, 'comments.json'), 'utf-8')).comments;
}

function commitInWorktree(ctx: TestContext, taskId: string, file: string): void {
  const wt = worktreePathFor(ctx.root, taskId);
  writeFileSync(join(wt, file), `${file}\n`);
  expect(ctx.git('-C', wt, 'add', file).exitCode).toBe(0);
  expect(ctx.git('-C', wt, 'commit', '-m', `Add ${file}`).exitCode).toBe(0);
}

describe('merging escape hatch', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    // Daemonless suite: no runner exists to execute the pre-accept agent turn,
    // and these tests assert on the merging escape hatch, not on pre-accept.
    disablePreAccept(ctx.root);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: Users must be able to escape a stuck merging state.
  // Without this, a failed pipeline leaves the task stuck forever —
  // can't unblock, can't accept, can't give feedback.
  test('unblock on merging task moves it back to blocked', async () => {
    // Create and start a task to get a session
    const taskId = await createTask(ctx, 'Stuck merging task', 'Fix the pipeline');
    await startAndReconcile(ctx, taskId);

    // Manually set task to merging state (simulating accept → pipeline pending)
    setTaskStatus(ctx.root, taskId, 'merging');

    // Verify task is indeed in merging state
    const showBefore = await ctx.lazy(['show', taskId]);
    expectSuccess(showBefore);
    expectOutput(showBefore, 'merging');

    // Unblock the merging task — should move it to blocked and proceed
    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Pipeline failed, fix the test'],
      MOCK_CLAUDE_SUCCESS,
    );
    expectSuccess(unblockResult);
    expectOutput(unblockResult, 'Task was in merging state. Moved back to blocked.');

    // Verify task is no longer in merging state (unblock moves it to blocked, then agent runs)
    const showAfter = await ctx.lazy(['show', taskId]);
    expectSuccess(showAfter);
    // The status line should show 'blocked' (after agent finishes), not 'merging'
    // Note: "merging" may appear in comments/notes, so check status field specifically
    const statusMatch = showAfter.stdout.match(/Status:\s+(\w+)/);
    expect(statusMatch).toBeTruthy();
    expect(statusMatch![1]).not.toBe('merging');
  });

  // INVARIANT (a dead accept never restores, 2026-09-22): a task marked as
  // mid-accept belongs to an accept the human already authorized, and the
  // daemon is resuming it — its merge may already have landed. Reject/close
  // would undo that accept, so they refuse while the resume is pending.
  test('reject refuses while a dead accept is being resumed', async () => {
    const taskId = await createTask(ctx, 'Accepted task', 'Something');
    await startAndReconcile(ctx, taskId);
    strandInMerging(ctx.root, taskId);

    const result = await ctx.lazy(['reject', taskId, '--reason', 'changed my mind', '--yes']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toContain('being resumed by the daemon');
    expect(readTaskStatus(ctx.root, taskId)).toBe('merging');
  });

  // REGRESSION (fix-stranded-merging): a task stranded in `merging` was once
  // inescapable — one sat wedged for two weeks. The resume rule above must not
  // bring that back: once the daemon's automatic resumes are exhausted, the
  // human's escape opens again and reject/close recover the task first.
  test('reject escapes a stranded task once automatic resumes are exhausted', async () => {
    const taskId = await createTask(ctx, 'Wedged task', 'Something');
    await startAndReconcile(ctx, taskId);
    strandInMerging(ctx.root, taskId);
    exhaustResumes(ctx.root, taskId);

    const result = await ctx.lazy(['reject', taskId, '--reason', 'not what I wanted', '--yes']);
    expectSuccess(result);
    expect(readTaskStatus(ctx.root, taskId)).toBe('abandoned');
    // INVARIANT: the escape clears EVERY resume key with the marker. A leftover
    // exhausted attempt count would stop the daemon from ever resuming a later
    // accept of this task, and a stale intent could be read as its decision.
    const meta = readTaskJson(ctx.root, taskId).metadata ?? {};
    for (const key of ['accept_in_flight_from', 'accept_intent', 'accept_resume_attempts', 'accept_resume_next_at']) {
      expect(meta[key] ?? '').toBe('');
    }
  });

  test('close escapes a stranded task once resumes are exhausted, and keeps the reason', async () => {
    const taskId = await createTask(ctx, 'Wedged task', 'Something');
    await startAndReconcile(ctx, taskId);
    strandInMerging(ctx.root, taskId);
    exhaustResumes(ctx.root, taskId);

    const result = await ctx.lazy(['close', taskId, '--reason', 'abandoning this line of work', '--yes']);
    expectSuccess(result);
    expect(readTaskStatus(ctx.root, taskId)).toBe('abandoned');
    // Never lose human feedback: the reason the human typed must survive the
    // recovery, not be orphaned by a refusal.
    expect(readTaskJson(ctx.root, taskId).close_reason).toBe('abandoning this line of work');
  });

  // INVARIANT (a dead accept never restores): the human already said accept.
  // An accept killed BEFORE its merge is landed by the daemon — the sweep used
  // to return it to `blocked`, silently dropping the decision.
  test('the reconciler resumes an accept that died before its merge, and lands it', async () => {
    const taskId = await createTask(ctx, 'Accepted task', 'Something');
    await startAndReconcile(ctx, taskId);
    commitInWorktree(ctx, taskId, 'landed-by-resume.txt');
    await seedFinal(ctx, taskId);
    strandInMerging(ctx.root, taskId);
    persistIntent(ctx.root, taskId, 'ship the feature');

    await runReconcile(ctx.root, ctx.protocolBase);

    expect(readTaskStatus(ctx.root, taskId)).toBe('complete');
    expect(ctx.git('show', 'main:landed-by-resume.txt').stdout.trim()).toBe('landed-by-resume.txt');
    const accepted = readComments(ctx.root, taskId).filter((c) => c.content.startsWith('[Accepted]'));
    expect(accepted.map((c) => c.content)).toEqual(['[Accepted] ship the feature']);
    expect(accepted[0].actor).toBe('builder');
    const meta = readTaskJson(ctx.root, taskId).metadata ?? {};
    expect(meta.accept_in_flight_from ?? '').toBe('');
    expect(meta.accept_intent ?? '').toBe('');
  });

  // INVARIANT (the 2026-09-08 field incident): an accept killed AFTER its squash
  // landed but before the store recorded it is FINISHED by the daemon — the
  // resumed squash recognises the content is already on the parent instead of
  // failing "squash merge produced no commit", and nothing is merged twice.
  test('the reconciler completes an accept that died after its merge landed', async () => {
    const taskId = await createTask(ctx, 'Accepted task', 'Something');
    await startAndReconcile(ctx, taskId);
    commitInWorktree(ctx, taskId, 'already-landed.txt');
    await seedFinal(ctx, taskId);
    // The dead accept's squash, already on the parent.
    const branch = ctx.git('-C', worktreePathFor(ctx.root, taskId), 'branch', '--show-current').stdout.trim();
    expect(ctx.git('merge', '--squash', branch).exitCode).toBe(0);
    expect(ctx.git('commit', '-m', 'squash from the accept that died').exitCode).toBe(0);
    const mainBefore = ctx.git('rev-parse', 'main').stdout.trim();
    strandInMerging(ctx.root, taskId);
    persistIntent(ctx.root, taskId, 'looks right to me', 'human');

    await runReconcile(ctx.root, ctx.protocolBase);

    expect(readTaskStatus(ctx.root, taskId)).toBe('complete');
    expect(ctx.git('rev-parse', 'main').stdout.trim()).toBe(mainBefore);
    const accepted = readComments(ctx.root, taskId).filter((c) => c.content.startsWith('[Accepted]'));
    expect(accepted.map((c) => c.content)).toEqual(['[Accepted] looks right to me']);
    expect(accepted[0].actor).toBe('human');
  });

  /** Squash the task's branch onto main by hand: the dead accept's merge, already landed. */
  function landSquash(taskId: string): string {
    const branch = ctx.git('-C', worktreePathFor(ctx.root, taskId), 'branch', '--show-current').stdout.trim();
    expect(ctx.git('merge', '--squash', branch).exitCode).toBe(0);
    expect(ctx.git('commit', '-m', 'squash from the accept that died').exitCode).toBe(0);
    return branch;
  }

  // INVARIANT: a resume never runs the acceptance gate. The gate already passed
  // when the dead accept began, and it moves the task to `working`, which a
  // `merging` task cannot do — so with [automation.pre_accept] on, every resume
  // used to throw until the escape restored the task over its landed merge.
  test('a resume with the acceptance gate enabled skips the gate and completes', async () => {
    const taskId = await createTask(ctx, 'Accepted task', 'Something');
    await startAndReconcile(ctx, taskId);
    commitInWorktree(ctx, taskId, 'gate-resume.txt');
    await seedFinal(ctx, taskId);
    const tomlPath = join(ctx.root, 'lazy.toml');
    const toml = readFileSync(tomlPath, 'utf-8');
    const enabled = toml.replace('[automation.pre_accept]\nenabled = false', '[automation.pre_accept]\nenabled = true\ncommands = ["false"]');
    expect(enabled).not.toBe(toml);
    writeFileSync(tomlPath, enabled);
    strandInMerging(ctx.root, taskId);
    persistIntent(ctx.root, taskId, 'gate already passed');

    await runReconcile(ctx.root, ctx.protocolBase);

    expect(readTaskStatus(ctx.root, taskId)).toBe('complete');
    expect(ctx.git('show', 'main:gate-resume.txt').exitCode).toBe(0);
  });

  // INVARIANT (a dead accept never restores — the 2026-09-08 incident): the
  // dead accept's squash landed, then a sibling accept changed the same lines
  // on the parent. The resume's idempotence check now sees a conflict. The task
  // must stay `merging` (marked, for the retry/escape machinery) — never be put
  // back to `blocked` while its work sits on the parent.
  test('a resume that hits a conflict after its squash landed never restores the task', async () => {
    const taskId = await createTask(ctx, 'Accepted task', 'Something');
    await startAndReconcile(ctx, taskId);
    commitInWorktree(ctx, taskId, 'shared.txt');
    await seedFinal(ctx, taskId);
    landSquash(taskId);
    // The sibling's edit to the same lines, landed after the crash.
    writeFileSync(join(ctx.root, 'shared.txt'), 'rewritten by a sibling accept\n');
    expect(ctx.git('commit', '-am', 'sibling accept edits the same lines').exitCode).toBe(0);
    strandInMerging(ctx.root, taskId);
    persistIntent(ctx.root, taskId, 'ship it');

    await runReconcile(ctx.root, ctx.protocolBase);

    expect(readTaskStatus(ctx.root, taskId)).toBe('merging');
    const meta = readTaskJson(ctx.root, taskId).metadata ?? {};
    expect(meta.accept_in_flight_from).toBe('blocked');
    expect(meta.accept_resume_attempts).toBe('1');
    const failed = readComments(ctx.root, taskId).filter((c) => c.content.startsWith('[Accept resume failed]'));
    expect(failed).toHaveLength(1);
  });

  // INVARIANT (a dead accept never restores): killed INSIDE the transition —
  // follow-through record and [Accepted] comment written, session ended
  // `accepted`, status still `merging`. Preflight refuses an accepted session,
  // so this used to fail every resume until the escape restored the task. Now
  // it is finished (by the resume, or by storage's ended-session self-heal plus
  // the follow-through sweep): complete, one [Accepted] comment, marker gone,
  // follow-through done, nothing merged again.
  test('an accept killed between ending the session and writing the status is finished', async () => {
    const taskId = await createTask(ctx, 'Accepted task', 'Something');
    await startAndReconcile(ctx, taskId);
    commitInWorktree(ctx, taskId, 'mid-transition.txt');
    await seedFinal(ctx, taskId);
    landSquash(taskId);
    const mainBefore = ctx.git('rev-parse', 'main').stdout.trim();
    strandInMerging(ctx.root, taskId);
    persistIntent(ctx.root, taskId, 'finish me', 'human');
    setTaskMetadata(ctx.root, taskId, 'accept_followthrough', JSON.stringify({
      targetBranch: 'main', viaForge: false, pushParent: false, mergeSha: mainBefore, done: [], attempts: 0,
    }));
    // The transition writes the reason before ending the session.
    const commentsPath = taskFilePath(ctx.root, taskId, 'comments.json');
    const stored = JSON.parse(readFileSync(commentsPath, 'utf-8'));
    stored.comments.push({ id: 'c-accepted', task_id: readTaskJson(ctx.root, taskId).id, content: '[Accepted] finish me', created_at: Date.now(), actor: 'human' });
    writeFileSync(commentsPath, JSON.stringify(stored));
    const sess = readSessionJson(ctx.root, taskId)!;
    writeSessionJson(ctx.root, taskId, { ...sess, ended_at: Date.now(), outcome: 'accepted' });

    await runReconcile(ctx.root, ctx.protocolBase);

    expect(readTaskStatus(ctx.root, taskId)).toBe('complete');
    expect(ctx.git('rev-parse', 'main').stdout.trim()).toBe(mainBefore);
    const accepted = readComments(ctx.root, taskId).filter((c) => c.content.startsWith('[Accepted]'));
    expect(accepted.map((c) => c.content)).toEqual(['[Accepted] finish me']);
    expect(accepted[0].actor).toBe('human');
    const meta = readTaskJson(ctx.root, taskId).metadata ?? {};
    expect(meta.accept_in_flight_from ?? '').toBe('');
    expect(meta.accept_followthrough ?? '').toBe('');
  });

  /** An open BLOCKING raised item: the accept gate refuses any fresh accept over it. */
  function openBlockingRaise(taskId: string): void {
    writeRaisedItemsFile(ctx.root, taskId, [{
      id: 'raise-after-accept',
      task_id: readTaskJson(ctx.root, taskId).id,
      content: 'A question raised after the human said accept.',
      blocking: true,
      created_at: Date.now(),
      triage_status: 'open',
    }]);
  }

  // INVARIANT (ask the trees first): a resume whose work already landed is
  // finished BEFORE preflight and every gate — none may refuse it. Here the
  // raised-item gate would refuse any fresh accept; before this rule it refused
  // the resume three times and the escape then restored the task over its
  // landed merge.
  test('a resume whose merge landed is finished even when a gate would now refuse', async () => {
    const taskId = await createTask(ctx, 'Accepted task', 'Something');
    await startAndReconcile(ctx, taskId);
    commitInWorktree(ctx, taskId, 'landed-then-gated.txt');
    await seedFinal(ctx, taskId);
    landSquash(taskId);
    const mainBefore = ctx.git('rev-parse', 'main').stdout.trim();
    openBlockingRaise(taskId);
    strandInMerging(ctx.root, taskId);
    persistIntent(ctx.root, taskId, 'already said yes');

    await runReconcile(ctx.root, ctx.protocolBase);

    expect(readTaskStatus(ctx.root, taskId)).toBe('complete');
    expect(ctx.git('rev-parse', 'main').stdout.trim()).toBe(mainBefore);
    const accepted = readComments(ctx.root, taskId).filter((c) => c.content.startsWith('[Accepted]'));
    expect(accepted.map((c) => c.content)).toEqual(['[Accepted] already said yes']);
  });

  // INVARIANT: a resume re-checks none of the accept's POLICY gates even when
  // the work has not landed yet — they passed when the human's accept began.
  test('a resume that has not merged yet is not refused by a policy gate', async () => {
    const taskId = await createTask(ctx, 'Accepted task', 'Something');
    await startAndReconcile(ctx, taskId);
    commitInWorktree(ctx, taskId, 'gated-before-merge.txt');
    await seedFinal(ctx, taskId);
    openBlockingRaise(taskId);
    strandInMerging(ctx.root, taskId);
    persistIntent(ctx.root, taskId, 'land it');

    await runReconcile(ctx.root, ctx.protocolBase);

    expect(readTaskStatus(ctx.root, taskId)).toBe('complete');
    expect(ctx.git('show', 'main:gated-before-merge.txt').exitCode).toBe(0);
  });

  // INVARIANT (never restore over landed work): with the daemon's resumes
  // exhausted the escape reopens, but it asks the trees first. Work already on
  // the target means reject/close/unblock would recreate the 2026-09-08
  // incident, so they refuse and point at `lazy accept` — which finishes it.
  test('after resumes are exhausted, the escape refuses when the work has landed and accept finishes it', async () => {
    const taskId = await createTask(ctx, 'Accepted task', 'Something');
    await startAndReconcile(ctx, taskId);
    commitInWorktree(ctx, taskId, 'landed-escape.txt');
    await seedFinal(ctx, taskId);
    landSquash(taskId);
    strandInMerging(ctx.root, taskId);
    persistIntent(ctx.root, taskId, 'it merged');
    exhaustResumes(ctx.root, taskId);

    const rejected = await ctx.lazy(['reject', taskId, '--reason', 'undo it', '--yes']);
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stdout + rejected.stderr).toContain('already on');
    expect(rejected.stdout + rejected.stderr).toContain('lazy accept');
    expect(readTaskStatus(ctx.root, taskId)).toBe('merging');

    const accepted = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(accepted);
    expect(readTaskStatus(ctx.root, taskId)).toBe('complete');
  });

  // INVARIANT: accept on a merging task with the local driver must not crash or
  // strand the task. There is no remote pipeline to wait on, so the merge simply
  // completes. (This used to assert an "already in merging state ... still
  // pending" message, but that was CLI-layer text removed when accept became a
  // thin RPC wrapper over the daemon — f7dd25ba. The behavior it guarded, "don't
  // blow up on a merging task", is what is asserted now.)
  test('accept on merging task with local driver completes the merge', async () => {
    const taskId = await createTask(ctx, 'Local merging task', 'Something');
    await startAndReconcile(ctx, taskId);
    // Fixture setup, not the subject (see test/helpers/final.ts). Daemonless
    // suite, so the final is seeded at the storage level.
    await seedFinal(ctx, taskId);

    setTaskStatus(ctx.root, taskId, 'merging');

    // Accept on a merging task — local driver returns null for getPRState
    // which means it falls through to the pending state message
    const acceptResult = await ctx.lazy(['accept', taskId]);
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'accepted and merged');
    expectOutput(await ctx.lazy(['show', taskId]), 'complete');
  });

  // INVARIANT: After unblocking a merging task, the user should be able to
  // re-accept it, completing the full escape-hatch → retry cycle.
  test('full escape-hatch cycle: merging → unblock → blocked → accept', async () => {
    const taskId = await createTask(ctx, 'Full cycle task', 'Fix and retry');
    await startAndReconcile(ctx, taskId);

    // Set to merging (simulating pipeline pending)
    setTaskStatus(ctx.root, taskId, 'merging');
    setTaskStatus(ctx.root, taskId, 'merging');

    // Escape via unblock
    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Fix the failing test'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(unblockResult);
    // `unblock` launches the agent and returns; only a reconcile pass records
    // the response and moves the task working → blocked, which accept requires.
    await runReconcile(ctx.root, ctx.protocolBase);
    // Fixture setup, not the subject (see test/helpers/final.ts). Seeded AFTER
    // the unblock turn because that turn is later work — a final seeded before
    // it would be invalidated by resolveFinalState. Daemonless suite, so the
    // final is seeded at the storage level.
    await seedFinal(ctx, taskId);

    // Task should no longer be in merging state (agent finishes → blocked)
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    const statusMatch = showResult.stdout.match(/Status:\s+(\w+)/);
    expect(statusMatch).toBeTruthy();
    expect(statusMatch![1]).not.toBe('merging');

    // Re-accept should work (task is no longer in merging state)
    const acceptResult = await ctx.lazy(['accept', taskId]);
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'accepted and merged');
  });
});
