/**
 * INVARIANT: the daemon's storage event tap forwards createComment's `options`
 * (forge identity, revision link) untouched. It once declared a fixed four-arg
 * signature and silently dropped them for every daemon-side import, so line
 * comments were re-imported every sync pass.
 */
import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileStorage } from '../../src/storage/file-storage';
import { tapStorageEvents } from '../../src/daemon/event-tap';
import { hashCommentBody } from '../../src/remote/comment-identity';

test('createComment options and updateComment survive the event tap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lazy-tap-root-'));
  const base = await mkdtemp(join(tmpdir(), 'lazy-tap-store-'));
  const fs = new FileStorage(root, { basePath: base });
  await fs.initialize();
  try {
    const storage = tapStorageEvents(fs);
    const task = await storage.createTask('g', undefined, undefined, 'tap', undefined, 'claude-code');
    const external = { forge: 'github' as const, kind: 'line_comment' as const, id: '9', body_hash: hashCommentBody('x') };
    const c = await storage.createComment(task.id, 'x', 'system', 'remote', { external, revises_comment_id: 'orig' });
    const [stored] = await storage.getTaskComments(task.id);
    expect(stored.external).toEqual(external);
    expect(stored.revises_comment_id).toBe('orig');
    const updated = await storage.updateComment(task.id, c.id, { content: 'y' });
    expect(updated.content).toBe('y');
  } finally {
    await fs.close();
    await rm(root, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  }
});
