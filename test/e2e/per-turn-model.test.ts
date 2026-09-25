import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { readFileSync, readdirSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/**
 * The WORK turns, named rather than taken as "the last turn of its role".
 *
 * A human-facing park now also records the wrap-up presentation step as a
 * supervisor→agent pair, so "the newest human turn" is the step's prompt
 * rather than the feedback the test sent — and that prompt carries no model
 * label, because the launch settings ride the agent reply. Every assertion
 * about per-turn model/effort means the WORK pair.
 */
function isWorkTurn(t: { turn_type?: string | null }): boolean {
  return (t.turn_type ?? 'work') === 'work';
}

/**
 * Resolve the tasks directory for a test project. Test projects use external
 * storage (external_path in lazy.toml) with a fallback to the in-repo
 * .lazy/tasks layout.
 */
function tasksDirFor(root: string): string {
  const toml = readFileSync(join(root, 'lazy.toml'), 'utf-8');
  const m = toml.match(/^external_path\s*=\s*"(.+)"/m);
  if (m && m[1]) return join(m[1], 'tasks');
  return join(root, '.lazy', 'tasks');
}

/**
 * Find the full task UUID from a short (8-char) prefix.
 */
function findFullTaskId(root: string, shortId: string): string {
  const dirs = readdirSync(tasksDirFor(root));
  const match = dirs.find(d => d.startsWith(shortId));
  if (!match) throw new Error(`Task directory not found for ${shortId}`);
  return match;
}

/**
 * Read turns.json for a task and return the parsed turns array.
 */
function readTurns(root: string, shortId: string): Array<{
  sequence: number;
  role: string;
  turn_type?: string | null;
  model?: string;
  model_id?: string;
  effort?: string;
  content: string;
}> {
  const fullId = findFullTaskId(root, shortId);
  const turnsPath = join(tasksDirFor(root), fullId, 'turns.json');
  const data = JSON.parse(readFileSync(turnsPath, 'utf-8'));
  return data.turns;
}

describe('per-turn model override', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // start/unblock require a real daemon (post-v0.11 the CLI goes through the
    // daemon for storage and turn reconciliation), so these run withDaemon.
    // The per-turn model is set by the launch from the --model flag — it does
    // not depend on the mocked agent response — so a fixed daemon mock is fine.
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: When --model is specified on start, the first turn records that model.
  // This ensures the model used for each turn is traceable.
  test('start with --model records model on the first turn', async () => {
    const taskId = await createTask(ctx, 'Model on start', 'Do work');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes', '--model', 'claude-haiku-4-5-20251001'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);
    // Wait for the daemon to reconcile the turn to blocked before reading turns.
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

    const turns = readTurns(ctx.root, taskId);
    // First turn (human) should have claude-haiku-4-5-20251001 recorded
    const humanTurn = turns.find(t => t.role === 'human');
    expect(humanTurn).toBeDefined();
    expect(humanTurn!.model).toBe('claude-haiku-4-5-20251001');
  }, 30_000);

  // INVARIANT: When --model is specified on unblock, the feedback turn records that model.
  test('unblock with --model records model on the feedback turn', async () => {
    const taskId = await createTask(ctx, 'Model on unblock', 'Do work');

    // Start task (creates first turn, goes to blocked)
    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

    // Unblock with --model claude-sonnet-4-5-20250929
    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Make it better', '--model', 'claude-sonnet-4-5-20250929'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(unblockResult);
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

    const turns = readTurns(ctx.root, taskId);
    // Find the feedback turn (second human turn, sequence > 1)
    const humanTurns = turns.filter(t => t.role === 'human' && isWorkTurn(t));
    expect(humanTurns.length).toBeGreaterThanOrEqual(2);
    const feedbackTurn = humanTurns[humanTurns.length - 1];
    expect(feedbackTurn.model).toBe('claude-sonnet-4-5-20250929');
  }, 30_000);

  // INVARIANT (override-is-durable): after unblocking with --model
  // claude-haiku-4-5-20251001, the next unblock without --model still uses
  // haiku — the override was PERSISTED into task.model, and a plain unblock
  // falls back to task.model. Users do not re-specify the model every turn.
  // The inheritance comes from task.model, not from a scan of prior turns:
  // that scan ("sticky model") was removed in fix-unblock-sticky-model because
  // it carried nothing task.model did not already carry and shadowed
  // `lazy edit --model` (see the edit test below).
  test('a --model override carries to the next unblock without --model', async () => {
    const taskId = await createTask(ctx, 'Sticky model', 'Do work');

    // Start task
    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

    // First unblock with --model claude-haiku-4-5-20251001
    const unblock1 = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Use claude-haiku-4-5-20251001', '--model', 'claude-haiku-4-5-20251001'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(unblock1);
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

    // Second unblock WITHOUT --model — inherits claude-haiku-4-5-20251001 from task.model
    const unblock2 = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Continue'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(unblock2);
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

    const turns = readTurns(ctx.root, taskId);
    // Find human turns (skip agent turns)
    const humanTurns = turns.filter(t => t.role === 'human' && isWorkTurn(t));
    // Last human turn should have haiku (from the persisted task.model)
    const lastHumanTurn = humanTurns[humanTurns.length - 1];
    expect(lastHumanTurn.model).toBe('claude-haiku-4-5-20251001');
  }, 45_000);

  // INVARIANT (edited-task-model-wins — fix-unblock-sticky-model): `lazy edit
  // --model` on a STARTED task must take effect on the next launch. It used
  // not to: unblock resolved `override ?? stickyModel ?? task.model`, where
  // stickyModel was the previous turn's model, so an edit could never outrank
  // the last turn and the edit was a silent no-op. `lazy edit` documents model
  // as editable on started tasks precisely so later turns pick it up.
  // Precedence is now: --model override > task.model > config default.
  test('lazy edit --model on a started task is honored by the next unblock', async () => {
    const taskId = await createTask(ctx, 'Edited model', 'Do work');

    const startResult = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--model', 'claude-opus-4-6'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(startResult);
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

    // Edit the task's model — no --model on the unblock that follows.
    const editResult = await ctx.lazy(['edit', taskId, '--model', 'claude-haiku-4-5-20251001']);
    expectSuccess(editResult);

    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Continue'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(unblockResult);
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

    const turns = readTurns(ctx.root, taskId);
    const lastHumanTurn = turns.filter(t => t.role === 'human' && isWorkTurn(t)).at(-1)!;
    expect(lastHumanTurn.model).toBe('claude-haiku-4-5-20251001');
    // The agent turn it produced ran on the edited model too.
    expect(turns.filter(t => t.role === 'agent' && isWorkTurn(t)).at(-1)!.model).toBe('claude-haiku-4-5-20251001');
  }, 45_000);

  // INVARIANT: When no per-turn model has been set and no --model flag is given,
  // the turn falls back to the task-level model.
  test('fallback to task-level model when no per-turn model set', async () => {
    const taskId = await createTask(ctx, 'Task model fallback', 'Do work');

    // Start with --model claude-opus-4-6 (sets both task model and first turn model)
    const startResult = await ctx.lazyMocked(['start', taskId, '--yes', '--model', 'claude-opus-4-6'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

    const turns = readTurns(ctx.root, taskId);
    const humanTurn = turns.find(t => t.role === 'human');
    expect(humanTurn).toBeDefined();
    // First turn should record claude-opus-4-6 (the model used)
    expect(humanTurn!.model).toBe('claude-opus-4-6');
  }, 30_000);

  // INVARIANT: show command displays per-turn model when it differs from task-level model.
  test('show displays per-turn model when it differs from task model', async () => {
    const taskId = await createTask(ctx, 'Show model display', 'Do work');

    // Start with claude-opus-4-6 (sets task model)
    const startResult = await ctx.lazyMocked(['start', taskId, '--yes', '--model', 'claude-opus-4-6'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

    // Unblock with haiku (different from task model)
    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Switch to claude-haiku-4-5-20251001', '--model', 'claude-haiku-4-5-20251001'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(unblockResult);
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

    // Show should display haiku since it differs from task-level claude-opus-4-6
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'claude-haiku-4-5-20251001');
  }, 30_000);

  // INVARIANT: a mid-task model override lands on THAT turn only. The turns
  // recorded before it keep the model they actually ran under — this is the
  // whole point of per-turn labels: an experiment must be able to label its own
  // arms, which is impossible while `task.model` is the only record and it is
  // last-value-wins.
  test('a mid-task model override labels only the turns from that point on', async () => {
    const taskId = await createTask(ctx, 'Mid-task override', 'Do work');

    const startResult = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--model', 'claude-opus-4-6', '--effort', 'low'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(startResult);
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

    const afterStart = readTurns(ctx.root, taskId);
    const firstAgentTurn = afterStart.find(t => t.role === 'agent')!;
    // The AGENT turn carries the labels too — usage without them cannot be
    // attributed to anything.
    expect(firstAgentTurn.model).toBe('claude-opus-4-6');
    expect(firstAgentTurn.effort).toBe('low');

    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Try the other arm', '--model', 'claude-haiku-4-5-20251001', '--effort', 'high'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(unblockResult);
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

    const turns = readTurns(ctx.root, taskId);
    const agentTurns = turns.filter(t => t.role === 'agent' && isWorkTurn(t));
    expect(agentTurns.length).toBeGreaterThanOrEqual(2);

    // The pre-override turn is untouched by the override…
    expect(agentTurns[0].model).toBe('claude-opus-4-6');
    expect(agentTurns[0].effort).toBe('low');
    // …and the post-override turn carries the new arm, on both the feedback turn
    // the human authored and the agent turn it produced.
    const lastAgentTurn = agentTurns[agentTurns.length - 1];
    expect(lastAgentTurn.model).toBe('claude-haiku-4-5-20251001');
    expect(lastAgentTurn.effort).toBe('high');
    const lastHumanTurn = turns.filter(t => t.role === 'human' && isWorkTurn(t)).at(-1)!;
    expect(lastHumanTurn.model).toBe('claude-haiku-4-5-20251001');
    expect(lastHumanTurn.effort).toBe('high');

    // `lazy show --json` exposes the labels so an experiment can read them
    // without parsing storage internals.
    const showJson = await ctx.lazy(['show', taskId, '--json']);
    expectSuccess(showJson);
    const shown = JSON.parse(showJson.stdout) as {
      turns: Array<{ role: string; turn_type?: string | null; model: string | null; model_id: string | null; effort: string | null }>;
    };
    const shownAgentTurns = shown.turns.filter(t => t.role === 'agent' && isWorkTurn(t));
    expect(shownAgentTurns[0].model).toBe('claude-opus-4-6');
    expect(shownAgentTurns[0].effort).toBe('low');
    expect(shownAgentTurns.at(-1)!.model).toBe('claude-haiku-4-5-20251001');
    expect(shownAgentTurns.at(-1)!.effort).toBe('high');
    // INVARIANT: this seam runs no agent, so no concrete model id is ever
    // reported — and the alias is NOT copied in to fill the gap.
    expect(shownAgentTurns.at(-1)!.model_id).toBeNull();
  }, 45_000);
});
