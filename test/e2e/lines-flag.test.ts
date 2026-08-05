import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { writeFileSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, expectOutputExcludes } from '../helpers/assertions';
import { createTask, startAndReconcile } from '../helpers/fixtures';

// Every command's stdout ends with a trailing newline, so a bare split('\n')
// yields one extra empty element. splitLines() drops it, so the counts below
// are counts of real output lines.
function splitLines(stdout: string): string[] {
  return stdout.replace(/\n$/, '').split('\n');
}

describe('lazy show --lines', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('slices output to specific line range', async () => {
    const taskId = await createTask(ctx, 'Lines test task', 'Test prompt');

    // Get full output first to verify we have multiple lines
    const fullResult = await ctx.lazy(['show', taskId]);
    expectSuccess(fullResult);
    const fullLines = splitLines(fullResult.stdout);
    expect(fullLines.length).toBeGreaterThan(5);

    // Get sliced output (lines 2-4)
    const slicedResult = await ctx.lazy(['show', taskId, '--lines', '2..4']);
    expectSuccess(slicedResult);
    const slicedLines = splitLines(slicedResult.stdout);

    // Should have exactly 3 lines (2, 3, 4)
    expect(slicedLines.length).toBe(3);

    // Verify the sliced lines match the original lines 2-4 (0-indexed: 1-3)
    expect(slicedLines[0]).toBe(fullLines[1]);
    expect(slicedLines[1]).toBe(fullLines[2]);
    expect(slicedLines[2]).toBe(fullLines[3]);
  });

  test('slices from line N to end', async () => {
    const taskId = await createTask(ctx, 'Lines from N test');

    const fullResult = await ctx.lazy(['show', taskId]);
    expectSuccess(fullResult);
    const fullLines = splitLines(fullResult.stdout);

    // Get lines from 3 to end
    const slicedResult = await ctx.lazy(['show', taskId, '--lines', '3..']);
    expectSuccess(slicedResult);
    const slicedLines = splitLines(slicedResult.stdout);

    // Should have all lines from 3 onwards (0-indexed: 2 onwards)
    expect(slicedLines.length).toBe(fullLines.length - 2);
    expect(slicedLines[0]).toBe(fullLines[2]);
  });

  test('slices from start to line M', async () => {
    const taskId = await createTask(ctx, 'Lines to M test');

    const fullResult = await ctx.lazy(['show', taskId]);
    expectSuccess(fullResult);
    const fullLines = splitLines(fullResult.stdout);

    // Get lines from start to 3
    const slicedResult = await ctx.lazy(['show', taskId, '--lines', '..3']);
    expectSuccess(slicedResult);
    const slicedLines = splitLines(slicedResult.stdout);

    // Should have exactly 3 lines (1, 2, 3)
    expect(slicedLines.length).toBe(3);
    expect(slicedLines[0]).toBe(fullLines[0]);
    expect(slicedLines[1]).toBe(fullLines[1]);
    expect(slicedLines[2]).toBe(fullLines[2]);
  });

  test('fails with invalid line range format', async () => {
    const taskId = await createTask(ctx, 'Invalid range test');

    const result = await ctx.lazy(['show', taskId, '--lines', 'invalid']);
    expectFailure(result);
    expectError(result, 'Invalid line range');
  });

  test('fails with start > end', async () => {
    const taskId = await createTask(ctx, 'Invalid range test');

    const result = await ctx.lazy(['show', taskId, '--lines', '10..5']);
    expectFailure(result);
    expectError(result, 'Invalid line range');
  });

  test('handles out of bounds ranges gracefully', async () => {
    const taskId = await createTask(ctx, 'Out of bounds test');

    const fullResult = await ctx.lazy(['show', taskId]);
    expectSuccess(fullResult);
    const fullLines = splitLines(fullResult.stdout);

    // Request lines beyond the actual output
    const result = await ctx.lazy(['show', taskId, '--lines', '1000..2000']);
    expectSuccess(result);

    // Should return empty output (no lines in that range)
    expect(result.stdout.trim()).toBe('');
  });
});

describe('lazy diff --lines', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('slices diff output to specific line range', async () => {
    const taskId = await createTask(ctx, 'Diff lines test', 'Make changes');

    // Start task and make some changes
    // Daemonless: drive the reconcile pass that records the agent turn.
    await startAndReconcile(ctx, taskId);

    // Get full diff first
    const fullResult = await ctx.lazy(['diff', taskId, '--full']);
    expectSuccess(fullResult);
    const fullLines = splitLines(fullResult.stdout);
    expect(fullLines.length).toBeGreaterThan(3);

    // Get sliced diff (lines 1-3)
    const slicedResult = await ctx.lazy(['diff', taskId, '--full', '--lines', '1..3']);
    expectSuccess(slicedResult);
    const slicedLines = splitLines(slicedResult.stdout);

    expect(slicedLines.length).toBe(3);
    expect(slicedLines[0]).toBe(fullLines[0]);
    expect(slicedLines[1]).toBe(fullLines[1]);
    expect(slicedLines[2]).toBe(fullLines[2]);
  });

  test('slices stat diff output', async () => {
    const taskId = await createTask(ctx, 'Stat diff lines test', 'Make changes');

    // Daemonless: drive the reconcile pass that records the agent turn.
    await startAndReconcile(ctx, taskId);

    // Get sliced stat diff
    const result = await ctx.lazy(['diff', taskId, '--lines', '1..2']);
    expectSuccess(result);
    const lines = splitLines(result.stdout);

    // Should have exactly 2 lines
    expect(lines.length).toBe(2);
  });

  test('works with --turn flag', async () => {
    const taskId = await createTask(ctx, 'Turn diff lines test', 'Make changes');

    // Daemonless: drive the reconcile pass that records the agent turn.
    await startAndReconcile(ctx, taskId);

    // Get full turn diff first
    const fullResult = await ctx.lazy(['diff', taskId, '--turn', 'latest']);
    expectSuccess(fullResult);
    const fullLines = splitLines(fullResult.stdout);

    if (fullLines.length > 2) {
      // Get sliced turn diff
      const slicedResult = await ctx.lazy(['diff', taskId, '--turn', 'latest', '--lines', '1..2']);
      expectSuccess(slicedResult);
      const slicedLines = splitLines(slicedResult.stdout);

      expect(slicedLines.length).toBe(2);
      expect(slicedLines[0]).toBe(fullLines[0]);
    }
  });
});
