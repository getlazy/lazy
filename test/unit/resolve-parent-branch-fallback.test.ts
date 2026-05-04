/**
 * Unit tests for resolveParentBranchWithFallback — the stale-parent
 * detection logic in syncTask/unblock.
 *
 * INVARIANT: When a task's parent is terminal (complete/closed/abandoned),
 * the function walks up the ancestor chain to find a living parent. If none
 * is found, it falls back to top-level (remote_target_branch or main).
 * The task is reparented as a side effect so future operations don't walk again.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { resolve } from 'path';

// --- Track storage mutations ---
let parentUpdates: Array<{ taskId: string; parentId: string | null }> = [];
let metadataUpdates: Array<{ taskId: string; key: string; value: string }> = [];
let comments: Array<{ taskId: string; content: string }> = [];
let taskStore: Map<string, any> = new Map();

// Mock storage
const mockStorage = {
  getTask: async (id: string) => taskStore.get(id) ?? null,
  updateTaskParent: async (taskId: string, parentId: string | null) => {
    parentUpdates.push({ taskId, parentId });
  },
  updateTaskMetadata: async (taskId: string, key: string, value: string) => {
    metadataUpdates.push({ taskId, key, value });
  },
  createComment: async (taskId: string, content: string, _actor: string) => {
    comments.push({ taskId, content });
  },
};

// Mock getCurrentBranch
let mockCurrentBranch = 'main';
mock.module(resolve(import.meta.dir, '../../src/git/operations.ts'), () => ({
  getCurrentBranch: async () => mockCurrentBranch,
  resolveDetachedHead: async (branch: string) => branch,
  getCurrentSha: async () => 'abc123',
  branchExists: async () => false,
  hasUpstreamChanges: async () => false,
  hasUncommittedChanges: async () => false,
  recoverMissingWorktreeWithFetch: async () => ({ recovered: false }),
  checkMergeConflicts: async () => false,
  checkMergeConflictsIntoTarget: async () => false,
}));

// Mock getBranchNameFromId — import real functions to avoid breaking other tests
// (bun's mock.module replaces the entire module, so we must re-export everything)
import { deriveTaskRef as realDeriveTaskRef, taskRef as realTaskRef } from '../../src/cli/helpers';
const branchNameMap = new Map<string, string>();
mock.module(resolve(import.meta.dir, '../../src/cli/helpers.ts'), () => ({
  getBranchNameFromId: async (taskId: string) => {
    return branchNameMap.get(taskId) ?? `lazy/${taskId.substring(0, 8)}`;
  },
  shortId: (id: string) => id.substring(0, 8),
  displayId: (task: any) => task.code ?? task.id.substring(0, 8),
  taskRef: realTaskRef,
  getWorktreePath: () => '/tmp/worktree',
  getWorktreePathForRef: () => '/tmp/worktree',
  deriveTaskRef: realDeriveTaskRef,
}));

// Mock constants
mock.module(resolve(import.meta.dir, '../../src/constants.ts'), () => ({
  getActor: () => 'test',
}));

// Mock logger
mock.module(resolve(import.meta.dir, '../../src/utils/logger.ts'), () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

// Import the real function after mocks are registered
const { resolveParentBranchWithFallback } = await import('../../src/daemon/task-lifecycle');

describe('resolveParentBranch stale parent fallback', () => {
  beforeEach(() => {
    parentUpdates = [];
    metadataUpdates = [];
    comments = [];
    taskStore.clear();
    branchNameMap.clear();
    mockCurrentBranch = 'main';
  });

  // INVARIANT: No parent → return remote_target_branch or current branch
  test('returns remote_target_branch for top-level task', async () => {
    const task = { id: 'child-id-1234', parent_task_id: null, metadata: { remote_target_branch: 'develop' } };
    const result = await resolveParentBranchWithFallback(task as any, mockStorage as any, '/project');
    expect(result.branch).toBe('develop');
    expect(result.warnings).toEqual([]);
    expect(parentUpdates).toEqual([]);
  });

  // INVARIANT: Living parent → return parent's branch directly
  test('returns parent branch when parent is alive', async () => {
    const parent = { id: 'parent-id-1234', status: 'blocked', code: 'parent-task' };
    taskStore.set(parent.id, parent);
    branchNameMap.set(parent.id, 'lazy/parent-task');

    const task = { id: 'child-id-1234', parent_task_id: parent.id, metadata: {} };
    const result = await resolveParentBranchWithFallback(task as any, mockStorage as any, '/project');
    expect(result.branch).toBe('lazy/parent-task');
    expect(result.warnings).toEqual([]);
    expect(parentUpdates).toEqual([]);
  });

  // INVARIANT: Terminal parent → walk up and reparent to living grandparent
  test('walks up to living grandparent when parent is complete', async () => {
    const grandparent = { id: 'gp-id-12345678', status: 'blocked', code: 'grandparent' };
    const parent = { id: 'parent-id-1234', status: 'complete', code: 'parent', parent_task_id: grandparent.id };
    taskStore.set(grandparent.id, grandparent);
    taskStore.set(parent.id, parent);
    branchNameMap.set(grandparent.id, 'lazy/grandparent');

    const task = { id: 'child-id-1234', parent_task_id: parent.id, metadata: {} };
    const result = await resolveParentBranchWithFallback(task as any, mockStorage as any, '/project');

    expect(result.branch).toBe('lazy/grandparent');
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('is complete');
    expect(result.warnings[0]).toContain('grandparent');
    expect(parentUpdates).toEqual([{ taskId: 'child-id-1234', parentId: grandparent.id }]);
    expect(comments.length).toBe(1);
    expect(comments[0].content).toContain('[Re-parented]');
  });

  // INVARIANT: Entire chain terminal → fall back to main, reparent to top-level,
  // and always set remote_target_branch to the resolved main branch.
  test('falls back to main when all ancestors are terminal', async () => {
    const grandparent = { id: 'gp-id-12345678', status: 'closed', code: 'gp', parent_task_id: null };
    const parent = { id: 'parent-id-1234', status: 'complete', code: 'parent', parent_task_id: grandparent.id };
    taskStore.set(grandparent.id, grandparent);
    taskStore.set(parent.id, parent);
    mockCurrentBranch = 'main';

    const task = { id: 'child-id-1234', parent_task_id: parent.id, metadata: {} };
    const result = await resolveParentBranchWithFallback(task as any, mockStorage as any, '/project');

    expect(result.branch).toBe('main');
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('is complete');
    expect(result.warnings[0]).toContain('main');
    expect(parentUpdates).toEqual([{ taskId: 'child-id-1234', parentId: null }]);
    // Always sets remote_target_branch when falling back to top-level
    expect(metadataUpdates).toEqual([{ taskId: 'child-id-1234', key: 'remote_target_branch', value: 'main' }]);
  });

  // INVARIANT: Missing parent (deleted from storage) → fall back to main
  test('falls back to main when parent is not found in storage', async () => {
    const task = { id: 'child-id-1234', parent_task_id: 'missing-parent', metadata: {} };
    mockCurrentBranch = 'main';

    const result = await resolveParentBranchWithFallback(task as any, mockStorage as any, '/project');

    expect(result.branch).toBe('main');
    expect(result.warnings.length).toBe(1);
    expect(parentUpdates).toEqual([{ taskId: 'child-id-1234', parentId: null }]);
    expect(metadataUpdates).toEqual([{ taskId: 'child-id-1234', key: 'remote_target_branch', value: 'main' }]);
  });

  // INVARIANT: Closed parent → same behavior as complete parent
  test('treats closed parent same as complete parent', async () => {
    const parent = { id: 'parent-id-1234', status: 'closed', code: 'closed-parent', parent_task_id: null };
    taskStore.set(parent.id, parent);
    mockCurrentBranch = 'main';

    const task = { id: 'child-id-1234', parent_task_id: parent.id, metadata: {} };
    const result = await resolveParentBranchWithFallback(task as any, mockStorage as any, '/project');

    expect(result.branch).toBe('main');
    expect(parentUpdates).toEqual([{ taskId: 'child-id-1234', parentId: null }]);
  });

  // INVARIANT: Top-level task with stale lazy/* remote_target_branch → detect and
  // correct to actual main branch. No legitimate target branch starts with lazy/ —
  // that prefix is reserved for task branches.
  test('corrects stale lazy/* remote_target_branch on top-level task', async () => {
    const task = { id: 'child-id-1234', parent_task_id: null, metadata: { remote_target_branch: 'lazy/stale-parent-branch' } };
    mockCurrentBranch = 'main';

    const result = await resolveParentBranchWithFallback(task as any, mockStorage as any, '/project');

    // Should fall back to getCurrentBranch, not use the stale lazy/* branch
    expect(result.branch).toBe('main');
    // Should overwrite the stale metadata
    expect(metadataUpdates).toEqual([{ taskId: 'child-id-1234', key: 'remote_target_branch', value: 'main' }]);
    // Should warn about the correction
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('Corrected stale remote_target_branch');
    expect(result.warnings[0]).toContain('lazy/stale-parent-branch');
    // Should NOT reparent (already top-level)
    expect(parentUpdates).toEqual([]);
  });

  // INVARIANT: Top-level task with legitimate non-lazy remote_target_branch → use as-is
  test('preserves legitimate remote_target_branch on top-level task', async () => {
    const task = { id: 'child-id-1234', parent_task_id: null, metadata: { remote_target_branch: 'develop' } };
    const result = await resolveParentBranchWithFallback(task as any, mockStorage as any, '/project');

    expect(result.branch).toBe('develop');
    expect(result.warnings).toEqual([]);
    // Should NOT overwrite metadata
    expect(metadataUpdates).toEqual([]);
    expect(parentUpdates).toEqual([]);
  });

  // INVARIANT: Stale remote_target_branch is IGNORED when falling back to top-level.
  // remote_target_branch was set relative to the now-dead parent chain — using it
  // would sync against a stale branch forever.
  test('ignores stale remote_target_branch when all ancestors are terminal', async () => {
    const parent = { id: 'parent-id-1234', status: 'complete', code: 'parent', parent_task_id: null };
    taskStore.set(parent.id, parent);
    mockCurrentBranch = 'main';

    const task = { id: 'child-id-1234', parent_task_id: parent.id, metadata: { remote_target_branch: 'lazy/stale-parent-branch' } };
    const result = await resolveParentBranchWithFallback(task as any, mockStorage as any, '/project');

    // Should use getCurrentBranch ('main'), NOT the stale 'lazy/stale-parent-branch'
    expect(result.branch).toBe('main');
    // Should overwrite the stale remote_target_branch metadata
    expect(metadataUpdates).toEqual([{ taskId: 'child-id-1234', key: 'remote_target_branch', value: 'main' }]);
  });
});
