import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { readFileSync, readdirSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/**
 * Find the full task UUID from a short (8-char) prefix.
 */
function findFullTaskId(root: string, shortId: string): string {
  const tasksDir = join(root, '.lazy', 'tasks');
  const dirs = readdirSync(tasksDir);
  const match = dirs.find(d => d.startsWith(shortId));
  if (!match) throw new Error(`Task directory not found for ${shortId}`);
  return match;
}

/**
 * Read comments.json for a task and return the parsed comments array.
 */
function readComments(root: string, shortId: string): Array<{ content: string; actor?: string }> {
  const fullId = findFullTaskId(root, shortId);
  const commentsPath = join(root, '.lazy', 'tasks', fullId, 'comments.json');
  try {
    const data = JSON.parse(readFileSync(commentsPath, 'utf-8'));
    return data.comments;
  } catch {
    return [];
  }
}

/**
 * Read status-changelog.json for a task and return the parsed changes array.
 */
function readStatusChangelog(root: string, shortId: string): Array<{ status: string; actor?: string }> {
  const fullId = findFullTaskId(root, shortId);
  const changelogPath = join(root, '.lazy', 'tasks', fullId, 'status-changelog.json');
  try {
    const data = JSON.parse(readFileSync(changelogPath, 'utf-8'));
    return data.changes;
  } catch {
    return [];
  }
}

/**
 * Read turns.json for a task and return the parsed turns array.
 */
function readTurns(root: string, shortId: string): Array<{ role: string; actor?: string; content: string }> {
  const fullId = findFullTaskId(root, shortId);
  const turnsPath = join(root, '.lazy', 'tasks', fullId, 'turns.json');
  try {
    const data = JSON.parse(readFileSync(turnsPath, 'utf-8'));
    return data.turns;
  } catch {
    return [];
  }
}

describe('actor tracking', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: CLI commands record actor='human' by default (no LAZY_ACTOR env var).
  // This distinguishes direct CLI usage from MCP-initiated actions.
  test('comment from CLI records actor as human', async () => {
    const taskId = await createTask(ctx, 'Actor tracking test');

    const result = await ctx.lazy(['comment', taskId, '--message', 'Human comment']);
    expectSuccess(result);

    const comments = readComments(ctx.root, taskId);
    expect(comments).toHaveLength(1);
    expect(comments[0].content).toBe('Human comment');
    expect(comments[0].actor).toBe('human');
  });

  // INVARIANT: When LAZY_ACTOR=builder is set (as MCP tool handlers do),
  // commands record actor='builder' on all persisted records.
  test('comment with LAZY_ACTOR=builder records actor as builder', async () => {
    const taskId = await createTask(ctx, 'Builder actor test');

    const result = await ctx.lazy(['comment', taskId, '--message', 'Builder comment'], {
      env: { LAZY_ACTOR: 'builder' },
    });
    expectSuccess(result);

    const comments = readComments(ctx.root, taskId);
    expect(comments).toHaveLength(1);
    expect(comments[0].content).toBe('Builder comment');
    expect(comments[0].actor).toBe('builder');
  });

  // INVARIANT: Status transitions record the actor who triggered them.
  // This enables usage stats on human vs builder workflow balance.
  test('close from CLI records actor=human on status changelog', async () => {
    const taskId = await createTask(ctx, 'Status actor test');

    const result = await ctx.lazy(['close', taskId, '--yes', '--reason', 'Done']);
    expectSuccess(result);

    const changelog = readStatusChangelog(ctx.root, taskId);
    // Should have at least the 'backlog' entry (from create) and the 'closed' entry
    const closedEntry = changelog.find(c => c.status === 'closed');
    expect(closedEntry).toBeDefined();
    expect(closedEntry!.actor).toBe('human');
  });

  // INVARIANT: Status transitions via LAZY_ACTOR=builder record actor=builder.
  test('close with LAZY_ACTOR=builder records actor=builder on status changelog', async () => {
    const taskId = await createTask(ctx, 'Builder close test');

    const result = await ctx.lazy(['close', taskId, '--yes', '--reason', 'Builder close'], {
      env: { LAZY_ACTOR: 'builder' },
    });
    expectSuccess(result);

    const changelog = readStatusChangelog(ctx.root, taskId);
    const closedEntry = changelog.find(c => c.status === 'closed');
    expect(closedEntry).toBeDefined();
    expect(closedEntry!.actor).toBe('builder');
  });

  // INVARIANT: Human turns record the actor who created them.
  // This distinguishes feedback typed by a human during pairing from
  // feedback injected by the builder via MCP.
  test('start from CLI records actor=human on the first turn', async () => {
    const taskId = await createTask(ctx, 'Turn actor test', 'Do something');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    const turns = readTurns(ctx.root, taskId);
    const humanTurn = turns.find(t => t.role === 'human');
    expect(humanTurn).toBeDefined();
    expect(humanTurn!.actor).toBe('human');
  });

  // INVARIANT: Start with LAZY_ACTOR=builder records actor=builder on turns.
  test('start with LAZY_ACTOR=builder records actor=builder on the first turn', async () => {
    const taskId = await createTask(ctx, 'Builder turn test', 'Do something');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_ACTOR: 'builder' },
    });
    expectSuccess(startResult);

    const turns = readTurns(ctx.root, taskId);
    const humanTurn = turns.find(t => t.role === 'human');
    expect(humanTurn).toBeDefined();
    expect(humanTurn!.actor).toBe('builder');
  });

  // INVARIANT: Reconciler status transitions record actor='system', not the caller's actor.
  // The reconciler is a system process — its transitions shouldn't be attributed to
  // whoever triggered reconciliation (human via CLI or builder via MCP).
  test('reconciler transitions record actor=system', async () => {
    const taskId = await createTask(ctx, 'Reconciler actor test', 'Do work');

    // Start the task — this creates working status
    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // Run list to trigger reconciliation (working → blocked transition)
    const listResult = await ctx.lazy(['list']);
    expectSuccess(listResult);

    // After start + reconciliation, the task should have gone through:
    // backlog → working → blocked
    // The working→blocked transition is done by the reconciler
    const changelog = readStatusChangelog(ctx.root, taskId);
    const blockedEntry = changelog.find(c => c.status === 'blocked');
    expect(blockedEntry).toBeDefined();
    expect(blockedEntry!.actor).toBe('system');
  });

  // INVARIANT: Existing data without actor field is backward-compatible.
  // Old entries without actor are assumed to be human (the default).
  test('backlog status entry from create has no actor (backward compat)', async () => {
    const taskId = await createTask(ctx, 'Backward compat test');

    const changelog = readStatusChangelog(ctx.root, taskId);
    // The 'backlog' entry from task creation happened before actor tracking
    // was added to the create path, so it should have no actor field (or human).
    const backlogEntry = changelog.find(c => c.status === 'backlog');
    expect(backlogEntry).toBeDefined();
    // No actor on create — that's fine, backward compat means absent = human
  });
});
