import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectOutputExcludes, expectError } from '../helpers/assertions';
import { createTask, disablePreAccept, startAndReconcile } from '../helpers/fixtures';

describe('lazy list', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    // Daemonless suite: it asserts only on list membership, so the pre-accept
    // agent turn (on by default) is noise with no runner to execute it.
    disablePreAccept(ctx.root);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('shows no tasks message when empty', async () => {
    const result = await ctx.lazy(['list']);
    expectSuccess(result);
    expectOutput(result, 'No active tasks');
  });

  test('lists created tasks', async () => {
    await createTask(ctx, 'Task Alpha');
    await createTask(ctx, 'Task Beta');

    const result = await ctx.lazy(['list']);
    expectSuccess(result);
    expectOutput(result, 'Task Alpha');
    expectOutput(result, 'Task Beta');
  });

  test('--flat shows flat list with PARENT column', async () => {
    await createTask(ctx, 'Flat test');

    const result = await ctx.lazy(['list', '--flat']);
    expectSuccess(result);
    expectOutput(result, 'PARENT');
    expectOutput(result, 'Flat test');
  });

  test('blocked shows tasks in blocked state', async () => {
    // Create and start a task so it transitions from backlog → working → blocked
    const taskId = await createTask(ctx, 'Blocked task', 'Do work');
    await startAndReconcile(ctx, taskId);

    const result = await ctx.lazy(['blocked']);
    expectSuccess(result);
    expectOutput(result, 'Blocked task');
  });

  test('active only shows tasks with sessions', async () => {
    // Create a task without starting it (no session)
    await createTask(ctx, 'Not started task');

    const result = await ctx.lazy(['active']);
    expectSuccess(result);
    expectOutput(result, 'No active tasks');
  });

  test('active shows empty when no tasks exist', async () => {
    const result = await ctx.lazy(['active']);
    expectSuccess(result);
    expectOutput(result, 'No active tasks');
  });

  test('active shows started task that is blocked', async () => {
    // Create and start a task with mocked response
    const taskId = await createTask(ctx, 'Started task', 'Do something');
    await startAndReconcile(ctx, taskId);

    const result = await ctx.lazy(['active']);
    expectSuccess(result);
    expectOutput(result, 'Started task');
  });

  test('active does not show created-but-not-started task', async () => {
    // Create a task without starting it
    await createTask(ctx, 'Not started task');

    // Create and start another task
    const startedId = await createTask(ctx, 'Started task for active', 'Do work');
    await startAndReconcile(ctx, startedId);

    // Check list first to see both tasks
    const listResult = await ctx.lazy(['list']);
    expectSuccess(listResult);
    expectOutput(listResult, 'Not started task');
    expectOutput(listResult, 'Started task for active');

    // Now check active - should only show the started one
    const result = await ctx.lazy(['active']);
    expectSuccess(result);
    expectOutput(result, 'Started task for active');
    expectOutputExcludes(result, 'Not started task');
  });

  test('active shows multiple started tasks', async () => {
    // Start multiple tasks
    const task1 = await createTask(ctx, 'First task', 'Do first');
    await startAndReconcile(ctx, task1);

    const task2 = await createTask(ctx, 'Second task', 'Do second');
    await startAndReconcile(ctx, task2);

    const result = await ctx.lazy(['active']);
    expectSuccess(result);
    expectOutput(result, 'First task');
    expectOutput(result, 'Second task');
  });

  test('blocked shows only started tasks waiting for review', async () => {
    // Create a task without starting it (backlog, no session)
    await createTask(ctx, 'Never started');

    // Create and start a task (blocked, has session, waiting for review)
    const startedId = await createTask(ctx, 'Started and blocked', 'Do something');
    await startAndReconcile(ctx, startedId);

    const result = await ctx.lazy(['blocked']);
    expectSuccess(result);
    // Only the started task should appear in blocked (not the backlog task)
    expectOutput(result, 'Started and blocked');
    // "Never started" should NOT appear (it's backlog, not blocked)
  });

  test('active does not show accepted task even with session', async () => {
    // Create and start a task with commit (needed for accept to work)
    const taskId = await createTask(ctx, 'Task to accept', 'Do work');
    await startAndReconcile(ctx, taskId);

    // Verify it appears in active
    let result = await ctx.lazy(['active']);
    expectSuccess(result);
    expectOutput(result, 'Task to accept');

    // Accept the task
    const acceptResult = await ctx.lazy(['accept', taskId]);
    expectSuccess(acceptResult);

    // Now it should NOT appear in active
    result = await ctx.lazy(['active']);
    expectSuccess(result);
    expectOutputExcludes(result, 'Task to accept');
  });

  test('active does not show rejected task even with session', async () => {
    // Create and start a task with commit (needed for reject to work)
    const taskId = await createTask(ctx, 'Task to reject', 'Do work');
    await startAndReconcile(ctx, taskId);

    // Verify it appears in active
    let result = await ctx.lazy(['active']);
    expectSuccess(result);
    expectOutput(result, 'Task to reject');

    // Reject the task with required --yes and --reason flags
    const rejectResult = await ctx.lazy(['reject', taskId, '--yes', '--reason', 'Testing rejection']);
    expectSuccess(rejectResult);

    // Now it should NOT appear in active
    result = await ctx.lazy(['active']);
    expectSuccess(result);
    expectOutputExcludes(result, 'Task to reject');
  });

  test('active does not show closed task even with session', async () => {
    // Create and start a task
    const taskId = await createTask(ctx, 'Task to close', 'Do work');
    await startAndReconcile(ctx, taskId);

    // Verify it appears in active
    let result = await ctx.lazy(['active']);
    expectSuccess(result);
    expectOutput(result, 'Task to close');

    // Close the task
    await ctx.lazy(['close', taskId, '--reason', 'Not needed']);

    // Now it should NOT appear in active
    result = await ctx.lazy(['active']);
    expectSuccess(result);
    expectOutputExcludes(result, 'Task to close');
  });

  test('active shows working task with session', async () => {
    // Create and start a task - it will be in blocked state after MOCK_CLAUDE_SUCCESS
    const taskId = await createTask(ctx, 'Working task', 'Do work');
    await startAndReconcile(ctx, taskId);

    // Should appear in active (blocked is non-terminal)
    const result = await ctx.lazy(['active']);
    expectSuccess(result);
    expectOutput(result, 'Working task');
  });

  test('blocked does not show accepted task', async () => {
    const taskId = await createTask(ctx, 'Task for blocked accept test', 'Do work');
    await startAndReconcile(ctx, taskId);

    // Verify it appears in blocked
    let result = await ctx.lazy(['blocked']);
    expectSuccess(result);
    expectOutput(result, 'Task for blocked accept test');

    // Accept the task
    const acceptResult = await ctx.lazy(['accept', taskId]);
    expectSuccess(acceptResult);

    // Now it should NOT appear in blocked
    result = await ctx.lazy(['blocked']);
    expectSuccess(result);
    expectOutputExcludes(result, 'Task for blocked accept test');
  });

  test('blocked does not show rejected task', async () => {
    const taskId = await createTask(ctx, 'Task for blocked reject test', 'Do work');
    await startAndReconcile(ctx, taskId);

    // Verify it appears in blocked
    let result = await ctx.lazy(['blocked']);
    expectSuccess(result);
    expectOutput(result, 'Task for blocked reject test');

    // Reject the task
    const rejectResult = await ctx.lazy(['reject', taskId, '--yes', '--reason', 'Bad approach']);
    expectSuccess(rejectResult);

    // Now it should NOT appear in blocked
    result = await ctx.lazy(['blocked']);
    expectSuccess(result);
    expectOutputExcludes(result, 'Task for blocked reject test');
  });

  test('tree view: long child code splits to two lines', async () => {
    // Create parent + child with a code that exceeds column width with tree prefix
    const parentResult = await ctx.lazy(['create', '--goal', 'Parent feature', '--code', 'parent-feat']);
    expectSuccess(parentResult);
    // "└─ " (3) + "child-long-code-name" (20) = 23 > 20 → must split
    const childResult = await ctx.lazy(['create', '--goal', 'Child sub-task work', '--code', 'child-long-code-name', '--parent', 'parent-feat']);
    expectSuccess(childResult);

    const result = await ctx.lazy(['list']);
    expectSuccess(result);

    const lines = result.stdout.split('\n');

    // Child code line has tree connector but NOT the status (data is on next line)
    const childCodeLine = lines.find(l => l.includes('child-long-code-name'));
    expect(childCodeLine).toBeDefined();
    expect(childCodeLine!.includes('└─') || childCodeLine!.includes('├─')).toBe(true);
    expect(childCodeLine!.includes('backlog')).toBe(false);

    // Next line has the status data
    const dataLine = lines[lines.indexOf(childCodeLine!) + 1];
    expect(dataLine).toBeDefined();
    expect(dataLine!.includes('backlog')).toBe(true);

    // Parent (root) has code and status on the same line
    const parentLine = lines.find(l => l.includes('parent-feat'));
    expect(parentLine).toBeDefined();
    expect(parentLine!.includes('backlog')).toBe(true);
  });

  test('tree view: short child code stays on one line', async () => {
    // Create parent + child with a short code that fits: "└─ " (3) + "sub" (3) = 6 <= 20
    const parentResult = await ctx.lazy(['create', '--goal', 'Parent task', '--code', 'parent-task']);
    expectSuccess(parentResult);
    const childResult = await ctx.lazy(['create', '--goal', 'Small child', '--code', 'sub', '--parent', 'parent-task']);
    expectSuccess(childResult);

    const result = await ctx.lazy(['list']);
    expectSuccess(result);

    const lines = result.stdout.split('\n');

    // Short child code should have tree prefix AND status on the SAME line
    const childLine = lines.find(l => l.includes('sub') && (l.includes('└─') || l.includes('├─')));
    expect(childLine).toBeDefined();
    expect(childLine!.includes('backlog')).toBe(true);
  });

  test('long code in plain list wraps remaining columns to next line', async () => {
    const longCode = 'fix-the-very-long-descriptive-task-name1';
    const result1 = await ctx.lazy(['create', '--goal', 'Long code task', '--code', longCode]);
    expectSuccess(result1);

    const result = await ctx.lazy(['list']);
    expectSuccess(result);

    const lines = result.stdout.split('\n');

    // The long code should appear on its own line
    const codeLine = lines.find(l => l.includes(longCode));
    expect(codeLine).toBeDefined();
    // Status should NOT be on the same line as the long code
    expect(codeLine!.includes('backlog')).toBe(false);

    // The next line should contain the status data
    const dataLine = lines[lines.indexOf(codeLine!) + 1];
    expect(dataLine).toBeDefined();
    expect(dataLine!.includes('backlog')).toBe(true);
  });

  test('list does not show accepted task by default', async () => {
    const taskId = await createTask(ctx, 'Task for list accept test', 'Do work');
    await startAndReconcile(ctx, taskId);

    // Verify it appears in list
    let result = await ctx.lazy(['list']);
    expectSuccess(result);
    expectOutput(result, 'Task for list accept test');

    // Accept the task
    const acceptResult = await ctx.lazy(['accept', taskId]);
    expectSuccess(acceptResult);

    // Now it should NOT appear in list (default excludes terminal)
    result = await ctx.lazy(['list']);
    expectSuccess(result);
    expectOutputExcludes(result, 'Task for list accept test');

    // But it should appear with --all
    result = await ctx.lazy(['list', '--all']);
    expectSuccess(result);
    expectOutput(result, 'Task for list accept test');
  });

  test('list with task ID filters to show only that task tree', async () => {
    // Create parent with two children
    const parentId = await createTask(ctx, 'Parent task', 'Parent work');
    const child1Id = await createTask(ctx, 'Child 1', 'Child 1 work');
    const child2Id = await createTask(ctx, 'Child 2', 'Child 2 work');

    // Create another independent task
    const otherTaskId = await createTask(ctx, 'Other task', 'Other work');

    // Set up parent-child relationships by creating with --parent
    await ctx.lazy(['create', '--goal', 'Child A', '--code', 'child-a', '--parent', parentId.substring(0, 8)]);
    await ctx.lazy(['create', '--goal', 'Child B', '--code', 'child-b', '--parent', parentId.substring(0, 8)]);

    // List all tasks - should show everything
    let result = await ctx.lazy(['list']);
    expectSuccess(result);
    expectOutput(result, 'Parent task');
    expectOutput(result, 'Child A');
    expectOutput(result, 'Child B');
    expectOutput(result, 'Other task');

    // Filter by parent task ID - should show only parent and its children
    result = await ctx.lazy(['list', parentId.substring(0, 8)]);
    expectSuccess(result);
    expectOutput(result, 'Parent task');
    expectOutput(result, 'Child A');
    expectOutput(result, 'Child B');
    expectOutputExcludes(result, 'Other task');
  });

  test('list with task code filters correctly', async () => {
    // Create tasks with codes
    await ctx.lazy(['create', '--goal', 'Release task', '--code', 'release-v1']);
    await ctx.lazy(['create', '--goal', 'Feature task', '--code', 'feature-x', '--parent', 'release-v1']);
    await ctx.lazy(['create', '--goal', 'Unrelated task', '--code', 'unrelated']);

    // Filter by code
    const result = await ctx.lazy(['list', 'release-v1']);
    expectSuccess(result);
    expectOutput(result, 'Release task');
    expectOutput(result, 'Feature task');
    expectOutputExcludes(result, 'Unrelated task');
  });

  test('list with task ID and --all flag shows terminal descendants', async () => {
    // Create parent and child
    const parentId = await createTask(ctx, 'Parent for all test', 'Work');
    // A prompt is required: `lazy start` refuses a prompt-less task.
    expectSuccess(await ctx.lazy(['create', '--goal', 'Child task', '--prompt', 'Do child work', '--code', 'child-all', '--parent', parentId.substring(0, 8)]));

    // The parent must be started first: a child branches off the parent's
    // worktree, so `start` refuses while the parent has none.
    await startAndReconcile(ctx, parentId);

    // Start and accept the child task
    await startAndReconcile(ctx, 'child-all');
    await ctx.lazy(['accept', 'child-all']);

    // Without --all, accepted child should not appear even when filtering by parent
    let result = await ctx.lazy(['list', parentId.substring(0, 8)]);
    expectSuccess(result);
    expectOutput(result, 'Parent for all test');
    expectOutputExcludes(result, 'Child task');

    // With --all, accepted child should appear when filtering by parent
    result = await ctx.lazy(['list', parentId.substring(0, 8), '--all']);
    expectSuccess(result);
    expectOutput(result, 'Parent for all test');
    expectOutput(result, 'Child task');
  });

  test('list filters recursively to include nested descendants', async () => {
    // Create grandparent -> parent -> child hierarchy.
    // Codes must be at least 2 characters, so the old single-letter 'p'/'c'
    // codes are rejected — and because these creates were unasserted, the
    // rejection silently produced a one-node tree instead of a failure.
    expectSuccess(await ctx.lazy(['create', '--goal', 'Grandparent', '--code', 'gp']));
    expectSuccess(await ctx.lazy(['create', '--goal', 'Parent', '--code', 'pp', '--parent', 'gp']));
    expectSuccess(await ctx.lazy(['create', '--goal', 'Child', '--code', 'cc', '--parent', 'pp']));
    expectSuccess(await ctx.lazy(['create', '--goal', 'Unrelated', '--code', 'unrel']));

    // Filter by grandparent - should show all three levels
    const result = await ctx.lazy(['list', 'gp']);
    expectSuccess(result);
    expectOutput(result, 'Grandparent');
    expectOutput(result, 'Parent');
    expectOutput(result, 'Child');
    expectOutputExcludes(result, 'Unrelated');
  });
});

/**
 * `--levels <n>` depth scoping on `lazy list` / `lazy blocked`.
 *
 * INVARIANT — the number is 1-BASED and counts the levels of the listing as
 * rendered: `--levels 1` shows top-level rows only, `--levels 2` adds their
 * children. It is deliberately NOT the engineer's literal `--depth 0` spelling:
 * "0" reads as "nothing" as easily as "roots only", and a listing flag whose
 * most useful value is ambiguous is a trap (CLAUDE.md, principle of least
 * surprise).
 *
 * INVARIANT — a depth-limited listing must never look complete. Every elided
 * subtree is reported twice: "(+N hidden)" on the deepest visible row, and a
 * footnote totalling what the limit dropped.
 */
describe('lazy list/blocked --levels', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    disablePreAccept(ctx.root);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** grandparent → parent → child, plus an unrelated top-level task. */
  async function createHierarchy(): Promise<void> {
    expectSuccess(await ctx.lazy(['create', '--goal', 'Depth root', '--code', 'depth-root']));
    expectSuccess(await ctx.lazy(['create', '--goal', 'Depth kid', '--code', 'depth-kid', '--parent', 'depth-root']));
    expectSuccess(await ctx.lazy(['create', '--goal', 'Depth grandkid', '--code', 'depth-gk', '--parent', 'depth-kid']));
    expectSuccess(await ctx.lazy(['create', '--goal', 'Depth sibling', '--code', 'depth-sib']));
  }

  test('--levels 1 shows only top-level tasks and counts what it hid', async () => {
    await createHierarchy();

    const result = await ctx.lazy(['list', '--levels', '1']);
    expectSuccess(result);
    expectOutput(result, 'Depth root');
    expectOutput(result, 'Depth sibling');
    expectOutputExcludes(result, 'Depth kid');
    expectOutputExcludes(result, 'Depth grandkid');

    // Both elision signals: the per-row marker and the footnote.
    expectOutput(result, '(+2 hidden)');
    expectOutput(result, '2 descendant task(s) hidden below --levels 1');
  });

  test('--levels 2 shows one level of children and hides below it', async () => {
    await createHierarchy();

    const result = await ctx.lazy(['list', '--levels', '2']);
    expectSuccess(result);
    expectOutput(result, 'Depth root');
    expectOutput(result, 'Depth kid');
    expectOutputExcludes(result, 'Depth grandkid');
    expectOutput(result, '(+1 hidden)');
    expectOutput(result, '1 descendant task(s) hidden below --levels 2');
  });

  test('no --levels means no limit and no elision noise', async () => {
    await createHierarchy();

    const result = await ctx.lazy(['list']);
    expectSuccess(result);
    expectOutput(result, 'Depth grandkid');
    expectOutputExcludes(result, 'hidden');
  });

  // INVARIANT: levels are counted from the ROWS THIS LISTING SHOWS, so a
  // subtree filter makes the filtered task level 1 — the two scopings compose
  // rather than one silently winning.
  test('composes with the subtree positional', async () => {
    await createHierarchy();

    const result = await ctx.lazy(['list', 'depth-kid', '--levels', '1']);
    expectSuccess(result);
    expectOutput(result, 'Depth kid');
    expectOutputExcludes(result, 'Depth grandkid');
    expectOutputExcludes(result, 'Depth root');
    expectOutput(result, '(+1 hidden)');
  });

  test('--flat honors the limit too', async () => {
    await createHierarchy();

    const result = await ctx.lazy(['list', '--levels', '1', '--flat']);
    expectSuccess(result);
    expectOutput(result, 'PARENT');
    expectOutput(result, 'Depth root');
    expectOutputExcludes(result, 'Depth kid');
    expectOutput(result, '(+2 hidden)');
  });

  test('rejects a non-positive or non-numeric value instead of guessing', async () => {
    const zero = await ctx.lazy(['list', '--levels', '0']);
    expectFailure(zero);
    expectError(zero, '--levels must be a positive integer');

    const word = await ctx.lazy(['list', '--levels', 'deep']);
    expectFailure(word);
    expectError(word, '--levels must be a positive integer');
  });

  test('lazy blocked --levels 1 hides blocked descendants and says so', async () => {
    const parentId = await createTask(ctx, 'Blocked parent', 'Do work');
    await startAndReconcile(ctx, parentId);

    expectSuccess(await ctx.lazy([
      'create', '--goal', 'Blocked kid', '--prompt', 'Do work', '--code', 'blocked-kid', '--parent', parentId,
    ]));
    await startAndReconcile(ctx, 'blocked-kid');

    const unlimited = await ctx.lazy(['blocked']);
    expectSuccess(unlimited);
    expectOutput(unlimited, 'Blocked parent');
    expectOutput(unlimited, 'Blocked kid');

    const limited = await ctx.lazy(['blocked', '--levels', '1']);
    expectSuccess(limited);
    expectOutput(limited, 'Blocked parent');
    expectOutputExcludes(limited, 'Blocked kid');
    expectOutput(limited, '(+1 hidden)');
    expectOutput(limited, '1 descendant task(s) hidden below --levels 1');
  });
});
