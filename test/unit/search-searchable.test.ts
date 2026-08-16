/**
 * Unit test: the searchable content loader has ONE owner.
 *
 * `src/search/searchable.ts` and `src/cli/commands/search-data.ts` used to
 * carry near-identical copies of `SearchableItem` + `getAllSearchableContent`,
 * one for the MCP fuzzy path and one for the CLI/daemon-RPC fuzzy path. They
 * drifted with nothing to catch it: the MCP copy never loaded conversations at
 * all, and indexed a task's goal without its code, so the same fuzzy query
 * returned different results depending on which surface asked. These tests pin
 * the collapse — both the single identity and the behavior that was missing.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getAllSearchableContent as loaderFromSearchModule } from '../../src/search';
import { getAllSearchableContent as loaderFromCliModule } from '../../src/cli/commands/search-data';
import { createStorage, type Storage } from '../../src/storage';
import { spawnSync } from '../../src/utils/spawn';

describe('searchable content loader', () => {
  let testDir: string;
  let storage: Storage;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'lazy-searchable-test-'));
    mkdirSync(join(testDir, '.lazy'), { recursive: true });

    spawnSync(['git', 'init'], { cwd: testDir });
    spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: testDir });
    spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: testDir });
    writeFileSync(join(testDir, 'README.md'), '# Test\n');
    spawnSync(['git', 'add', '.'], { cwd: testDir });
    spawnSync(['git', 'commit', '-m', 'Initial commit'], { cwd: testDir });

    storage = await createStorage(testDir, { backend: 'external' });
  });

  afterEach(async () => {
    if (storage) await storage.close();
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  // INVARIANT: one implementation, two import paths. `search-data.ts` re-exports
  // the loader rather than defining its own — if someone reintroduces a second
  // copy, these stop being the same function object and this fails.
  test('both import paths resolve to the same function', () => {
    expect(loaderFromCliModule).toBe(loaderFromSearchModule);
  });

  // The exact drift that motivated the collapse: the MCP-side copy indexed
  // `task.goal` alone, so a fuzzy query for a task's code found nothing there
  // while the CLI found it.
  test('task items index the code alongside the goal', async () => {
    await storage.createTask('Do the thing', undefined, undefined, 'my-task-code');

    const items = await loaderFromSearchModule(storage);
    const taskItem = items.find(i => i.type === 'task');
    expect(taskItem).toBeDefined();
    expect(taskItem!.content).toContain('my-task-code');
    expect(taskItem!.content).toContain('Do the thing');
  });

  // The other half of the drift: the MCP-side copy never called
  // listConversations, so fuzzy search over MCP silently could not reach
  // conversation content that the structured and regex paths both return.
  test('conversations are loaded', async () => {
    const now = new Date().toISOString();
    const noUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    };
    await storage.saveConversation({
      sessionId: 'conv-session-1',
      projectPath: '-tmp-test',
      cwd: testDir,
      version: null,
      gitBranch: null,
      startedAt: now,
      endedAt: now,
      importedAt: 1,
      summary: 'A chat about zucchini_marker',
      stats: {
        messageCount: 1,
        userMessageCount: 1,
        assistantMessageCount: 0,
        subagentCount: 0,
        totalTokens: 0,
      },
      totalUsage: noUsage,
      messages: [
        {
          uuid: 'msg-1',
          parentUuid: null,
          timestamp: now,
          role: 'user',
          text: 'what about zucchini_marker?',
          model: null,
          usage: null,
        },
      ],
      subagents: [],
    });

    const items = await loaderFromSearchModule(storage);
    const convItems = items.filter(i => i.type === 'conversation');
    expect(convItems.length).toBeGreaterThan(0);
    expect(convItems.some(i => i.content.includes('zucchini_marker'))).toBe(true);
  });

  // The locator this task exists for, asserted at the loader rather than
  // through a surface — turns carry both fields, and entities with no position
  // in a per-task list carry neither.
  test('turn items carry entityIndex and turnSequence; task items carry neither', async () => {
    const task = await storage.createTask('Locator task');
    const session = await storage.createSession(task.id, 'claude-code', 'lazy/seed', 'a'.repeat(40));
    for (const [i, content] of ['first turn', 'second turn'].entries()) {
      await storage.createTurn({
        sessionId: session.id,
        sequence: i + 1,
        role: i % 2 === 0 ? 'human' : 'agent',
        content,
      });
    }

    const items = await loaderFromSearchModule(storage);

    const second = items.find(i => i.type === 'turn' && i.content.includes('second turn'));
    expect(second).toBeDefined();
    expect(second!.entityIndex).toBe(1);
    // Sequences start at 1 here, so a loader that conflated the two would
    // report 2 — and send `show` to the wrong turn.
    expect(second!.turnSequence).toBe(2);

    const taskItem = items.find(i => i.type === 'task');
    expect(taskItem!.entityIndex).toBeUndefined();
    expect(taskItem!.turnSequence).toBeUndefined();
  });
});
