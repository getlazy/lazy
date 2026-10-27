/**
 * `lazy_edit`'s `token_cap` from a task agent: it may put a cap on a direct
 * subtask or tighten one, never raise or clear one, and never touch its own.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';
import { createEditHandler } from '../../src/mcp/tools';
import { TOKEN_CAP_KEY } from '../../src/usage-pause/running-stop';
import type { Task } from '../../src/types';

let lazyRoot: string;
let basePath: string;
let storage: FileStorage;
let parent: Task;
let child: Task;

describe('MCP lazy_edit token_cap from a task agent', () => {
  beforeEach(async () => {
    lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-mcp-cap-root-'));
    basePath = await mkdtemp(join(tmpdir(), 'lazy-mcp-cap-store-'));
    storage = new FileStorage(lazyRoot, { basePath });
    await storage.initialize();
    parent = await storage.createTask('Cluster');
    child = await storage.createTask('Child', parent.id);
    await storage.updateTaskMetadata(child.id, TOKEN_CAP_KEY, '50000000');
  });

  afterEach(async () => {
    await storage.close();
    await Promise.all([rm(lazyRoot, { recursive: true, force: true }), rm(basePath, { recursive: true, force: true })]);
  });

  const asParentAgent = () => createEditHandler({ taskId: parent.id, worktreePath: lazyRoot, storage });

  // INVARIANT: a task agent never raises or clears a token cap on work it
  // drives — that would lift a spend limit a person set, the same reason it may
  // not let a task past the usage pause.
  test('raising or clearing a subtask\'s cap is refused', async () => {
    await expect(asParentAgent()({ task_id: child.id, token_cap: '80M' })).rejects.toThrow(/never raise or clear/);
    await expect(asParentAgent()({ task_id: child.id, token_cap: 'none' })).rejects.toThrow(/never raise or clear/);
    expect((await storage.getTask(child.id))?.metadata?.[TOKEN_CAP_KEY]).toBe('50000000');
  });

  // INVARIANT: an agent never changes its OWN task's cap.
  test('its own cap is refused', async () => {
    await expect(asParentAgent()({ task_id: parent.id, token_cap: '10M' })).rejects.toThrow(/OWN task's token cap/);
  });
});
