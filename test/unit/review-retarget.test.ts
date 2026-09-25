/**
 * src/daemon/review-retarget.ts — moving a reparented task's open PR/MR onto
 * its new target, or closing it when the forge refuses.
 *
 * The forge and the config are faked at the module boundary; storage is an
 * in-memory stand-in that enforces the real state machine, so a transition the
 * FSM forbids fails here exactly as it would in FileStorage.
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { resolve } from 'path';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';
import { assertValidTransition } from '../../src/task-state-machine';
import type { Task, TaskStatus } from '../../src/types';

type PrState = 'OPEN' | 'CLOSED' | 'MERGED' | null;

let task: Task;
let comments: string[];
let prState: PrState;
let retargetRefused: boolean;
let retargets: string[];
/** Runs inside the forge's close call — a person acting while lazy waits on the forge. */
let duringClose: (() => void) | null;
/** What the forge reports once lazy has asked it to close the PR. */
let stateAfterClose: PrState;

function makeTask(status: TaskStatus): Task {
  return {
    id: 'child-task-id', code: 'child', goal: 'Child', prompt: '', type: 'task', status,
    created_at: Date.now(), completed_at: null, target: { kind: 'branch', branch: 'main' },
    branched_from_sha: null, close_reason: null, model: null, agent_id: 'claude-code',
    metadata: { github_remote_ref_id: '7', github_remote_ref_url: 'https://github.com/o/r/pull/7' },
    pending_sync: 0, runner_type: null, tags: [],
  };
}

const storage = {
  getTask: async () => ({ ...task, metadata: { ...task.metadata } }),
  createComment: async (_id: string, content: string) => { comments.push(content); },
  getSessionByTaskId: async () => ({ id: 'sess', git_branch: 'lazy/child' }),
  updateTaskMetadata: async (_id: string, key: string, value: string) => { task.metadata![key] = value; },
  updateTaskStatus: async (_id: string, status: TaskStatus) => {
    assertValidTransition(task.status, status);
    task = { ...task, status };
  },
};

await mockModule(resolve(import.meta.dir, '../../src/config/loader.ts'), () => ({
  loadConfig: async () => ({ remote: { driver: 'github', git_remote: 'origin', offline: false } }),
}));
await mockModule(resolve(import.meta.dir, '../../src/utils/offline.ts'), () => ({
  isOfflineMode: async () => false,
}));
await mockModule(resolve(import.meta.dir, '../../src/remote/index.ts'), () => ({
  createDriver: () => ({
    needsSync: true,
    hasRemoteRef: () => true,
    getPRState: async () => prState,
    getReviewBase: async () => 'lazy/old-parent',
    getTaskUrl: async () => 'https://github.com/o/r/pull/7',
    retargetReview: async (_t: Task, base: string) => {
      retargets.push(base);
      if (retargetRefused) throw new Error('base branch is protected');
    },
    cleanup: async () => {
      duringClose?.();
      prState = stateAfterClose;
    },
  }),
}));

const { retargetReviewsAfterReparent } = await import('../../src/daemon/review-retarget');

beforeEach(() => {
  task = makeTask('submitted');
  comments = [];
  prState = 'OPEN';
  retargetRefused = true;
  retargets = [];
  duringClose = null;
  stateAfterClose = 'CLOSED';
});

afterAll(() => {
  restoreMockedModules();
});

describe('closing a PR the forge would not retarget', () => {
  test('a task still submitted goes back to blocked', async () => {
    await retargetReviewsAfterReparent('/tmp/project', storage as never, [task]);
    expect(task.status).toBe('blocked');
    expect(comments.at(-1)).toContain('the task is back to blocked');
    expect(task.metadata!.github_remote_ref_id).toBe('');
  });

  // INVARIANT: the status write is decided on a FRESH read under the task's
  // lifecycle lock. A person who unblocks the task while lazy waits on the forge
  // leaves it `working` with an agent running; `working -> blocked` is a valid
  // edge, so writing from the stale read would mark a running task blocked and
  // invite a second unblock onto the same worktree.
  test('a task unblocked while lazy talked to the forge stays working', async () => {
    duringClose = () => { task = { ...task, status: 'working' }; };
    await retargetReviewsAfterReparent('/tmp/project', storage as never, [task]);
    expect(task.status).toBe('working');
    expect(comments.at(-1)).toContain('the task is now working, so its status was left alone');
  });
});

describe('a forge that cannot be asked', () => {
  // INVARIANT: "could not read the PR's state" is not "there is no open PR".
  // Skipping silently left a person believing the PR had followed the task; the
  // task says the PR was NOT moved, exactly as when lazy is offline. The forge
  // accept's wrong-base refusal still stops a merge into the old branch.
  test('an unreadable PR state leaves a "not retargeted" note and touches nothing', async () => {
    prState = null;
    const notes = await retargetReviewsAfterReparent('/tmp/project', storage as never, [task]);
    expect(retargets).toEqual([]);
    expect(task.status).toBe('submitted');
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain('[PR not retargeted]');
    expect(comments[0]).toContain('could not be asked');
    expect(notes).toEqual(comments);
  });
});

describe('a close the forge cannot confirm', () => {
  // INVARIANT: after asking the forge to close the PR, "could not read its
  // state" is NOT "closed". Treating it as closed dropped the task's PR record
  // and blocked the task while the PR might still be open against the old
  // branch — and with the record gone, the wrong-base guards (accept, remote-
  // sync) could no longer see the PR at all. The record is KEPT, the status is
  // left alone, and the task says the PR was not moved.
  test('keeps the PR record and the status, and says the PR was not moved', async () => {
    stateAfterClose = null;
    await retargetReviewsAfterReparent('/tmp/project', storage as never, [task]);
    expect(task.metadata!.github_remote_ref_id).toBe('7');
    expect(task.metadata!.github_remote_ref_url).toBe('https://github.com/o/r/pull/7');
    expect(task.status).toBe('submitted');
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain('[PR not retargeted]');
    expect(comments[0]).toContain('could not confirm');
  });
});

describe('the "lazy closed this PR" marker', () => {
  // INVARIANT (src/daemon/lazy-closed-review.ts): the marker is written BEFORE
  // lazy asks the forge to close the PR, so a crash or an unreadable answer
  // after the close can never leave an unmarked close for remote-sync to read
  // as somebody else's — which abandons a live task and moves its children.
  test('is on the task when the close is requested', async () => {
    let markedAtClose: string | undefined;
    duringClose = () => { markedAtClose = task.metadata!.lazy_closed_review; };
    await retargetReviewsAfterReparent('/tmp/project', storage as never, [task]);
    expect(markedAtClose).toBe('https://github.com/o/r/pull/7');
  });

  test('stays with the kept record when the close cannot be confirmed', async () => {
    stateAfterClose = null;
    await retargetReviewsAfterReparent('/tmp/project', storage as never, [task]);
    expect(task.metadata!.lazy_closed_review).toBe('https://github.com/o/r/pull/7');
    expect(task.metadata!.github_remote_ref_id).toBe('7');
  });

  test('is cleared with the record once the close is confirmed', async () => {
    await retargetReviewsAfterReparent('/tmp/project', storage as never, [task]);
    expect(task.metadata!.lazy_closed_review ?? '').toBe('');
    expect(task.metadata!.github_remote_ref_id).toBe('');
  });

  test('is cleared when the forge says the PR is still open (the close did not happen)', async () => {
    stateAfterClose = 'OPEN';
    await retargetReviewsAfterReparent('/tmp/project', storage as never, [task]);
    expect(task.metadata!.lazy_closed_review ?? '').toBe('');
    expect(task.metadata!.github_remote_ref_id).toBe('7');
  });
});
