import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

describe('lazy sync', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('sync requires a remote driver', async () => {
    // Default config uses local driver
    const result = await ctx.lazy(['sync']);
    expectFailure(result);
    expectError(result, 'Sync requires a remote driver');
  });

  test('sync shows help', async () => {
    const result = await ctx.lazy(['sync', '--help']);
    expectSuccess(result);
    expectOutput(result, 'Sync lazy tasks with your remote repository');
    expectOutput(result, 'Fetches PR comments from remote');
    expectOutput(result, 'Human review feedback');
    expectOutput(result, 'Notes added via lazy comment');
  });

  test('sync with github driver prints sync messages', async () => {
    // Configure github driver
    const configPath = join(ctx.root, 'lazy.toml');
    writeFileSync(configPath, '[remote]\ndriver = "github"\ngithub_auto_push = true\n');

    // Sync will fail gracefully since gh CLI is not available in test env
    // but it should at least try to run and show the right messages
    const result = await ctx.lazy(['sync']);
    const output = result.stdout + result.stderr;
    // Should show sync header and export section
    expect(output.includes('Syncing with remote')).toBe(true);
    expect(output.includes('Exporting task branches')).toBe(true);
    // Should show import and export sections
    expect(output.includes('Fetching PR comments')).toBe(true);
    expect(output.includes('Posting task artifacts to PRs')).toBe(true);
  });

  test('sync always includes external change detection', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    writeFileSync(configPath, '[remote]\ndriver = "github"\ngithub_auto_push = true\n');

    const result = await ctx.lazy(['sync']);
    const output = result.stdout;
    // Should have both sections
    expect(output.includes('Detecting external changes')).toBe(true);
    expect(output.includes('Exporting task branches')).toBe(true);
  });

  test('sync skips working tasks', async () => {
    // Create and start a task so it has a session
    const taskId = await createTask(ctx, 'Working task', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    // Manually set task status back to 'working' (simulates an agent actively running)
    const tasksDir = join(ctx.root, '.lazy', 'tasks');
    const entries = readdirSync(tasksDir);
    const fullId = entries.find(e => e.startsWith(taskId));
    if (!fullId) throw new Error(`No task directory starting with ${taskId}`);
    const taskJsonPath = join(tasksDir, fullId, 'task.json');
    const taskData = JSON.parse(readFileSync(taskJsonPath, 'utf-8'));
    taskData.status = 'working';
    writeFileSync(taskJsonPath, JSON.stringify(taskData, null, 2) + '\n');

    // Configure github driver and run sync
    const configPath = join(ctx.root, 'lazy.toml');
    writeFileSync(configPath, '[remote]\ndriver = "github"\ngithub_auto_push = true\n');

    const syncResult = await ctx.lazy(['sync']);
    const output = syncResult.stdout + syncResult.stderr;

    // Sync should run (showing phase headers) but not crash
    expect(output.includes('Syncing with remote')).toBe(true);
    expect(output.includes('Sync complete')).toBe(true);

    // Task should still be in 'working' state (sync did not change it)
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'working');
  });
});
