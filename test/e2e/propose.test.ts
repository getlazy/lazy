import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, expectOutputExcludes } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';
import { join } from 'path';
import { existsSync, readdirSync, readFileSync } from 'fs';

describe('lazy propose', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('creates a proposal file for a task', async () => {
    const taskId = await createTask(ctx, 'Main task');

    // Use lazy show to get the full UUID
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    const uuidMatch = showResult.stdout.match(/ID:\s+([a-f0-9-]{36})/);
    expect(uuidMatch).not.toBeNull();
    const fullId = uuidMatch![1];

    const result = await ctx.lazy([
      'propose',
      '--goal', 'Add input validation',
      '--code', 'add-validation',
      '--prompt', 'The API endpoints lack input validation...',
      '--task', taskId,
    ]);

    expectSuccess(result);
    expectOutput(result, 'Proposed follow-up task');
    expectOutput(result, 'Add input validation');
    expectOutput(result, 'add-validation');

    // Verify proposal file exists
    const proposalsDir = join(ctx.root, '.lazy', 'tasks', fullId, 'proposals');
    expect(existsSync(proposalsDir)).toBe(true);

    const files = readdirSync(proposalsDir).filter(f => f.endsWith('.json'));
    expect(files.length).toBe(1);

    // Verify proposal content
    const content = JSON.parse(readFileSync(join(proposalsDir, files[0]), 'utf-8'));
    expect(content.goal).toBe('Add input validation');
    expect(content.code).toBe('add-validation');
    expect(content.prompt).toBe('The API endpoints lack input validation...');
    expect(content.status).toBe('pending');
  });

  test('requires --goal flag', async () => {
    const taskId = await createTask(ctx, 'Main task');

    const result = await ctx.lazy(['propose', '--task', taskId]);

    expectFailure(result);
    expectError(result, '--goal is required');
  });

  test('creates proposal without --code or --prompt', async () => {
    const taskId = await createTask(ctx, 'Main task');

    const result = await ctx.lazy([
      'propose',
      '--goal', 'Simple follow-up',
      '--task', taskId,
    ]);

    expectSuccess(result);
    expectOutput(result, 'Proposed follow-up task');
    expectOutput(result, 'Simple follow-up');
  });

  test('creates multiple proposals for the same task', async () => {
    const taskId = await createTask(ctx, 'Main task');

    const showResult = await ctx.lazy(['show', taskId]);
    const uuidMatch = showResult.stdout.match(/ID:\s+([a-f0-9-]{36})/);
    const fullId = uuidMatch![1];

    const result1 = await ctx.lazy([
      'propose',
      '--goal', 'First improvement',
      '--task', taskId,
    ]);
    expectSuccess(result1);

    const result2 = await ctx.lazy([
      'propose',
      '--goal', 'Second improvement',
      '--task', taskId,
    ]);
    expectSuccess(result2);

    // Verify two proposal files exist
    const proposalsDir = join(ctx.root, '.lazy', 'tasks', fullId, 'proposals');
    const files = readdirSync(proposalsDir).filter(f => f.endsWith('.json'));
    expect(files.length).toBe(2);
  });

  test('proposals appear in lazy show output', async () => {
    const taskId = await createTask(ctx, 'Main task');

    // Create a proposal
    await ctx.lazy([
      'propose',
      '--goal', 'Add caching layer',
      '--code', 'add-cache',
      '--task', taskId,
    ]);

    // Show should display proposals
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'Proposals (1 pending)');
    expectOutput(showResult, 'Add caching layer');
  });

  test('proposals not shown in lazy show when there are none', async () => {
    const taskId = await createTask(ctx, 'Main task');

    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutputExcludes(showResult, 'Proposals');
  });

  test('shows usage when --help is passed', async () => {
    const result = await ctx.lazy(['propose', '--help']);
    expectSuccess(result);
    expectOutput(result, 'Usage: lazy propose');
  });
});
