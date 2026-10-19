/**
 * FileStorage's atomic writes are DURABLE: bytes are fsynced before the rename
 * and the directory after it, before the write resolves.
 */
import { test, expect, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import { FileStorage } from '../../src/storage/file-storage';
import { realDurableFsOps, setDurableFsOpsForTest } from '../../src/storage/durable-write';
import type { StoredConversation } from '../../src/storage/types';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function makeStorage(): Promise<FileStorage> {
  const root = await mkdtemp(join(tmpdir(), 'lazy-durable-root-'));
  const base = await mkdtemp(join(tmpdir(), 'lazy-durable-store-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }), () => rm(base, { recursive: true, force: true }));
  const storage = new FileStorage(root, { basePath: base });
  await storage.initialize();
  return storage;
}

/** Record every durable fs op (with full paths) while still performing it. */
function recordOps(): Array<{ op: 'sync-file' | 'rename' | 'sync-dir'; path: string; from?: string }> {
  const ops: Array<{ op: 'sync-file' | 'rename' | 'sync-dir'; path: string; from?: string }> = [];
  const restore = setDurableFsOpsForTest({
    async writeAndSync(p, c) {
      await realDurableFsOps.writeAndSync(p, c);
      ops.push({ op: 'sync-file', path: p });
    },
    async rename(from, to) {
      await realDurableFsOps.rename(from, to);
      ops.push({ op: 'rename', path: to, from });
    },
    async syncDir(d) {
      await realDurableFsOps.syncDir(d);
      ops.push({ op: 'sync-dir', path: d });
    },
  });
  cleanups.push(restore);
  return ops;
}

// INVARIANT: every acknowledged store write fsyncs the file before renaming it
// into place and fsyncs the target directory after the rename. Without it a
// machine crash just after the daemon answers can lose a comment or unblock the
// human was told had landed ("Never lose human feedback").
test('a comment write syncs the file, renames, then syncs the task directory', async () => {
  const storage = await makeStorage();
  const task = await storage.createTask('g', undefined, undefined, 'durable', undefined, 'claude-code');
  const ops = recordOps();
  await storage.createComment(task.id, 'do not lose me', 'human');

  const finalRename = ops.findIndex((o) => o.op === 'rename' && basename(o.path) === 'comments.json' && !o.path.includes('.tmp'));
  expect(finalRename).toBeGreaterThan(-1);
  const taskDir = dirname(ops[finalRename].path);
  const stagedSync = ops.findIndex((o) => o.op === 'sync-file' && basename(o.path).startsWith('comments.json.'));
  const dirSync = ops.findIndex((o) => o.op === 'sync-dir' && o.path === taskDir);
  expect(stagedSync).toBeGreaterThan(-1);
  expect(stagedSync).toBeLessThan(finalRename);
  expect(dirSync).toBeGreaterThan(finalRename);
  // An existing task directory is not a new entry in the tasks directory.
  expect(ops.some((o) => o.op === 'sync-dir' && o.path === dirname(taskDir))).toBe(false);
  expect((await storage.getTaskComments(task.id))[0].content).toBe('do not lose me');
});

// INVARIANT: creating a task also syncs the TASKS directory after the new task
// directory is synced. The new directory is an entry there; without that sync a
// crash can drop the whole task, prompt included.
test('creating a task syncs the tasks directory after the new task directory', async () => {
  const storage = await makeStorage();
  const ops = recordOps();
  await storage.createTask('g', undefined, undefined, 'durable-new', undefined, 'claude-code');

  const taskJson = ops.findIndex((o) => o.op === 'rename' && basename(o.path) === 'task.json' && !o.path.includes('.tmp'));
  expect(taskJson).toBeGreaterThan(-1);
  const taskDir = dirname(ops[taskJson].path);
  const taskDirSync = ops.findIndex((o) => o.op === 'sync-dir' && o.path === taskDir);
  const parentSync = ops.findIndex((o) => o.op === 'sync-dir' && o.path === dirname(taskDir));
  expect(taskDirSync).toBeGreaterThan(taskJson);
  expect(parentSync).toBeGreaterThan(taskDirSync);
});

// INVARIANT: the direct (non-staged) write path syncs the temp file, renames it
// within the same directory, then syncs that directory.
test('a direct write syncs the file, renames in place, then syncs its directory', async () => {
  const storage = await makeStorage();
  const ops = recordOps();
  const conversation = {
    sessionId: 'durable-conv',
    projectPath: '-tmp',
    cwd: '/tmp',
    version: '1.0.0',
    gitBranch: 'main',
    startedAt: '2026-09-01T10:00:00.000Z',
    endedAt: '2026-09-01T11:00:00.000Z',
    importedAt: 1,
    summary: 'words the human typed',
    stats: { messageCount: 0, userMessageCount: 0, assistantMessageCount: 0, subagentCount: 0, totalTokens: 0 },
    totalUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    messages: [],
  } as unknown as StoredConversation;
  await storage.saveConversation(conversation);

  const i = ops.findIndex((o) => o.op === 'rename' && basename(o.path) === 'durable-conv.json');
  expect(i).toBeGreaterThan(0);
  const target = ops[i];
  expect(dirname(target.from!)).toBe(dirname(target.path));
  expect(ops[i - 1]).toEqual({ op: 'sync-file', path: target.from! });
  expect(ops[i + 1]).toEqual({ op: 'sync-dir', path: dirname(target.path) });
  expect((await storage.loadConversation('durable-conv'))?.summary).toBe('words the human typed');
});
