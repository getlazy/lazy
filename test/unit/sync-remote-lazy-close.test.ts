/**
 * syncTaskFromRemote (src/task/sync-remote.ts) and a CLOSED PR: lazy's own
 * close (the task carries the "lazy closed this PR" marker) is settled, never
 * read as the task having been closed on the forge. The daemon's remote-sync
 * twin is covered in sync-external-merge.test.ts.
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { resolve } from 'path';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';
import { assertValidTransition } from '../../src/task-state-machine';
import type { Task, TaskStatus } from '../../src/types';

let task: Task;
let abandoned: string[];
let reparentedFrom: string[];

const storage = {
  getTask: async () => ({ ...task, metadata: { ...task.metadata } }),
  getSessionByTaskId: async () => ({ id: 'sess', git_branch: 'lazy/child' }),
  getSessionCommits: async () => [{ sha: 'c1' }],
  createComment: async () => {},
  updateTaskMetadata: async (_id: string, key: string, value: string) => { task.metadata![key] = value; },
  updateTaskStatus: async (_id: string, status: TaskStatus) => {
    assertValidTransition(task.status, status);
    task = { ...task, status };
  },
  abandonTask: async (id: string) => { abandoned.push(id); },
};

const loaderPath = resolve(import.meta.dir, '../../src/config/loader.ts');
const realLoader = { ...(await import(loaderPath)) };
await mockModule(loaderPath, () => ({
  ...realLoader,
  loadConfig: async () => ({ ...realLoader.DEFAULT_CONFIG, remote: { ...realLoader.DEFAULT_CONFIG.remote, driver: 'github' } }),
}));
const remotePath = resolve(import.meta.dir, '../../src/remote/index.ts');
const realRemote = { ...(await import(remotePath)) };
await mockModule(remotePath, () => ({
  ...realRemote,
  createDriver: () => ({
    needsSync: true,
    hasRemoteRef: (t: Task) => !!t.metadata?.github_remote_ref_id,
    syncComments: async () => [],
    getPRState: async () => 'CLOSED',
  }),
}));
const orphanPath = resolve(import.meta.dir, '../../src/task/orphan.ts');
const realOrphan = { ...(await import(orphanPath)) };
await mockModule(orphanPath, () => ({
  ...realOrphan,
  reparentChildren: async (t: Task) => { reparentedFrom.push(t.id); return []; },
}));

const { syncTaskFromRemote } = await import('../../src/task/sync-remote');

function makeTask(metadata: Record<string, string>): Task {
  return {
    id: 'child-task-id', code: 'child', goal: 'Child', prompt: '', type: 'task', status: 'submitted',
    created_at: Date.now(), completed_at: null, target: { kind: 'branch', branch: 'main' },
    branched_from_sha: null, close_reason: null, model: null, agent_id: 'claude-code',
    metadata, pending_sync: 0, runner_type: null, tags: [],
  };
}

beforeEach(() => {
  abandoned = [];
  reparentedFrom = [];
});

afterAll(() => {
  restoreMockedModules();
});

describe('syncTaskFromRemote on a CLOSED PR', () => {
  // INVARIANT (src/daemon/lazy-closed-review.ts): a PR lazy closed itself is
  // settled — record and marker dropped, a still-submitted task back to
  // blocked — never abandoned, and its children are never moved.
  test('lazy\'s own close (marked) settles the task', async () => {
    task = makeTask({ github_remote_ref_id: '7', lazy_closed_review: 'https://github.com/o/r/pull/7' });
    await syncTaskFromRemote(task, storage as never, '/tmp/project', 'system');
    expect(abandoned).toEqual([]);
    expect(reparentedFrom).toEqual([]);
    expect(task.status).toBe('blocked');
    expect(task.metadata!.github_remote_ref_id).toBe('');
    expect(task.metadata!.lazy_closed_review).toBe('');
  });

  // INVARIANT: an unmarked close is somebody else's and still ends the task.
  test('an external close (unmarked) still abandons the task and moves its children', async () => {
    task = makeTask({ github_remote_ref_id: '7' });
    await syncTaskFromRemote(task, storage as never, '/tmp/project', 'system');
    expect(abandoned).toEqual([task.id]);
    expect(reparentedFrom).toEqual([task.id]);
  });
});
