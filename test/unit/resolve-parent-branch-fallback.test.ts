/**
 * Unit tests for resolveParentBranchWithFallback — the stale-parent
 * detection logic in syncTask/unblock.
 *
 * INVARIANT: When a task's parent is terminal (complete/closed/abandoned),
 * the function walks up the ancestor chain to find a living parent. If none
 * is found, it falls back to top-level (the named target branch or main).
 * The task's canonical `target` is repointed as a side effect so future
 * operations don't walk again. Since the target is a single discriminated
 * union, a parent task and a target branch can never be set independently —
 * the resolver always writes exactly one TaskTarget.
 */

import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';
import { resolve } from 'path';
import type { TaskTarget } from '../../src/types';

// --- Track storage mutations ---
let targetUpdates: Array<{ taskId: string; target: TaskTarget }> = [];
let comments: Array<{ taskId: string; content: string }> = [];
let taskStore: Map<string, any> = new Map();

// Mock storage
const mockStorage = {
  getTask: async (id: string) => taskStore.get(id) ?? null,
  updateTaskTarget: async (taskId: string, target: TaskTarget) => {
    targetUpdates.push({ taskId, target });
  },
  createComment: async (taskId: string, content: string, _actor: string) => {
    comments.push({ taskId, content });
  },
};

// INVARIANT: the heal path resolves to the REPO DEFAULT branch (origin/HEAD →
// 'main' fallback) — NEVER to whatever branch the user happens to have checked
// out at sync time. Adopting the current branch was the root of the
// fix-target-adoption bug: tasks created/synced from a release branch silently
// adopted it as their integration target and later opened PRs against dead
// bases. The resolver now reads only the configured remote default.
let mockRemoteDefaultBranch = 'main';
let mockCurrentBranchSentinel = 'should-never-be-read';
await mockModule(resolve(import.meta.dir, '../../src/git/operations.ts'), () => ({
  getRemoteDefaultBranch: async () => mockRemoteDefaultBranch,
  getCurrentBranch: async () => mockCurrentBranchSentinel,
  resolveDetachedHead: async (branch: string) => branch,
  getCurrentSha: async () => 'abc123',
  branchExists: async () => false,
  hasUpstreamChanges: async () => false,
  hasUncommittedChanges: async () => false,
  recoverMissingWorktreeWithFetch: async () => ({ recovered: false }),
  checkMergeConflicts: async () => false,
  checkMergeConflictsIntoTarget: async () => false,
}));

// Mock loadConfig — the resolver needs config.remote.git_remote to ask the right
// remote for its default branch.
await mockModule(resolve(import.meta.dir, '../../src/config/loader.ts'), () => ({
  loadConfig: async () => ({ remote: { git_remote: 'origin' } }),
}));

// Mock getBranchNameFromId — import real functions to avoid breaking other tests
// (bun's mock.module replaces the entire module, so we must re-export everything)
import { deriveTaskRef as realDeriveTaskRef, taskRef as realTaskRef } from '../../src/cli/helpers';
const branchNameMap = new Map<string, string>();
await mockModule(resolve(import.meta.dir, '../../src/cli/helpers.ts'), () => ({
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
await mockModule(resolve(import.meta.dir, '../../src/constants.ts'), () => ({
  getActor: () => 'test',
}));

// Mock logger
await mockModule(resolve(import.meta.dir, '../../src/utils/logger.ts'), () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

// Import the real function after mocks are registered
const { resolveParentBranchWithFallback } = await import('../../src/daemon/task-lifecycle');

// Helpers to build the canonical target on mock tasks.
const branchT = (branch: string): TaskTarget => ({ kind: 'branch', branch });
const taskT = (parentTaskId: string): TaskTarget => ({ kind: 'task', parentTaskId });

describe('resolveParentBranch stale parent fallback', () => {
  beforeEach(() => {
    targetUpdates = [];
    comments = [];
    taskStore.clear();
    branchNameMap.clear();
    mockRemoteDefaultBranch = 'main';
  });

  // INVARIANT: Top-level (branch target) → return that branch, no rewrite.
  test('returns target branch for top-level task', async () => {
    const task = { id: 'child-id-1234', target: branchT('develop'), metadata: {} };
    const result = await resolveParentBranchWithFallback(task as any, mockStorage as any, '/project');
    expect(result.branch).toBe('develop');
    expect(result.warnings).toEqual([]);
    expect(targetUpdates).toEqual([]);
  });

  // INVARIANT: Living parent → return parent's branch directly
  test('returns parent branch when parent is alive', async () => {
    const parent = { id: 'parent-id-1234', status: 'blocked', code: 'parent-task', target: branchT('main') };
    taskStore.set(parent.id, parent);
    branchNameMap.set(parent.id, 'lazy/parent-task');

    const task = { id: 'child-id-1234', target: taskT(parent.id), metadata: {} };
    const result = await resolveParentBranchWithFallback(task as any, mockStorage as any, '/project');
    expect(result.branch).toBe('lazy/parent-task');
    expect(result.warnings).toEqual([]);
    expect(targetUpdates).toEqual([]);
  });

  // INVARIANT: Terminal parent → walk up and reparent to living grandparent.
  // The new target is a single { kind: 'task' } — no stale branch tags along.
  test('walks up to living grandparent when parent is complete', async () => {
    const grandparent = { id: 'gp-id-12345678', status: 'blocked', code: 'grandparent', target: branchT('main') };
    const parent = { id: 'parent-id-1234', status: 'complete', code: 'parent', target: taskT(grandparent.id) };
    taskStore.set(grandparent.id, grandparent);
    taskStore.set(parent.id, parent);
    branchNameMap.set(grandparent.id, 'lazy/grandparent');

    const task = { id: 'child-id-1234', target: taskT(parent.id), metadata: {} };
    const result = await resolveParentBranchWithFallback(task as any, mockStorage as any, '/project');

    expect(result.branch).toBe('lazy/grandparent');
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('is complete');
    expect(result.warnings[0]).toContain('grandparent');
    expect(targetUpdates).toEqual([{ taskId: 'child-id-1234', target: { kind: 'task' as const, parentTaskId: grandparent.id } }]);
    expect(comments.length).toBe(1);
    expect(comments[0].content).toContain('[Re-parented]');
  });

  // INVARIANT: Entire chain terminal → fall back to main and repoint the target
  // to a single { kind: 'branch' } pointing at the resolved main branch.
  test('falls back to main when all ancestors are terminal', async () => {
    const grandparent = { id: 'gp-id-12345678', status: 'abandoned', code: 'gp', target: branchT('main') };
    const parent = { id: 'parent-id-1234', status: 'complete', code: 'parent', target: taskT(grandparent.id) };
    taskStore.set(grandparent.id, grandparent);
    taskStore.set(parent.id, parent);
    mockRemoteDefaultBranch = 'main';

    const task = { id: 'child-id-1234', target: taskT(parent.id), metadata: {} };
    const result = await resolveParentBranchWithFallback(task as any, mockStorage as any, '/project');

    expect(result.branch).toBe('main');
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('is complete');
    expect(result.warnings[0]).toContain('main');
    expect(targetUpdates).toEqual([{ taskId: 'child-id-1234', target: { kind: 'branch' as const, branch: 'main' } }]);
  });

  // INVARIANT: Missing parent (deleted from storage) → fall back to main
  test('falls back to main when parent is not found in storage', async () => {
    const task = { id: 'child-id-1234', target: taskT('missing-parent'), metadata: {} };
    mockRemoteDefaultBranch = 'main';

    const result = await resolveParentBranchWithFallback(task as any, mockStorage as any, '/project');

    expect(result.branch).toBe('main');
    expect(result.warnings.length).toBe(1);
    expect(targetUpdates).toEqual([{ taskId: 'child-id-1234', target: { kind: 'branch' as const, branch: 'main' } }]);
  });

  // INVARIANT: Abandoned parent → same behavior as complete parent
  test('treats abandoned parent same as complete parent', async () => {
    const parent = { id: 'parent-id-1234', status: 'abandoned', code: 'abandoned-parent', target: branchT('main') };
    taskStore.set(parent.id, parent);
    mockRemoteDefaultBranch = 'main';

    const task = { id: 'child-id-1234', target: taskT(parent.id), metadata: {} };
    const result = await resolveParentBranchWithFallback(task as any, mockStorage as any, '/project');

    expect(result.branch).toBe('main');
    expect(targetUpdates).toEqual([{ taskId: 'child-id-1234', target: { kind: 'branch' as const, branch: 'main' } }]);
  });

  // INVARIANT: Top-level task with a stale lazy/* branch in its target → detect
  // and correct to the actual main branch. No legitimate target branch starts
  // with lazy/ — that prefix is reserved for task branches, and a lazy/ ref in
  // the branch slot can only come from legacy data the resolver heals.
  test('corrects stale lazy/* target branch on top-level task', async () => {
    const task = { id: 'child-id-1234', target: branchT('lazy/stale-parent-branch'), metadata: {} };
    mockRemoteDefaultBranch = 'main';

    const result = await resolveParentBranchWithFallback(task as any, mockStorage as any, '/project');

    // Should fall back to getCurrentBranch, not use the stale lazy/* branch
    expect(result.branch).toBe('main');
    // Should overwrite the stale target with a canonical branch target
    expect(targetUpdates).toEqual([{ taskId: 'child-id-1234', target: { kind: 'branch' as const, branch: 'main' } }]);
    // Should warn about the correction
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('Corrected stale target branch');
    expect(result.warnings[0]).toContain('lazy/stale-parent-branch');
  });

  // INVARIANT: Top-level task with a legitimate non-lazy target branch → use as-is
  test('preserves legitimate target branch on top-level task', async () => {
    const task = { id: 'child-id-1234', target: branchT('develop'), metadata: {} };
    const result = await resolveParentBranchWithFallback(task as any, mockStorage as any, '/project');

    expect(result.branch).toBe('develop');
    expect(result.warnings).toEqual([]);
    // Should NOT rewrite the target
    expect(targetUpdates).toEqual([]);
  });

  // INVARIANT (fix-target-adoption): when the heal path fires, the resolver
  // reads the repo's configured default branch — NEVER the user's currently
  // checked-out branch. Adopting `getCurrentBranch()` was the root of the
  // silent-target-adoption bug: syncing a task while accidentally checked
  // out on `lazy/release-v015` heal-pathed the task onto that branch and
  // later opened a PR against a dead base.
  test('heal path resolves to repo default, NOT current branch', async () => {
    mockRemoteDefaultBranch = 'main';
    // If the resolver ever calls getCurrentBranch, it'll get a sentinel that
    // the assertion below rejects — defense in depth against the regression
    // returning silently.
    mockCurrentBranchSentinel = 'lazy/release-v015';

    // Top-level with empty-sentinel target (a fresh top-level task before
    // start, or any task whose target was never explicitly set).
    const task = { id: 'child-id-1234', target: branchT(''), metadata: {} };
    const result = await resolveParentBranchWithFallback(task as any, mockStorage as any, '/project');

    expect(result.branch).toBe('main');
    expect(result.branch).not.toBe('lazy/release-v015');
  });
});

afterAll(() => {
  restoreMockedModules();
});
