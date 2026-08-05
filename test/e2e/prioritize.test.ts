/**
 * E2E tests for task queue priority: `lazy create --priority`, the standalone
 * `lazy prioritize <task> <level>` command, and its validation. Priority orders
 * the concurrency drain sweep; here we assert the CLI surface persists it.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, extractTaskId } from '../helpers/assertions';

describe('lazy create --priority', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('sets a task priority at creation', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Urgent work', '--priority', 'high']);
    expectSuccess(result);
    expectOutput(result, 'Priority: high');
  });

  test('rejects an invalid priority', async () => {
    const result = await ctx.lazy(['create', '--goal', 'x', '--priority', 'yesterday']);
    expectFailure(result);
  });

  test('defaults to normal (no Priority line printed)', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Normal work']);
    expectSuccess(result);
    expect(result.stdout).not.toContain('Priority:');
  });
});

describe('lazy prioritize', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('updates an existing task and persists (visible in lazy show)', async () => {
    const created = await ctx.lazy(['create', '--goal', 'Reprioritize me']);
    const id = extractTaskId(created.stdout);

    const set = await ctx.lazy(['prioritize', id, 'urgent']);
    expectSuccess(set);
    expectOutput(set, 'priority set to urgent');

    const show = await ctx.lazy(['show', id, '--json']);
    expectSuccess(show);
    const task = JSON.parse(show.stdout);
    expect(task.priority).toBe('urgent');
  });

  test('rejects an invalid level', async () => {
    const created = await ctx.lazy(['create', '--goal', 'x']);
    const id = extractTaskId(created.stdout);
    const result = await ctx.lazy(['prioritize', id, 'banana']);
    expectFailure(result);
  });

  test('requires both task and level', async () => {
    const created = await ctx.lazy(['create', '--goal', 'x']);
    const id = extractTaskId(created.stdout);
    const result = await ctx.lazy(['prioritize', id]);
    expectFailure(result);
  });
});
