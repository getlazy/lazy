import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createStorage, type Storage } from '../../src/storage';
import { protocolDir, writeStatus, clearStatus } from '../../src/protocol';
import { unfinishedSyncMerge, UNFINISHED_SYNC_MERGE_KEY, syncLogHead, recordUnfinishedSyncMerge } from '../../src/task/unfinished-sync';
import { runSelfSync } from '../../src/daemon/self-sync';
import { testStorageOptions } from '../helpers/storage';
import { isolateLazyEnv } from '../helpers/isolated-lazy-env';
import type { Task } from '../../src/types';

isolateLazyEnv();

describe('unfinished sync provenance', () => {
  let dir: string;
  let storage: Storage;
  let task: Task;
  let head: string;
  let incoming: string;
  function git(...args: string[]) {
    const result = Bun.spawnSync(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
    return { code: result.exitCode, out: result.stdout.toString().trim() };
  }
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'unfinished-sync-'));
    await mkdir(join(dir, '.lazy'));
    storage = await createStorage(dir, testStorageOptions(dir));
    task = { ...await storage.createTask('Abandon sync'), status: 'interrupted' };
    await mkdir(protocolDir(task.id), { recursive: true });
    await writeFile(`${protocolDir(task.id)}.dispatched-command`, 'command-1');
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@lazy.test');
    git('config', 'user.name', 'Test');
    await writeFile(join(dir, '.gitignore'), '.lazy/\n');
    git('add', '.gitignore');
    await writeFile(join(dir, 'shared.txt'), 'base\n');
    git('add', 'shared.txt'); git('commit', '-m', 'Base');
    git('checkout', '-b', 'lazy/task');
    await writeFile(join(dir, 'shared.txt'), 'task\n');
    git('add', 'shared.txt'); git('commit', '-m', 'Task');
    head = git('rev-parse', 'HEAD').out;
    git('checkout', 'main');
    await writeFile(join(dir, 'shared.txt'), 'parent\n');
    git('add', 'shared.txt'); git('commit', '-m', 'Parent');
    incoming = git('rev-parse', 'HEAD').out;
    git('checkout', 'lazy/task');
  });
  afterEach(async () => {
    if (task) {
      await rm(protocolDir(task.id), { recursive: true, force: true });
      await rm(`${protocolDir(task.id)}.dispatched-command`, { force: true });
    }
    if (storage) await storage.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  function checkpoint(extra = {}) {
    writeStatus(protocolDir(task.id), {
      pid: process.pid, task_id: task.id, command_type: 'sync', phase: 'merge_and_fix',
      started_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      pre_turn_sha: head, upstream_merge_sha: incoming, sync_command_id: 'command-1', ...extra,
    });
  }

  // INVARIANT: a stopped sync from an older lazy version must be abandonable
  // using its own checkpoint, without requiring a newly introduced marker.
  test('recognizes the existing supervisor checkpoint and rejects mismatched records', async () => {
    expect(git('merge', incoming, '--no-ff').code).not.toBe(0);
    checkpoint();
    expect(await unfinishedSyncMerge(storage, task, dir)).toEqual({ head, mergeHead: incoming, conflicts: 1 });
    checkpoint({ pre_turn_sha: incoming });
    expect(await unfinishedSyncMerge(storage, task, dir)).toBeNull();
    checkpoint({ command_type: 'start' });
    expect(await unfinishedSyncMerge(storage, task, dir)).toBeNull();
    checkpoint({ task_id: 'another-task' });
    expect(await unfinishedSyncMerge(storage, task, dir)).toBeNull();
  });

  // INVARIANT: either ordered sync step can be abandoned, even after the first
  // step advanced HEAD beyond the turn's starting SHA.
  test('recognizes exact per-step endpoints for a live or stopped sync', async () => {
    expect(git('merge', incoming, '--no-ff').code).not.toBe(0);
    checkpoint({ pre_turn_sha: 'previous-step', upstream_merge_sha: undefined,
      sync_merge_start_sha: head, sync_merge_sha: incoming });
    expect(await unfinishedSyncMerge(storage, task, dir)).not.toBeNull();
    expect(await unfinishedSyncMerge(storage, { ...task, status: 'working' }, dir)).not.toBeNull();
    checkpoint({ sync_merge_sha: head });
    expect(await unfinishedSyncMerge(storage, task, dir)).toBeNull();
  });

  // INVARIANT: a first-step marker cannot mask the same command's later
  // merge, and Stop must retain that merge when it removes the checkpoint.
  test('the current checkpoint supersedes earlier endpoints only for its own command', async () => {
    expect(git('merge', incoming, '--no-ff').code).not.toBe(0);
    await storage.updateTaskMetadata(task.id, UNFINISHED_SYNC_MERGE_KEY,
      JSON.stringify({ head: 'earlier-head', mergeHead: 'earlier-target', commandId: 'command-1' }));
    checkpoint({ sync_merge_start_sha: head, sync_merge_sha: incoming });
    expect(await unfinishedSyncMerge(storage, task, dir)).toEqual({ head, mergeHead: incoming, conflicts: 1 });
    checkpoint({ sync_command_id: 'another-command' });
    expect(await unfinishedSyncMerge(storage, task, dir)).toBeNull();
    checkpoint();
    const merge = await unfinishedSyncMerge(storage, task, dir);
    expect(merge).not.toBeNull();
    await recordUnfinishedSyncMerge(storage, task.id, merge!.head, merge!.mergeHead);
    clearStatus(protocolDir(task.id));
    expect(await unfinishedSyncMerge(storage, task, dir)).toEqual(merge);
  });

  // INVARIANT: self-sync records provenance, not step progress; repeat syncs
  // still derive their plan from git, and a stale record cannot claim a new merge.
  test('recognizes a real self-sync conflict only while its endpoints match', async () => {
    const result = await runSelfSync({ storage, taskId: task.id, sessionId: 'unused',
      displayId: 'test', branch: 'lazy/task', worktreePath: dir,
      plan: [{ step: 2, ref: 'main', target: incoming }] });
    expect(result.status).toBe('conflict');
    expect(await unfinishedSyncMerge(storage, task, dir)).not.toBeNull();
    await writeFile(`${protocolDir(task.id)}.dispatched-command`, 'command-2');
    expect(await unfinishedSyncMerge(storage, task, dir)).toBeNull();
    await writeFile(`${protocolDir(task.id)}.dispatched-command`, 'command-1');
    await storage.updateTaskMetadata(task.id, UNFINISHED_SYNC_MERGE_KEY, JSON.stringify({ head: incoming, mergeHead: incoming }));
    expect(await unfinishedSyncMerge(storage, task, dir)).toBeNull();
  });
});

// INVARIANT: legacy recovery uses explicit sync records, never the presence of
// conflict markers or the name of the current parent branch.
test('legacy sync logs identify only the latest sync and its exact incoming commit', () => {
  const incoming = 'a'.repeat(40);
  const log = `[supervisor] Received command: sync for task task-123\n[supervisor] Sync command: pre-turn SHA 12345678, parent_branch=main\n[merge] Pre-merge HEAD: 12345678\n[git] Merging ${incoming}\n`;
  expect(syncLogHead(log, 'task-123', incoming)).toBe('12345678');
  expect(syncLogHead(log, 'other-task', incoming)).toBeNull();
  expect(syncLogHead(log, 'task-123', 'b'.repeat(40))).toBeNull();
  expect(syncLogHead(log + '[supervisor] Received command: unblock for task task-123\n', 'task-123', incoming)).toBeNull();
  expect(syncLogHead(log + '[merge] Pre-merge HEAD: 87654321\n[git] Merging ' + 'b'.repeat(40) + '\n', 'task-123', incoming)).toBeNull();
});
