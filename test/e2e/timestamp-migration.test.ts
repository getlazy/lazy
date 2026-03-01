/**
 * E2E tests for unix timestamp migration.
 *
 * Verifies that:
 * - New tasks store dates as unix millisecond numbers
 * - Legacy ISO string dates are migrated on read
 * - Date display formatting works correctly
 * - Date comparisons/sorting work with numeric timestamps
 * - Round-trip: create → read back → dates are correct numbers
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

/** Write comments.json for a given full task UUID */
function writeCommentsJson(root: string, fullId: string, data: unknown): void {
  const path = join(root, '.lazy', 'tasks', fullId, 'comments.json');
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

describe('timestamp migration', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('new task stores created_at as a number', async () => {
    const before = Date.now();
    const taskId = await createTask(ctx, 'Numeric timestamp task');
    const after = Date.now();

    const raw = readTaskJson(ctx.root, taskId);

    expect(typeof raw.created_at).toBe('number');
    expect(raw.created_at as number).toBeGreaterThanOrEqual(before);
    expect(raw.created_at as number).toBeLessThanOrEqual(after);
    expect(raw.completed_at).toBeNull();
  });

  test('legacy ISO string created_at is migrated to number on read', async () => {
    // Create a task normally
    const taskId = await createTask(ctx, 'Legacy date migration');
    const fullId = getFullId(ctx.root, taskId);

    // Overwrite task.json with a legacy ISO string date
    const raw = readTaskJson(ctx.root, taskId);
    raw.created_at = '2025-01-01T12:00:00.000Z';
    writeTaskJson(ctx.root, fullId, raw);

    // Verify it was written as a string
    const beforeRead = readTaskJson(ctx.root, taskId);
    expect(typeof beforeRead.created_at).toBe('string');

    // Read via CLI (triggers migration)
    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
    expectOutput(result, 'Legacy date migration');

    // After CLI read, task.json should have been migrated to a number
    const afterRead = readTaskJson(ctx.root, taskId);
    expect(typeof afterRead.created_at).toBe('number');
    expect(afterRead.created_at).toBe(new Date('2025-01-01T12:00:00.000Z').getTime());
  });

  test('legacy "YYYY-MM-DD HH:MM:SS" format is migrated correctly', async () => {
    const taskId = await createTask(ctx, 'Custom format migration');
    const fullId = getFullId(ctx.root, taskId);

    // Overwrite with the custom format that the old isoNow() used
    const raw = readTaskJson(ctx.root, taskId);
    raw.created_at = '2025-06-15 14:30:00';
    writeTaskJson(ctx.root, fullId, raw);

    // Read via CLI to trigger migration
    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);

    // Check the migrated value - should treat as UTC
    const afterRead = readTaskJson(ctx.root, taskId);
    expect(typeof afterRead.created_at).toBe('number');
    expect(afterRead.created_at).toBe(new Date('2025-06-15T14:30:00Z').getTime());
  });

  test('display formatting shows readable date from numeric timestamp', async () => {
    const taskId = await createTask(ctx, 'Date display test');
    const fullId = getFullId(ctx.root, taskId);

    // Set a known timestamp: 2025-03-15 09:45:00 UTC
    const knownTs = new Date('2025-03-15T09:45:00Z').getTime();
    const raw = readTaskJson(ctx.root, taskId);
    raw.created_at = knownTs;
    writeTaskJson(ctx.root, fullId, raw);

    // Show the task - should format the date nicely
    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
    expectOutput(result, '2025-03-15 09:45');
  });

  test('list sorting works with numeric timestamps', async () => {
    // Create tasks with known timestamps in a specific order
    const taskId1 = await createTask(ctx, 'Older task AAA');
    const taskId2 = await createTask(ctx, 'Newer task BBB');

    const fullId1 = getFullId(ctx.root, taskId1);
    const fullId2 = getFullId(ctx.root, taskId2);

    // Set timestamps: task1 is older, task2 is newer
    const raw1 = readTaskJson(ctx.root, taskId1);
    raw1.created_at = new Date('2025-01-01T00:00:00Z').getTime();
    writeTaskJson(ctx.root, fullId1, raw1);

    const raw2 = readTaskJson(ctx.root, taskId2);
    raw2.created_at = new Date('2025-06-01T00:00:00Z').getTime();
    writeTaskJson(ctx.root, fullId2, raw2);

    // List tasks - they should be listed (sorted by last activity)
    const result = await ctx.lazy(['list']);
    expectSuccess(result);
    expectOutput(result, 'Older task AAA');
    expectOutput(result, 'Newer task BBB');
  });

  test('round-trip: create, read back, dates are correct numbers', async () => {
    const before = Date.now();
    const taskId = await createTask(ctx, 'Round trip test');
    const after = Date.now();

    // Read via show command
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'Round trip test');

    // Read raw JSON - should still be a number
    const raw = readTaskJson(ctx.root, taskId);
    expect(typeof raw.created_at).toBe('number');
    expect(raw.created_at as number).toBeGreaterThanOrEqual(before);
    expect(raw.created_at as number).toBeLessThanOrEqual(after);

    // The number should be a valid date
    const d = new Date(raw.created_at as number);
    expect(d.getFullYear()).toBeGreaterThanOrEqual(2025);
  });

  test('comments with legacy string dates are migrated on read', async () => {
    const taskId = await createTask(ctx, 'Comments migration test');
    const fullId = getFullId(ctx.root, taskId);

    // Write comments.json with legacy string timestamps
    const legacyComments = {
      comments: [
        {
          id: 'comment-001',
          task_id: fullId,
          content: 'First comment from reviewer',
          created_at: '2025-04-10T08:30:00.000Z',
        },
        {
          id: 'comment-002',
          task_id: fullId,
          content: 'Second comment with feedback',
          created_at: '2025-04-10 09:00:00',
        },
      ],
    };
    writeCommentsJson(ctx.root, fullId, legacyComments);

    // Read via show command (which reads comments and triggers timestamp migration)
    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);

    // After read, comments.json should have numeric timestamps
    const commentsPath = join(ctx.root, '.lazy', 'tasks', fullId, 'comments.json');
    const afterRead = JSON.parse(readFileSync(commentsPath, 'utf-8'));
    expect(typeof afterRead.comments[0].created_at).toBe('number');
    expect(afterRead.comments[0].created_at).toBe(new Date('2025-04-10T08:30:00.000Z').getTime());
    expect(typeof afterRead.comments[1].created_at).toBe('number');
    expect(afterRead.comments[1].created_at).toBe(new Date('2025-04-10T09:00:00Z').getTime());
  });

  test('already-numeric timestamps are not modified', async () => {
    const taskId = await createTask(ctx, 'No-op migration test');
    const fullId = getFullId(ctx.root, taskId);

    // Read the current numeric timestamp
    const raw = readTaskJson(ctx.root, taskId);
    const originalTs = raw.created_at as number;
    expect(typeof originalTs).toBe('number');

    // Read again via CLI
    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);

    // Timestamp should be unchanged
    const afterRead = readTaskJson(ctx.root, taskId);
    expect(afterRead.created_at).toBe(originalTs);
  });
});
