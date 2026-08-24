import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { readFileSync, readdirSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, extractTaskId } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

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

/** Read the persisted task.model straight from task.json for a short task ID. */
function readTaskModel(root: string, shortId: string): string | undefined {
  const tasksDir = tasksDirFor(root);
  const match = readdirSync(tasksDir).find(d => d.startsWith(shortId));
  if (!match) throw new Error(`Task directory not found for ${shortId}`);
  const task = JSON.parse(readFileSync(join(tasksDir, match, 'task.json'), 'utf-8'));
  return task.model;
}

/** Read the persisted effort metadata straight from task.json. */
function readTaskEffort(root: string, shortId: string): string | undefined {
  const tasksDir = tasksDirFor(root);
  const match = readdirSync(tasksDir).find(d => d.startsWith(shortId));
  if (!match) throw new Error(`Task directory not found for ${shortId}`);
  const task = JSON.parse(readFileSync(join(tasksDir, match, 'task.json'), 'utf-8'));
  return task.metadata?.effort;
}

describe('lazy edit', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: lazy does NOT normalize or shorten model names. validateModel
  // passes any non-empty string straight through to the Claude CLI (which
  // resolves the name itself), and both `edit` and `show` echo task.model
  // verbatim — there is no alias mapping (e.g. claude-opus-4-6 → "opus").
  test('updates task model', async () => {
    const taskId = await createTask(ctx, 'test task');

    // Verify initial model is not set (shows as -)
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'Model:   -');

    // Update model — stored and echoed verbatim, no alias normalization
    const editResult = await ctx.lazy(['edit', taskId, '--model', 'claude-opus-4-6']);
    expectSuccess(editResult);
    expectOutput(editResult, 'Updated model: claude-opus-4-6');

    // Verify model was updated (displayed verbatim)
    const showResult2 = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult2);
    expectOutput(showResult2, 'Model:   claude-opus-4-6');
  });

  test('updates task goal', async () => {
    const taskId = await createTask(ctx, 'original goal');

    const editResult = await ctx.lazy(['edit', taskId, '--goal', 'new goal']);
    expectSuccess(editResult);
    expectOutput(editResult, 'Updated goal: new goal');

    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'Goal:    new goal');
  });

  test('updates multiple fields at once', async () => {
    const taskId = await createTask(ctx, 'test task');

    const editResult = await ctx.lazy([
      'edit',
      taskId,
      '--goal',
      'updated goal',
      '--model',
      'claude-haiku-4-5-20251001',
    ]);
    expectSuccess(editResult);
    expectOutput(editResult, 'Updated goal: updated goal');
    expectOutput(editResult, 'Updated model: claude-haiku-4-5-20251001');

    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'Goal:    updated goal');
    // Model is displayed verbatim — no alias normalization (see INVARIANT above).
    expectOutput(showResult, 'Model:   claude-haiku-4-5-20251001');
  });

  // INVARIANT: There is no model-name allowlist/registry. validateModel accepts
  // any non-empty string and defers name resolution to the Claude CLI, so an
  // unrecognized-looking name is NOT rejected by lazy — only an empty model is.
  // Do NOT reinstate model-name validation here (see persist-model-change).
  test('accepts arbitrary model names but rejects an empty one', async () => {
    const taskId = await createTask(ctx, 'test task');

    // Any non-empty string is accepted and passed through verbatim.
    const editResult = await ctx.lazy(['edit', taskId, '--model', 'some-custom-model']);
    expectSuccess(editResult);
    expectOutput(editResult, 'Updated model: some-custom-model');

    // An empty model string is still refused.
    const emptyResult = await ctx.lazy(['edit', taskId, '--model', '']);
    expectFailure(emptyResult);
    expectError(emptyResult, 'Model name cannot be empty');
  });

  test('prevents editing after task is started', async () => {
    // This test would need to actually start a task, which requires Docker
    // For now, we'll skip this test case as it's already covered by existing edit logic
  });

  test('shows no changes when nothing is updated', async () => {
    const taskId = await createTask(ctx, 'test task');

    // Try to edit without providing any flags (will fail in non-TTY)
    const editResult = await ctx.lazy(['edit', taskId]);
    expectFailure(editResult);
    expectError(editResult, 'Interactive mode requires a TTY');
  });

  test('sets parent on a task', async () => {
    const parentId = await createTask(ctx, 'Parent task');
    const childId = await createTask(ctx, 'Child task');

    const editResult = await ctx.lazy(['edit', childId, '--parent', parentId]);
    expectSuccess(editResult);
    expectOutput(editResult, `Updated parent: ${parentId}`);

    // Verify parent is shown in show output
    const showResult = await ctx.lazy(['show', childId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'Parent Task:');
    expectOutput(showResult, parentId);
  });

  test('clears parent with --parent ""', async () => {
    // Create parent and child using create --parent
    const parentId = await createTask(ctx, 'Parent task');
    const childResult = await ctx.lazy(['create', '--goal', 'Child task', '--parent', parentId]);
    const childId = extractTaskId(childResult.stdout);

    // Verify parent is set
    const showBefore = await ctx.lazy(['show', childId]);
    expectOutput(showBefore, 'Parent Task:');

    // Clear parent
    const editResult = await ctx.lazy(['edit', childId, '--parent', '']);
    expectSuccess(editResult);
    expectOutput(editResult, 'Cleared parent');

    // Verify parent is gone
    const showAfter = await ctx.lazy(['show', childId]);
    expectSuccess(showAfter);
    // Should not show parent section
    if (showAfter.stdout.includes('Parent Task:')) {
      throw new Error('Expected parent info to be cleared, but it still appears in show output');
    }
  });

  test('rejects self as parent', async () => {
    const taskId = await createTask(ctx, 'Self-referential task');

    const editResult = await ctx.lazy(['edit', taskId, '--parent', taskId]);
    expectFailure(editResult);
    expectError(editResult, 'Cannot set task as its own parent');
  });

  test('rejects circular parent chain', async () => {
    const taskA = await createTask(ctx, 'Task A');
    const taskB = await createTask(ctx, 'Task B');

    // Set B's parent to A
    const edit1 = await ctx.lazy(['edit', taskB, '--parent', taskA]);
    expectSuccess(edit1);

    // Try to set A's parent to B — would create A→B→A cycle
    const edit2 = await ctx.lazy(['edit', taskA, '--parent', taskB]);
    expectFailure(edit2);
    expectError(edit2, 'circular parent chain');
  });

  // INVARIANT: A parent in a terminal state cannot be assigned via edit. `close`
  // moves a task to the 'abandoned' terminal status (not a literal 'closed'
  // status — that value does not exist), and the rejection message reports the
  // actual status.
  test('rejects terminal-state parent in edit', async () => {
    const parentId = await createTask(ctx, 'Closed parent');
    const childId = await createTask(ctx, 'Child task');

    // Close the parent → status becomes 'abandoned'
    await ctx.lazy(['close', parentId, '--reason', 'Done']);

    const editResult = await ctx.lazy(['edit', childId, '--parent', parentId]);
    expectFailure(editResult);
    expectError(editResult, 'task is abandoned');
  });

  test('rejects non-existent parent in edit', async () => {
    const taskId = await createTask(ctx, 'Task');

    const editResult = await ctx.lazy(['edit', taskId, '--parent', 'nonexist0']);
    expectFailure(editResult);
    expectError(editResult, 'No task found');
  });

  test('updates task type on backlog task', async () => {
    const taskId = await createTask(ctx, 'test task');

    // Verify initial type is 'task'
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'Type:    task');

    // Update type to refactor
    const editResult = await ctx.lazy(['edit', taskId, '--type', 'refactor']);
    expectSuccess(editResult);
    expectOutput(editResult, 'Updated type: refactor');

    // Verify type was updated
    const showResult2 = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult2);
    expectOutput(showResult2, 'Type:    refactor');
  });

  // INVARIANT: Changing a task's type after its prompt is set warns the user
  // (the prompt was crafted for the old type). The warning is emitted via
  // console.warn → STDERR, while the "Updated type" confirmation is on STDOUT;
  // assert each on the correct stream.
  test('warns when changing type after prompt is set', async () => {
    const taskId = await createTask(ctx, 'test task', 'Some prompt content');

    // Update type to refactor - should warn on stderr and confirm on stdout
    const editResult = await ctx.lazy(['edit', taskId, '--type', 'refactor']);
    expectSuccess(editResult);
    expectError(editResult, 'Warning');
    expectOutput(editResult, 'Updated type: refactor');
  });

  test('rejects invalid type in edit', async () => {
    const taskId = await createTask(ctx, 'test task');

    const editResult = await ctx.lazy(['edit', taskId, '--type', 'invalid-type']);
    expectFailure(editResult);
    expectError(editResult, 'Invalid type');
  });
});

describe('lazy edit on started tasks', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // `start` requires a real daemon (post-v0.11: CLI goes through the daemon
    // for storage), so these tests run withDaemon.
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

  // INVARIANT: A model-only edit is allowed on a started task (has turns).
  // It is the supported way to durably change a running task's model —
  // auto-resume/auto-deliver relaunch from task.model, so without this a
  // stale task.model could crash-loop relaunches on a wrong/dead model.
  test('model-only edit succeeds on a started task', async () => {
    const taskId = await startedTask();

    const editResult = await ctx.lazy(['edit', taskId, '--model', 'claude-opus-4-6']);
    expectSuccess(editResult);
    expectOutput(editResult, 'Updated model: claude-opus-4-6');

    expect(readTaskModel(ctx.root, taskId)).toBe('claude-opus-4-6');
  });

  // INVARIANT: Non-model fields stay frozen once an agent has worked on the
  // task — changing goal/prompt/type/code/parent mid-flight is unsafe. Only
  // --model is exempt.
  test('goal edit is still rejected on a started task', async () => {
    const taskId = await startedTask();

    const editResult = await ctx.lazy(['edit', taskId, '--goal', 'New goal']);
    expectFailure(editResult);
    expectError(editResult, 'only --model and --effort can be changed');
  });

  // INVARIANT: The model-only exemption does not extend to combined edits —
  // --model together with a disallowed field is rejected as a whole, with an
  // actionable message, rather than partially applied.
  test('model combined with goal is rejected on a started task', async () => {
    const taskId = await startedTask();

    const before = readTaskModel(ctx.root, taskId);
    const editResult = await ctx.lazy(['edit', taskId, '--model', 'claude-opus-4-6', '--goal', 'New goal']);
    expectFailure(editResult);
    expectError(editResult, 'only --model and --effort can be changed');
    // Nothing was applied — the model is unchanged too.
    expect(readTaskModel(ctx.root, taskId)).toBe(before);
  });

  // INVARIANT: --effort is editable on a STARTED task, exactly like --model.
  // `lazy start --effort` persists the level on the task, so without this a
  // task that ran one turn at max would stay pinned there; dialing it between
  // turns is the entire reason the flag exists on edit.
  test('effort-only edit succeeds on a started task and persists', async () => {
    const taskId = await startedTask();

    const editResult = await ctx.lazy(['edit', taskId, '--effort', 'medium']);
    expectSuccess(editResult);
    expectOutput(editResult, 'Updated effort: medium');

    expect(readTaskEffort(ctx.root, taskId)).toBe('medium');
  });

  // INVARIANT: model + effort together is still a mid-flight-safe edit —
  // neither restates the work, so the pair is allowed on a started task.
  test('model and effort together succeed on a started task', async () => {
    const taskId = await startedTask();

    const editResult = await ctx.lazy(['edit', taskId, '--model', 'claude-opus-4-6', '--effort', 'xhigh']);
    expectSuccess(editResult);
    expectOutput(editResult, 'Updated effort: xhigh');
    expectOutput(editResult, 'Updated model: claude-opus-4-6');

    expect(readTaskModel(ctx.root, taskId)).toBe('claude-opus-4-6');
    expect(readTaskEffort(ctx.root, taskId)).toBe('xhigh');
  });

  test('effort combined with goal is rejected on a started task', async () => {
    const taskId = await startedTask();

    // Starting the task already persisted the resolved effort, so "unchanged"
    // is the assertion — nothing from the rejected edit was partially applied.
    const before = readTaskEffort(ctx.root, taskId);
    const editResult = await ctx.lazy(['edit', taskId, '--effort', 'low', '--goal', 'New goal']);
    expectFailure(editResult);
    expectError(editResult, 'only --model and --effort can be changed');
    expect(readTaskEffort(ctx.root, taskId)).toBe(before);
  });

  test('sets effort on a not-yet-started task', async () => {
    const taskId = await createTask(ctx, 'Effort task');

    const editResult = await ctx.lazy(['edit', taskId, '--effort', 'high']);
    expectSuccess(editResult);
    expectOutput(editResult, 'Updated effort: high (takes effect next turn)');
    expect(readTaskEffort(ctx.root, taskId)).toBe('high');
  });

  // Same value set and message shape as `lazy start --effort` — the two
  // surfaces must never disagree about what is legal.
  test('rejects an invalid effort level', async () => {
    const taskId = await createTask(ctx, 'Effort task');

    const editResult = await ctx.lazy(['edit', taskId, '--effort', 'banana']);
    expectFailure(editResult);
    expectError(editResult, "Invalid effort 'banana'");
    expectError(editResult, 'low, medium, high, xhigh, max');
    expect(readTaskEffort(ctx.root, taskId)).toBeUndefined();
  });
});
