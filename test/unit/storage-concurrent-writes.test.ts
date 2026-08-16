import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage/file-storage';

/**
 * INVARIANT: an acknowledged write is durable. Storage writes are
 * read-modify-write over a whole task directory (atomicWriteTask copies the
 * directory and swaps it), so a lost update does not just drop one field — it
 * reverts every file the loser wrote.
 *
 * The storage lock used to be re-entrant by PID, which meant it excluded other
 * PROCESSES but never other operations inside the daemon. Two concurrent RPCs
 * therefore interleaved freely, and whichever swapped the directory last
 * silently undid the other. That is how `lazy edit --prompt` reported success
 * (task.json AND prompt-history.json were written) and was then rolled back by a
 * concurrent `lazy start`, which launched the agent with the pre-edit prompt.
 *
 * These tests pin in-process mutual exclusion. Without it they fail.
 */
describe('FileStorage concurrent writes', () => {
  let root: string;
  let storage: FileStorage;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'lazy-concurrent-writes-'));
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

  test('a prompt edit concurrent with other task writes is not lost', async () => {
    const task = await storage.createTask('goal');
    await storage.updateTaskPrompt(task.id, 'TRUNCATED');

    // The shape of the reported incident: a prompt edit lands while `start` is
    // stamping model/status onto the same task.
    await Promise.all([
      storage.updateTaskModel(task.id, 'opus'),
      storage.updateTaskPrompt(task.id, 'FULL PROMPT'),
      storage.updateTaskStatus(task.id, 'queued', 'human'),
    ]);

    const after = await storage.getTask(task.id);
    expect(after?.prompt).toBe('FULL PROMPT');
    // Every concurrent write survives — none was reverted by the directory swap.
    expect(after?.model).toBe('opus');
    expect(after?.status).toBe('queued');

    // prompt-history.json is written in the SAME atomicWriteTask as task.json,
    // so a reverted directory swap loses the version too (that is what `lazy
    // show` reads back, and what made the loss visible).
    // getPromptHistory returns newest-first.
    const history = await storage.getPromptHistory(task.id);
    expect(history.map((v) => v.content)).toEqual(['FULL PROMPT', 'TRUNCATED']);
  });

  test('concurrent writes to different fields all survive', async () => {
    const task = await storage.createTask('original goal');

    await Promise.all([
      storage.updateTaskGoal(task.id, 'new goal'),
      storage.updateTaskPrompt(task.id, 'a prompt'),
      storage.updateTaskType(task.id, 'fix'),
      storage.updateTaskPriority(task.id, 'high'),
      storage.updateTaskModel(task.id, 'sonnet'),
    ]);

    const after = await storage.getTask(task.id);
    expect(after?.goal).toBe('new goal');
    expect(after?.prompt).toBe('a prompt');
    expect(after?.type).toBe('fix');
    expect(after?.priority).toBe('high');
    expect(after?.model).toBe('sonnet');
  });

  // INVARIANT: reads are deliberately lock-free (every write lands via an
  // atomic rename), so a write must never make a task momentarily INVISIBLE.
  // The old whole-directory swap renamed the task directory aside before
  // moving the new one in, and a reader landing in that window got
  // "404 Task not found" for a task that plainly exists.
  test('a task stays visible to lock-free readers throughout a write', async () => {
    const task = await storage.createTask('goal');

    let reading = true;
    const misses: string[] = [];
    const reader = (async () => {
      while (reading) {
        const seen = await storage.getTask(task.id);
        if (!seen) misses.push('task disappeared mid-write');
        await new Promise((r) => setTimeout(r, 0));
      }
    })();

    for (let i = 0; i < 25; i++) {
      await storage.updateTaskPrompt(task.id, `prompt ${i}`);
    }
    reading = false;
    await reader;

    expect(misses).toEqual([]);
  });

  test('concurrent comment and journal writes all persist', async () => {
    // Both append to their own file inside the same task directory, so a
    // reverted swap drops one entirely rather than merging.
    const task = await storage.createTask('goal');

    await Promise.all([
      storage.createComment(task.id, 'comment one'),
      storage.appendJournalEntry(task.id, 'journal one'),
      storage.createComment(task.id, 'comment two'),
    ]);

    const comments = await storage.getTaskComments(task.id);
    const journal = await storage.getTaskJournal(task.id);
    expect(comments.map((c) => c.content).sort()).toEqual(['comment one', 'comment two']);
    expect(journal.map((j) => j.content)).toEqual(['journal one']);
  });
});
