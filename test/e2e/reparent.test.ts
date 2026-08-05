/**
 * Tests for `lazy reparent <task> --parent <new-parent>`.
 *
 * Reparent repoints a task to a new parent and merges that parent into the
 * task's branch by reusing the existing sync machinery.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import {
  findFullTaskId,
  readTaskJson as readTaskJsonAt,
  setTaskStatus as setTaskStatusAt,
  taskFilePath,
} from '../helpers/storage';
import { parentTaskIdOf } from '../../src/task-target';

describe('lazy reparent', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // Task state lives in EXTERNAL storage; test/helpers/storage.ts is the one
  // place that knows the layout (CLAUDE.md). The hand-rolled
  // `~/.lazy/<basename>/tasks` paths this file used to carry duplicated that
  // knowledge and would break silently if the layout moved.
  const fullIdFor = (shortId: string) => findFullTaskId(ctx.root, shortId);
  const readTaskJson = (shortId: string) => readTaskJsonAt(ctx.root, shortId) as any;
  const setTaskStatus = (shortId: string, status: string) => setTaskStatusAt(ctx.root, shortId, status);
  const readTaskFile = (shortId: string, file: string) =>
    JSON.parse(readFileSync(taskFilePath(ctx.root, shortId, file), 'utf-8'));

  // INVARIANT: reparent = repoint + sync, and it KEEPS the task. It must not
  // create a new task, reset the session, or discard history — only the parent
  // pointer changes. This is the core design decision (the rejected spike
  // proposed close-and-recreate, which loses conversation history). If this
  // test starts failing because a new task/session was created, the
  // implementation has regressed to the discredited approach.
  test('repoints parent and syncs while keeping the same task and session', async () => {
    // New parent task, started WITHOUT a commit so its branch sits at main HEAD.
    // That guarantees a clean sync (no upstream changes) for a deterministic test.
    const parentId = await createTask(ctx, 'New parent', 'Parent work');
    await ctx.lazyMocked(['start', parentId, '--yes'], MOCK_CLAUDE_SUCCESS);
    setTaskStatus(parentId, 'blocked');

    // Task to move: top-level (parent = main), started WITH a commit.
    const taskId = await createTask(ctx, 'Wrongly parented task', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    setTaskStatus(taskId, 'blocked');

    // Capture identity before reparent.
    const beforeTask = readTaskJson(taskId);
    const beforeTurns = readTaskFile(taskId, 'turns.json');
    expect(parentTaskIdOf(beforeTask)).toBeNull();

    // Mocked: reparent's sync step relaunches the task's own agent to merge the
    // new parent in, so this call really does reach the runner. Without the
    // agent mock it tries to spawn a container and dies on `binary 'docker' not
    // found` — the sync, not reparent's repoint, is what needs the fake agent.
    const result = await ctx.lazyMocked(
      ['reparent', taskId, '--parent', parentId, '--yes'],
      MOCK_CLAUDE_SUCCESS,
    );
    expectSuccess(result);
    const output = result.stdout + result.stderr;
    expect(output).toContain('Reparented');

    // Parent pointer was repointed to the new parent task.
    const afterTask = readTaskJson(taskId);
    expect(parentTaskIdOf(afterTask)).toBe(fullIdFor(parentId));

    // Same task: id and code are unchanged (task was kept, not recreated).
    expect(afterTask.id).toBe(beforeTask.id);
    expect(afterTask.code).toBe(beforeTask.code);

    // History preserved: the original turns are still present.
    const afterTurns = readTaskFile(taskId, 'turns.json');
    expect(afterTurns.turns.length).toBeGreaterThanOrEqual(beforeTurns.turns.length);

    // A [Reparented] audit comment was recorded.
    const comments = readTaskFile(taskId, 'comments.json');
    const hasReparentComment = comments.comments.some(
      (c: any) => typeof c.content === 'string' && c.content.includes('[Reparented]'),
    );
    expect(hasReparentComment).toBe(true);
  });

  // INVARIANT: don't pull the branch out from under a running agent.
  test('reparent on a working task fails with a clear error', async () => {
    const parentId = await createTask(ctx, 'Parent', 'Parent work');
    await ctx.lazyMocked(['start', parentId, '--yes'], MOCK_CLAUDE_SUCCESS);
    setTaskStatus(parentId, 'blocked');

    const taskId = await createTask(ctx, 'Working task', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    setTaskStatus(taskId, 'working');

    const result = await ctx.lazy(['reparent', taskId, '--parent', parentId, '--yes']);
    expectFailure(result);
    expect((result.stdout + result.stderr)).toContain('currently working');
  });

  test('reparent onto an unresolvable parent fails with a clear error', async () => {
    const taskId = await createTask(ctx, 'Some task', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    setTaskStatus(taskId, 'blocked');

    const result = await ctx.lazy(['reparent', taskId, '--parent', 'no-such-parent-xyz', '--yes']);
    expectFailure(result);
    expect((result.stdout + result.stderr)).toContain('Could not resolve');
  });

  test('reparent onto the current parent is a no-op', async () => {
    // Top-level task — its effective parent branch is main.
    const taskId = await createTask(ctx, 'Already on main', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    setTaskStatus(taskId, 'blocked');

    const result = await ctx.lazy(['reparent', taskId, '--parent', 'main', '--yes']);
    expectSuccess(result);
    const output = result.stdout + result.stderr;
    expect(output.includes('already parented') || output.includes('Nothing to do')).toBe(true);
  });

  test('reparent without --yes in a non-interactive shell requires confirmation', async () => {
    const taskId = await createTask(ctx, 'Confirm task', 'Do work');

    const result = await ctx.lazy(['reparent', taskId, '--parent', 'main']);
    expectFailure(result);
    expect((result.stdout + result.stderr)).toContain('--yes');
  });

  test('reparent without --parent fails', async () => {
    const taskId = await createTask(ctx, 'No parent flag', 'Do work');

    const result = await ctx.lazy(['reparent', taskId, '--yes']);
    expectFailure(result);
    expect((result.stdout + result.stderr)).toContain('--parent');
  });

  test('reparent help documents the command', async () => {
    const result = await ctx.lazy(['reparent', '--help']);
    expectSuccess(result);
    const output = result.stdout + result.stderr;
    expect(output).toContain('--parent');
    expect(output).toContain('reparent');
  });
});
