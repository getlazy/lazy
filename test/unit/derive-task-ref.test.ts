import { describe, test, expect } from 'bun:test';
import { deriveTaskRef, taskRef } from '../../src/cli/helpers';
import type { Task } from '../../src/types';

function makeTask(overrides: Partial<Task> & { id: string; created_at: number }): Task {
  return {
    goal: 'test goal',
    prompt: '',
    type: 'task' as const,
    status: 'backlog' as const,
    completed_at: null,
    parent_task_id: null,
    branched_from_sha: null,
    close_reason: null,
    model: null,
    metadata: null,
    code: null,
    ...overrides,
  };
}

describe('deriveTaskRef', () => {
  // INVARIANT: Tasks with a unique code get the code as their ref.
  // This is the common case and produces the most readable branch names.
  test('unique code returns just the code', () => {
    const task = makeTask({ id: 'aaaa1111-0000-0000-0000-000000000000', code: 'wait-multi', created_at: 1708732800000 });
    const others = [
      makeTask({ id: 'bbbb2222-0000-0000-0000-000000000000', code: 'other-task', created_at: 1708732800000 }),
    ];
    expect(deriveTaskRef(task, [task, ...others])).toBe('wait-multi');
  });

  // INVARIANT: When two tasks share the same code, the creation date disambiguates.
  // This prevents branch name collisions without resorting to opaque hex IDs.
  test('duplicate code with different dates adds date suffix', () => {
    const task = makeTask({ id: 'aaaa1111-0000-0000-0000-000000000000', code: 'wait-multi', created_at: 1708732800000 }); // 2024-02-24
    const dup = makeTask({ id: 'bbbb2222-0000-0000-0000-000000000000', code: 'wait-multi', created_at: 1709337600000 }); // 2024-03-02
    expect(deriveTaskRef(task, [task, dup])).toBe('wait-multi-24-02-24');
    expect(deriveTaskRef(dup, [task, dup])).toBe('wait-multi-24-03-02');
  });

  // INVARIANT: When code AND date collide, the task short ID provides final disambiguation.
  // This covers the rare case of re-creating a task with the same code on the same day.
  test('duplicate code and same date adds date and task ID suffix', () => {
    const task1 = makeTask({ id: 'aaaa1111-0000-0000-0000-000000000000', code: 'wait-multi', created_at: 1708732800000 });
    const task2 = makeTask({ id: 'bbbb2222-0000-0000-0000-000000000000', code: 'wait-multi', created_at: 1708732800000 });
    expect(deriveTaskRef(task1, [task1, task2])).toBe('wait-multi-24-02-24-aaaa1111');
    expect(deriveTaskRef(task2, [task1, task2])).toBe('wait-multi-24-02-24-bbbb2222');
  });

  // INVARIANT: Tasks without a code fall back to the 8-char hex ID.
  // This handles legacy tasks and edge cases gracefully.
  test('no code falls back to shortId', () => {
    const task = makeTask({ id: 'cccc3333-0000-0000-0000-000000000000', code: null, created_at: 1708732800000 });
    expect(deriveTaskRef(task, [task])).toBe('cccc3333');
  });

  // INVARIANT: Ambiguity check considers all tasks including terminal (accepted, rejected, closed).
  // Old branches/worktrees might still exist on disk, so we must avoid collisions with them.
  test('considers terminal tasks for ambiguity', () => {
    const active = makeTask({ id: 'aaaa1111-0000-0000-0000-000000000000', code: 'auth-fix', created_at: 1708732800000, status: 'working' as const });
    const closed = makeTask({ id: 'bbbb2222-0000-0000-0000-000000000000', code: 'auth-fix', created_at: 1709337600000, status: 'complete' as const });
    expect(deriveTaskRef(active, [active, closed])).toBe('auth-fix-24-02-24');
  });

  test('single task with code and no others returns just the code', () => {
    const task = makeTask({ id: 'dddd4444-0000-0000-0000-000000000000', code: 'solo-task', created_at: 1708732800000 });
    expect(deriveTaskRef(task, [task])).toBe('solo-task');
  });

  test('three tasks with same code on different dates get date suffix', () => {
    const t1 = makeTask({ id: 'aaaa1111-0000-0000-0000-000000000000', code: 'fix-bug', created_at: 1708732800000 }); // 2024-02-24
    const t2 = makeTask({ id: 'bbbb2222-0000-0000-0000-000000000000', code: 'fix-bug', created_at: 1709337600000 }); // 2024-03-02
    const t3 = makeTask({ id: 'cccc3333-0000-0000-0000-000000000000', code: 'fix-bug', created_at: 1709942400000 }); // 2024-03-09
    const all = [t1, t2, t3];
    expect(deriveTaskRef(t1, all)).toBe('fix-bug-24-02-24');
    expect(deriveTaskRef(t2, all)).toBe('fix-bug-24-03-02');
    expect(deriveTaskRef(t3, all)).toBe('fix-bug-24-03-09');
  });

  test('mixed: two same-date duplicates and one different date', () => {
    const t1 = makeTask({ id: 'aaaa1111-0000-0000-0000-000000000000', code: 'fix-bug', created_at: 1708732800000 }); // 2024-02-24
    const t2 = makeTask({ id: 'bbbb2222-0000-0000-0000-000000000000', code: 'fix-bug', created_at: 1708732800000 }); // 2024-02-24 (same)
    const t3 = makeTask({ id: 'cccc3333-0000-0000-0000-000000000000', code: 'fix-bug', created_at: 1709337600000 }); // 2024-03-02
    const all = [t1, t2, t3];
    // t1 and t2 share date, need full disambiguation
    expect(deriveTaskRef(t1, all)).toBe('fix-bug-24-02-24-aaaa1111');
    expect(deriveTaskRef(t2, all)).toBe('fix-bug-24-02-24-bbbb2222');
    // t3 has unique date among duplicates
    expect(deriveTaskRef(t3, all)).toBe('fix-bug-24-03-02');
  });
});

describe('taskRef', () => {
  // INVARIANT: taskRef returns stored task_ref metadata when available.
  // Once a task_ref is stored, it must remain stable — even if ambiguity changes.
  test('returns stored task_ref from metadata', () => {
    const task = makeTask({
      id: 'aaaa1111-0000-0000-0000-000000000000',
      code: 'wait-multi',
      created_at: 1708732800000,
      metadata: { task_ref: 'wait-multi' },
    });
    expect(taskRef(task)).toBe('wait-multi');
  });

  // INVARIANT: taskRef falls back to shortId for legacy tasks without stored refs.
  // This ensures backward compatibility with tasks created before this feature.
  test('falls back to shortId when no task_ref in metadata', () => {
    const task = makeTask({
      id: 'aaaa1111-0000-0000-0000-000000000000',
      code: 'wait-multi',
      created_at: 1708732800000,
    });
    expect(taskRef(task)).toBe('aaaa1111');
  });

  test('falls back to shortId when metadata is null', () => {
    const task = makeTask({
      id: 'bbbb2222-0000-0000-0000-000000000000',
      code: null,
      created_at: 1708732800000,
      metadata: null,
    });
    expect(taskRef(task)).toBe('bbbb2222');
  });
});
