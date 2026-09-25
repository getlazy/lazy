/**
 * Unit tests for the self-sync step selection and the in-place merge.
 *
 * The self-sync route (src/daemon/self-sync.ts) is what lets a `working` task —
 * a loop, between children — reconcile its own branch. These tests cover the two
 * decisions that route makes on its own: WHICH merges a call performs, and what
 * happens to the worktree when one of them conflicts.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile, realpath } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  planSelfSyncSteps,
  runSelfSync,
  assertWorktreeReadyForSelfSync,
} from '../../src/daemon/self-sync';
import type { Storage } from '../../src/storage';

function gitIn(cwd: string, ...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), exitCode: result.exitCode };
}

/** Records the turns a self-sync writes, so the test can assert on them. */
function stubStorage(): { storage: Storage; turns: Array<Record<string, unknown>> } {
  const turns: Array<Record<string, unknown>> = [];
  const storage = {
    getNextTurnSequence: async () => turns.length + 1,
    createTurn: async (input: Record<string, unknown>) => {
      turns.push(input);
      return {} as never;
    },
  } as unknown as Storage;
  return { storage, turns };
}

describe('planSelfSyncSteps', () => {
  const base = { parentRef: 'main', parentSha: 'abc1234', parentHasChanges: true };

  test('origin comes first and the parent second — the order sync has always used', () => {
    // INVARIANT: the task branch must be at its true tip before the parent is
    // merged on top. Merging the parent into a branch still missing a
    // colleague's commits produces a merge `lazy accept` will not reproduce.
    const steps = planSelfSyncSteps({ ...base, remoteBranch: 'origin/lazy/task' });
    expect(steps.map(s => s.ref)).toEqual(['origin/lazy/task', 'main']);
    expect(steps.map(s => s.step)).toEqual([1, 2]);
  });

  test('the parent step merges the SHA the daemon resolved, not the ref name', () => {
    // The ref could move between resolution and merge; the SHA cannot.
    const steps = planSelfSyncSteps(base);
    expect(steps).toHaveLength(1);
    expect(steps[0].target).toBe('abc1234');
    expect(steps[0].ref).toBe('main');
  });

  test('step numbering is fixed, not positional — a parent-only call is still step 2', () => {
    // "1 of 2 / 2 of 2" has to mean the same thing on every call, so an agent
    // reading a conflict report can tell WHICH merge conflicted.
    expect(planSelfSyncSteps(base)[0].step).toBe(2);
  });

  test('an origin-only call is step 1 alone', () => {
    const steps = planSelfSyncSteps({ ...base, parentHasChanges: false, remoteBranch: 'origin/lazy/task' });
    expect(steps.map(s => s.step)).toEqual([1]);
  });

  test('nothing outstanding plans no merges — which is what makes a repeat call a no-op', () => {
    // IDEMPOTENCE: both inputs are containment-tested by the caller, so the step
    // an earlier call already merged is simply not offered again.
    expect(planSelfSyncSteps({ ...base, parentHasChanges: false })).toEqual([]);
  });
});

describe('runSelfSync in a real repository', () => {
  let dir: string;
  let worktree: string;

  beforeEach(async () => {
    // realpath first: macOS tmpdir is /var → /private/var, and git prints the
    // resolved spelling (see docs/testing-harness.md).
    dir = await realpath(await mkdtemp(join(tmpdir(), 'lazy-self-sync-')));
    worktree = dir;
    gitIn(dir, 'init', '--initial-branch=main');
    gitIn(dir, 'config', 'user.email', 'test@lazy.test');
    gitIn(dir, 'config', 'user.name', 'Test');
    await writeFile(join(dir, 'base.txt'), 'base\n');
    gitIn(dir, 'add', '.');
    gitIn(dir, 'commit', '-m', 'Base');
    // A task branch, plus one commit on main that it does not have.
    gitIn(dir, 'checkout', '-b', 'lazy/task');
    gitIn(dir, 'checkout', 'main');
    await writeFile(join(dir, 'from-parent.txt'), 'landed on main\n');
    gitIn(dir, 'add', '.');
    gitIn(dir, 'commit', '-m', 'Parent work');
    gitIn(dir, 'checkout', 'lazy/task');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function parentPlan(): ReturnType<typeof planSelfSyncSteps> {
    const sha = gitIn(dir, 'rev-parse', 'main').stdout.trim();
    return planSelfSyncSteps({ parentRef: 'main', parentSha: sha, parentHasChanges: true });
  }

  test('a clean merge lands in the worktree and is recorded as a sync turn', async () => {
    const { storage, turns } = stubStorage();
    const outcome = await runSelfSync({
      storage,
      taskId: 'task-1234',
      sessionId: 'sess-1',
      displayId: 'my-task',
      worktreePath: worktree,
      plan: parentPlan(),
    });

    expect(outcome.status).toBe('merged');
    expect(outcome.steps).toHaveLength(1);
    expect(outcome.steps[0].outcome).toBe('merged');
    expect(await readFile(join(worktree, 'from-parent.txt'), 'utf-8')).toContain('landed on main');

    // INVARIANT: a merge lazy performed is a `supervisor`-actored sync turn — the
    // same shape a supervisor sync records — so the task's history shows it.
    expect(turns).toHaveLength(1);
    expect(turns[0].actor).toBe('supervisor');
    expect(turns[0].turnType).toBe('sync');
    expect(String(turns[0].content)).toContain('Merged main');
    // Deliberately no SHA window: the calling agent's own work turn already
    // spans these commits, and attributing them twice double-counts the merge.
    expect(turns[0].startSha).toBeUndefined();
    expect(turns[0].endShaWork).toBeUndefined();
  });

  test('a conflicted merge is LEFT IN PLACE for the calling agent, with instructions', async () => {
    // INVARIANT: the agent that called is the one that resolves. Aborting the
    // merge here would leave it with nothing to resolve — it cannot start a
    // merge itself (refs are read-only inside its container).
    await writeFile(join(worktree, 'from-parent.txt'), 'task version\n');
    gitIn(worktree, 'add', '.');
    gitIn(worktree, 'commit', '-m', 'Task touched the same file');

    const { storage, turns } = stubStorage();
    const outcome = await runSelfSync({
      storage,
      taskId: 'task-1234',
      sessionId: 'sess-1',
      displayId: 'my-task',
      worktreePath: worktree,
      plan: parentPlan(),
    });

    expect(outcome.status).toBe('conflict');
    expect(outcome.steps[0].conflicted_files).toEqual(['from-parent.txt']);
    expect(outcome.message).toContain('Step 2 of 2');
    expect(outcome.instructions).toContain('lazy_commit');
    // No turn for a step that did not land.
    expect(turns).toHaveLength(0);

    // The merge really is still in progress, with the conflict markers on disk.
    expect(gitIn(worktree, 'rev-parse', '--verify', 'MERGE_HEAD').exitCode).toBe(0);
    expect(await readFile(join(worktree, 'from-parent.txt'), 'utf-8')).toContain('<<<<<<<');
  });

  test('ordinary sync aborts a conflict before handing it to a supervisor', async () => {
    await writeFile(join(worktree, 'from-parent.txt'), 'task version\n');
    gitIn(worktree, 'add', '.');
    gitIn(worktree, 'commit', '-m', 'Task touched the same file');

    const { storage, turns } = stubStorage();
    const headBefore = gitIn(worktree, 'rev-parse', 'HEAD').stdout.trim();
    const outcome = await runSelfSync({
      storage,
      taskId: 'task-1234',
      sessionId: 'sess-1',
      displayId: 'my-task',
      worktreePath: worktree,
      plan: parentPlan(),
      leaveConflictInProgress: false,
    });

    expect(outcome.status).toBe('conflict');
    expect(outcome.message).toContain('aborted');
    expect(turns).toHaveLength(0);
    expect(gitIn(worktree, 'rev-parse', '--verify', 'MERGE_HEAD').exitCode).not.toBe(0);
    expect(gitIn(worktree, 'rev-parse', 'HEAD').stdout.trim()).toBe(headBefore);
    expect(await readFile(join(worktree, 'from-parent.txt'), 'utf-8')).toBe('task version\n');
  });

  test('a second call refuses while a merge is in progress, and says how to finish it', async () => {
    gitIn(worktree, 'merge', 'main', '--no-commit', '--no-ff');
    await expect(
      assertWorktreeReadyForSelfSync(worktree, 'my-task'),
    ).rejects.toThrow(/merge in progress/);
  });

  test('uncommitted changes are refused rather than merged on top of', async () => {
    await writeFile(join(worktree, 'base.txt'), 'dirty\n');
    await expect(
      assertWorktreeReadyForSelfSync(worktree, 'my-task'),
    ).rejects.toThrow(/uncommitted changes/);
  });

  test('after the agent concludes the merge, the same call reports nothing left', async () => {
    // The idempotence contract end to end: merge, then a plan built from the
    // same containment test is empty and the call is a no-op.
    const { storage } = stubStorage();
    await runSelfSync({
      storage, taskId: 'task-1234', sessionId: 'sess-1', displayId: 'my-task',
      worktreePath: worktree, plan: parentPlan(),
    });

    const again = await runSelfSync({
      storage, taskId: 'task-1234', sessionId: 'sess-1', displayId: 'my-task',
      worktreePath: worktree,
      plan: planSelfSyncSteps({
        parentRef: 'main',
        parentSha: gitIn(dir, 'rev-parse', 'main').stdout.trim(),
        // What the daemon's own `hasUpstreamChanges` would now answer.
        parentHasChanges: false,
      }),
    });
    expect(again.status).toBe('up_to_date');
    expect(again.steps).toEqual([]);
  });
});
