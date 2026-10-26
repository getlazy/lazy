/**
 * E2E for `lazy sessions <task> [name]`: the CLI read of a task container's
 * tmux sessions. The reads themselves run against a real tmux in
 * test/unit/task-sessions.test.ts and test/e2e/task-sessions-survive-restart.test.ts;
 * what is tested HERE is the command — that it reaches the daemon's read, says
 * "not running" for a task with no environment rather than an empty list or
 * an error, and refuses bad input before asking anything.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';

describe('lazy sessions', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await setupTestLazy(); });
  afterEach(async () => { await ctx.cleanup(); });

  // INVARIANT: a task whose environment is not running answers "nothing is
  // running" — never an empty list that reads like a running environment
  // with no sessions, and never an error.
  test('a task with no running environment says so, in text and JSON', async () => {
    const taskId = await createTask(ctx, 'Sessions e2e', 'Some work');
    const result = await ctx.lazy(['sessions', taskId]);
    expectSuccess(result);
    expectOutput(result, "the task's environment is not running");

    const json = await ctx.lazy(['sessions', taskId, 'services', '--json']);
    expectSuccess(json);
    expect(JSON.parse(json.stdout)).toMatchObject({ running: false, output: null });
  });

  test('refuses a bad --lines and a missing task id', async () => {
    const taskId = await createTask(ctx, 'Sessions e2e', 'Some work');
    const bad = await ctx.lazy(['sessions', taskId, 'services', '--lines', '0']);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain('Invalid --lines');

    const bare = await ctx.lazy(['sessions']);
    expect(bare.exitCode).toBe(1);
    expect(bare.stdout).toContain('Usage: lazy sessions');
  });

  test('refuses a session name lazy would not address', async () => {
    const taskId = await createTask(ctx, 'Sessions e2e', 'Some work');
    const result = await ctx.lazy(['sessions', taskId, '../etc']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toContain('name must be a session name');
  });
});

describe('lazy sessions: who else is in the task', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await setupTestLazy(); });
  afterEach(async () => { await ctx.cleanup(); });

  // INVARIANT: the list says whether the agent is running a turn, from the
  // task's status, even when the task's environment is not running — and its
  // JSON carries the members inside the task (none here) beside the sessions.
  test('names the agent state, in text and JSON', async () => {
    const taskId = await createTask(ctx, 'Sessions presence e2e', 'Some work');
    const result = await ctx.lazy(['sessions', taskId]);
    expectSuccess(result);
    expectOutput(result, 'agent   not running a turn — backlog');

    const json = await ctx.lazy(['sessions', taskId, '--json']);
    expectSuccess(json);
    expect(JSON.parse(json.stdout)).toMatchObject({ members: [], agent: { status: 'backlog', working: false, turn: null } });
  });
});
