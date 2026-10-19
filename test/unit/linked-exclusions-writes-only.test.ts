import { describe, test, expect } from 'bun:test';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { detectExternalChanges, debugSyncLogger } from '../../src/daemon/remote-sync';
import { IMPORT_SOURCE_BRANCH_KEY, IMPORT_SOURCE_URL_KEY } from '../../src/task/linked';

/**
 * INVARIANT: the linked-task exclusions (`isLinkedTask`) cover WRITES to a PR/MR
 * someone else owns — push, retarget, close, description refresh, comment.
 * READING that PR/MR's fate and applying it to the task is not a write: a
 * linked task whose PR merged completes, one whose PR closed is abandoned.
 * The read path once dropped linked tasks (a merge with no recorded session
 * commits counted as "spurious", and a linked task never records any), so
 * linked tasks stayed open forever.
 */

const ROOT = resolve(import.meta.dir, '../..');

function harness(tasks: any[], prState: string) {
  const statuses: Record<string, string[]> = {};
  const comments: Record<string, string[]> = {};
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const storage: any = {
    listTasks: async () => tasks,
    getTask: async (id: string) => byId.get(id) ?? null,
    getSessionByTaskId: async (id: string) => ({ id: `s-${id}`, ended_at: null, git_branch: 'b' }),
    getSessionCommits: async () => [],
    getTaskComments: async (id: string) => (comments[id] ?? []).map((content) => ({ content })),
    createComment: async (id: string, content: string) => { (comments[id] ??= []).push(content); },
    updateTaskMetadata: async (id: string, k: string, v: string) => { byId.get(id)!.metadata[k] = v; },
    endSession: async () => {},
    updateTaskStatus: async (id: string, s: string) => { (statuses[id] ??= []).push(s); byId.get(id)!.status = s; },
    abandonTask: async (id: string) => { (statuses[id] ??= []).push('abandoned'); byId.get(id)!.status = 'abandoned'; },
    getActiveChildren: async () => [],
    getChildTasks: async () => [],
    listChildTasks: async () => [],
  };
  const writes: string[] = [];
  const driver: any = {
    hasRemoteRef: () => true,
    getPRState: async () => prState,
    getReviewBase: async () => 'main',
    getChecksStatus: async () => ({ status: 'passed', failed: [] }),
    recoverRemoteRef: async () => null,
    getTaskUrl: async () => null,
    retargetReview: async () => { writes.push('retarget'); },
    cleanup: async () => { writes.push('close'); },
    pushBranch: async () => { writes.push('push'); },
  };
  return { storage, driver, statuses, comments, writes };
}

function task(id: string, linked: boolean): any {
  return {
    id, code: id, status: 'blocked', target: { kind: 'branch', branch: 'main' },
    metadata: linked ? { [IMPORT_SOURCE_URL_KEY]: 'feature/x', [IMPORT_SOURCE_BRANCH_KEY]: 'feature/x' } : {},
  };
}

describe('linked-task exclusions apply to writes only', () => {
  test('a merged linked PR completes its task though it recorded no commits; an unlinked one stays spurious', async () => {
    const h = harness([task('linked-1', true), task('plain-1', false)], 'MERGED');
    const result = await detectExternalChanges(h.storage, h.driver, debugSyncLogger);
    expect(result.merged).toBe(1);
    expect(result.spurious).toBe(1);
    expect(h.statuses['linked-1']).toContain('complete');
    expect(h.statuses['plain-1']).toBeUndefined();
    expect(h.comments['linked-1'].some((c) => c.includes('linked PR/MR was merged on the forge'))).toBe(true);
    expect(h.writes).toEqual([]);
  });

  test('a closed linked PR abandons its task with a comment, writing nothing to the forge', async () => {
    const h = harness([task('linked-2', true)], 'CLOSED');
    const result = await detectExternalChanges(h.storage, h.driver, debugSyncLogger);
    expect(result.closed).toBe(1);
    expect(h.statuses['linked-2']).toEqual(['abandoned']);
    expect(h.comments['linked-2'].some((c) => c.includes('closed on the forge without being merged'))).toBe(true);
    expect(h.writes).toEqual([]);
  });

  test('the write paths keep their linked exclusions', async () => {
    const remoteSync = await readFile(resolve(ROOT, 'src/daemon/remote-sync.ts'), 'utf-8');
    // exportTasks (push) and the description refresh both still skip linked tasks.
    expect((remoteSync.match(/if \(isLinkedTask\(task\)\) continue;/g) ?? []).length).toBeGreaterThanOrEqual(2);
    const retarget = await readFile(resolve(ROOT, 'src/daemon/review-retarget.ts'), 'utf-8');
    expect(retarget).toContain('isLinkedTask(task)');
    const base = await readFile(resolve(ROOT, 'src/daemon/review-base.ts'), 'utf-8');
    expect(base).toContain('isLinkedTask(task)');
  });
});
