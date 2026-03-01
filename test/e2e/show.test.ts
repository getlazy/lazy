import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';

describe('lazy show', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('shows task details', async () => {
    const taskId = await createTask(ctx, 'Show detail task', 'Detailed prompt text');

    const result = await ctx.lazy(['show', taskId]);

    expectSuccess(result);
    expectOutput(result, 'Show detail task');
    expectOutput(result, 'backlog');
    expectOutput(result, 'Detailed prompt text');
  });

  test('shows "not started" for task without session', async () => {
    const taskId = await createTask(ctx, 'Unstarted task');

    const result = await ctx.lazy(['show', taskId]);

    expectSuccess(result);
    expectOutput(result, 'not started');
  });

  test('fails for nonexistent task', async () => {
    const result = await ctx.lazy(['show', 'nonexist0']);

    expectFailure(result);
    expectError(result, 'No task or conversation found matching');
  });

  test('shows usage when no arguments', async () => {
    const result = await ctx.lazy(['show']);

    expectFailure(result);
    // show without args prints usage and exits 1
  });

  // --- Alias tests ---

  test('view alias works identically to show', async () => {
    const taskId = await createTask(ctx, 'View alias task', 'Test view alias');

    const showResult = await ctx.lazy(['show', taskId]);
    const viewResult = await ctx.lazy(['view', taskId]);

    expectSuccess(showResult);
    expectSuccess(viewResult);
    // Both commands should produce identical output
    expect(viewResult.stdout).toBe(showResult.stdout);
  });

  test('view alias supports --json flag', async () => {
    const taskId = await createTask(ctx, 'View JSON task', 'Test view with JSON');

    const result = await ctx.lazy(['view', taskId, '--json']);

    expectSuccess(result);
    const json = JSON.parse(result.stdout);
    expect(json.goal).toBe('View JSON task');
    expect(json.prompt).toBe('Test view with JSON');
  });

  // --- JSON output tests ---

  describe('--json', () => {
    test('outputs valid JSON for a task', async () => {
      const taskId = await createTask(ctx, 'JSON test task', 'A prompt for JSON');

      const result = await ctx.lazy(['show', taskId, '--json']);

      expectSuccess(result);
      const json = JSON.parse(result.stdout);
      expect(json.goal).toBe('JSON test task');
      expect(json.prompt).toBe('A prompt for JSON');
      expect(json.status).toBe('backlog');
    });

    // INVARIANT: --json output must include all major task sections so agents
    // can inspect any part of a task without falling back to text parsing.
    test('includes all major sections', async () => {
      const taskId = await createTask(ctx, 'Full JSON task', 'Full prompt');

      // Add a comment to have something in comments array
      await ctx.lazy(['comment', taskId, '--message', 'Test comment for JSON']);

      const result = await ctx.lazy(['show', taskId, '--json']);

      expectSuccess(result);
      const json = JSON.parse(result.stdout);

      // Task fields
      expect(json.id).toBeDefined();
      expect(json.code).toBeDefined();
      expect(json.goal).toBe('Full JSON task');
      expect(json.status).toBeDefined();
      expect(json.type).toBeDefined();
      expect(json.created_at).toBeDefined();

      // Arrays should always be present (may be empty)
      expect(Array.isArray(json.turns)).toBe(true);
      expect(Array.isArray(json.commits)).toBe(true);
      expect(Array.isArray(json.comments)).toBe(true);
      expect(Array.isArray(json.children)).toBe(true);
      expect(Array.isArray(json.proposals)).toBe(true);

      // Comment should be present
      expect(json.comments.length).toBe(1);
      expect(json.comments[0].content).toBe('Test comment for JSON');
    });

    // INVARIANT: text output must not change when --json is not passed.
    // This ensures backwards compatibility for human users.
    test('text output unchanged without --json', async () => {
      const taskId = await createTask(ctx, 'Text unchanged task');

      const result = await ctx.lazy(['show', taskId]);

      expectSuccess(result);
      // Should contain human-readable formatting, not JSON
      expectOutput(result, 'Text unchanged task');
      expectOutput(result, 'backlog');
      // Should NOT be valid JSON
      expect(() => JSON.parse(result.stdout)).toThrow();
    });
  });
});
