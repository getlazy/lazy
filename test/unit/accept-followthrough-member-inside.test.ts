/**
 * INVARIANT: a merge the forge made while a member was working in the task
 * (their task was `submitted`, then its PR merged) is committed, but the
 * task's worktree, branch, container and tokens are NOT cleaned up under them.
 * Post-accept follow-through — the one function both the remote-sync merge path
 * and the daemon's retry sweep run — leaves `cleanup` pending while a member
 * is inside, without counting it as a failure (no attempt, no backoff, no
 * system message), and runs it on the first pass after their session ends.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { runAcceptFollowThrough } from '../../src/daemon/task-lifecycle';
import { ACCEPT_FOLLOWTHROUGH_KEY, FOLLOWTHROUGH_STEPS } from '../../src/daemon/accept-intent';
import { claimMemberTerminal, markMemberTerminalEntered, releaseMemberTerminal, resetMemberTerminalsForTests } from '../../src/server/member-terminals';
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
    // Cleanup's first read. Answering "no session" keeps the second pass from
    // needing a container runtime or git: what is asserted is whether cleanup
    // RAN, and that the worktree is still there while the member is inside.
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
  test('keeps the worktree until the member session ends, then cleans up', async () => {
    const { task, calls, ctx } = fixture();
    const worktree = getWorktreePath(root, task);
    await mkdir(worktree, { recursive: true });
    expect(claimMemberTerminal(task.id, ALICE).ok).toBe(true);
    markMemberTerminalEntered(task.id, ALICE);

    for (let pass = 0; pass < 2; pass++) {
      const held = await runAcceptFollowThrough(root, task.id, ctx);
      expect(held.pending).toEqual(['cleanup']);
      expect(held.waitingForMember).toBe(ALICE);
      expect(calls).toEqual([]);
      expect((await stat(worktree)).isDirectory()).toBe(true);
      // Not a failure: nothing counted, nothing backed off.
      const record = JSON.parse(task.metadata[ACCEPT_FOLLOWTHROUGH_KEY]);
      expect(record.attempts).toBe(0);
      expect(record.nextAttemptAt).toBeUndefined();
      expect(record.done).not.toContain('cleanup');
    }

    // Her session ends (the hold is freed after the vacate).
    releaseMemberTerminal(task.id, ALICE, async () => {}, 1);
    await new Promise((r) => setTimeout(r, 20));
    const after = await runAcceptFollowThrough(root, task.id, ctx);
    expect(after.pending).toEqual([]);
    expect(calls).toEqual(['cleanup']);
    expect(task.metadata[ACCEPT_FOLLOWTHROUGH_KEY]).toBe('');
  });
});
