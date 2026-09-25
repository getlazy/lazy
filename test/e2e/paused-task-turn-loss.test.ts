/**
 * A turn is lost when the task is PAUSED while its agent is still running.
 *
 * Observed in the wild (2026-09-05, daemon 0.23.1670-alpha): a task went
 * `working` → `blocked` with actor `system` six milliseconds after `lazy start`,
 * while its agent ran on for another minute. The agent's turn, its commits and
 * its turn-report sequence were never recorded — `turn_sequence: null`,
 * `commit_count: 0` — even though the task's branch carried the change.
 *
 * Two independent defects, one per test below.
 *
 * 1. The CAUSE. `recoverBacklogWithCommits` (reconcile sweep 7) recovers a
 *    `backlog` task whose branch has commits, on the reasoning that real work
 *    exists. But `lazy start` cuts the branch and writes the empty
 *    `Initialize task …` commit while the task is STILL `backlog`, so during
 *    every launch that sweep sees "1 commit ahead" and writes `blocked` over the
 *    launcher's `working`.
 *
 * 2. The LOSS. `reconcileTasks` reads `response.json` only for tasks it lists as
 *    `working`. A task parked early therefore never has its supervisor's
 *    finished response consumed, and nothing ever writes the turn.
 *
 * Both tests run on the fake-binary seam deliberately (CLAUDE.md, "Two agent
 * seams"): the loss lives in the host↔supervisor protocol FILES and in the
 * reconciler's own sweeps, and the module mock replaces `launchSupervisorAsync`
 * outright — under it neither the empty init commit's timing nor an unconsumed
 * `response.json` exists to reproduce.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { agentTurns, taskDir, taskStatus, waitForStatus } from '../helpers/agent-seam';
import { readSessionJson, readTaskJson, setTaskStatus, worktreePathFor, writeTaskJson } from '../helpers/storage';
import { protocolDir as getProtocolDir, writeResponse } from '../../src/protocol';
import type { CompletedResponse } from '../../src/protocol';

/** The daemon reconciles every 5s; three ticks is a comfortable observation window. */
const THREE_TICKS_MS = 16_000;

/**
 * The protocol dir is keyed by the FULL task id; the CLI hands back a short one.
 * The storage directory name is the full id, so it is the cheapest lookup that
 * does not reach into the daemon.
 */
async function fullTaskId(root: string, shortId: string): Promise<string> {
  const dir = await taskDir(root, shortId);
  const parts = dir.split('/');
  return parts[parts.length - 1]!;
}

/** Commits recorded against a task, straight from storage. */
async function recordedCommits(root: string, shortId: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(join(await taskDir(root, shortId), 'commits.json'), 'utf-8');
  return (JSON.parse(raw) as { commits: Array<Record<string, unknown>> }).commits;
}

describe('a turn finished while the task was paused is still recorded', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT (defect 2, the loss): a completed response nobody consumed is
  // evidence of a turn that HAPPENED, and a paused task is not a reason to throw
  // it away. `reconcileTasks` only reads response.json for `working` tasks, so
  // without the paused-response sweep this turn has no reader at all and the
  // task keeps `turn_sequence: null` and zero commits while its branch carries
  // the work.
  //
  // The state is forced rather than raced: reproducing it through the wild
  // sequence needs a sweep to land inside a millisecond-wide window, which is
  // exactly why the bug survived so long. What the sweep must do about that
  // state is fully determined, so that is what this asserts.
  test('a turn that finishes after the task was parked lands its turn and its commits', async () => {
    const taskId = await createTask(ctx, 'Paused mid-turn', 'Do the work');
    // A turn that is still running when the task gets parked — the wild shape.
    await ctx.setClaudeScenario({ steps: [{ kind: 'sleep', ms: 120_000 }] });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    await waitForStatus(ctx.root, taskId, ['working'], 30_000);

    // No agent turn yet — the turn is still in flight. This is the state the
    // observed task was in when `system` parked it.
    expect(await agentTurns(ctx.root, taskId)).toHaveLength(0);

    // The agent's real work, on the branch, exactly as the observed task had it.
    const worktree = worktreePathFor(ctx.root, taskId);
    await writeFile(join(worktree, 'agent-work.txt'), 'the change the branch carried\n');
    ctx.git('-C', worktree, 'add', 'agent-work.txt');
    ctx.git('-C', worktree, 'commit', '-m', 'Agent work that must not be lost');

    // The bug, forced: the task is parked by `system` while its agent runs on.
    // In the wild `recoverBacklogWithCommits` did this inside a millisecond-wide
    // window during launch; a test that waited for the window to recur would be
    // a coin toss, and what must happen next is fully determined either way.
    setTaskStatus(ctx.root, taskId, 'blocked');

    // The supervisor finishing its turn against the now-parked task.
    const protoDir = getProtocolDir(await fullTaskId(ctx.root, taskId));
    const finished: CompletedResponse = {
      status: 'completed',
      result: 'The turn that used to vanish: what I changed, and why.',
      session_id: 'fake-sess-paused',
      usage: { input_tokens: 1_200, output_tokens: 300 },
    };
    writeResponse(protoDir, finished);

    const deadline = Date.now() + THREE_TICKS_MS;
    let contents: string[] = [];
    while (Date.now() < deadline) {
      contents = (await agentTurns(ctx.root, taskId)).map(t => String(t.content));
      if (contents.some(c => c.includes('The turn that used to vanish'))) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // The turn: `turn_sequence: null` and an absent agent turn were the observed
    // symptom.
    expect(contents.some(c => c.includes('The turn that used to vanish'))).toBe(true);

    // The commits: `commit_count: 0` on a branch that carried the change was the
    // other half of the same symptom.
    const commits = await recordedCommits(ctx.root, taskId);
    expect(commits.map(c => String(c.message))).toContain('Agent work that must not be lost');

    // And the sweep must leave the task where it found it: parked, not `working`.
    expect(await waitForStatus(ctx.root, taskId, ['blocked', 'conflict'], 30_000)).toBe('blocked');
  }, 120_000);

  // INVARIANT (defect 1, the cause): the backlog-recovery sweep must never move a
  // task that is CURRENTLY STARTING. `lazy start` writes the empty
  // `Initialize task …` commit before the task leaves `backlog`, so "the branch
  // is 1 commit ahead of its base" is the normal state of every launch and is
  // NOT proof of work worth recovering. The empty commit changes no tree, which
  // is what the real-work gate tests.
  //
  // The status is written back to `backlog` under a live supervisor to hold the
  // race's window open: in the wild it is open for milliseconds, and a test that
  // waited for it to recur would be a coin toss.
  test('a backlog task whose branch has only the init commit is left alone', async () => {
    const taskId = await createTask(ctx, 'Launch race', 'Do the work');
    // A turn that never finishes: the branch stays at the empty init commit, so
    // the only thing the sweep can see is the launch artifact itself.
    await ctx.setClaudeScenario({ steps: [{ kind: 'sleep', ms: 120_000 }] });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));

    // Re-open the window `lazy start` closes when it flips the task to `working`,
    // and give the task the base SHA the sweep needs to ask "is this branch
    // ahead?". A CHILD task gets `branched_from_sha` written by the launcher —
    // the observed task was one — while a top-level task carries the same SHA
    // only on its session, so this makes the top-level fixture stand in for the
    // child shape rather than inventing a value: it is the session's own
    // `git_start_sha`, which is what the launcher stores on a child.
    const session = readSessionJson(ctx.root, taskId);
    const task = readTaskJson(ctx.root, taskId);
    task.branched_from_sha = session!.git_start_sha;
    task.status = 'backlog';
    writeTaskJson(ctx.root, taskId, task);

    // Several sweeps must go by without the task moving. `blocked` here is the
    // wild bug verbatim: a task parked by `system` while its agent runs on.
    const deadline = Date.now() + THREE_TICKS_MS;
    while (Date.now() < deadline) {
      expect(await taskStatus(ctx.root, taskId)).toBe('backlog');
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }

    // Nothing was recovered, so nothing was recorded against the task either.
    expect(await recordedCommits(ctx.root, taskId)).toHaveLength(0);
  }, 120_000);
});
