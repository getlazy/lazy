import { describe, test, expect, beforeEach } from 'bun:test';
import {
  generateCode,
  storePending,
  validateCode,
  clearPending,
  pendingCount,
  renderGuidance,
  type PendingConfirmation,
} from '../../src/mcp/confirmation';
import {
  acceptConfirmationLevel,
  redoConfirmationLevel,
  reopenConfirmationLevel,
  createConfirmationLevel,
  gatherAcceptContext,
  gatherRedoContext,
  gatherReopenContext,
  gatherCreateParentWarningContext,
  gatherCreateParentWarningSternContext,
  type DiffStat,
} from '../../src/mcp/confirmation-context';
import type { Task } from '../../src/types';

// --- Code generation ---

describe('generateCode', () => {
  test('produces verb-4hex format', () => {
    const code = generateCode('ac');
    expect(code).toMatch(/^ac-[0-9a-f]{4}$/);
  });

  test('uses the provided verb prefix', () => {
    expect(generateCode('ab')).toMatch(/^ab-/);
    expect(generateCode('rd')).toMatch(/^rd-/);
  });

  test('generates different codes on successive calls', () => {
    // With 65536 possibilities, collision in 10 tries is astronomically unlikely
    const codes = new Set<string>();
    for (let i = 0; i < 10; i++) {
      codes.add(generateCode('ac'));
    }
    expect(codes.size).toBeGreaterThan(1);
  });
});

// --- Code validation ---

describe('validateCode', () => {
  beforeEach(() => {
    clearPending();
  });

  test('validates matching code, operation, and taskId', () => {
    const code = 'rj-abcd';
    storePending({
      code,
      operation: 'reject',
      taskId: 'task-123',
      createdAt: Date.now(),
    });
    expect(validateCode(code, 'reject', 'task-123')).toBe(true);
  });

  // INVARIANT: Codes are single-use. After successful validation the code is consumed.
  test('code is consumed after successful validation (single-use)', () => {
    const code = 'rj-abcd';
    storePending({
      code,
      operation: 'reject',
      taskId: 'task-123',
      createdAt: Date.now(),
    });
    expect(validateCode(code, 'reject', 'task-123')).toBe(true);
    expect(validateCode(code, 'reject', 'task-123')).toBe(false);
  });

  // INVARIANT: Codes are scoped to operation. A reject code cannot confirm an accept.
  test('rejects code with wrong operation', () => {
    const code = 'rj-abcd';
    storePending({
      code,
      operation: 'reject',
      taskId: 'task-123',
      createdAt: Date.now(),
    });
    expect(validateCode(code, 'accept', 'task-123')).toBe(false);
  });

  // INVARIANT: Codes are scoped to taskId. A code for task A cannot confirm task B.
  test('rejects code with wrong taskId', () => {
    const code = 'rj-abcd';
    storePending({
      code,
      operation: 'reject',
      taskId: 'task-123',
      createdAt: Date.now(),
    });
    expect(validateCode(code, 'reject', 'task-456')).toBe(false);
  });

  // INVARIANT: Codes expire after 5 minutes to force fresh guidance.
  test('rejects expired code', () => {
    const code = 'rj-abcd';
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000 - 1;
    storePending({
      code,
      operation: 'reject',
      taskId: 'task-123',
      createdAt: fiveMinutesAgo,
    });
    expect(validateCode(code, 'reject', 'task-123')).toBe(false);
  });

  test('returns false for unknown code', () => {
    expect(validateCode('xx-9999', 'reject', 'task-123')).toBe(false);
  });
});

// --- Pending store ---

describe('storePending', () => {
  beforeEach(() => {
    clearPending();
  });

  test('stores and retrieves confirmation', () => {
    storePending({
      code: 'ac-1234',
      operation: 'accept',
      taskId: 'task-1',
      createdAt: Date.now(),
    });
    expect(pendingCount()).toBe(1);
  });

  test('garbage-collects expired entries on store', () => {
    const expired = Date.now() - 6 * 60 * 1000;
    storePending({
      code: 'ac-0001',
      operation: 'accept',
      taskId: 'task-1',
      createdAt: expired,
    });
    expect(pendingCount()).toBe(1);

    // Storing a new entry triggers GC of the expired one
    storePending({
      code: 'ac-0002',
      operation: 'accept',
      taskId: 'task-2',
      createdAt: Date.now(),
    });
    expect(pendingCount()).toBe(1); // only the new one remains
  });
});

// --- Scaling functions ---

describe('acceptConfirmationLevel', () => {
  // INVARIANT: Tiny diffs need no confirmation to avoid unnecessary friction.
  test('returns none for tiny diff (<=20 lines, <=2 files)', () => {
    expect(acceptConfirmationLevel({ filesChanged: 1, linesAdded: 10, linesRemoved: 5 })).toBe('none');
    expect(acceptConfirmationLevel({ filesChanged: 2, linesAdded: 10, linesRemoved: 10 })).toBe('none');
  });

  test('returns light for moderate diff', () => {
    expect(acceptConfirmationLevel({ filesChanged: 3, linesAdded: 30, linesRemoved: 20 })).toBe('light');
  });

  // INVARIANT: Large diffs (>100 lines or >5 files) require standard confirmation.
  test('returns standard for large diff (>100 lines)', () => {
    expect(acceptConfirmationLevel({ filesChanged: 3, linesAdded: 60, linesRemoved: 41 })).toBe('standard');
  });

  test('returns standard for many files (>5)', () => {
    expect(acceptConfirmationLevel({ filesChanged: 6, linesAdded: 20, linesRemoved: 20 })).toBe('standard');
  });

  // INVARIANT: Very large diffs (>500 lines or >10 files) require stern confirmation.
  test('returns stern for very large diff (>500 lines)', () => {
    expect(acceptConfirmationLevel({ filesChanged: 3, linesAdded: 400, linesRemoved: 101 })).toBe('stern');
  });

  test('returns stern for very many files (>10)', () => {
    expect(acceptConfirmationLevel({ filesChanged: 11, linesAdded: 10, linesRemoved: 10 })).toBe('stern');
  });

  // Boundary tests
  test('boundary: exactly 20 lines and 2 files is none', () => {
    expect(acceptConfirmationLevel({ filesChanged: 2, linesAdded: 12, linesRemoved: 8 })).toBe('none');
  });

  test('boundary: 21 lines with <=2 files is light', () => {
    expect(acceptConfirmationLevel({ filesChanged: 2, linesAdded: 11, linesRemoved: 10 })).toBe('light');
  });

  test('boundary: exactly 100 lines is light', () => {
    expect(acceptConfirmationLevel({ filesChanged: 3, linesAdded: 60, linesRemoved: 40 })).toBe('light');
  });

  test('boundary: 101 lines is standard', () => {
    expect(acceptConfirmationLevel({ filesChanged: 3, linesAdded: 60, linesRemoved: 41 })).toBe('standard');
  });

  test('boundary: exactly 500 lines is standard', () => {
    expect(acceptConfirmationLevel({ filesChanged: 3, linesAdded: 300, linesRemoved: 200 })).toBe('standard');
  });

  test('boundary: 501 lines is stern', () => {
    expect(acceptConfirmationLevel({ filesChanged: 3, linesAdded: 300, linesRemoved: 201 })).toBe('stern');
  });
});

describe('redoConfirmationLevel', () => {
  test('returns standard for few commits', () => {
    expect(redoConfirmationLevel(0)).toBe('standard');
    expect(redoConfirmationLevel(3)).toBe('standard');
    expect(redoConfirmationLevel(5)).toBe('standard');
  });

  test('returns stern for many commits (>5)', () => {
    expect(redoConfirmationLevel(6)).toBe('stern');
    expect(redoConfirmationLevel(20)).toBe('stern');
  });
});

describe('reopenConfirmationLevel', () => {
  test('returns light for non-complete tasks', () => {
    expect(reopenConfirmationLevel({ status: 'abandoned' })).toBe('light');
    expect(reopenConfirmationLevel({ status: 'abandoned' })).toBe('light');
  });

  // INVARIANT: Reopening completed (accepted) tasks is standard because the work was already merged.
  test('returns standard for completed tasks', () => {
    expect(reopenConfirmationLevel({ status: 'complete' })).toBe('standard');
  });
});

describe('createConfirmationLevel', () => {
  const activeTask = {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    code: 'active-task',
    status: 'working' as const,
  } as Task;

  const blockedTask = {
    id: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
    code: 'blocked-task',
    status: 'blocked' as const,
  } as Task;

  test('returns none when no parent specified', () => {
    expect(createConfirmationLevel(undefined, [{ task: activeTask, childCount: 0 }])).toBe('none');
  });

  test('returns none when parent is not main', () => {
    expect(createConfirmationLevel('some-task', [{ task: activeTask, childCount: 0 }])).toBe('none');
  });

  test('returns none when parent is main but no active tasks', () => {
    expect(createConfirmationLevel('main', [])).toBe('none');
  });

  // INVARIANT: Singleton tasks (no non-terminal subtasks) do NOT trigger a warning.
  // Only push back when the project demonstrably uses parent-child hierarchy with live subtasks.
  test('returns none when parent is main and active tasks are singletons (no active children)', () => {
    expect(createConfirmationLevel('main', [{ task: activeTask, childCount: 0 }])).toBe('none');
  });

  // INVARIANT: Stern confirmation when creating under main and active tasks have children.
  // The project clearly uses parent-child hierarchy — creating parentless is almost certainly wrong.
  test('returns stern when parent is main and active task has children', () => {
    expect(createConfirmationLevel('main', [{ task: activeTask, childCount: 5 }])).toBe('stern');
  });

  // INVARIANT: Guard fires for blocked tasks too, not just working tasks.
  // A blocked task is still active — the agent is just waiting for feedback.
  test('returns stern when blocked task has children', () => {
    expect(createConfirmationLevel('main', [{ task: blockedTask, childCount: 3 }])).toBe('stern');
  });

  // Mixed: one task with children, one without — stern wins because hierarchy is in use
  test('returns stern when any active task has children', () => {
    expect(createConfirmationLevel('main', [
      { task: activeTask, childCount: 0 },
      { task: blockedTask, childCount: 2 },
    ])).toBe('stern');
  });
});

// --- Template rendering ---

describe('renderGuidance', () => {
  test('substitutes all placeholders', () => {
    const result = renderGuidance('reject', {
      task_code: 'fix-bug',
      task_id: 'a1b2c3d4',
      commit_count: 3,
      lines_changed: 247,
      confirmation_code: 'rj-7f3a',
    });
    expect(result).toContain('fix-bug');
    expect(result).toContain('3 commits');
    expect(result).toContain('247 lines');
    expect(result).toContain('rj-7f3a');
    expect(result).not.toContain('{{');
  });

  test('renders accept-light template', () => {
    const result = renderGuidance('accept-light', {
      task_code: 'my-task',
      files_changed: 5,
      lines_added: 100,
      lines_removed: 20,
      confirmation_code: 'ac-1234',
    });
    expect(result).toContain('my-task');
    expect(result).toContain('5 files');
    expect(result).toContain('ac-1234');
  });

  test('renders accept-standard template', () => {
    const result = renderGuidance('accept-standard', {
      task_code: 'my-task',
      task_id: 'abcd1234',
      files_changed: 12,
      lines_added: 600,
      lines_removed: 100,
      parent_branch: 'main',
      confirmation_code: 'ac-5678',
    });
    expect(result).toContain('12 files');
    expect(result).toContain('main');
    expect(result).toContain('lazy_diff');
  });

  test('renders accept-stern template', () => {
    const result = renderGuidance('accept-stern', {
      task_code: 'big-feature',
      task_id: 'abcd1234',
      files_changed: 47,
      lines_added: 2134,
      lines_removed: 500,
      commit_count: 15,
      parent_branch: 'main',
      confirmation_code: 'ac-9abc',
    });
    expect(result).toContain('large merge');
    expect(result).toContain('47 files');
    expect(result).toContain('2134 additions');
  });

  test('renders close-light template', () => {
    const result = renderGuidance('close-light', {
      task_code: 'empty-task',
      confirmation_code: 'cl-1111',
    });
    expect(result).toContain('no work');
    expect(result).toContain('cl-1111');
  });

  test('renders close-stern template', () => {
    const result = renderGuidance('close-stern', {
      task_code: 'big-task',
      commit_count: 10,
      lines_changed: 500,
      confirmation_code: 'cl-2222',
    });
    expect(result).toContain('10 commits');
    expect(result).toContain('500 lines');
  });

  test('renders create-parent-warning template', () => {
    const result = renderGuidance('create-parent-warning', {
      active_task_code: 'current-work',
      confirmation_code: 'cr-3333',
    });
    expect(result).toContain('current-work');
    expect(result).toContain('main');
  });

  // INVARIANT: Stern create warning names the active parent task and its child count,
  // making it obvious to the builder what they probably meant to do.
  test('renders create-parent-warning-stern template', () => {
    const result = renderGuidance('create-parent-warning-stern', {
      active_task_code: 'release-v011',
      child_count: 14,
      confirmation_code: 'cr-4444',
    });
    expect(result).toContain('release-v011');
    expect(result).toContain('14 children');
    expect(result).toContain('cr-4444');
    expect(result).toContain('almost certainly wrong');
  });

  test('renders reopen-standard template', () => {
    const result = renderGuidance('reopen-standard', {
      task_code: 'done-task',
      confirmation_code: 'ro-4444',
    });
    expect(result).toContain('previously completed');
    expect(result).toContain('ro-4444');
  });

  test('renders redo-standard template', () => {
    const result = renderGuidance('redo-standard', {
      task_code: 'old-task',
      commit_count: 3,
      confirmation_code: 'rd-5555',
    });
    expect(result).toContain('3 commits');
    expect(result).toContain('rd-5555');
  });

  test('renders redo-stern template', () => {
    const result = renderGuidance('redo-stern', {
      task_code: 'old-task',
      commit_count: 10,
      confirmation_code: 'rd-6666',
    });
    expect(result).toContain('significant history');
    expect(result).toContain('10 commits');
  });

  test('throws for unknown template name', () => {
    expect(() => renderGuidance('nonexistent', {})).toThrow('Unknown confirmation template');
  });

  test('leaves unresolved placeholders as-is', () => {
    const result = renderGuidance('reject', { task_code: 'test' });
    // Missing placeholders are left as {{...}}
    expect(result).toContain('{{commit_count}}');
  });
});

// --- Context-gathering functions ---

describe('context-gathering functions', () => {
  const task = {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    code: 'my-task',
  } as Task;

  test('gatherAcceptContext produces correct fields', () => {
    const ctx = gatherAcceptContext(
      task,
      { filesChanged: 5, linesAdded: 100, linesRemoved: 20 },
      3,
      'main',
      'ac-1234',
    );
    expect(ctx.task_code).toBe('my-task');
    expect(ctx.task_id).toBe('aaaaaaaa');
    expect(ctx.files_changed).toBe(5);
    expect(ctx.lines_added).toBe(100);
    expect(ctx.lines_removed).toBe(20);
    expect(ctx.commit_count).toBe(3);
    expect(ctx.parent_branch).toBe('main');
    expect(ctx.confirmation_code).toBe('ac-1234');
  });

  test('gatherRedoContext produces correct fields', () => {
    const ctx = gatherRedoContext(task, 7, 'rd-2222');
    expect(ctx.task_code).toBe('my-task');
    expect(ctx.commit_count).toBe(7);
  });

  test('gatherReopenContext produces correct fields', () => {
    const ctx = gatherReopenContext(task, 'ro-3333');
    expect(ctx.task_code).toBe('my-task');
    expect(ctx.confirmation_code).toBe('ro-3333');
  });

  test('gatherCreateParentWarningContext produces correct fields', () => {
    const ctx = gatherCreateParentWarningContext(task, 'cr-4444');
    expect(ctx.active_task_code).toBe('my-task');
    expect(ctx.confirmation_code).toBe('cr-4444');
  });

  test('gatherCreateParentWarningSternContext produces correct fields', () => {
    const ctx = gatherCreateParentWarningSternContext(task, 14, 'cr-5555');
    expect(ctx.active_task_code).toBe('my-task');
    expect(ctx.child_count).toBe(14);
    expect(ctx.confirmation_code).toBe('cr-5555');
  });

  test('falls back to task id prefix when code is null', () => {
    const noCodeTask = { id: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff', code: null } as Task;
    const ctx = gatherRedoContext(noCodeTask, 1, 'rd-0000');
    expect(ctx.task_code).toBe('bbbbbbbb');
  });
});
