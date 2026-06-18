/**
 * Tests for the destination-worktree restore-conflict handling on accept.
 *
 * INVARIANT (fix-accept-dirty-destination): a dirty DESTINATION/parent worktree
 * must not block accept. When the auto-stash CANNOT be cleanly restored after
 * the (durable) merge, the CHILD accept still SUCCEEDS, the stash is RETAINED
 * (project invariant #1 — never lose human work), and the reconciliation is
 * handed to the worktree's owning task by unblocking it with feedback.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { runGit } from '../../src/utils/git';
import { LocalDriver } from '../../src/remote/local-driver';
import { planRestoreConflictReconciliation } from '../../src/daemon/task-lifecycle';
import type { DestinationRestoreConflict } from '../../src/git/operations';
import type { Storage } from '../../src/storage';
import type { Task, Session, TaskStatus } from '../../src/types';

async function initRepo(dir: string): Promise<void> {
  await runGit(['init', '-q', '-b', 'main'], { cwd: dir });
  await runGit(['config', 'user.email', 'test@example.com'], { cwd: dir });
  await runGit(['config', 'user.name', 'Test'], { cwd: dir });
  await writeFile(join(dir, 'README.md'), 'init\n');
  await runGit(['add', '.'], { cwd: dir });
  await runGit(['commit', '-q', '-m', 'init'], { cwd: dir });
}

describe('LocalDriver.merge surfaces a restore conflict without failing the accept', () => {
  let repo: string;
  let parentWorktree: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'lazy-restore-'));
    await initRepo(repo);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    if (parentWorktree) await rm(parentWorktree, { recursive: true, force: true });
  });

  test('returns status "merged" WITH restoreConflict when the dirt collides post-merge', async () => {
    // Parent branch lives in its own worktree (an intermediate parent task).
    await runGit(['branch', 'lazy/parent'], { cwd: repo });
    parentWorktree = `${repo}-parent`;
    await runGit(['worktree', 'add', '-q', parentWorktree, 'lazy/parent'], { cwd: repo });

    // Child ADDS a new tracked file — no BRANCH conflict with the parent, so the
    // driver's pre-merge conflict check passes and the squash actually runs.
    await runGit(['checkout', '-q', '-b', 'lazy/child', 'lazy/parent'], { cwd: repo });
    await writeFile(join(repo, 'gen.txt'), 'from merge\n');
    await runGit(['add', '.'], { cwd: repo });
    await runGit(['commit', '-q', '-m', 'child adds gen.txt'], { cwd: repo });
    await runGit(['checkout', '-q', 'main'], { cwd: repo });

    // The destination worktree has an UNTRACKED file at the same path → the
    // post-merge stash pop is refused (collision with the merged file).
    await writeFile(join(parentWorktree, 'gen.txt'), 'human untracked\n');

    const driver = new LocalDriver();
    const result = await driver.merge({
      sourceBranch: 'lazy/child',
      targetBranch: 'lazy/parent',
      task: { id: 'child001', goal: 'child work' } as Task,
      taskShortId: 'child001',
      root: repo,
    });

    // The child accept SUCCEEDS — the merge is durable.
    expect(result.status).toBe('merged');
    // And the restore conflict is surfaced for the caller to reconcile.
    expect(result.status === 'merged' && result.restoreConflict).toBeTruthy();
    if (result.status === 'merged') {
      expect(result.restoreConflict!.mode).toBe('pop-refused');
      expect(result.restoreConflict!.targetBranch).toBe('lazy/parent');
    }
    // The stash is retained — the human's untracked work is preserved.
    const stashList = await runGit(['stash', 'list'], { cwd: parentWorktree });
    expect(stashList.stdout).toContain('lazy-accept-autostash');
  });

  test('clean destination worktree merges with NO restoreConflict', async () => {
    await runGit(['branch', 'lazy/parent'], { cwd: repo });
    parentWorktree = `${repo}-parent`;
    await runGit(['worktree', 'add', '-q', parentWorktree, 'lazy/parent'], { cwd: repo });

    await runGit(['checkout', '-q', '-b', 'lazy/child', 'lazy/parent'], { cwd: repo });
    await writeFile(join(repo, 'child.txt'), 'child work\n');
    await runGit(['add', '.'], { cwd: repo });
    await runGit(['commit', '-q', '-m', 'child work'], { cwd: repo });
    await runGit(['checkout', '-q', 'main'], { cwd: repo });

    const driver = new LocalDriver();
    const result = await driver.merge({
      sourceBranch: 'lazy/child',
      targetBranch: 'lazy/parent',
      task: { id: 'child001', goal: 'child work' } as Task,
      taskShortId: 'child001',
      root: repo,
    });

    expect(result.status).toBe('merged');
    if (result.status === 'merged') {
      expect(result.restoreConflict).toBeUndefined();
    }
  });
});

describe('planRestoreConflictReconciliation', () => {
  function makeStorage(tasks: Task[], sessions: Record<string, Session>): Storage {
    return {
      listTasks: async () => tasks,
      getSessionByTaskId: async (id: string) => sessions[id] ?? null,
    } as unknown as Storage;
  }

  function makeTask(id: string, code: string, status: TaskStatus): Task {
    return { id, code, status, goal: 'parent goal' } as Task;
  }

  function makeSession(taskId: string, branch: string, ended: number | null): Session {
    return { id: `sess-${taskId}`, task_id: taskId, git_branch: branch, ended_at: ended } as Session;
  }

  const rc: DestinationRestoreConflict = {
    worktreePath: '/tmp/wt-parent',
    targetBranch: 'lazy/parent',
    stashSha: 'deadbeef',
    stashLabel: 'lazy-accept-autostash into lazy/parent',
    mode: 'pop-refused',
  };

  test('unblocks the owning idle parent task with explanatory feedback', async () => {
    const storage = makeStorage(
      [makeTask('parent01', 'parent-x', 'blocked')],
      { parent01: makeSession('parent01', 'lazy/parent', null) },
    );

    const plan = await planRestoreConflictReconciliation(storage, rc, 'child-y');

    expect(plan.kind).toBe('unblock');
    if (plan.kind === 'unblock') {
      expect(plan.taskId).toBe('parent01');
      expect(plan.taskDisplayId).toBe('parent-x');
      // Feedback explains the situation and references the preserved stash and child.
      expect(plan.feedback).toContain('child-y');
      expect(plan.feedback).toContain('deadbeef');
      expect(plan.feedback).toContain('git stash pop'); // pop-refused recovery step
    }
  });

  test('falls back when no task owns the destination branch (e.g. raw branch / main)', async () => {
    const storage = makeStorage([], {});
    const plan = await planRestoreConflictReconciliation(storage, rc, 'child-y');
    expect(plan.kind).toBe('fallback');
  });

  test('falls back when the owning task is terminal (not unblockable)', async () => {
    const storage = makeStorage(
      [makeTask('parent01', 'parent-x', 'complete')],
      { parent01: makeSession('parent01', 'lazy/parent', null) },
    );
    const plan = await planRestoreConflictReconciliation(storage, rc, 'child-y');
    expect(plan.kind).toBe('fallback');
  });

  test('falls back when the owning task session has ended', async () => {
    const storage = makeStorage(
      [makeTask('parent01', 'parent-x', 'blocked')],
      { parent01: makeSession('parent01', 'lazy/parent', 1234567890) },
    );
    const plan = await planRestoreConflictReconciliation(storage, rc, 'child-y');
    expect(plan.kind).toBe('fallback');
  });
});
