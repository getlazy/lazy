/**
 * E2E tests for legacy model alias migration.
 *
 * Verifies that legacy model names (apprentice/journeyman/master) stored in
 * task.json are migrated to current names (haiku/sonnet/opus) on read.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, extractTaskId } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';

/** Read the raw task.json for a given short task ID from the test context */
function readTaskJson(root: string, shortId: string): Record<string, unknown> {
  const tasksDir = join(root, '.lazy', 'tasks');
  const entries = readdirSync(tasksDir);
  const fullId = entries.find(e => e.startsWith(shortId));
  if (!fullId) throw new Error(`No task directory starting with ${shortId}`);
  const content = readFileSync(join(tasksDir, fullId, 'task.json'), 'utf-8');
  return JSON.parse(content);
}

/** Write a raw task.json for a given full task UUID */
function writeTaskJson(root: string, fullId: string, data: Record<string, unknown>): void {
  const path = join(root, '.lazy', 'tasks', fullId, 'task.json');
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

/** Get the full task UUID from a short ID */
function getFullId(root: string, shortId: string): string {
  const tasksDir = join(root, '.lazy', 'tasks');
  const entries = readdirSync(tasksDir);
  const fullId = entries.find(e => e.startsWith(shortId));
  if (!fullId) throw new Error(`No task directory starting with ${shortId}`);
  return fullId;
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
    const fullId = getFullId(ctx.root, taskId);

    // Overwrite task.json with legacy model name
    const raw = readTaskJson(ctx.root, taskId);
    raw.model = 'apprentice';
    writeTaskJson(ctx.root, fullId, raw);

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
    const fullId = getFullId(ctx.root, taskId);

    const raw = readTaskJson(ctx.root, taskId);
    raw.model = 'journeyman';
    writeTaskJson(ctx.root, fullId, raw);

    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);

    const afterRead = readTaskJson(ctx.root, taskId);
    expect(afterRead.model).toBe('sonnet');
  });

  test('master is migrated to opus on read', async () => {
    const taskId = await createTask(ctx, 'Master model task');
    const fullId = getFullId(ctx.root, taskId);

    const raw = readTaskJson(ctx.root, taskId);
    raw.model = 'master';
    writeTaskJson(ctx.root, fullId, raw);

    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);

    const afterRead = readTaskJson(ctx.root, taskId);
    expect(afterRead.model).toBe('opus');
  });

  test('current model names are not modified', async () => {
    const taskId = await createTask(ctx, 'Current model task');
    const fullId = getFullId(ctx.root, taskId);

    const raw = readTaskJson(ctx.root, taskId);
    raw.model = 'sonnet';
    writeTaskJson(ctx.root, fullId, raw);

    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);

    const afterRead = readTaskJson(ctx.root, taskId);
    expect(afterRead.model).toBe('sonnet');
  });

  test('null model is not modified', async () => {
    const taskId = await createTask(ctx, 'Null model task');
    const fullId = getFullId(ctx.root, taskId);

    const raw = readTaskJson(ctx.root, taskId);
    raw.model = null;
    writeTaskJson(ctx.root, fullId, raw);

    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);

    const afterRead = readTaskJson(ctx.root, taskId);
    expect(afterRead.model).toBeNull();
  });
});
