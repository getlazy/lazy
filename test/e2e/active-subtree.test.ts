/**
 * E2E tests for `lazy active <task_id>` — the optional positional that narrows
 * the active view to one task's SUBTREE (the task itself plus every descendant:
 * children, grandchildren, ...).
 *
 * INVARIANT: the filter is recursive, not direct-children-only, and the subtree
 * is computed against ALL tasks — a terminal task in the middle of the
 * hierarchy must not hide its still-active descendants.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { resolve } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectOutputExcludes, expectError, extractTaskId } from '../helpers/assertions';
import { createTask, disablePreAccept, startAndReconcile } from '../helpers/fixtures';

const ENTRY_PATH = resolve(__dirname, '../../src/index.ts');

/** Create a task with an explicit code and (optionally) a parent task. */
async function createCodedTask(
  ctx: TestContext,
  goal: string,
  code: string,
  parent?: string,
): Promise<string> {
  const args = ['create', '--goal', goal, '--prompt', 'Do work', '--code', code];
  if (parent) args.push('--parent', parent);
  const result = await ctx.lazy(args);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to create ${code}: ${result.stderr}\n${result.stdout}`);
  }
  return extractTaskId(result.stdout);
}

describe('lazy active <task_id> (subtree filter)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    // Daemonless suite asserting only on listing membership — the pre-accept
    // agent turn (on by default) has no runner to execute it here.
    disablePreAccept(ctx.root);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('shows the whole subtree — root, child, and grandchild — and nothing outside it', async () => {
    const rootId = await createCodedTask(ctx, 'Release root', 'release-v020');
    await startAndReconcile(ctx, rootId);

    const childId = await createCodedTask(ctx, 'Release child', 'release-child', rootId);
    await startAndReconcile(ctx, childId);

    const grandchildId = await createCodedTask(ctx, 'Release grandchild', 'release-grandchild', childId);
    await startAndReconcile(ctx, grandchildId);

    const outsiderId = await createTask(ctx, 'Unrelated task', 'Do other work');
    await startAndReconcile(ctx, outsiderId);

    // Unfiltered: everything shows.
    const unfiltered = await ctx.lazy(['active']);
    expectSuccess(unfiltered);
    expectOutput(unfiltered, 'Release root');
    expectOutput(unfiltered, 'Unrelated task');

    // Filtered by code: only the subtree.
    const filtered = await ctx.lazy(['active', 'release-v020']);
    expectSuccess(filtered);
    expectOutput(filtered, 'Release root');
    expectOutput(filtered, 'Release child');
    expectOutput(filtered, 'Release grandchild');
    expectOutputExcludes(filtered, 'Unrelated task');
  });

  test('resolves the positional by short hex id prefix, and combines with --flat', async () => {
    const rootId = await createCodedTask(ctx, 'Prefix root', 'prefix-root');
    await startAndReconcile(ctx, rootId);

    const childId = await createCodedTask(ctx, 'Prefix child', 'prefix-child', rootId);
    await startAndReconcile(ctx, childId);

    const outsiderId = await createTask(ctx, 'Outside subtree', 'Do other work');
    await startAndReconcile(ctx, outsiderId);

    const result = await ctx.lazy(['active', rootId.substring(0, 4), '--flat']);
    expectSuccess(result);
    // --flat still renders the flat view's PARENT column.
    expectOutput(result, 'PARENT');
    expectOutput(result, 'Prefix root');
    expectOutput(result, 'Prefix child');
    expectOutputExcludes(result, 'Outside subtree');
  });

  test('--ids-only respects the subtree filter', async () => {
    const rootId = await createCodedTask(ctx, 'Ids root', 'ids-root');
    await startAndReconcile(ctx, rootId);

    const childId = await createCodedTask(ctx, 'Ids child', 'ids-child', rootId);
    await startAndReconcile(ctx, childId);

    const outsiderId = await createCodedTask(ctx, 'Ids outsider', 'ids-outsider');
    await startAndReconcile(ctx, outsiderId);

    const result = await ctx.lazy(['active', 'ids-root', '--ids-only']);
    expectSuccess(result);
    const ids = result.stdout.split('\n').map(l => l.trim()).filter(Boolean);
    expect(ids).toContain('ids-root');
    expect(ids).toContain('ids-child');
    expect(ids).not.toContain('ids-outsider');
  });

  // INVARIANT: subtree closure is computed over ALL tasks, so a terminal task
  // between an active root and its active grandchild cannot truncate the walk.
  test('reaches descendants through a terminal intermediate task', async () => {
    const rootId = await createCodedTask(ctx, 'Deep root', 'deep-root');
    await startAndReconcile(ctx, rootId);

    const midId = await createCodedTask(ctx, 'Deep middle', 'deep-middle', rootId);
    await startAndReconcile(ctx, midId);

    const leafId = await createCodedTask(ctx, 'Deep leaf', 'deep-leaf', midId);
    await startAndReconcile(ctx, leafId);

    // Close the middle task — it becomes terminal and drops out of `active`.
    const closed = await ctx.lazy(['close', midId, '--reason', 'not needed', '--yes']);
    expectSuccess(closed);

    const result = await ctx.lazy(['active', 'deep-root']);
    expectSuccess(result);
    expectOutput(result, 'Deep root');
    expectOutput(result, 'Deep leaf');
    expectOutputExcludes(result, 'Deep middle');
  });

  test('a valid task with no active descendants gets a clean empty state, not an error', async () => {
    // Created but never started: no session, so nothing in the subtree is active.
    await createCodedTask(ctx, 'Quiet task', 'quiet-task');

    const result = await ctx.lazy(['active', 'quiet-task']);
    expectSuccess(result);
    // The message names the subtree — a bare "No active tasks." would read as
    // "nothing is running anywhere".
    expectOutput(result, 'No active tasks in quiet-task');
  });

  test('an unknown task is an actionable not-found error', async () => {
    const result = await ctx.lazy(['active', 'no-such-task']);
    expectFailure(result);
    expectError(result, 'Task not found: no-such-task');
  });

  test('--follow with an empty subtree prints the filtered empty state and exits', async () => {
    await createCodedTask(ctx, 'Idle follow task', 'idle-follow');

    // The follow loop stops on an empty view, so this terminates on its own —
    // and it exercises the resolve-before-loop path used by follow mode.
    const result = await ctx.lazy(['active', 'idle-follow', '-f']);
    expectSuccess(result);
    expectOutput(result, 'No active tasks in idle-follow');
  });

  test('--follow renders only the subtree', async () => {
    const rootId = await createCodedTask(ctx, 'Follow root', 'follow-root');
    await startAndReconcile(ctx, rootId);

    const childId = await createCodedTask(ctx, 'Follow child', 'follow-child', rootId);
    await startAndReconcile(ctx, childId);

    const outsiderId = await createTask(ctx, 'Follow outsider', 'Do other work');
    await startAndReconcile(ctx, outsiderId);

    // A non-empty follow never exits on its own — read the first frame, then kill.
    const proc = Bun.spawn(['bun', 'run', ENTRY_PATH, 'active', 'follow-root', '-f'], {
      cwd: ctx.root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: 'sk-test-fake-key-for-testing',
        LAZY_PROTOCOL_BASE: ctx.protocolBase,
        LAZY_TEST: '1',
      },
    });

    let output = '';
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + 20_000;
    while (!output.includes('following') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
    }
    reader.cancel().catch(() => { /* the process is about to be killed */ });
    proc.kill();
    await proc.exited;

    expect(output).toContain('Follow root');
    expect(output).toContain('Follow child');
    expect(output).not.toContain('Follow outsider');
    expect(output).toContain('following');
  });

  test('usage documents the positional', async () => {
    const result = await ctx.lazy(['active', '--help']);
    expectSuccess(result);
    expectOutput(result, '<task_id>');
    expectOutput(result, 'subtree');
  });
});
