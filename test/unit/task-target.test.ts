/**
 * Unit tests for the TaskTarget discriminated union and its legacy mapping.
 *
 * INVARIANT: A task's integration target is ONE discriminated union, so the
 * old illegal states are unrepresentable by construction:
 *   - both a parent task AND a target branch set
 *   - neither set
 *   - a 'lazy/...' task-branch ref smuggled into the branch slot
 * The smart constructors are the enforcement boundary; `targetFromLegacy`
 * deserializes the old two-field shape and is the single mapping point.
 */

import { describe, test, expect } from 'bun:test';
import {
  taskTarget,
  branchTarget,
  targetFromLegacy,
  targetToLegacy,
  parentTaskIdOf,
  targetBranchOf,
  collectSubtreeIds,
} from '../../src/task-target';
import type { Task } from '../../src/types';

describe('TaskTarget construction guards', () => {
  // INVARIANT: a 'lazy/...' ref must never live in the branch slot — that's a
  // task-branch reference, exactly the illegal state the union exists to prevent.
  test('branchTarget rejects lazy/* refs', () => {
    expect(() => branchTarget('lazy/abc12345')).toThrow(/lazy task ref/);
  });

  // INVARIANT: the branch slot is meaningless when empty.
  test('branchTarget rejects empty / whitespace branches', () => {
    expect(() => branchTarget('')).toThrow(/non-empty/);
    expect(() => branchTarget('   ')).toThrow(/non-empty/);
  });

  test('branchTarget trims and builds a branch variant', () => {
    expect(branchTarget('  main  ')).toEqual({ kind: 'branch' as const, branch: 'main' });
  });

  // INVARIANT: a task variant must carry a real parent id.
  test('taskTarget rejects an empty parent id', () => {
    expect(() => taskTarget('')).toThrow(/non-empty/);
  });

  test('taskTarget builds a task variant', () => {
    expect(taskTarget('parent-123')).toEqual({ kind: 'task' as const, parentTaskId: 'parent-123' });
  });
});

describe('legacy (parent_task_id, remote_target_branch) ↔ TaskTarget mapping', () => {
  // parent_task_id set → task variant (the branch is derived from the parent).
  test('parent_task_id wins → task variant', () => {
    expect(targetFromLegacy('parent-1', 'develop')).toEqual({ kind: 'task' as const, parentTaskId: 'parent-1' });
    expect(targetFromLegacy('parent-1', null)).toEqual({ kind: 'task' as const, parentTaskId: 'parent-1' });
  });

  // No parent, named branch → branch variant.
  test('no parent, named branch → branch variant', () => {
    expect(targetFromLegacy(null, 'develop')).toEqual({ kind: 'branch' as const, branch: 'develop' });
  });

  // Lenient: legacy data may carry a missing or 'lazy/...' branch. The mapping
  // preserves it verbatim as a "needs runtime resolution" sentinel — the
  // resolver heals it. (branchTarget, used by app code, would reject these.)
  test('no parent, missing branch → empty branch sentinel', () => {
    expect(targetFromLegacy(null, null)).toEqual({ kind: 'branch' as const, branch: '' });
    expect(targetFromLegacy(null, undefined)).toEqual({ kind: 'branch' as const, branch: '' });
  });

  test('no parent, stale lazy/* branch → preserved verbatim for the resolver', () => {
    expect(targetFromLegacy(null, 'lazy/stale')).toEqual({ kind: 'branch' as const, branch: 'lazy/stale' });
  });

  // Round-trip: canonical → legacy → canonical is stable for well-formed targets.
  test('round-trips a task target through the legacy projection', () => {
    const t = taskTarget('parent-9');
    const legacy = targetToLegacy(t);
    expect(legacy).toEqual({ parent_task_id: 'parent-9', remote_target_branch: null });
    expect(targetFromLegacy(legacy.parent_task_id, legacy.remote_target_branch)).toEqual(t);
  });

  test('round-trips a branch target through the legacy projection', () => {
    const t = branchTarget('release-1.0');
    const legacy = targetToLegacy(t);
    expect(legacy).toEqual({ parent_task_id: null, remote_target_branch: 'release-1.0' });
    expect(targetFromLegacy(legacy.parent_task_id, legacy.remote_target_branch)).toEqual(t);
  });

  // INVARIANT: PostgresStorage stores the canonical `target` JSONB but keeps a
  // denormalized parent_task_id column for the ancestry CTE / child lookups.
  // Both write paths set that column to targetToLegacy(target).parent_task_id,
  // which must equal parentTaskIdOf(target) — so the column is a pure projection
  // of the union and cannot drift from it.
  test('parent_task_id column projection agrees with parentTaskIdOf', () => {
    const asTask = (target: Task['target']): Task => ({ target } as Task);
    for (const t of [taskTarget('parent-7'), branchTarget('main')] as const) {
      expect(targetToLegacy(t).parent_task_id).toBe(parentTaskIdOf(asTask(t)));
    }
  });
});

describe('TaskTarget projections', () => {
  const asTask = (target: Task['target']): Task => ({ target } as Task);

  test('parentTaskIdOf returns the parent id only for task targets', () => {
    expect(parentTaskIdOf(asTask({ kind: 'task' as const, parentTaskId: 'p1' }))).toBe('p1');
    expect(parentTaskIdOf(asTask({ kind: 'branch' as const, branch: 'main' }))).toBeNull();
  });

  test('targetBranchOf returns the branch only for non-empty branch targets', () => {
    expect(targetBranchOf(asTask({ kind: 'branch' as const, branch: 'main' }))).toBe('main');
    expect(targetBranchOf(asTask({ kind: 'branch' as const, branch: '' }))).toBeUndefined();
    expect(targetBranchOf(asTask({ kind: 'task' as const, parentTaskId: 'p1' }))).toBeUndefined();
  });
});

describe('collectSubtreeIds', () => {
  const child = (id: string, parentId: string): Task => ({ id, target: taskTarget(parentId) } as Task);
  const root = (id: string): Task => ({ id, target: branchTarget('main') } as Task);

  test('collects the task itself plus descendants at every depth', () => {
    const tasks = [root('r'), child('c1', 'r'), child('c2', 'r'), child('g1', 'c1'), child('gg1', 'g1'), root('other')];
    expect([...collectSubtreeIds('r', tasks)].sort()).toEqual(['c1', 'c2', 'g1', 'gg1', 'r']);
  });

  test('a leaf subtree is just the task itself', () => {
    expect([...collectSubtreeIds('g1', [root('r'), child('c1', 'r'), child('g1', 'c1')])]).toEqual(['g1']);
  });

  test('an id with no matching task still yields that id (callers filter, not the walk)', () => {
    expect([...collectSubtreeIds('missing', [root('r')])]).toEqual(['missing']);
  });

  // INVARIANT: a corrupt store with a cyclic parent link must not hang the walk.
  test('terminates on a parent cycle', () => {
    const tasks = [child('a', 'b'), child('b', 'a')];
    expect([...collectSubtreeIds('a', tasks)].sort()).toEqual(['a', 'b']);
  });
});
