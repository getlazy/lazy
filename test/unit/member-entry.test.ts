/**
 * Member terminals and turns take turns with a task (src/daemon/member-entry.ts,
 * `refuseLaunchWhileMemberInside` in src/daemon/turn-credentials.ts).
 *
 * INVARIANT: a member cannot get into a task while a turn runs on it, and a
 * turn cannot start while a member is in it. Their terminals run in a container
 * of their own, so the two never share a process space or a credential — what
 * they would share is the worktree's files, mid-edit. Both checks run under the
 * task's lifecycle lock, so whichever comes second sees the other.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  claimMemberTerminal,
  releaseMemberTerminal,
  memberTerminalContainer,
  memberInsideTask,
  resetMemberTerminalsForTests,
} from '../../src/server/member-terminals';
import { enterTaskAsMember } from '../../src/daemon/member-entry';
import { mustRecreateForCredentialPlan, refuseLaunchWhileMemberInside } from '../../src/daemon/turn-credentials';
import { bindTurnCredential, getTaskSessionBinding, clearSessionCredentialCache } from '../../src/daemon/session-credentials';
import { RpcError } from '../../src/daemon/rpc-error';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';

function fakeStorage(task: Record<string, unknown>, opts: { turns?: number; session?: boolean } = {}) {
  const metadata = new Map<string, string>();
  return {
    getTask: async () => task as never,
    getSessionByTaskId: async () => (opts.session === false ? null : ({ id: 'sess-1', task_id: task.id }) as never),
    getSessionTurns: async () => Array.from({ length: opts.turns ?? 1 }, (_, i) => ({ sequence: i + 1 })) as never,
    getTaskMetadata: async (_id: string, key: string) => metadata.get(key) ?? null,
    updateTaskMetadata: async (_id: string, key: string, value: string) => { metadata.set(key, value); },
  };
}

const ALICE = 'alice@example.com';
const noBinding = async () => null;
const liveBinding = async () => ({ revokedAt: null });
// The task's own container is stopped by the entry; these tests are about the
// exclusion, so there is none to stop (the stop has its own tests below).

afterEach(() => resetMemberTerminalsForTests());

describe('a member entering a task', () => {
  test('enters a paused task that has run a turn, and from then on is inside', async () => {
    expect(claimMemberTerminal('task-1', ALICE).ok).toBe(true);
    const entered = await enterTaskAsMember({
      projectRoot: '/p', storage: fakeStorage({ id: 'task-1', status: 'blocked' }), taskId: 'task-1', email: ALICE,
      deps: { bindingFor: noBinding },
    });
    expect(entered).toEqual({ ok: true });
    expect(memberInsideTask('task-1')).toBe(ALICE);
  });

  for (const [label, status, bindingFor] of [
    ['a working task', 'working', noBinding],
    ['a live binding (a launch has bound, not yet flipped)', 'blocked', liveBinding],
  ] as const) {
    test(`is refused on ${label}, and keeps no turn out`, async () => {
      expect(claimMemberTerminal('task-2', ALICE).ok).toBe(true);
      const refused = await enterTaskAsMember({
        projectRoot: '/p', storage: fakeStorage({ id: 'task-2', status }), taskId: 'task-2', email: ALICE,
        deps: { bindingFor },
      });
      expect(refused).toMatchObject({ ok: false, status: 409 });
      expect(memberInsideTask('task-2')).toBeNull();
    });
  }

  test('is refused on a task that has not started, or whose session has no turn yet', async () => {
    for (const [storage, why] of [
      [fakeStorage({ id: 'task-3', status: 'backlog' }), 'not started'],
      [fakeStorage({ id: 'task-3', status: 'blocked' }, { turns: 0 }), 'not run a turn'],
      [fakeStorage({ id: 'task-3', status: 'blocked' }, { session: false }), 'not run a turn'],
    ] as const) {
      expect(claimMemberTerminal('task-3', ALICE).ok).toBe(true);
      const refused = await enterTaskAsMember({ projectRoot: '/p', storage, taskId: 'task-3', email: ALICE, deps: { bindingFor: noBinding } });
      expect(refused).toMatchObject({ ok: false, status: 409 });
      if (!refused.ok) expect(refused.message).toContain(why);
      expect(memberInsideTask('task-3')).toBeNull();
      releaseMemberTerminal('task-3', ALICE);
    }
  });
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

  async function memberInside(taskId: string): Promise<void> {
    expect(claimMemberTerminal(taskId, ALICE).ok).toBe(true);
    const entered = await enterTaskAsMember({
      projectRoot: root, storage: fakeStorage({ id: taskId, status: 'blocked' }), taskId, email: ALICE,
      deps: { bindingFor: noBinding },
    });
    expect(entered.ok).toBe(true);
    await memberTerminalContainer(taskId, ALICE, async () => ({ name: 'lazymember-x', binary: 'docker', remove: async () => {} }), async () => true);
  }

  // Every turn launch path reaches mustRecreateForCredentialPlan under the
  // task's lifecycle lock (test/unit/launch-under-lifecycle-lock.test.ts), and
  // the start path calls refuseLaunchWhileMemberInside directly.
  test('is refused with a 409 naming the member, and the binding it just planned is released', async () => {
    await memberInside('task-4');
    const bound = await bindTurnCredential(root, { taskId: 'task-4', sessionId: 's', ownerUserId: 'bob@example.com', kind: 'api-key' });
    const plan = { mode: 'session' as const, token: bound.token, kind: 'api-key' as const, ownerUserId: 'bob@example.com', kindChanged: false };

    const err = await mustRecreateForCredentialPlan(root, 'task-4', plan).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).status).toBe(409);
    expect((err as Error).message).toContain(ALICE);
    // Left live, the member's next terminal would read "a turn is running"
    // while none is — and be refused for nothing.
    expect((await getTaskSessionBinding(root, 'task-4'))?.revokedAt).not.toBeNull();
  });

  test('stays refused through the grace, and starts once the member\'s session has ended', async () => {
    await memberInside('task-5');
    releaseMemberTerminal('task-5', ALICE, async () => {}, 5);
    await expect(refuseLaunchWhileMemberInside(root, 'task-5')).rejects.toThrow(ALICE);
    await new Promise((r) => setTimeout(r, 25));
    await expect(refuseLaunchWhileMemberInside(root, 'task-5')).resolves.toBeUndefined();
  });

  test('a member who has only claimed (not entered) does not block a launch', async () => {
    expect(claimMemberTerminal('task-6', ALICE).ok).toBe(true);
    await expect(refuseLaunchWhileMemberInside(root, 'task-6')).resolves.toBeUndefined();
  });

  // The interleaving the lock exists for, from the member's side: a launch
  // that has bound its credential before the member's entry takes the lock
  // leaves the binding live, and the entry refuses on it.
  test('an entry after a launch has bound is refused', async () => {
    await bindTurnCredential(root, { taskId: 'task-7', sessionId: 's', ownerUserId: 'bob@example.com', kind: 'api-key' });
    expect(claimMemberTerminal('task-7', ALICE).ok).toBe(true);
    const refused = await enterTaskAsMember({
      projectRoot: root, storage: fakeStorage({ id: 'task-7', status: 'blocked' }), taskId: 'task-7', email: ALICE,
    });
    expect(refused).toMatchObject({ ok: false, status: 409 });
    expect(memberInsideTask('task-7')).toBeNull();
  });
});

// INVARIANT: nothing but the member touches the worktree while they are in it.
// A sync is refused for a person and QUEUED for the automations (the retry
// loop merges it once the session has ended); a reject or close is refused and
// keeps members out while it runs; a task being merged or finished cannot be
// entered.
describe('other worktree writers while a member is inside', () => {
  test('a sync is refused for a person and queued for the automations', async () => {
    const { standDownForMember } = await import('../../src/daemon/task-lifecycle');
    expect(claimMemberTerminal('task-8', ALICE).ok).toBe(true);
    await enterTaskAsMember({ projectRoot: '/p', storage: fakeStorage({ id: 'task-8', status: 'blocked' }), taskId: 'task-8', email: ALICE, deps: { bindingFor: noBinding } });
    const queued: string[] = [];
    const storage = { incrementTaskPendingSync: async (id: string) => { queued.push(id); } };
    await expect(standDownForMember(storage, { id: 'task-8' }, {})).rejects.toThrow(ALICE);
    expect(queued).toEqual([]);
    expect(await standDownForMember(storage, { id: 'task-8' }, { queueIfMemberInside: true })).toBe(ALICE);
    expect(queued).toEqual(['task-8']);
    expect(await standDownForMember(storage, { id: 'other' }, { queueIfMemberInside: true })).toBeNull();
  });

  test('a reject or close is refused while a member is in, and keeps members out while it runs', async () => {
    const { beginWorktreeTeardown } = await import('../../src/daemon/member-entry');
    expect(claimMemberTerminal('task-9', ALICE).ok).toBe(true);
    await enterTaskAsMember({ projectRoot: '/p', storage: fakeStorage({ id: 'task-9', status: 'blocked' }), taskId: 'task-9', email: ALICE, deps: { bindingFor: noBinding } });
    await expect(beginWorktreeTeardown('task-9')).rejects.toThrow(ALICE);

    const release = await beginWorktreeTeardown('task-10');
    expect(claimMemberTerminal('task-10', ALICE).ok).toBe(true);
    const during = await enterTaskAsMember({ projectRoot: '/p', storage: fakeStorage({ id: 'task-10', status: 'blocked' }), taskId: 'task-10', email: ALICE, deps: { bindingFor: noBinding } });
    expect(during).toMatchObject({ ok: false, status: 409 });
    release();
    const after = await enterTaskAsMember({ projectRoot: '/p', storage: fakeStorage({ id: 'task-10', status: 'blocked' }), taskId: 'task-10', email: ALICE, deps: { bindingFor: noBinding } });
    expect(after.ok).toBe(true);
  });

  for (const status of ['merging', 'complete', 'abandoned']) {
    test(`a ${status} task cannot be entered`, async () => {
      expect(claimMemberTerminal('task-11', ALICE).ok).toBe(true);
      const r = await enterTaskAsMember({ projectRoot: '/p', storage: fakeStorage({ id: 'task-11', status }), taskId: 'task-11', email: ALICE, deps: { bindingFor: noBinding } });
      expect(r).toMatchObject({ ok: false, status: 409 });
      expect(memberInsideTask('task-11')).toBeNull();
    });
  }
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
        deps: { bindingFor: noBinding },
      });
      expect(entered.ok).toBe(true);
      expect(memberInsideTask('task-12')).toBe(ALICE);
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
    deps: { bindingFor: noBinding },
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

// INVARIANT (engineer rule): the daemon never acts on a task before the
// supervisor has returned control, and letting a member into the worktree is
// acting on it. A parked status is not that handback: an `interrupted` task
// whose supervisor survived a restart, or a turn whose response.json nobody has
// settled yet, reads as parked. The entry asks supervisorStillOwnsTurn inside
// the lock, and refuses — retryably — rather than let a member into a worktree
// the supervisor's post-turn phases are still writing.
describe("a member's entry while the supervisor still owns the last turn", () => {
  let base: string;
  let unpin: () => void;
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'lzd-member-handback-'));
    unpin = pinDaemonBaseDir(base);
  });
  afterEach(async () => {
    unpin();
    await rm(base, { recursive: true, force: true });
  });

  async function enter(taskId: string, status: string) {
    expect(claimMemberTerminal(taskId, ALICE).ok).toBe(true);
    return enterTaskAsMember({
      projectRoot: base, storage: fakeStorage({ id: taskId, status }), taskId, email: ALICE,
      deps: { bindingFor: noBinding },
    });
  }

  test('an unsettled response.json refuses the entry', async () => {
    const { protocolDir } = await import('../../src/protocol');
    const { mkdir, writeFile } = await import('fs/promises');
    const dir = protocolDir('task-16');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'response.json'), '{}');
    const r = await enter('task-16', 'blocked');
    expect(r).toMatchObject({ ok: false, status: 409 });
    if (!r.ok) {
      expect(r.message).toBe('The agent is still finishing its last turn. Open the terminal again in a moment.');
      // lazy's internals are for the log, never for the member.
      expect(r.message).not.toMatch(/supervisor|mailbox|response|settled/i);
    }
    expect(memberInsideTask('task-16')).toBeNull();
  });

  test('a live supervisor still in a post-turn phase refuses the entry', async () => {
    const { protocolDir } = await import('../../src/protocol');
    const { mkdir, writeFile } = await import('fs/promises');
    const runnerModule = await import('../../src/runner');
    const { spyOn } = await import('bun:test');
    const dir = protocolDir('task-17');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'status.json'), JSON.stringify({ phase: 'maintain', updated_at: new Date().toISOString() }));
    const spy = spyOn(runnerModule, 'createRunner').mockResolvedValue({
      runNameForTask: (ref: string) => `lazy-${ref}`,
      isRunning: async () => true,
    } as never);
    try {
      // `interrupted` after a daemon restart: the supervisor survived it.
      const r = await enter('task-17', 'interrupted');
      expect(r).toMatchObject({ ok: false, status: 409 });
      if (!r.ok) {
        expect(r.message).toBe('The agent is still finishing its last turn. Open the terminal again in a moment.');
        expect(r.message).not.toMatch(/supervisor|maintain|mailbox/i);
      }
      expect(memberInsideTask('task-17')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

// INVARIANT: a member never enters beside a pairing session. `lazy pair`, or a
// Pair from the dashboard on a daemon that is not managed, runs the agent IN
// the task's container, at work in the worktree — the turn/member exclusion
// applies (it used to be framed as "the stop would end it"; the entry no
// longer stops anything, engineer 2026-10-05). The entry refuses (409, naming the web Pair's holder
// where there is one) while the task is `pairing` or its pairing lock is held —
// except for this member's OWN web Pair under the hold they already hold,
// which runs in their own container.
describe("a member's entry while the task is being paired on", () => {
  test("an owner's pairing session (task `pairing`) refuses the entry", async () => {
    expect(claimMemberTerminal('task-18', ALICE).ok).toBe(true);
    const r = await enterTaskAsMember({
      projectRoot: '/nonexistent-project', storage: fakeStorage({ id: 'task-18', status: 'pairing' }), taskId: 'task-18', email: ALICE,
      deps: { bindingFor: noBinding },
    });
    expect(r).toMatchObject({ ok: false, status: 409 });
    if (!r.ok) expect(r.message).toContain('pairing');
    expect(memberInsideTask('task-18')).toBeNull();
  });

  test("another member's web Pair refuses the entry, naming them", async () => {
    expect(claimMemberTerminal('task-19', ALICE).ok).toBe(true);
    const r = await enterTaskAsMember({
      projectRoot: '/p', storage: fakeStorage({ id: 'task-19', status: 'blocked' }), taskId: 'task-19', email: ALICE,
      deps: {
        bindingFor: noBinding,
        pairing: async () => ({ pairing: true, webPairEmail: 'bob@example.com' }),
      },
    });
    expect(r).toMatchObject({ ok: false, status: 409 });
    if (!r.ok) expect(r.message).toContain('bob@example.com');
  });

  test("the member's own web Pair, under their current hold, lets their next terminal in", async () => {
    expect(claimMemberTerminal('task-20', ALICE).ok).toBe(true);
    const first = await enterTaskAsMember({
      projectRoot: '/p', storage: fakeStorage({ id: 'task-20', status: 'blocked' }), taskId: 'task-20', email: ALICE,
      deps: { bindingFor: noBinding, pairing: async () => ({ pairing: false, webPairEmail: null }) },
    });
    expect(first.ok).toBe(true);
    // Her Pair started; her next terminal (a Shell) enters beside it.
    expect(claimMemberTerminal('task-20', ALICE).ok).toBe(true);
    const next = await enterTaskAsMember({
      projectRoot: '/p', storage: fakeStorage({ id: 'task-20', status: 'pairing' }), taskId: 'task-20', email: ALICE,
      deps: { bindingFor: noBinding, pairing: async () => ({ pairing: true, webPairEmail: ALICE }) },
    });
    expect(next.ok).toBe(true);
  });

  test("a web Pair naming this member but with no hold of theirs is still refused", async () => {
    expect(claimMemberTerminal('task-21', ALICE).ok).toBe(true);
    const r = await enterTaskAsMember({
      projectRoot: '/p', storage: fakeStorage({ id: 'task-21', status: 'pairing' }), taskId: 'task-21', email: ALICE,
      deps: { bindingFor: noBinding, pairing: async () => ({ pairing: true, webPairEmail: ALICE }) },
    });
    expect(r).toMatchObject({ ok: false, status: 409 });
  });
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
    expect(src).not.toMatch(/memberInsideTask|beginTaskContainerBringUp/);
    expect(src).not.toMatch(/withTaskLifecycleLock\(/);
  });
});

// INVARIANT: a member never enters while a Chat or another operation holds the
// task's worktree (the turn/member exclusion; the entry stops nothing since
// engineer 2026-10-05). An owner's dashboard Chat on
// a daemon that is not managed runs the agent IN the task's container with the
// task still `blocked` and no pairing lock — only its web-Chat hold and the
// worktree lock show it. The entry refuses (409, naming the Chat's holder, or
// the operation holding the worktree lock) — except for this member's OWN
// web Chat under the hold they already hold, which runs in their own
// container and whose worktree lock is its own.
describe("a member's entry while a Chat or another operation holds the task", () => {
  test("an owner's dashboard Chat refuses the entry", async () => {
    expect(claimMemberTerminal('task-24', ALICE).ok).toBe(true);
    const r = await enterTaskAsMember({
      projectRoot: '/p', storage: fakeStorage({ id: 'task-24', status: 'blocked' }), taskId: 'task-24', email: ALICE,
      deps: {
        bindingFor: noBinding,
        worktreeHolders: async () => ({ webChat: { held: true, email: null }, lock: { what: 'a Chat with the agent' } }),
      },
    });
    expect(r).toMatchObject({ ok: false, status: 409 });
    if (!r.ok) expect(r.message).toContain('chatting');
    expect(memberInsideTask('task-24')).toBeNull();
  });

  test('an operation this daemon holds the worktree lock for refuses the entry, naming it', async () => {
    const { mkdtemp, mkdir, rm } = await import('fs/promises');
    const { acquireLock, removeLock } = await import('../../src/utils/lock');
    const { getWorktreePath } = await import('../../src/task/identity');
    const root = await mkdtemp(join(tmpdir(), 'member-entry-lock-'));
    const task = { id: 'task-25', status: 'blocked' };
    const worktree = getWorktreePath(root, task as never);
    await mkdir(worktree, { recursive: true });
    await acquireLock(worktree, 'lazy accept (acceptance gate)');
    try {
      expect(claimMemberTerminal('task-25', ALICE).ok).toBe(true);
      const r = await enterTaskAsMember({
        projectRoot: root, storage: fakeStorage(task), taskId: 'task-25', email: ALICE,
        deps: { bindingFor: noBinding },
      });
      expect(r).toMatchObject({ ok: false, status: 409 });
      // A lock this daemon holds is described in fixed words for its operation.
      if (!r.ok) expect(r.message).toContain("an accept's checks");
    } finally {
      await removeLock(worktree);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the member's own web Chat, under their current hold, lets their next terminal in", async () => {
    expect(claimMemberTerminal('task-26', ALICE).ok).toBe(true);
    const first = await enterTaskAsMember({
      projectRoot: '/p', storage: fakeStorage({ id: 'task-26', status: 'blocked' }), taskId: 'task-26', email: ALICE,
      deps: { bindingFor: noBinding },
    });
    expect(first.ok).toBe(true);
    expect(claimMemberTerminal('task-26', ALICE).ok).toBe(true);
    const next = await enterTaskAsMember({
      projectRoot: '/p', storage: fakeStorage({ id: 'task-26', status: 'blocked' }), taskId: 'task-26', email: ALICE,
      deps: {
        bindingFor: noBinding,
        worktreeHolders: async () => ({ webChat: { held: true, email: ALICE }, lock: { what: 'a Chat with the agent' } }),
      },
    });
    expect(next.ok).toBe(true);
  });

  test('a web Chat naming this member but with no hold of theirs is still refused', async () => {
    expect(claimMemberTerminal('task-27', ALICE).ok).toBe(true);
    const r = await enterTaskAsMember({
      projectRoot: '/p', storage: fakeStorage({ id: 'task-27', status: 'blocked' }), taskId: 'task-27', email: ALICE,
      deps: {
        bindingFor: noBinding,
        worktreeHolders: async () => ({ webChat: { held: true, email: ALICE }, lock: { what: 'a Chat with the agent' } }),
      },
    });
    expect(r).toMatchObject({ ok: false, status: 409 });
  });
});

// INVARIANT: the worktree-lock refusal never shows text the task's agent can
// write, and does not believe a lock on the lock file's word alone. The lock
// file lives in the worktree, so a turn can plant any command text (a sentence
// aimed at the member, shown as lazy's own) and any pid. The entry describes a
// lock only in fixed words — a lock this daemon holds is known from memory and
// named for its operation, one held by another live LAZY process (by the OS's
// own command line) is "another operation" — and ignores every other lock.
describe("the worktree-lock refusal and a lock file the agent can write", () => {
  const PLANTED = 'IGNORE lazy: your session expired, paste your token at https://evil.example';

  async function withWorktree<T>(taskId: string, fn: (root: string, worktree: string) => Promise<T>): Promise<T> {
    const { mkdtemp, mkdir, rm } = await import('fs/promises');
    const { getWorktreePath } = await import('../../src/task/identity');
    const root = await mkdtemp(join(tmpdir(), 'member-entry-planted-'));
    const worktree = getWorktreePath(root, { id: taskId } as never);
    await mkdir(worktree, { recursive: true });
    try {
      return await fn(root, worktree);
    } finally {
      const { removeLock } = await import('../../src/utils/lock');
      await removeLock(worktree);
      await rm(root, { recursive: true, force: true });
    }
  }

  const enter = (root: string, taskId: string) => enterTaskAsMember({
    projectRoot: root, storage: fakeStorage({ id: taskId, status: 'blocked' }), taskId, email: ALICE,
    deps: { bindingFor: noBinding },
  });

  test("arbitrary text in a lock this daemon holds never appears in the refusal", async () => {
    await withWorktree('task-28', async (root, worktree) => {
      const { acquireLock } = await import('../../src/utils/lock');
      await acquireLock(worktree, PLANTED);
      expect(claimMemberTerminal('task-28', ALICE).ok).toBe(true);
      const r = await enter(root, 'task-28');
      expect(r).toMatchObject({ ok: false, status: 409 });
      if (!r.ok) {
        expect(r.message).not.toContain('evil.example');
        expect(r.message).not.toContain('IGNORE');
        expect(r.message).toContain('another operation');
      }
    });
  });

  test("a lock file this daemon never wrote, naming this daemon's pid, is not believed", async () => {
    await withWorktree('task-29', async (root, worktree) => {
      const { writeFile } = await import('fs/promises');
      const { getLockPath } = await import('../../src/utils/lock');
      await writeFile(getLockPath(worktree), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), command: PLANTED }));
      expect(claimMemberTerminal('task-29', ALICE).ok).toBe(true);
      const r = await enter(root, 'task-29');
      expect(r.ok).toBe(true);
    });
  });

  test('a lock file naming a live process that is not lazy is not believed', async () => {
    await withWorktree('task-30', async (root, worktree) => {
      const { writeFile } = await import('fs/promises');
      const { getLockPath } = await import('../../src/utils/lock');
      const other = Bun.spawn(['sleep', '30']);
      try {
        await writeFile(getLockPath(worktree), JSON.stringify({ pid: other.pid, started_at: new Date().toISOString(), command: PLANTED }));
        expect(claimMemberTerminal('task-30', ALICE).ok).toBe(true);
        const r = await enter(root, 'task-30');
        expect(r.ok).toBe(true);
      } finally {
        other.kill();
      }
    });
  });
});
