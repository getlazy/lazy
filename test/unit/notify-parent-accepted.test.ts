/**
 * Unit tests for notifyParentOfAcceptedSubtask.
 *
 * INVARIANT: accepting a child drops a `[Subtask accepted]` comment on the
 * parent task (when one exists), including the accept-tag SHA for idempotency
 * with lazy_wait's head_sha — and never throws into the accept path.
 *
 * INVARIANT (data integrity): notify is idempotent; createComment failures stamp
 * a pending metadata flag rather than silently losing the signal forever.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import {
  notifyParentOfAcceptedSubtask,
  isParentAcceptNotifyComment,
  PARENT_ACCEPT_NOTIFY_PENDING_KEY,
  sweepPendingParentAcceptNotifies,
} from '../../src/task/notify-parent-accepted';
import { createAcceptTag, acceptTagName, resolveTaskTipSha } from '../../src/git/operations';
import { taskTarget, branchTarget } from '../../src/task-target';
import type { Task, Comment } from '../../src/types';
import type { Storage } from '../../src/storage/interface';

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    id: overrides.id,
    code: overrides.code ?? null,
    goal: overrides.goal ?? 'goal',
    prompt: overrides.prompt ?? 'prompt',
    status: overrides.status ?? 'complete',
    type: overrides.type ?? 'task',
    created_at: overrides.created_at ?? Date.now(),
    completed_at: overrides.completed_at ?? null,
    target: overrides.target ?? branchTarget('main'),
    branched_from_sha: overrides.branched_from_sha ?? null,
    close_reason: overrides.close_reason ?? null,
    model: overrides.model ?? null,
    agent_id: overrides.agent_id ?? 'claude',
    runner_type: overrides.runner_type ?? null,
    metadata: overrides.metadata ?? {},
    tags: overrides.tags ?? [],
    pending_sync: overrides.pending_sync ?? 0,
  } as Task;
}

describe('notifyParentOfAcceptedSubtask', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'lazy-notify-parent-'));
    const git = (args: string[]) => {
      const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf-8' });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    };
    git(['init']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    await writeFile(join(repoRoot, 'README'), 'hi\n');
    git(['add', 'README']);
    git(['commit', '-m', 'init']);
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  test('no-ops when the child has no parent task (top-level into a branch)', async () => {
    const comments: Array<{ taskId: string; content: string; actor: unknown }> = [];
    const storage = {
      getTask: async () => null,
      getTaskComments: async () => [],
      createComment: async (taskId: string, content: string, actor?: unknown) => {
        comments.push({ taskId, content, actor });
        return {} as never;
      },
      updateTaskMetadata: async () => {},
    } as unknown as Storage;

    const child = makeTask({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    await notifyParentOfAcceptedSubtask(storage, child, repoRoot);
    expect(comments).toEqual([]);
  });

  test('drops a [Subtask accepted] comment on the parent with the accept-tag SHA', async () => {
    const parentId = '11111111-2222-3333-4444-555555555555';
    const childId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    await createAcceptTag(childId, 'HEAD', repoRoot);
    const tagSha = spawnSync('git', ['rev-parse', `refs/tags/${acceptTagName(childId)}^{commit}`], {
      cwd: repoRoot,
      encoding: 'utf-8',
    }).stdout.trim();

    const comments: Array<{ taskId: string; content: string; actor: unknown }> = [];
    const meta: Record<string, string> = {};
    const child = makeTask({
      id: childId,
      code: 'child-task',
      target: taskTarget(parentId),
      metadata: meta,
    });
    const storage = {
      getTask: async (id: string) => {
        if (id === parentId) return makeTask({ id: parentId, code: 'parent-task' });
        if (id === childId) return child;
        return null;
      },
      getTaskComments: async () => comments.map(c => ({ content: c.content }) as Comment),
      createComment: async (taskId: string, content: string, actor?: unknown) => {
        comments.push({ taskId, content, actor });
        return {} as never;
      },
      updateTaskMetadata: async (_id: string, key: string, value: string) => {
        if (value) meta[key] = value;
        else delete meta[key];
      },
    } as unknown as Storage;

    await notifyParentOfAcceptedSubtask(storage, child, repoRoot);

    expect(comments).toHaveLength(1);
    expect(comments[0].taskId).toBe(parentId);
    expect(comments[0].actor).toBe('system');
    expect(comments[0].content).toContain('[Subtask accepted]');
    expect(comments[0].content).toContain('child-task');
    expect(comments[0].content).toContain(`merge ${tagSha}`);
  });

  test('is idempotent — second call does not duplicate the parent comment', async () => {
    const parentId = '11111111-2222-3333-4444-555555555555';
    const childId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    await createAcceptTag(childId, 'HEAD', repoRoot);

    const comments: Array<{ taskId: string; content: string }> = [];
    const child = makeTask({ id: childId, code: 'child-task', target: taskTarget(parentId) });
    const storage = {
      getTask: async (id: string) =>
        id === parentId ? makeTask({ id: parentId }) : id === childId ? child : null,
      getTaskComments: async () => comments.map(c => ({ content: c.content }) as Comment),
      createComment: async (taskId: string, content: string) => {
        comments.push({ taskId, content });
        return {} as never;
      },
      updateTaskMetadata: async () => {},
    } as unknown as Storage;

    await notifyParentOfAcceptedSubtask(storage, child, repoRoot);
    await notifyParentOfAcceptedSubtask(storage, child, repoRoot);
    expect(comments).toHaveLength(1);
  });

  test('stamps pending metadata when createComment fails — accept must not fail over notify', async () => {
    const parentId = '11111111-2222-3333-4444-555555555555';
    const childId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    await createAcceptTag(childId, 'HEAD', repoRoot);

    const meta: Record<string, string> = {};
    const child = makeTask({ id: childId, target: taskTarget(parentId), metadata: meta });
    const storage = {
      getTask: async (id: string) =>
        id === parentId ? makeTask({ id: parentId }) : id === childId ? child : null,
      getTaskComments: async () => [],
      createComment: async () => {
        throw new Error('storage unavailable');
      },
      updateTaskMetadata: async (_id: string, key: string, value: string) => {
        if (value) meta[key] = value;
        else delete meta[key];
        child.metadata = { ...meta };
      },
    } as unknown as Storage;

    await expect(notifyParentOfAcceptedSubtask(storage, child, repoRoot)).resolves.toBeUndefined();
    expect(meta[PARENT_ACCEPT_NOTIFY_PENDING_KEY]).toBe('1');
  });

  test('sweepPendingParentAcceptNotifies delivers a missed comment and clears pending', async () => {
    const parentId = '11111111-2222-3333-4444-555555555555';
    const childId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    await createAcceptTag(childId, 'HEAD', repoRoot);

    const comments: Array<{ taskId: string; content: string }> = [];
    const meta: Record<string, string> = { [PARENT_ACCEPT_NOTIFY_PENDING_KEY]: '1' };
    const child = makeTask({
      id: childId,
      code: 'child-task',
      status: 'complete',
      target: taskTarget(parentId),
      metadata: meta,
    });
    const storage = {
      listTasks: async () => [child],
      getTask: async (id: string) =>
        id === parentId ? makeTask({ id: parentId }) : id === childId ? child : null,
      getTaskComments: async () => comments.map(c => ({ content: c.content }) as Comment),
      createComment: async (taskId: string, content: string) => {
        comments.push({ taskId, content });
        return {} as never;
      },
      updateTaskMetadata: async (_id: string, key: string, value: string) => {
        if (value) meta[key] = value;
        else delete meta[key];
        child.metadata = { ...meta };
      },
    } as unknown as Storage;

    const n = await sweepPendingParentAcceptNotifies(storage, repoRoot);
    expect(n).toBe(1);
    expect(comments).toHaveLength(1);
    expect(meta[PARENT_ACCEPT_NOTIFY_PENDING_KEY]).toBeUndefined();
  });
});

describe('isParentAcceptNotifyComment', () => {
  test('matches by child code and optional merge SHA', () => {
    const child = { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', code: 'child-task' };
    const sha = '0123456789abcdef0123456789abcdef01234567';
    expect(
      isParentAcceptNotifyComment(
        { content: `[Subtask accepted] child-task was accepted and merged into this task (merge ${sha}).` },
        child,
        sha,
      ),
    ).toBe(true);
    expect(
      isParentAcceptNotifyComment(
        { content: '[Subtask accepted] child-task was accepted and merged into this task.' },
        child,
        sha,
      ),
    ).toBe(true);
    expect(
      isParentAcceptNotifyComment(
        { content: `[Subtask accepted] other-task was accepted and merged into this task (merge ${sha}).` },
        child,
        sha,
      ),
    ).toBe(false);
  });
});

describe('resolveTaskTipSha', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'lazy-tip-sha-'));
    const git = (args: string[]) => {
      const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf-8' });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    };
    git(['init']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    await writeFile(join(repoRoot, 'README'), 'hi\n');
    git(['add', 'README']);
    git(['commit', '-m', 'init']);
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  test('complete tasks return the accept-tag SHA even when the branch is gone', async () => {
    const taskId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    await createAcceptTag(taskId, 'HEAD', repoRoot);
    const expected = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf-8',
    }).stdout.trim();

    const tip = await resolveTaskTipSha(taskId, 'complete', 'lazy/gone-branch', repoRoot);
    expect(tip).toBe(expected);
  });

  test('non-complete tasks return the branch tip', async () => {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf-8',
    }).stdout.trim();
    const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf-8',
    }).stdout.trim();

    const tip = await resolveTaskTipSha('any-id', 'blocked', branch, repoRoot);
    expect(tip).toBe(head);
  });
});
