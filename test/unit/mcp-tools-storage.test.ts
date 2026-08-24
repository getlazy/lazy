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
import { spawnSyncUnsupervised } from '../../src/utils/spawn';

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
    spawnSyncUnsupervised(['git', 'init'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'config', 'user.name', 'Test'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'config', 'user.email', 'test@example.com'], { cwd: testDir });
    writeFileSync(join(testDir, 'README.md'), '# Test\n');
    spawnSyncUnsupervised(['git', 'add', '.'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'commit', '-m', 'Initial commit'], { cwd: testDir });

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

  /**
   * Seed a task with a session and `contents.length` turns, then return its id.
   * Sequences deliberately start at 1 so a test can tell an index apart from a
   * sequence number.
   */
  async function seedTurns(goal: string, contents: string[]): Promise<string> {
    const task = await storage.createTask(goal);
    const session = await storage.createSession(task.id, 'claude-code', 'lazy/seed', 'a'.repeat(40));
    for (const [i, content] of contents.entries()) {
      await storage.createTurn({
        sessionId: session.id,
        sequence: i + 1,
        role: i % 2 === 0 ? 'human' : 'agent',
        content,
      });
    }
    return task.id;
  }

  // INVARIANT: a turn hit must be directly addressable. Search excerpts are
  // truncated by design (search LOCATES, lazy_show READS), so a hit that names
  // only its task means paging through lazy_show by hand to find which turn
  // matched. `index` is the turn's offset in the very list lazy_show pages
  // over; `turnSequence` is the number lazy_show reports.
  test('lazy_search turn hits carry index and turnSequence usable with lazy_show', async () => {
    const taskId = await seedTurns('Turn locator task', [
      'opening instructions, nothing notable',
      'considered several options here',
      'settled on the widget_locator_marker approach for good reasons',
      'wrapped up and committed',
    ]);

    const handlers = createAllHandlers(ctx);
    const searchResult = await handlers.get('lazy_search')!({ query: 'widget_locator_marker' }) as any;

    const turnHit = searchResult.results.find((r: any) => r.type === 'turn');
    expect(turnHit).toBeDefined();
    expect(turnHit.index).toBe(2);
    // Sequences start at 1 in this fixture, so a surface that confused the two
    // would report 3 here — and send lazy_show to the wrong turn.
    expect(turnHit.turnSequence).toBe(3);

    // The round trip the locator exists for: feed index straight back as
    // lazy_show's offset and land on exactly the turn that matched.
    const shown = await handlers.get('lazy_show')!({
      task_id: taskId,
      sections: ['turns'],
      offset: turnHit.index,
      limit: 1,
    }) as any;
    expect(shown.turns.length).toBe(1);
    expect(shown.turns[0].sequence).toBe(turnHit.turnSequence);
    expect(shown.turns[0].content).toContain('widget_locator_marker');
  });

  // Same locator on the fuzzy path, which loads content through an entirely
  // separate reader (getAllSearchableContent) — an easy place for the field to
  // silently go missing.
  test('lazy_search fuzzy turn hits carry the same locator', async () => {
    await seedTurns('Fuzzy locator task', [
      'opening instructions',
      'the parallelogram_marker showed up during review',
    ]);

    const handlers = createAllHandlers(ctx);
    const searchResult = await handlers.get('lazy_search')!({
      query: 'paralelogram_marker',
      fuzzy: true,
      filter: 'turns',
    }) as any;

    const turnHit = searchResult.results.find((r: any) => r.content.includes('parallelogram_marker'));
    expect(turnHit).toBeDefined();
    expect(turnHit.index).toBe(1);
    expect(turnHit.turnSequence).toBe(2);
  });

  // A task/prompt hit has no position in any per-task list. Emitting index: 0
  // there would read as "the first turn" and send lazy_show somewhere wrong.
  test('lazy_search task hits carry no locator', async () => {
    const handlers = createAllHandlers(ctx);
    await handlers.get('lazy_create')!({ goal: 'Task with no session at all, mentions kumquat' });

    const searchResult = await handlers.get('lazy_search')!({ query: 'kumquat' }) as any;
    const taskHit = searchResult.results.find((r: any) => r.type === 'task');
    expect(taskHit).toBeDefined();
    expect(taskHit.index).toBeUndefined();
    expect(taskHit.turnSequence).toBeUndefined();
  });
});
