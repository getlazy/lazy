/**
 * Auto-delivery of an upstream change whose sync the usage pause HOLDS
 * ([usage_pause], src/daemon/auto-deliver.ts `deliverUpstreamUpdated`).
 *
 * The real signal queue (SQLite under the project's .lazy/) and the real
 * delivery gates run; the one thing replaced is the sync itself, which is the
 * subject of test/e2e/usage-pause-reviews-and-asks.test.ts — here only its
 * answer matters.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';
import type { Session, Task } from '../../src/types';

let syncAnswer: Record<string, unknown> = {};
const lifecyclePath = resolve(import.meta.dir, '../../src/daemon/task-lifecycle.ts');
const realLifecycle = await import(lifecyclePath);
await mockModule(lifecyclePath, () => ({
  ...realLifecycle,
  syncTask: async () => syncAnswer,
}));

const { deliverUpstreamUpdated } = await import('../../src/daemon/auto-deliver');
const { initSignalDb, emitSignal, readSignals, closeSignalDb } = await import('../../src/daemon/signals');

function blockedTask(id: string): Task {
  return { id, code: null, goal: 'g', status: 'blocked', agent_id: 'claude-code', metadata: null } as unknown as Task;
}

function storageFor(task: Task) {
  return {
    async getSessionByTaskId(): Promise<Session> {
      return { id: `sess-${task.id}`, task_id: task.id, user_stopped: false, container_name: null } as unknown as Session;
    },
    async getTask(): Promise<Task> { return task; },
    async getTaskMetadata(): Promise<string | null> { return null; },
    async updateTaskMetadata(): Promise<void> {},
  };
}

describe('auto-delivery of an upstream change under a usage pause', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-auto-deliver-usage-pause-'));
    await mkdir(join(root, '.lazy'), { recursive: true });
    await writeFile(join(root, 'lazy.toml'), '[usage_pause]\nthreshold_percent = 95\n');
    initSignalDb(root);
  });

  afterAll(async () => {
    closeSignalDb();
    restoreMockedModules();
    await rm(root, { recursive: true, force: true });
  });

  // INVARIANT: a conflict sync the pause holds is owned by the queued sync
  // (`pending_sync`), which retries with backoff and runs after the reset — so
  // the upstream signal is CONSUMED. Left queued, every delivery pass for the
  // whole pause re-fetched and re-merged only to be held again.
  test('a held sync consumes the upstream signal', async () => {
    const task = blockedTask('task-held-sync-0000-0000-000000000001');
    const signal = emitSignal(task.id, { type: 'upstream_change', summary: 'parent moved' });
    syncAnswer = { taskId: task.id, displayId: 'x', status: 'pending_sync', message: 'held', warnings: [], usagePauseHeld: true };

    const delivered = await deliverUpstreamUpdated(storageFor(task) as never, task, root, 'signal_queue', [signal.id]);

    expect(delivered).toBe(false);
    expect(readSignals(task.id)).toHaveLength(0);
  });

  // The contrast: a sync that is only pending (a failed fetch, a task that
  // stopped being syncable) leaves the signal for a later pass.
  test('a sync that is merely pending leaves the signal queued', async () => {
    const task = blockedTask('task-pending-sync-0000-0000-000000000002');
    const signal = emitSignal(task.id, { type: 'upstream_change', summary: 'parent moved' });
    syncAnswer = { taskId: task.id, displayId: 'x', status: 'pending_sync', message: 'fetch failed', warnings: [] };

    const delivered = await deliverUpstreamUpdated(storageFor(task) as never, task, root, 'signal_queue', [signal.id]);

    expect(delivered).toBe(false);
    expect(readSignals(task.id).map((s) => s.id)).toEqual([signal.id]);
  });
});
