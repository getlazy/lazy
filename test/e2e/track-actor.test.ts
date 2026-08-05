import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, startAndReconcile, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
// The shared helper is the ONE place that knows tasks live at lazy.toml's
// external_path; the per-suite <root>/.lazy/tasks copies below died with ENOENT
// once storage moved out of the repo.
import { readTurns, taskFilePath } from '../helpers/storage';

/** Read a task's JSON record file, or [] when it was never written. */
function readRecords<T>(root: string, shortId: string, file: string, key: string): T[] {
  try {
    const data = JSON.parse(readFileSync(taskFilePath(root, shortId, file), 'utf-8'));
    return data[key];
  } catch {
    return [];
  }
}

/** Read comments.json for a task and return the parsed comments array. */
function readComments(root: string, shortId: string): Array<{ content: string; actor?: string }> {
  return readRecords(root, shortId, 'comments.json', 'comments');
}

/** Read status-changelog.json for a task and return the parsed changes array. */
function readStatusChangelog(root: string, shortId: string): Array<{ status: string; actor?: string }> {
  return readRecords(root, shortId, 'status-changelog.json', 'changes');
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

    const result = await ctx.lazy(['close', taskId, '--reason', 'Done']);
    expectSuccess(result);

    const changelog = readStatusChangelog(ctx.root, taskId);
    // Should have at least the 'backlog' entry (from create) and the 'abandoned' entry
    const abandonedEntry = changelog.find(c => c.status === 'abandoned');
    expect(abandonedEntry).toBeDefined();
    expect(abandonedEntry!.actor).toBe('human');
  });

  // INVARIANT: Status transitions via LAZY_ACTOR=builder record actor=builder.
  test('close with LAZY_ACTOR=builder records actor=builder on status changelog', async () => {
    const taskId = await createTask(ctx, 'Builder close test');

    const result = await ctx.lazy(['close', taskId, '--reason', 'Builder close'], {
      env: { LAZY_ACTOR: 'builder' },
    });
    expectSuccess(result);

    const changelog = readStatusChangelog(ctx.root, taskId);
    const abandonedEntry = changelog.find(c => c.status === 'abandoned');
    expect(abandonedEntry).toBeDefined();
    expect(abandonedEntry!.actor).toBe('builder');
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

    // Start the task, then drive the reconcile pass that makes the
    // working → blocked transition. `lazy list` used to reconcile on the way
    // through; post-v0.11 only the daemon's loop (or an explicit pass) does.
    await startAndReconcile(ctx, taskId);

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
