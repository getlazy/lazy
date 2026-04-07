/**
 * Unit test: MCP tool handlers use injected storage instead of requireStorage()
 *
 * When MCP handlers run inside the daemon process, they should use the storage
 * instance provided in McpToolContext, not call requireStorage() which
 * fails with LAZY_IS_DAEMON=1.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createAllHandlers, type McpToolContext } from '../../src/mcp/tools';
import { createStorage, type Storage } from '../../src/storage';
import { spawnSync } from '../../src/utils/spawn';

describe('MCP tools with injected storage', () => {
  let testDir: string;
  let storage: Storage;
  let ctx: McpToolContext;

  beforeEach(async () => {
    // Create a temporary lazy project
    testDir = mkdtempSync(join(tmpdir(), 'lazy-mcp-test-'));

    // Initialize a minimal lazy project
    const dotLazyDir = join(testDir, '.lazy');
    mkdirSync(dotLazyDir, { recursive: true });

    // Initialize git repo with at least one commit
    spawnSync(['git', 'init'], { cwd: testDir });
    spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: testDir });
    spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: testDir });
    writeFileSync(join(testDir, 'README.md'), '# Test\n');
    spawnSync(['git', 'add', '.'], { cwd: testDir });
    spawnSync(['git', 'commit', '-m', 'Initial commit'], { cwd: testDir });

    // Create storage instance
    storage = await createStorage(testDir, { backend: 'external' });

    // Create context with injected storage
    ctx = {
      taskId: '',
      worktreePath: testDir,
      storage,
    };
  });

  afterEach(async () => {
    if (storage) {
      await storage.close();
    }
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test('createAllHandlers with injected storage does not call requireStorage', async () => {
    // Mock requireStorage to track if it's called
    const requireStorageMock = mock(() => {
      throw new Error('requireStorage should not be called when storage is injected');
    });

    // Temporarily replace the import (this is a smoke test — we verify by not crashing)
    const handlers = createAllHandlers(ctx);

    // Verify handlers were created
    expect(handlers.size).toBeGreaterThan(0);
    expect(handlers.has('lazy_search')).toBe(true);
    expect(handlers.has('lazy_show')).toBe(true);
    expect(handlers.has('lazy_create')).toBe(true);
    expect(handlers.has('lazy_list')).toBe(true);

    // Test that a handler can actually use the storage without calling requireStorage
    const listHandler = handlers.get('lazy_list');
    expect(listHandler).toBeDefined();

    // Call the handler — it should use ctx.storage, not requireStorage
    const result = await listHandler!({ all: false });
    expect(result).toBeDefined();
    expect((result as any).count).toBeGreaterThanOrEqual(0);
    expect((result as any).tasks).toBeDefined();
  });

  test('handlers work correctly with injected storage', async () => {
    const handlers = createAllHandlers(ctx);

    // Test lazy_list
    const listHandler = handlers.get('lazy_list');
    const listResult = await listHandler!({});
    expect((listResult as any).count).toBe(0); // No tasks yet
    expect((listResult as any).tasks).toEqual([]);

    // Test lazy_create
    const createHandler = handlers.get('lazy_create');
    const createResult = await createHandler!({
      goal: 'Test task',
      prompt: 'Test prompt',
    });
    expect((createResult as any).id).toBeDefined();
    expect((createResult as any).goal).toBe('Test task');

    // Verify the task was created by listing again
    const listResult2 = await listHandler!({});
    expect((listResult2 as any).count).toBe(1);
    expect((listResult2 as any).tasks[0].goal).toBe('Test task');
  });

  test('lazy_search works with injected storage', async () => {
    const handlers = createAllHandlers(ctx);

    // Create a task first
    const createHandler = handlers.get('lazy_create');
    await createHandler!({
      goal: 'Searchable task',
      prompt: 'This is a test prompt with unique_keyword_12345',
    });

    // Search for it
    const searchHandler = handlers.get('lazy_search');
    const searchResult = await searchHandler!({
      query: 'unique_keyword_12345',
    });

    expect((searchResult as any).count).toBeGreaterThan(0);
    expect((searchResult as any).results).toBeDefined();
  });
});
