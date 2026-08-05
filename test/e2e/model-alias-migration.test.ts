/**
 * E2E tests for legacy model alias migration.
 *
 * Verifies that legacy model names (apprentice/journeyman/master) stored in
 * task.json are migrated to current names (haiku/sonnet/opus) on read.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync, writeFileSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, extractTaskId } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';
import { taskFilePath } from '../helpers/storage';

// Storage lives at the project's `external_path`, NOT <root>/.lazy/tasks — see
// test/helpers/storage.ts. This suite seeds legacy model aliases the CLI can no
// longer write, so it must resolve the real layout rather than assume one.

/** Read the raw task.json for a given short task ID from the test context */
function readTaskJson(root: string, shortId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(taskFilePath(root, shortId, 'task.json'), 'utf-8'));
}

/** Write a raw task.json for a given short task ID */
function writeTaskJson(root: string, shortId: string, data: Record<string, unknown>): void {
  writeFileSync(taskFilePath(root, shortId, 'task.json'), JSON.stringify(data, null, 2) + '\n');
}

describe('model alias migration', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('apprentice is migrated to haiku on read', async () => {
    const taskId = await createTask(ctx, 'Apprentice model task');

    // Overwrite task.json with legacy model name
    const raw = readTaskJson(ctx.root, taskId);
    raw.model = 'apprentice';
    writeTaskJson(ctx.root, taskId, raw);

    // Verify it was written as apprentice
    const beforeRead = readTaskJson(ctx.root, taskId);
    expect(beforeRead.model).toBe('apprentice');

    // Read via CLI (triggers migration)
    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);

    // After CLI read, task.json should have been migrated
    const afterRead = readTaskJson(ctx.root, taskId);
    expect(afterRead.model).toBe('haiku');
  });

  test('journeyman is migrated to sonnet on read', async () => {
    const taskId = await createTask(ctx, 'Journeyman model task');

    const raw = readTaskJson(ctx.root, taskId);
    raw.model = 'journeyman';
    writeTaskJson(ctx.root, taskId, raw);

    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);

    const afterRead = readTaskJson(ctx.root, taskId);
    expect(afterRead.model).toBe('sonnet');
  });

  test('master is migrated to opus on read', async () => {
    const taskId = await createTask(ctx, 'Master model task');

    const raw = readTaskJson(ctx.root, taskId);
    raw.model = 'master';
    writeTaskJson(ctx.root, taskId, raw);

    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);

    const afterRead = readTaskJson(ctx.root, taskId);
    expect(afterRead.model).toBe('opus');
  });

  test('current model names are not modified', async () => {
    const taskId = await createTask(ctx, 'Current model task');

    const raw = readTaskJson(ctx.root, taskId);
    raw.model = 'sonnet';
    writeTaskJson(ctx.root, taskId, raw);

    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);

    const afterRead = readTaskJson(ctx.root, taskId);
    expect(afterRead.model).toBe('sonnet');
  });

  test('null model is not modified', async () => {
    const taskId = await createTask(ctx, 'Null model task');

    const raw = readTaskJson(ctx.root, taskId);
    raw.model = null;
    writeTaskJson(ctx.root, taskId, raw);

    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);

    const afterRead = readTaskJson(ctx.root, taskId);
    expect(afterRead.model).toBeNull();
  });
});
