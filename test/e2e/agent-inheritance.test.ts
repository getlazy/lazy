/**
 * A new task's agent must never be decided by a silent hardcoded default.
 *
 * `Storage.createTask()` stamps `agent_id: agentId ?? 'claude-code'`, so any
 * creation path that forgets to pass an agent pins its task to Claude Code
 * forever — the project's configured agent never reaches it. Before
 * `allow-mid-task-agent-change` only `lazy create` passed one, so on a project
 * configured for Cursor, `lazy clone`, `lazy redo` and `lazy branch` all
 * silently produced Claude Code tasks.
 *
 * These tests pin the resolution order that fixes it (see
 * `src/agent/task-agent.ts`): explicit flag > the task it was derived from >
 * the project default.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectError, extractTaskId } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { readTaskJson, writeTaskJson } from '../helpers/storage';

/** The agent recorded on a task, straight from storage. */
function agentOf(root: string, taskId: string): string {
  return readTaskJson(root, taskId).agent_id;
}

describe('agent inheritance on task creation', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('lazy create --agent records the requested agent', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Cursor task', '--agent', 'cursor']);
    expectSuccess(result);
    const taskId = extractTaskId(result.stdout);

    expect(agentOf(ctx.root, taskId)).toBe('cursor');
  });

  test('lazy create rejects an unknown agent, naming the valid ones', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Bad agent', '--agent', 'not-an-agent']);
    expectFailure(result);
    expectError(result, 'Unknown agent');
  });

  // INVARIANT: a subtask runs on its PARENT's agent, not the project default.
  // A parent deliberately put on Cursor must not have its children silently
  // retargeted to Claude Code — they are continuations of the parent's work.
  test('a subtask inherits its parent task agent', async () => {
    const parent = await ctx.lazy(['create', '--goal', 'Parent on cursor', '--agent', 'cursor']);
    expectSuccess(parent);
    const parentId = extractTaskId(parent.stdout);

    const child = await ctx.lazy(['create', '--goal', 'Child', '--parent', parentId]);
    expectSuccess(child);
    const childId = extractTaskId(child.stdout);

    expect(agentOf(ctx.root, childId)).toBe('cursor');
  });

  // Inheritance is a default, not a cage — an explicit flag still wins.
  test('an explicit --agent on a subtask overrides the parent agent', async () => {
    const parent = await ctx.lazy(['create', '--goal', 'Parent on cursor', '--agent', 'cursor']);
    const parentId = extractTaskId(parent.stdout);

    const child = await ctx.lazy([
      'create', '--goal', 'Child', '--parent', parentId, '--agent', 'claude-code',
    ]);
    expectSuccess(child);

    expect(agentOf(ctx.root, extractTaskId(child.stdout))).toBe('claude-code');
  });

  // INVARIANT: a clone is the same work again, so it keeps the source's agent.
  // This is the path that was silently broken: clone passed no agent at all.
  test('lazy clone inherits the source task agent', async () => {
    const source = await ctx.lazy(['create', '--goal', 'Cursor work', '--agent', 'cursor']);
    const sourceId = extractTaskId(source.stdout);

    const cloned = await ctx.lazy(['clone', sourceId]);
    expectSuccess(cloned);
    const clonedId = extractTaskId(cloned.stdout);

    expect(agentOf(ctx.root, clonedId)).toBe('cursor');
  });

  // INVARIANT: the project default reaches EVERY creation path, not just
  // `lazy create`. `lazy system agent set` is the supported way to change it.
  test('the project default agent reaches create and clone alike', async () => {
    expectSuccess(await ctx.lazy(['system', 'agent', 'set', 'cursor']));

    const created = await ctx.lazy(['create', '--goal', 'Inherits project default']);
    expectSuccess(created);
    const createdId = extractTaskId(created.stdout);
    expect(agentOf(ctx.root, createdId)).toBe('cursor');

    const cloned = await ctx.lazy(['clone', createdId]);
    expectSuccess(cloned);
    expect(agentOf(ctx.root, extractTaskId(cloned.stdout))).toBe('cursor');
  });

  test('lazy edit --agent retargets a not-yet-started task', async () => {
    const taskId = await createTask(ctx, 'Retarget me');
    expect(agentOf(ctx.root, taskId)).toBe('claude-code');

    const result = await ctx.lazy(['edit', taskId, '--agent', 'cursor']);
    expectSuccess(result);

    expect(agentOf(ctx.root, taskId)).toBe('cursor');
  });

  test('lazy edit rejects an unknown agent without changing anything', async () => {
    const taskId = await createTask(ctx, 'Keep my agent');

    const result = await ctx.lazy(['edit', taskId, '--agent', 'not-an-agent']);
    expectFailure(result);
    expectError(result, 'Unknown agent');

    expect(agentOf(ctx.root, taskId)).toBe('claude-code');
  });
});

describe('agent switching on started tasks', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // `start` requires a real daemon (the CLI goes through it for storage).
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** Create a task, run one mocked agent turn, and wait until it is blocked. */
  async function startedTask(): Promise<string> {
    const taskId = await createTask(ctx, 'Started task', 'Do work');
    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);
    return taskId;
  }

  // INVARIANT: --agent IS changeable after work has begun. That is the whole
  // point of the feature — retargeting the next turn without redoing the task.
  test('an agent-only edit succeeds on a started task and persists', async () => {
    const taskId = await startedTask();

    const result = await ctx.lazy(['edit', taskId, '--agent', 'cursor']);
    expectSuccess(result);

    expect(agentOf(ctx.root, taskId)).toBe('cursor');
  });

  // INVARIANT: switching agents clears the agent session id. Sessions are not
  // migrated between agents — the next turn starts a fresh one on the new
  // agent, and lazy's own turn history is what carries the context over.
  // See docs/spikes/cross-agent-session-transplant.md for why.
  test('switching agents mid-task resets the agent session id', async () => {
    const taskId = await startedTask();

    const before = readTaskJson(ctx.root, taskId);
    expect(before.agent_id).toBe('claude-code');

    expectSuccess(await ctx.lazy(['edit', taskId, '--agent', 'cursor']));

    const { readSessionJson } = await import('../helpers/storage');
    const session = readSessionJson(ctx.root, taskId);
    expect(session).not.toBeNull();
    expect(session!.agent_id).toBe('cursor');
    expect(session!.agent_session_id ?? null).toBeNull();
  });

  // INVARIANT: a rejected edit applies NOTHING. --agent is processed in the
  // same command as the disallowed field, so if the gate ran after the write
  // the agent would change while the command reported failure — a silent
  // partial application. The gate must run first.
  test('an agent edit combined with a goal edit is rejected and changes nothing', async () => {
    const taskId = await startedTask();
    const before = agentOf(ctx.root, taskId);

    const result = await ctx.lazy(['edit', taskId, '--agent', 'cursor', '--goal', 'New goal']);
    expectFailure(result);

    expect(agentOf(ctx.root, taskId)).toBe(before);
  });

  // INVARIANT: switching agents mid-task re-resolves model/effort for the new
  // agent. Carrying a previous agent's `opus` into Cursor is what produced a
  // fatal_auth on Cursor's Opus quota (fix-agent-switch-resolution).
  test('edit --agent re-resolves a stored model and announces the change', async () => {
    const taskId = await startedTask();
    // Seed the claude-code default that a real launch would have persisted.
    const before = readTaskJson(ctx.root, taskId);
    writeTaskJson(ctx.root, taskId, {
      ...before,
      model: 'opus',
      metadata: { ...(before.metadata ?? {}), effort: 'high' },
    });

    const result = await ctx.lazy(['edit', taskId, '--agent', 'cursor']);
    expectSuccess(result);
    expect(result.stdout).toContain('claude-code → cursor');
    expect(result.stdout).toContain('opus → auto');
    expect(result.stdout).toMatch(/Effort:.*high →/);

    const after = readTaskJson(ctx.root, taskId);
    expect(after.agent_id).toBe('cursor');
    expect(after.model).toBe('auto');
  });

  // Co-supplied --model on the same write is "chosen for THIS agent" and must
  // survive; an empty model with the switch must fail at switch time.
  test('edit --agent --model keeps the co-supplied model for the new agent', async () => {
    const taskId = await startedTask();
    const before = readTaskJson(ctx.root, taskId);
    writeTaskJson(ctx.root, taskId, { ...before, model: 'opus' });

    const result = await ctx.lazy(['edit', taskId, '--agent', 'cursor', '--model', 'gpt-5']);
    expectSuccess(result);
    expect(result.stdout).toContain('gpt-5');

    expect(readTaskJson(ctx.root, taskId).model).toBe('gpt-5');
  });

  test('edit --agent with an invalid effort fails at switch time', async () => {
    const taskId = await startedTask();
    const before = readTaskJson(ctx.root, taskId);
    writeTaskJson(ctx.root, taskId, { ...before, model: 'opus' });

    const result = await ctx.lazy(['edit', taskId, '--agent', 'cursor', '--effort', 'ludicrous']);
    expectFailure(result);
    expectError(result, 'Invalid effort');

    // Nothing applied — agent and model unchanged.
    const after = readTaskJson(ctx.root, taskId);
    expect(after.agent_id).toBe('claude-code');
    expect(after.model).toBe('opus');
  });

  // `unblock --agent` is edit + unblock in one step: deliver the feedback AND
  // retarget the next turn, so the human does not have to run two commands.
  test('unblock --agent switches the agent while delivering feedback', async () => {
    const taskId = await startedTask();

    const result = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Try this on cursor', '--agent', 'cursor', '--yes'],
      MOCK_CLAUDE_SUCCESS,
    );
    expectSuccess(result);

    expect(agentOf(ctx.root, taskId)).toBe('cursor');
    // Re-resolve must have landed Cursor's default, not the prior turn's model.
    expect(readTaskJson(ctx.root, taskId).model).toBe('auto');
  });

  test('unblock rejects an unknown agent', async () => {
    const taskId = await startedTask();

    const result = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'go', '--agent', 'not-an-agent', '--yes'],
      MOCK_CLAUDE_SUCCESS,
    );
    expectFailure(result);
    expectError(result, 'Unknown agent');

    expect(agentOf(ctx.root, taskId)).toBe('claude-code');
  });
});
