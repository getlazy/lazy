/**
 * INVARIANT: accepted tasks end their member environments before worktree
 * cleanup. Idle sessions never expire while a task is live, so task completion
 * must end them. A failed removal is retryable follow-through and never undoes
 * acceptance or removes files beneath a still-running environment.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { runAcceptFollowThrough } from '../../src/daemon/task-lifecycle';
import { ACCEPT_FOLLOWTHROUGH_KEY, FOLLOWTHROUGH_STEPS } from '../../src/daemon/accept-intent';
import { claimMemberTerminal, markMemberTerminalEntered, membersInsideTask, resetMemberTerminalsForTests } from '../../src/server/member-terminals';
import { getWorktreePath } from '../../src/task/identity';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';

const ALICE = 'alice@example.com';
let root: string;
let unpin: () => void;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'followthrough-member-'));
  unpin = pinDaemonBaseDir(join(root, 'daemon'));
});
afterEach(async () => {
  resetMemberTerminalsForTests();
  unpin();
  await rm(root, { recursive: true, force: true });
});

function fixture() {
  const record = {
    targetBranch: 'main', viaForge: true, pushParent: false,
    done: FOLLOWTHROUGH_STEPS.filter((s) => s !== 'cleanup'), attempts: 0,
  };
  const task: any = {
    id: 'merged-task-0000-uuid', code: 'merged', status: 'complete', goal: 'g', created_at: 1,
    target: { kind: 'branch', branch: 'main' },
    metadata: { [ACCEPT_FOLLOWTHROUGH_KEY]: JSON.stringify(record), task_ref: 'merged' },
  };
  const calls: string[] = [];
  const storage: any = {
    getTask: async () => task,
    // No task session: exercise follow-through ordering without a runtime.
    getSessionByTaskId: async () => { calls.push('cleanup'); return null; },
    updateTaskMetadata: async (_id: string, key: string, value: string) => { task.metadata[key] = value; },
  };
  const ctx = {
    storage,
    config: { remote: { offline: true, git_remote: 'origin', driver: 'local' } } as any,
    driver: {} as any,
  };
  return { task, storage, calls, ctx };
}

describe('post-accept follow-through while a member is inside', () => {
  test('ends member sessions before cleanup, without waiting for idle expiry', async () => {
    const { task, calls, ctx } = fixture();
    expect(claimMemberTerminal(task.id, ALICE, async () => { calls.push('vacate'); }).ok).toBe(true);
    markMemberTerminalEntered(task.id, ALICE);

    const result = await runAcceptFollowThrough(root, task.id, ctx);
    expect(result.pending).toEqual([]);
    expect(calls).toEqual(['vacate', 'cleanup']);
    expect(membersInsideTask(task.id)).toEqual([]);
    expect(task.status).toBe('complete');
    expect(task.metadata[ACCEPT_FOLLOWTHROUGH_KEY]).toBe('');
  });

  test('retries failed member teardown without undoing acceptance or cleaning the worktree', async () => {
    const { task, calls, ctx } = fixture();
    const worktree = getWorktreePath(root, task);
    await mkdir(worktree, { recursive: true });
    let failRemoval = true;
    expect(claimMemberTerminal(task.id, ALICE, async () => {
      calls.push('vacate');
      if (failRemoval) throw new Error('runtime unavailable');
    }).ok).toBe(true);
    markMemberTerminalEntered(task.id, ALICE);

    const failed = await runAcceptFollowThrough(root, task.id, ctx);
    expect(failed.pending).toEqual(['cleanup']);
    expect(failed.error).toContain('runtime unavailable');
    expect(task.status).toBe('complete');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(call => call === 'vacate')).toBe(true);
    expect((await stat(worktree)).isDirectory()).toBe(true);
    const record = JSON.parse(task.metadata[ACCEPT_FOLLOWTHROUGH_KEY]);
    expect(record.attempts).toBe(1);
    expect(record.nextAttemptAt).toBeGreaterThan(Date.now());
    expect(record.done).not.toContain('cleanup');

    const beforeRetry = calls.length;
    failRemoval = false;
    const retried = await runAcceptFollowThrough(root, task.id, ctx);
    expect(retried.pending).toEqual([]);
    expect(calls.slice(beforeRetry)).toEqual(['vacate', 'cleanup']);
    expect(membersInsideTask(task.id)).toEqual([]);
    expect(task.status).toBe('complete');
    expect(task.metadata[ACCEPT_FOLLOWTHROUGH_KEY]).toBe('');
  });
});
