import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage/file-storage';

describe('task_ref index writers', () => {
  // INVARIANT: every writer that can change a task's metadata.task_ref keeps the
  // in-memory ref index in step. The only metadata writers in FileStorage are
  // createTask, updateTaskCode (before start), updateTaskMetadata and the tiers-served cleanup (which never
  // touches task_ref); a new writer must update the index or be listed here.
  test('no FileStorage code path writes task metadata outside the indexed writers', () => {
    const src = readFileSync(join(import.meta.dir, '../../src/storage/file-storage.ts'), 'utf8');
    const writes = src
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /\bmetadata(\?|!)?\.[A-Za-z_]+\s*=[^=]|\bmetadata(\?|!)?\[[^\]]+\]\s*=[^=]|\.metadata\s*=[^=]|delete [\w.!?]*metadata|Object\.assign\([^)]*metadata/.test(line))
      .map(({ line }) => line.trim());
    expect(writes).toEqual([
      'raw.metadata = null;', // read-time normalisation of a missing field
      'task.metadata = { ...(task.metadata ?? {}), task_ref: deriveTaskRef(task, existing) };', // createTask — indexed with the new task
      "task.metadata = { ...(task.metadata ?? {}), task_ref: deriveTaskRef(task, await this.listTasks()) };", // updateTaskCode before start — followed by indexSetRef
      'task.metadata = {};', // updateTaskMetadata
      'task.metadata[key] = value;', // updateTaskMetadata — followed by indexSetRef for task_ref
      'delete owner.metadata![TIERS_SERVED_KEY];', // not task_ref
    ]);
    expect(src).toContain("if (key === 'task_ref') await this.applyIndexUpdate((index) => this.indexSetRef(index, fullId, value));");
  });

  test('updateTaskMetadata(task_ref) moves the index entry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lazy-ref-index-'));
    try {
      const base = join(root, 'store');
      mkdirSync(base, { recursive: true });
      writeFileSync(join(root, 'lazy.toml'), `[storage]\nbackend = "external"\nexternal_path = "${base}"\n`);
      const storage = new FileStorage(root, { basePath: base });
      await storage.initialize();
      const t = await storage.createTask('x');
      await storage.updateTaskMetadata(t.id, 'task_ref', 'ref-a');
      await storage.updateTaskMetadata(t.id, 'task_ref', 'ref-b');
      const index = await (storage as any).ensureIndex();
      expect(index.refOf.get(t.id)).toBe('ref-b');
      expect(index.idsByRef.has('ref-a')).toBe(false);
      expect([...index.idsByRef.get('ref-b')]).toEqual([t.id]);
      await storage.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('createTask with an initial task_ref', () => {
  // INVARIANT: a task created with metadata.task_ref is findable through the ref index immediately.
  test('registers the initial ref', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lazy-ref-index-'));
    try {
      const base = join(root, 'store');
      mkdirSync(base, { recursive: true });
      writeFileSync(join(root, 'lazy.toml'), `[storage]\nbackend = "external"\nexternal_path = "${base}"\n`);
      const storage = new FileStorage(root, { basePath: base });
      await storage.initialize();
      const t = await storage.createTask('x', undefined, undefined, undefined, undefined, undefined, undefined, { metadata: { task_ref: 'init-ref' } } as never);
      const index = await (storage as any).ensureIndex();
      expect(index.refOf.get(t.id)).toBe('init-ref');
      await storage.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
