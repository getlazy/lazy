import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { readFileSync, readdirSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';
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
 * Read turns.json for a task and return the parsed turns array.
 */
function readTurns(root: string, shortId: string): Array<{ sequence: number; role: string; model?: string; content: string }> {
  const fullId = findFullTaskId(root, shortId);
  const turnsPath = join(root, '.lazy', 'tasks', fullId, 'turns.json');
  const data = JSON.parse(readFileSync(turnsPath, 'utf-8'));
  return data.turns;
}

describe('per-turn model override', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: When --model is specified on start, the first turn records that model.
  // This ensures the model used for each turn is traceable.
  test('start with --model records model on the first turn', async () => {
    const taskId = await createTask(ctx, 'Model on start', 'Do work');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes', '--model', 'haiku'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    const turns = readTurns(ctx.root, taskId);
    // First turn (human) should have haiku recorded
    const humanTurn = turns.find(t => t.role === 'human');
    expect(humanTurn).toBeDefined();
    expect(humanTurn!.model).toBe('haiku');
  });

  // INVARIANT: When --model is specified on unblock, the feedback turn records that model.
  test('unblock with --model records model on the feedback turn', async () => {
    const taskId = await createTask(ctx, 'Model on unblock', 'Do work');

    // Start task (creates first turn, goes to blocked)
    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // Unblock with --model sonnet
    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Make it better', '--model', 'sonnet'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(unblockResult);

    const turns = readTurns(ctx.root, taskId);
    // Find the feedback turn (second human turn, sequence > 1)
    const humanTurns = turns.filter(t => t.role === 'human');
    expect(humanTurns.length).toBeGreaterThanOrEqual(2);
    const feedbackTurn = humanTurns[humanTurns.length - 1];
    expect(feedbackTurn.model).toBe('sonnet');
  });

  // INVARIANT: Sticky behavior - after unblocking with --model haiku, the next unblock
  // without --model should still use haiku (inherited from previous turn).
  // This prevents users from having to re-specify the model every turn.
  test('sticky model: next unblock without --model inherits from previous turn', async () => {
    const taskId = await createTask(ctx, 'Sticky model', 'Do work');

    // Start task
    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // First unblock with --model haiku
    const unblock1 = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Use haiku', '--model', 'haiku'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(unblock1);

    // Second unblock WITHOUT --model — should inherit haiku from previous turn
    const unblock2 = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Continue'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(unblock2);

    const turns = readTurns(ctx.root, taskId);
    // Find human turns (skip agent turns)
    const humanTurns = turns.filter(t => t.role === 'human');
    // Last human turn should have haiku (sticky from previous)
    const lastHumanTurn = humanTurns[humanTurns.length - 1];
    expect(lastHumanTurn.model).toBe('haiku');
  });

  // INVARIANT: When no per-turn model has been set and no --model flag is given,
  // the turn falls back to the task-level model.
  test('fallback to task-level model when no per-turn model set', async () => {
    const taskId = await createTask(ctx, 'Task model fallback', 'Do work');

    // Start with --model opus (sets both task model and first turn model)
    const startResult = await ctx.lazyMocked(['start', taskId, '--yes', '--model', 'opus'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    const turns = readTurns(ctx.root, taskId);
    const humanTurn = turns.find(t => t.role === 'human');
    expect(humanTurn).toBeDefined();
    // First turn should record opus (the model used)
    expect(humanTurn!.model).toBe('opus');
  });

  // INVARIANT: show command displays per-turn model when it differs from task-level model.
  test('show displays per-turn model when it differs from task model', async () => {
    const taskId = await createTask(ctx, 'Show model display', 'Do work');

    // Start with opus (sets task model)
    const startResult = await ctx.lazyMocked(['start', taskId, '--yes', '--model', 'opus'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // Unblock with haiku (different from task model)
    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Switch to haiku', '--model', 'haiku'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(unblockResult);

    // Show should display haiku since it differs from task-level opus
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'haiku');
  });
});
