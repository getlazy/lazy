import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage/file-storage';

/**
 * INVARIANT (remove-reaper-cap-sweep): the 'queued' status and the `priority`
 * field were removed with the agent concurrency cap. Stores written by older
 * versions can still contain both, so FileStorage normalizes on read:
 * 'queued' → 'backlog' (the user simply re-starts the task — nothing drains a
 * queue any more) and a stale `priority` field is dropped.
 */
describe('legacy queued/priority normalization', () => {
  let root: string;
  let storage: FileStorage;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'lazy-legacy-queued-'));
    const base = join(root, 'store');
    mkdirSync(base, { recursive: true });
    writeFileSync(
      join(root, 'lazy.toml'),
      `[storage]\nbackend = "external"\nexternal_path = "${base}"\n`,
    );
    storage = new FileStorage(root, { basePath: base });
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a legacy 'queued' task reads back as 'backlog' and its priority field is dropped", async () => {
    const task = await storage.createTask('legacy task');

    // Rewrite task.json the way a pre-removal lazy would have left it.
    const taskFile = join(root, 'store', 'tasks', task.id, 'task.json');
    const raw = JSON.parse(readFileSync(taskFile, 'utf-8'));
    raw.status = 'queued';
    raw.priority = 'urgent';
    writeFileSync(taskFile, JSON.stringify(raw, null, 2));

    const read = await storage.getTask(task.id);
    expect(read?.status).toBe('backlog');
    expect((read as unknown as Record<string, unknown>)?.priority).toBeUndefined();

    // The normalization is written back, so the store self-heals.
    const healed = JSON.parse(readFileSync(taskFile, 'utf-8'));
    expect(healed.status).toBe('backlog');
    expect(healed.priority).toBeUndefined();
  });
});
