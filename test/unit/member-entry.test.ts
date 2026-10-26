/**
 * A member entering a task (src/daemon/member-entry.ts), and what still waits
 * for them.
 *
 * INVARIANT (engineer, 2026-10-21, replacing "member terminals and turns take
 * turns with a task"): a member inside a task never keeps a turn from
 * starting, and a running turn never keeps a member out — exactly like solo
 * `lazy shell <task>`. Their terminals still run in a container of their own,
 * so the two never share a process space or a credential; they share the
 * worktree's files, at the same time. What still waits for a member is only
 * what REMOVES their files: a reject, close or redo (refused, or confirmed to
 * end their sessions first).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  claimMemberTerminal,
  releaseMemberTerminal,
  memberTerminalContainer,
  membersInsideTask,
  resetMemberTerminalsForTests,
} from '../../src/server/member-terminals';
import { enterTaskAsMember, beginWorktreeTeardown } from '../../src/daemon/member-entry';
import { mustRecreateForCredentialPlan } from '../../src/daemon/turn-credentials';
import { bindTurnCredential, getTaskSessionBinding, clearSessionCredentialCache } from '../../src/daemon/session-credentials';
import { RpcError } from '../../src/daemon/rpc-error';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { beginMemberRecovery, memberInventoryRead, resetMemberRecoveryForTests } from '../../src/daemon/member-recovery';

function fakeStorage(task: Record<string, unknown>, opts: { turns?: number; session?: boolean } = {}) {
  return {
    getTask: async () => task as never,
    getSessionByTaskId: async () => (opts.session === false ? null : ({ id: 'sess-1', task_id: task.id }) as never),
    getSessionTurns: async () => Array.from({ length: opts.turns ?? 1 }, (_, i) => ({ sequence: i + 1 })) as never,
  };
}

const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';

afterEach(() => { resetMemberTerminalsForTests(); resetMemberRecoveryForTests(); });

const enter = (taskId: string, status: string, projectRoot = '/p') => enterTaskAsMember({
  projectRoot, storage: fakeStorage({ id: taskId, status }), taskId, email: ALICE,
});

describe('a member entering a task', () => {
  // INVARIANT: unknown inventory must not create a second member environment.
  test('waits for startup inventory before accepting terminal access', async () => {
    beginMemberRecovery('/p');
    expect(await enter('task-recovery', 'blocked')).toMatchObject({ ok: false, status: 503 });
    memberInventoryRead('/p');
    expect(await enter('task-recovery', 'blocked')).toEqual({ ok: true });
  });
  test('enters a paused task that has run a turn, and from then on is inside', async () => {
    expect(claimMemberTerminal('task-1', ALICE).ok).toBe(true);
    expect(await enter('task-1', 'blocked')).toEqual({ ok: true });
    expect((membersInsideTask('task-1')[0] ?? null)).toBe(ALICE);
  });

  // INVARIANT: a running turn never keeps a member out (engineer, 2026-10-21).
  test('enters a task whose turn is running', async () => {
    expect(claimMemberTerminal('task-2', ALICE).ok).toBe(true);
    expect(await enter('task-2', 'working')).toEqual({ ok: true });
    expect((membersInsideTask('task-2')[0] ?? null)).toBe(ALICE);
  });

  // INVARIANT: nor does a pairing session, a Chat, or the supervisor still
  // finishing a turn: the entry reads none of them any more — they are all the
  // agent at work in the worktree, which a member may share.
  test('enters a task being paired on, or interrupted', async () => {
    for (const [id, status] of [['task-2a', 'pairing'], ['task-2b', 'interrupted']] as const) {
      expect(claimMemberTerminal(id, ALICE).ok).toBe(true);
      expect(await enter(id, status, '/nonexistent-project')).toEqual({ ok: true });
    }
  });

  test('is refused on a task that has not started, or whose session has no turn yet', async () => {
    for (const [storage, why] of [
      [fakeStorage({ id: 'task-3', status: 'backlog' }), 'not started'],
      [fakeStorage({ id: 'task-3', status: 'blocked' }, { turns: 0 }), 'not run a turn'],
      [fakeStorage({ id: 'task-3', status: 'blocked' }, { session: false }), 'not run a turn'],
    ] as const) {
      expect(claimMemberTerminal('task-3', ALICE).ok).toBe(true);
      const refused = await enterTaskAsMember({ projectRoot: '/p', storage, taskId: 'task-3', email: ALICE });
      expect(refused).toMatchObject({ ok: false, status: 409 });
      if (!refused.ok) expect(refused.message).toContain(why);
      expect((membersInsideTask('task-3')[0] ?? null)).toBeNull();
      releaseMemberTerminal('task-3', ALICE);
    }
  });

  for (const status of ['merging', 'complete', 'abandoned']) {
    test(`a ${status} task cannot be entered`, async () => {
      expect(claimMemberTerminal('task-11', ALICE).ok).toBe(true);
      expect(await enter('task-11', status)).toMatchObject({ ok: false, status: 409 });
      expect((membersInsideTask('task-11')[0] ?? null)).toBeNull();
    });
  }
});

describe('a turn launching while a member is inside', () => {
  let root: string;
  let base: string;
  let unpin: () => void;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'member-entry-'));
    base = await mkdtemp(join(tmpdir(), 'lzd-member-entry-'));
    unpin = pinDaemonBaseDir(base);
    clearSessionCredentialCache();
  });

  afterEach(async () => {
    unpin();
    clearSessionCredentialCache();
    await rm(root, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  });

  // INVARIANT: every turn launch path reaches mustRecreateForCredentialPlan
  // under the task's lifecycle lock (test/unit/launch-under-lifecycle-lock.test.ts);
  // a member inside no longer refuses it, and the binding it planned stays live.
  test('is not refused, and keeps the binding it just planned', async () => {
    expect(claimMemberTerminal('task-4', ALICE).ok).toBe(true);
    expect((await enter('task-4', 'blocked', root)).ok).toBe(true);
    await memberTerminalContainer('task-4', ALICE, async () => ({ name: 'lazymember-x', binary: 'docker', remove: async () => {} }), async () => true);
    const bound = await bindTurnCredential(root, { taskId: 'task-4', sessionId: 's', ownerUserId: 'bob@example.com', kind: 'api-key' });
    const plan = { mode: 'session' as const, token: bound.token, kind: 'api-key' as const, ownerUserId: 'bob@example.com', kindChanged: false };
    await expect(mustRecreateForCredentialPlan(root, 'task-4', plan)).resolves.toBeDefined();
    expect((await getTaskSessionBinding(root, 'task-4'))?.revokedAt).toBeNull();
    expect((membersInsideTask('task-4')[0] ?? null)).toBe(ALICE);
  });

  test('no launch path carries a member check any more', async () => {
    const mod = await import('../../src/daemon/turn-credentials');
    expect('refuseLaunchWhileMemberInside' in mod).toBe(false);
    expect('assertNoMemberInside' in mod).toBe(false);
  });
});

// INVARIANT: what REMOVES a member's files waits for them: a reject or close
// is refused while a member is in (naming them), unless the caller confirmed
// ending their sessions, and keeps members out while it runs.
describe('a reject or close while a member is inside', () => {
  test('is refused, naming the member', async () => {
    expect(claimMemberTerminal('task-9', ALICE).ok).toBe(true);
    await enter('task-9', 'blocked');
    const err = await beginWorktreeTeardown('task-9').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).status).toBe(409);
    expect((err as Error).message).toContain(ALICE);
    expect((err as Error).message).toContain('--end-sessions');
    expect((membersInsideTask('task-9')[0] ?? null)).toBe(ALICE);
  });

  test('confirmed, ends their sessions first and goes ahead', async () => {
    const removed: string[] = [];
    expect(claimMemberTerminal('task-9b', ALICE, async (c) => { removed.push(c?.name ?? 'none'); }).ok).toBe(true);
    await enter('task-9b', 'blocked');
    await memberTerminalContainer('task-9b', ALICE, async () => ({ name: 'lazymember-9b', binary: 'docker', remove: async () => {} }), async () => true);
    const release = await beginWorktreeTeardown('task-9b', { endSessions: true });
    expect(removed).toEqual(['lazymember-9b']);
    expect((membersInsideTask('task-9b')[0] ?? null)).toBeNull();
    // Members are kept out until the teardown has finished.
    expect(claimMemberTerminal('task-9b', ALICE).ok).toBe(true);
    expect(await enter('task-9b', 'blocked')).toMatchObject({ ok: false, status: 409 });
    release();
  });

  test('a confirmed teardown whose removal fails removes nothing and says so', async () => {
    expect(claimMemberTerminal('task-9c', ALICE, async () => { throw new Error('runtime is down'); }).ok).toBe(true);
    await enter('task-9c', 'blocked');
    await memberTerminalContainer('task-9c', ALICE, async () => ({ name: 'lazymember-9c', binary: 'docker', remove: async () => {} }), async () => true);
    const err = await beginWorktreeTeardown('task-9c', { endSessions: true }).then(() => null, (e: unknown) => e);
    expect((err as RpcError).status).toBe(503);
    expect((err as Error).message).toContain('runtime is down');
    expect((membersInsideTask('task-9c')[0] ?? null)).toBe(ALICE);
  });

  // INVARIANT: several members may be inside at once (engineer, 2026-10-21);
  // teardown waits for all of them, names them all, and a confirmed one ends
  // every member's sessions — one failed removal does not stop the others.
  test('with two members inside, is refused naming both', async () => {
    for (const who of [ALICE, BOB]) {
      expect(claimMemberTerminal('task-13', who).ok).toBe(true);
      await enterTaskAsMember({ projectRoot: '/p', storage: fakeStorage({ id: 'task-13', status: 'blocked' }), taskId: 'task-13', email: who });
    }
    const err = await beginWorktreeTeardown('task-13').then(() => null, (e: unknown) => e);
    expect((err as RpcError).status).toBe(409);
    expect((err as Error).message).toContain(`${ALICE} and ${BOB} have`);
  });

  test('confirmed with two members, ends both; a failing one is reported and stays', async () => {
    const removed: string[] = [];
    const setup = async (who: string, vacate: () => Promise<void>) => {
      expect(claimMemberTerminal('task-14', who, vacate).ok).toBe(true);
      await enterTaskAsMember({ projectRoot: '/p', storage: fakeStorage({ id: 'task-14', status: 'blocked' }), taskId: 'task-14', email: who });
      await memberTerminalContainer('task-14', who, async () => ({ name: `c-${who}`, binary: 'docker', remove: async () => {} }), async () => true);
    };
    await setup(ALICE, async () => { throw new Error('runtime is down'); });
    await setup(BOB, async () => { removed.push(BOB); });
    const err = await beginWorktreeTeardown('task-14', { endSessions: true }).then(() => null, (e: unknown) => e);
    expect((err as RpcError).status).toBe(503);
    expect((err as Error).message).toContain('runtime is down');
    expect(removed).toEqual([BOB]);
    expect(membersInsideTask('task-14')).toEqual([ALICE]);
  });

  test('keeps members out while it runs', async () => {
    const release = await beginWorktreeTeardown('task-10');
    expect(claimMemberTerminal('task-10', ALICE).ok).toBe(true);
    expect(await enter('task-10', 'blocked')).toMatchObject({ ok: false, status: 409 });
    release();
    expect((await enter('task-10', 'blocked')).ok).toBe(true);
  });
});

// INVARIANT: a member's entry never stops the task's own container (engineer's
// decision on raised item f1219a6f, 2026-10-05, replacing "the entry stops it").
// That container holds the task's SHARED services, which every member sees and
// controls and which must keep running while members work. Everything in it is
// suspect and contained; the boundary that matters (container -> daemon/host)
// is enforced by read-only git mounts and pointer validation, not by stopping it.
describe("the task's own container on a member's entry", () => {
  test('is left running: the entry never asks the runtime to stop anything', async () => {
    const runnerModule = await import('../../src/runner');
    const { spyOn } = await import('bun:test');
    const calls: string[] = [];
    const spy = spyOn(runnerModule, 'createRunner').mockResolvedValue({
      usesSandbox: () => true,
      runNameForTask: (ref: string) => `lazy-${ref}`,
      isRunning: async () => true,
      stopRun: async (n: string) => { calls.push(`stop:${n}`); return true; },
      removeRun: async (n: string) => { calls.push(`remove:${n}`); },
    } as never);
    try {
      expect(claimMemberTerminal('task-12', ALICE).ok).toBe(true);
      const entered = await enterTaskAsMember({
        projectRoot: '/p', storage: fakeStorage({ id: 'task-12', status: 'blocked' }), taskId: 'task-12', email: ALICE,
      });
      expect(entered.ok).toBe(true);
      expect((membersInsideTask('task-12')[0] ?? null)).toBe(ALICE);
      expect(calls).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  test('the entry module no longer carries a stop at all', async () => {
    const mod = await import('../../src/daemon/member-entry');
    expect('stopTaskContainerForMember' in mod).toBe(false);
  });
});

// INVARIANT: claims on a worktree overlap (two children accepted into one
// parent, or a close beside an accept), and members stay out until the LAST
// one is released — the first to finish must not let them in under the other.
test('overlapping worktree claims keep members out until the last is released', async () => {
  const { beginWorktreeTeardown } = await import('../../src/daemon/member-entry');
  const enter = () => enterTaskAsMember({
    projectRoot: '/p', storage: fakeStorage({ id: 'task-15', status: 'blocked' }), taskId: 'task-15', email: ALICE,
  });
  const first = await beginWorktreeTeardown('task-15');
  const second = await beginWorktreeTeardown('task-15');
  first();
  first();
  expect(claimMemberTerminal('task-15', ALICE).ok).toBe(true);
  expect(await enter()).toMatchObject({ ok: false, status: 409 });
  releaseMemberTerminal('task-15', ALICE);
  second();
  expect(claimMemberTerminal('task-15', ALICE).ok).toBe(true);
  expect((await enter()).ok).toBe(true);
});

// INVARIANT: bringing the task's own container up without a turn
// (ensureTaskContainer — Start container, Start services) works while a member
// is inside (engineer, 2026-10-05: services are shared and keep running beside
// members), and never holds the task's lifecycle lock across the bring-up, so
// turn launches, accepts and syncs are not queued behind an image build.
describe("a container bring-up and a member's entry", () => {
  test('ensureTaskContainer neither consults the member hold nor holds the lifecycle lock', async () => {
    const { readFile } = await import('fs/promises');
    const src = await readFile(join(import.meta.dir, '../../src/daemon/task-container.ts'), 'utf-8');
    expect(src).not.toMatch(/membersInsideTask|memberNamesInsideTask|memberTerminalHolders|beginTaskContainerBringUp/);
    expect(src).not.toMatch(/withTaskLifecycleLock\(/);
  });
});

