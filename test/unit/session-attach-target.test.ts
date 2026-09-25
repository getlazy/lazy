import { describe, test, expect } from 'bun:test';
import { resolveSessionAttachTarget, taskModeRefusals } from '../../src/daemon/session-attach';
import { createSessionAttachUpgrader } from '../../src/server/session-attach-ws';
import { resetMemberTerminalsForTests, markMemberTerminalEntered } from '../../src/server/member-terminals';
import type { BuilderSession } from '../../src/storage/types';
import type { Session, Task } from '../../src/types';
import type { Storage } from '../../src/storage';
import type { Server } from 'bun';

/**
 * INVARIANT: the session attach route can only ever reach the container the
 * SESSION RECORD names, and only for the session's own member.
 *
 * This is the analogue of test/unit/shell-target.test.ts, and it is the test
 * that makes `/rpc/sessions/:id/attach/ws` safe to expose beyond the dashboard:
 * a client passes a session id and nothing else. No query parameter, header or
 * path segment can steer the exec at another session's container, the host, or
 * a container a tampered row names — and on a shared daemon a member presenting
 * another member's session id gets a 403, never a terminal.
 */

const ROOT = '/projects/demo';

function builderRow(overrides: Partial<BuilderSession>): BuilderSession {
  return {
    id: 'bs-alice',
    projectRoot: ROOT,
    memberEmail: 'alice@example.com',
    kind: 'interactive',
    state: 'running',
    containerName: 'lazy-builder-aaaa1111',
    builderId: 'aaaa1111',
    agentSessionId: null,
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    endedAt: null,
    ...overrides,
  };
}

const ALICE = builderRow({});
const BOB = builderRow({
  id: 'bs-bob',
  memberEmail: 'bob@example.com',
  containerName: 'lazy-builder-bbbb2222',
  builderId: 'bbbb2222',
});
const TAMPERED = builderRow({ id: 'bs-tampered', containerName: BOB.containerName });
const OTHER_PROJECT = builderRow({ id: 'bs-elsewhere', projectRoot: '/projects/other' });

const TASK = { id: 'task-1', runner_type: 'docker', metadata: { task_ref: 'some-task' } } as unknown as Task;
const TASK_SESSION = { id: 'sess-task-1', task_id: 'task-1', container_name: null, runner_type: 'docker' } as unknown as Session;

const STALE_TASK_SESSION = { ...TASK_SESSION, id: 'sess-task-1-old', container_name: 'lazy-run-some-task-old' } as unknown as Session;

function fakeStorage(): Pick<Storage, 'getBuilderSession' | 'getSession' | 'getTask' | 'getSessionByTaskId' | 'getSessionTurns'> {
  const rows = new Map([ALICE, BOB, TAMPERED, OTHER_PROJECT].map((r) => [r.id, r]));
  return {
    getBuilderSession: async (id: string) => rows.get(id) ?? null,
    getSession: async (id: string) =>
      id === TASK_SESSION.id ? TASK_SESSION : id === STALE_TASK_SESSION.id ? STALE_TASK_SESSION : null,
    getSessionByTaskId: async (taskId: string) => (taskId === TASK.id ? TASK_SESSION : null),
    getTask: async (id: string) => (id === TASK.id ? TASK : null),
    getSessionTurns: async (id: string) => (id === TASK_SESSION.id ? [{ sequence: 1 }] : []),
  } as never;
}

const dockerRunner = async () => ({
  type: 'docker' as const,
  usesSandbox: () => true,
  runNameForTask: (ref: string) => `lazy-run-${ref}`,
});

async function resolve(sessionId: string, callerEmail: string | null, multiMember = true) {
  return resolveSessionAttachTarget({
    projectRoot: ROOT,
    storage: fakeStorage(),
    sessionId,
    callerEmail,
    multiMember,
    bindingFor: async () => null,
    runnerFor: dockerRunner,
  });
}

describe('resolveSessionAttachTarget (attach exec target)', () => {
  test('a member reaches exactly the container their own session row names', async () => {
    const r = await resolve('bs-alice', 'alice@example.com');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.target.kind).toBe('builder');
      expect(r.target.container).toBe('lazy-builder-aaaa1111');
    }
  });

  test("a member presenting another member's session id is a 403", async () => {
    const r = await resolve('bs-bob', 'alice@example.com');
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  test('on a shared daemon a credential naming nobody (a control token) owns no session', async () => {
    const r = await resolve('bs-alice', null);
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  test("a row naming another launch's container is refused, not attached to", async () => {
    const r = await resolve('bs-tampered', 'alice@example.com');
    expect(r).toMatchObject({ ok: false, status: 409 });
  });

  test("another project's session is not found here", async () => {
    const r = await resolve('bs-elsewhere', 'alice@example.com');
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  test('a session that is not running is refused rather than relaunched', async () => {
    const stopped = builderRow({ state: 'stopped', containerName: null });
    const r = await resolveSessionAttachTarget({
      projectRoot: ROOT,
      storage: { ...fakeStorage(), getBuilderSession: async () => stopped } as never,
      sessionId: stopped.id,
      callerEmail: 'alice@example.com',
      multiMember: true,
      runnerFor: dockerRunner,
    });
    expect(r).toMatchObject({ ok: false, status: 409 });
  });

  // INVARIANT: ownership holds wherever another member CAN exist — managed
  // mode counts even with no member credential stored (team mode off).
  test('a managed daemon enforces ownership even when team mode is off', async () => {
    const prev = process.env.LAZY_TEST_FORCE_MANAGED;
    process.env.LAZY_TEST_FORCE_MANAGED = '1';
    try {
      const { multiMemberDaemon } = await import('../../src/daemon/session-attach');
      expect(await multiMemberDaemon('/nonexistent-project-root')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.LAZY_TEST_FORCE_MANAGED;
      else process.env.LAZY_TEST_FORCE_MANAGED = prev;
    }
  });

  test('on a single-person install the one caller is the owner', async () => {
    const r = await resolve('bs-bob', null, false);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.target.container).toBe('lazy-builder-bbbb2222');
  });

  // INVARIANT: on a shared daemon a task session is entered AS A MEMBER — a
  // named member resolves the task session (the route then runs their
  // terminal in a container of their own, never this one: see "a member's
  // terminal on a shared daemon" below), while a credential naming nobody is
  // refused: there would be nobody to bill or name.
  // (Replaces the earlier "refused on every shared daemon" rule, which was
  // recorded as provisional until per-member attach existed.)
  test('on a shared daemon a named member reaches the task session', async () => {
    const r = await resolve('sess-task-1', 'alice@example.com');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.target.container).toBe('lazy-run-some-task');
  });

  // INVARIANT: a task that has not run a turn has no environment to open; the
  // entry refuses it under the lock, and discovery says so first, so a
  // client (the bound-clone CLI, the Teams page) reads it before any socket.
  test('on a shared daemon a task that has not run a turn is refused up front', async () => {
    const r = await resolveSessionAttachTarget({
      projectRoot: ROOT,
      storage: { ...fakeStorage(), getSessionTurns: async () => [] } as never,
      sessionId: TASK_SESSION.id, callerEmail: 'alice@example.com', multiMember: true,
      bindingFor: async () => null, runnerFor: dockerRunner,
    });
    expect(r).toMatchObject({ ok: false, status: 409 });
    if (!r.ok) expect(r.message).toContain('has not run a turn yet');
  });

  test('on a shared daemon a task session is refused to a credential naming nobody', async () => {
    const r = await resolve('sess-task-1', null);
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  // INVARIANT: while a turn is RUNNING nobody opens a terminal on the task on
  // a shared daemon — not even that turn's own member. Member terminals and
  // turns take turns with the worktree (src/daemon/member-entry.ts); this is
  // the early answer, the entry re-checks under the lifecycle lock. Running =
  // the binding is live, or the task is working.
  describe('a running turn keeps every member out', () => {
    const as = (
      callerEmail: string,
      binding: { ownerUserId: string; revokedAt: number | null } | null,
      opts: { multiMember?: boolean; status?: string } = {},
    ) => resolveSessionAttachTarget({
      projectRoot: ROOT,
      storage: { ...fakeStorage(), getTask: async () => ({ ...TASK, status: opts.status ?? 'blocked' }) } as never,
      sessionId: TASK_SESSION.id, callerEmail, multiMember: opts.multiMember ?? true,
      runnerFor: dockerRunner, bindingFor: async () => binding,
    });

    test("a live placeholder naming another member is a 409", async () => {
      expect(await as('alice@example.com', { ownerUserId: 'bob@example.com', revokedAt: null }))
        .toMatchObject({ ok: false, status: 409 });
    });

    test("a live placeholder of the service credential is a 409", async () => {
      expect(await as('alice@example.com', { ownerUserId: '__service__', revokedAt: null }))
        .toMatchObject({ ok: false, status: 409 });
    });

    test("the live placeholder's own member is refused too", async () => {
      expect(await as('bob@example.com', { ownerUserId: 'bob@example.com', revokedAt: null }))
        .toMatchObject({ ok: false, status: 409 });
    });

    test('a working task with no binding (the daemon-env mode) is refused', async () => {
      expect(await as('alice@example.com', null, { status: 'working' })).toMatchObject({ ok: false, status: 409 });
    });

    test('between turns a member is let through to the entry step', async () => {
      expect((await as('alice@example.com', { ownerUserId: 'bob@example.com', revokedAt: 1 })).ok).toBe(true);
    });

    test('a single-person daemon has no other member to protect', async () => {
      expect((await as('alice@example.com', { ownerUserId: 'bob@example.com', revokedAt: null }, { multiMember: false })).ok).toBe(true);
    });
  });

  // INVARIANT: only the task's CURRENT session is attachable — a superseded
  // one would plan pair/chat against a stale container or agent session.
  test("a task's superseded session is refused with a 409 naming the current one", async () => {
    const r = await resolve('sess-task-1-old', null, false);
    expect(r).toMatchObject({ ok: false, status: 409 });
    if (!r.ok) expect(r.message).toContain('sess-task-1');
  });

  test("locally, a task session resolves to the task's own container, as the web shell derives it", async () => {
    const r = await resolve('sess-task-1', null, false);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.target.kind).toBe('task');
      expect(r.target.container).toBe('lazy-run-some-task');
    }
  });
});

describe('session attach upgrader: the client cannot steer the exec', () => {
  function upgrader(callerEmail: string) {
    return createSessionAttachUpgrader({
      getStorage: async () => fakeStorage() as Storage,
      root: ROOT,
      authenticate: async () => ({
        ok: true,
        actor: { kind: 'user', email: callerEmail } as never,
        legacyShared: false,
      }),
      multiMember: async () => true,
      confirmRunning: async () => ({ ok: true }),
      runnerFor: dockerRunner,
    });
  }

  function capturingServer() {
    const upgrades: Array<Record<string, unknown>> = [];
    const server = {
      upgrade: (_req: Request, opts?: { data?: unknown }) => {
        upgrades.push(opts?.data as Record<string, unknown>);
        return true;
      },
    } as unknown as Server<unknown>;
    return { server, upgrades };
  }

  // Every client-controllable input a hostile caller might try, aimed at Bob.
  const HOSTILE_QUERY =
    `?container=${BOB.containerName}&name=${BOB.containerName}&cmd=sh&attach=0&mode=attach`;

  function request(sessionId: string) {
    return new Request(`http://daemon/rpc/sessions/${sessionId}/attach/ws${HOSTILE_QUERY}`, {
      headers: {
        Authorization: 'Bearer t',
        'X-Lazy-Project': ROOT,
        'X-Lazy-Container': BOB.containerName!,
      },
    });
  }

  test("hostile query and headers are ignored — Alice's socket attaches to Alice's container", async () => {
    const { server, upgrades } = capturingServer();
    const outcome = await upgrader('alice@example.com').tryUpgrade(request('bs-alice'), server);
    expect(outcome).toBe('upgraded');
    expect(upgrades).toHaveLength(1);
    expect(upgrades[0]!.container).toBe('lazy-builder-aaaa1111');
    // A builder session is ATTACHED to (its own TTY), never exec'd into.
    expect(upgrades[0]!.attach).toBe(true);
  });

  test("Alice presenting Bob's session id gets a 403 and no socket", async () => {
    const { server, upgrades } = capturingServer();
    const outcome = await upgrader('alice@example.com').tryUpgrade(request('bs-bob'), server);
    expect(outcome).toBeInstanceOf(Response);
    expect((outcome as Response).status).toBe(403);
    expect(upgrades).toHaveLength(0);
  });

  test('an unauthenticated upgrade is a 401 before the session is looked up', async () => {
    let looked = false;
    const up = createSessionAttachUpgrader({
      getStorage: async () => { looked = true; return fakeStorage() as Storage; },
      root: ROOT,
      authenticate: async () => ({ ok: false, failure: { reason: 'missing' } }),
      multiMember: async () => true,
    });
    const outcome = await up.tryUpgrade(request('bs-alice'), capturingServer().server);
    expect((outcome as Response).status).toBe(401);
    expect(looked).toBe(false);
  });

  // INVARIANT: on a single-person daemon a task session gets the web shell's
  // own treatment — an EXEC into execContainerName's answer, never a TTY
  // attach, whatever a hostile query names — and ?mode=pair|chat goes through
  // shell-pair.ts's planner rather than around it.
  describe('a local task session', () => {
    function localUpgrader() {
      return createSessionAttachUpgrader({
        getStorage: async () => fakeStorage() as Storage,
        root: ROOT,
        authenticate: async () => ({ ok: true, actor: { kind: 'control' }, legacyShared: true }),
        multiMember: async () => false,
        confirmRunning: async () => ({ ok: true }),
        runnerFor: dockerRunner,
      });
    }
    function taskRequest(query: string) {
      return new Request(`http://daemon/rpc/sessions/${TASK_SESSION.id}/attach/ws?${query}`, {
        headers: { Authorization: 'Bearer t', 'X-Lazy-Project': ROOT, 'X-Lazy-Container': BOB.containerName! },
      });
    }

    test('execs a shell into the task\'s own container, ignoring a hostile query', async () => {
      const { server, upgrades } = capturingServer();
      const outcome = await localUpgrader().tryUpgrade(
        taskRequest(`container=${BOB.containerName}&name=${BOB.containerName}&attach=1&cmd=evil`),
        server,
      );
      expect(outcome).toBe('upgraded');
      expect(upgrades).toHaveLength(1);
      expect(upgrades[0]!.container).toBe('lazy-run-some-task');
      expect(upgrades[0]!.attach).toBe(false);
      // A single-person daemon's terminal keeps no turn from anyone: no limit.
      expect(upgrades[0]!.limits).toBeUndefined();
      expect(upgrades[0]!.cmd).not.toContain('evil');
    });

    test('pair and chat go through the pair/chat planner', async () => {
      for (const mode of ['pair', 'chat']) {
        const { server, upgrades } = capturingServer();
        const outcome = await localUpgrader().tryUpgrade(taskRequest(`mode=${mode}&container=${BOB.containerName}`), server);
        // The planner's own first refusal: this fixture task has no worktree
        // on disk. Reaching it proves the mode was planned, not bypassed.
        expect(outcome).toBeInstanceOf(Response);
        expect((outcome as Response).status).toBe(409);
        expect(await (outcome as Response).text()).toContain('Worktree missing');
        expect(upgrades).toHaveLength(0);
      }
    });
  });

  // INVARIANT: on a shared daemon a member's terminal NEVER runs in the task's
  // container. It execs into a container of the member's own
  // (src/daemon/member-container.ts) — whose environment carries their
  // credential and nothing else, so the exec adds none — and a hostile query
  // cannot point it anywhere else. No process a turn left running shares its
  // PID namespace, and nothing of the member's is in any turn's.
  test("a member's terminal on a shared daemon runs in their own container, never the task's", async () => {
    resetMemberTerminalsForTests();
    const launched: string[] = [];
    const up = createSessionAttachUpgrader({
      getStorage: async () => fakeStorage() as Storage,
      root: ROOT,
      authenticate: async () => ({ ok: true, actor: { kind: 'user', email: 'alice@example.com' } as never, legacyShared: false }),
      multiMember: async () => true,
      confirmRunning: async () => { throw new Error('a member terminal must not need the task container running'); },
      runnerFor: dockerRunner,
      bindingFor: async () => null,
      enterAsMember: async (o) => { markMemberTerminalEntered(o.taskId, o.email); return { ok: true }; },
      memberPreflight: async () => ({ refusals: {}, credentialMissing: false }),
      onMemberVacate: async () => {},
      launchMemberContainer: async (o) => {
        launched.push(o.memberEmail);
        return { ok: true, container: { name: 'lazymember-task-1-aaaa', binary: o.binary, remove: async () => {} } };
      },
      memberContainerRunning: async () => true,
    });
    const { server, upgrades } = capturingServer();
    const outcome = await up.tryUpgrade(new Request(
      `http://daemon/rpc/sessions/${TASK_SESSION.id}/attach/ws?container=lazy-run-some-task&attach=1&cmd=evil`,
      { headers: { Authorization: 'Bearer t', 'X-Lazy-Project': ROOT, 'X-Lazy-Container': 'lazy-run-some-task' } },
    ), server);
    expect(outcome).toBe('upgraded');
    expect(launched).toEqual(['alice@example.com']);
    expect(upgrades[0]!.container).toBe('lazymember-task-1-aaaa');
    expect(upgrades[0]!.container).not.toBe('lazy-run-some-task');
    expect(upgrades[0]!.attach).toBe(false);
    expect(upgrades[0]!.cmd).not.toContain('evil');
    // The exec carries no credential: the member's is in their container's
    // own environment, and nothing else's is anywhere near it.
    expect(upgrades[0]!.env).toEqual(['TERM=xterm-256color']);
    // A member's terminal is closed when forgotten (./terminal-idle.ts).
    expect(upgrades[0]!.limits).toEqual({ idleMs: 3_600_000, maxMs: 43_200_000 });
    resetMemberTerminalsForTests();
  });

  test("a member whose container cannot be made is refused with the daemon's own sentence", async () => {
    resetMemberTerminalsForTests();
    const up = createSessionAttachUpgrader({
      getStorage: async () => fakeStorage() as Storage,
      root: ROOT,
      authenticate: async () => ({ ok: true, actor: { kind: 'user', email: 'alice@example.com' } as never, legacyShared: false }),
      multiMember: async () => true,
      runnerFor: dockerRunner,
      bindingFor: async () => null,
      enterAsMember: async (o) => { markMemberTerminalEntered(o.taskId, o.email); return { ok: true }; },
      memberPreflight: async () => ({ refusals: {}, credentialMissing: false }),
      onMemberVacate: async () => {},
      launchMemberContainer: async () => ({ ok: false, status: 400, message: 'No Anthropic credential for this user: …' }),
    });
    const { server, upgrades } = capturingServer();
    const outcome = await up.tryUpgrade(new Request(`http://daemon/rpc/sessions/${TASK_SESSION.id}/attach/ws`, {
      headers: { Authorization: 'Bearer t', 'X-Lazy-Project': ROOT },
    }), server);
    expect((outcome as Response).status).toBe(400);
    expect(await (outcome as Response).text()).toContain('No Anthropic credential');
    expect(upgrades).toHaveLength(0);
    // Nothing came up, so nothing is held: the task is free at once.
    const { memberInsideTask } = await import('../../src/server/member-terminals');
    expect(memberInsideTask(TASK.id)).toBeNull();
    resetMemberTerminalsForTests();
  });

  // INVARIANT: one member in a task at a time — their terminals share one
  // container of their own, and two people editing one checkout at once is
  // not something either asked for — and the hold outlives their last
  // terminal until that container has been removed, so nothing they left
  // running survives into anyone else's session. The same member may open as
  // many terminals as they like; all of them land in the same container.
  describe('one member inside at a time', () => {
    function memberUpgrader(email: string, opts: {
      entered?: string[];
      vacated?: string[];
      enter?: () => Promise<{ ok: true } | { ok: false; status: number; message: string }>;
      preflight?: Awaited<ReturnType<typeof taskModeRefusals>>;
      launchThrows?: boolean;
      launched?: string[];
    } = {}) {
      return createSessionAttachUpgrader({
        getStorage: async () => fakeStorage() as Storage,
        root: ROOT,
        authenticate: async () => ({ ok: true, actor: { kind: 'user', email } as never, legacyShared: false }),
        multiMember: async () => true,
        confirmRunning: async () => ({ ok: true }),
        runnerFor: dockerRunner,
        bindingFor: async () => null,
        enterAsMember: async (o) => {
          opts.entered?.push(o.email);
          if (opts.enter) return opts.enter();
          // What the real entry does under the lifecycle lock.
          markMemberTerminalEntered(TASK.id, o.email);
          return { ok: true };
        },
        memberPreflight: async () => opts.preflight ?? { refusals: {}, credentialMissing: false },
        onMemberVacate: async (c) => { opts.vacated?.push(`${email}:${c?.name ?? 'none'}`); },
        memberGraceMs: 20,
        launchMemberContainer: async () => {
          if (opts.launchThrows) throw new Error('the registry is unreadable');
          const name = `lazymember-${email.split('@')[0]}-${(opts.launched?.length ?? 0) + 1}`;
          opts.launched?.push(name);
          return { ok: true, container: { name, binary: 'docker', remove: async () => {} } };
        },
        memberContainerRunning: async () => true,
      });
    }
    const req = () => new Request(`http://daemon/rpc/sessions/${TASK_SESSION.id}/attach/ws`, {
      headers: { Authorization: 'Bearer t', 'X-Lazy-Project': ROOT },
    });

    test('a second member is refused until the first has closed every terminal and been vacated', async () => {
      resetMemberTerminalsForTests();
      const vacated: string[] = [];
      const launched: string[] = [];
      const alice = capturingServer();
      expect(await memberUpgrader('alice@example.com', { vacated, launched }).tryUpgrade(req(), alice.server)).toBe('upgraded');
      expect(await memberUpgrader('alice@example.com', { vacated, launched }).tryUpgrade(req(), alice.server)).toBe('upgraded');
      // Both of Alice's terminals are in the ONE container made for her.
      expect(launched).toEqual(['lazymember-alice-1']);
      expect(alice.upgrades.map((u) => u.container)).toEqual(['lazymember-alice-1', 'lazymember-alice-1']);

      const bob = capturingServer();
      expect(((await memberUpgrader('bob@example.com').tryUpgrade(req(), bob.server)) as Response).status).toBe(409);

      for (const u of alice.upgrades) (u.onClose as () => void)();
      // Still held through the grace: Alice's container has not been removed yet.
      expect(((await memberUpgrader('bob@example.com').tryUpgrade(req(), bob.server)) as Response).status).toBe(409);
      expect(bob.upgrades).toHaveLength(0);

      await new Promise((r) => setTimeout(r, 60));
      // Her container is what the vacate removed.
      expect(vacated).toEqual(['alice@example.com:lazymember-alice-1']);
      expect(await memberUpgrader('bob@example.com').tryUpgrade(req(), bob.server)).toBe('upgraded');
      resetMemberTerminalsForTests();
    });

    test('every member entry goes through the entry step, and its refusal is the answer', async () => {
      resetMemberTerminalsForTests();
      const entered: string[] = [];
      const { server, upgrades } = capturingServer();
      const refused = await memberUpgrader('alice@example.com', {
        entered,
        enter: async () => ({ ok: false, status: 409, message: 'A turn has just started on this task.' }),
      }).tryUpgrade(req(), server);
      expect((refused as Response).status).toBe(409);
      expect(entered).toEqual(['alice@example.com']);
      expect(upgrades).toHaveLength(0);
      resetMemberTerminalsForTests();
    });

    // INVARIANT: a refused entry makes no container. The entry is the lock
    // turns and members share; a member it refuses (a turn is running) must
    // not have anything created for them.
    test('a refused entry never makes a container', async () => {
      resetMemberTerminalsForTests();
      const launched: string[] = [];
      const { server } = capturingServer();
      const refused = await memberUpgrader('alice@example.com', {
        launched,
        enter: async () => ({ ok: false, status: 409, message: 'A turn is running on this task.' }),
      }).tryUpgrade(req(), server);
      expect((refused as Response).status).toBe(409);
      expect(launched).toEqual([]);
      resetMemberTerminalsForTests();
    });

    // INVARIANT: every check that can refuse runs BEFORE the entry, which is
    // not free: from the moment it succeeds, no turn can start on the task. A
    // refused Pair — here, on an agent that cannot pair — never reaches the
    // entry, so it keeps nobody out.
    test('a refused Pair never reaches the entry', async () => {
      resetMemberTerminalsForTests();
      const entered: string[] = [];
      const { server, upgrades } = capturingServer();
      const pairReq = new Request(`http://daemon/rpc/sessions/${TASK_SESSION.id}/attach/ws?mode=pair`, {
        headers: { Authorization: 'Bearer t', 'X-Lazy-Project': ROOT },
      });
      const refused = await memberUpgrader('alice@example.com', {
        entered,
        preflight: { refusals: { pair: 'Cannot pair on a qa-agent task — that agent does not support pairing.' }, credentialMissing: false },
      }).tryUpgrade(pairReq, server);
      expect((refused as Response).status).toBe(409);
      expect(await (refused as Response).text()).toContain('does not support pairing');
      expect(entered).toEqual([]);
      expect(upgrades).toHaveLength(0);
      resetMemberTerminalsForTests();
    });

    test('a member with no credential is refused before the entry, with a 400', async () => {
      resetMemberTerminalsForTests();
      const entered: string[] = [];
      const { server } = capturingServer();
      const refused = await memberUpgrader('alice@example.com', {
        entered,
        preflight: { refusals: { shell: 'No Anthropic credential for this user: …' }, credentialMissing: true },
      }).tryUpgrade(req(), server);
      expect((refused as Response).status).toBe(400);
      expect(entered).toEqual([]);
      resetMemberTerminalsForTests();
    });

    // INVARIANT: a refused attempt that never entered frees the environment
    // at once — the next member can enter straight after it, not 30 seconds
    // later.
    test("a second member can enter right after the first member's refused attempt", async () => {
      resetMemberTerminalsForTests();
      const { server } = capturingServer();
      const refused = await memberUpgrader('alice@example.com', {
        enter: async () => ({ ok: false, status: 409, message: 'A turn has just started on this task.' }),
      }).tryUpgrade(req(), server);
      expect((refused as Response).status).toBe(409);

      const bob = capturingServer();
      expect(await memberUpgrader('bob@example.com').tryUpgrade(req(), bob.server)).toBe('upgraded');
      resetMemberTerminalsForTests();
    });

    // INVARIANT: a step that THROWS after the claim gives the claim back — a
    // leaked claim would lock every other member, and every turn, out of the
    // task until the daemon restarted.
    test('a container launch that throws after the claim releases it', async () => {
      resetMemberTerminalsForTests();
      const { server } = capturingServer();
      const outcome = await memberUpgrader('alice@example.com', { launchThrows: true }).tryUpgrade(req(), server);
      expect((outcome as Response).status).toBe(500);
      const { memberTerminalHolder } = await import('../../src/server/member-terminals');
      // Released: after the grace the task is free for anyone.
      await new Promise((r) => setTimeout(r, 60));
      expect(memberTerminalHolder(TASK.id)).toBeNull();
      resetMemberTerminalsForTests();
    });
  });
});

// INVARIANT: the preflight says what the upgrade would refuse, per mode, so a
// client can say it on the button — a refused WebSocket carries no reason a
// browser can read.
describe('attachSession preflight refusals', () => {
  const task = { ...TASK, status: 'blocked' } as unknown as Task;

  test('another member holding the container refuses every mode, naming them', async () => {
    const r = await taskModeRefusals({
      projectRoot: ROOT, task, callerEmail: 'alice@example.com', multiMember: true, binary: 'docker',
      deps: { holder: () => 'bob@example.com', credentialMissing: async () => false, pairOrChat: async () => null },
    });
    for (const m of ['shell', 'pair', 'chat'] as const) expect(r.refusals[m]).toContain('bob@example.com');
  });

  test('no stored credential refuses every mode with the marker Teams recognises', async () => {
    const r = await taskModeRefusals({
      projectRoot: ROOT, task, callerEmail: 'alice@example.com', multiMember: true, binary: 'docker',
      deps: { holder: () => null, credentialMissing: async () => true, pairOrChat: async () => null },
    });
    expect(r.credentialMissing).toBe(true);
    expect(r.refusals.shell).toContain('No Anthropic credential for this user');
  });

  // INVARIANT: a project whose container settings let a turn's container see
  // other containers' processes cannot keep a member's container apart from
  // the agent's, so every member terminal is refused there — said on the page.
  test('container settings that share a process namespace refuse every mode', async () => {
    const r = await taskModeRefusals({
      projectRoot: ROOT, task, callerEmail: 'alice@example.com', multiMember: true, binary: 'docker',
      deps: {
        holder: () => null,
        runArgsRefusal: async () => (await import('../../src/daemon/member-container')).memberContainerSettingsRefusal(['--pid=host']),
        credentialMissing: async () => false,
        pairOrChat: async () => null,
      },
    });
    for (const m of ['shell', 'pair', 'chat'] as const) expect(r.refusals[m]).toContain('--pid=host');
  });

  // INVARIANT: a member's own container runs only on docker, so on another
  // runtime every member terminal is refused — and the page says so on the
  // buttons, rather than each click failing at the upgrade with no reason a
  // browser can read.
  test('a runtime member containers cannot run on refuses every mode, naming it', async () => {
    const r = await taskModeRefusals({
      projectRoot: ROOT, task, callerEmail: 'alice@example.com', multiMember: true, binary: 'podman',
      deps: { holder: () => null, runArgsRefusal: async () => null, credentialMissing: async () => false, pairOrChat: async () => null },
    });
    for (const m of ['shell', 'pair', 'chat'] as const) {
      expect(r.refusals[m]).toContain('need the docker runtime');
      expect(r.refusals[m]).toContain('podman');
    }
    expect(r.credentialMissing).toBe(false);
  });

  test('the docker runtime is not refused for its own sake', async () => {
    const r = await taskModeRefusals({
      projectRoot: ROOT, task, callerEmail: 'alice@example.com', multiMember: true, binary: 'docker',
      deps: { holder: () => null, runArgsRefusal: async () => null, credentialMissing: async () => false, pairOrChat: async () => null, transcriptTooLarge: async () => false },
    });
    expect(r.refusals).toEqual({});
  });

  async function withWorktree<T>(task: Task, fn: (root: string) => Promise<T>): Promise<T> {
    const { mkdtemp, mkdir, rm, realpath } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { getWorktreePath } = await import('../../src/task/identity');
    const root = await realpath(await mkdtemp(join(tmpdir(), 'preflight-')));
    try {
      await mkdir(getWorktreePath(root, task), { recursive: true });
      return await fn(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  test("pair and chat carry the planner's own rules", async () => {
    const task = { ...TASK, status: 'working', agent_id: 'claude-code' } as unknown as Task;
    const r = await withWorktree(task, (root) => taskModeRefusals({ projectRoot: root, task, callerEmail: null, multiMember: false, binary: 'docker' }));
    expect(r.refusals.shell).toBeUndefined();
    expect(r.refusals.pair).toContain('mid-turn');
    expect(r.refusals.chat).toContain('waiting for you');
  });

  // INVARIANT: the page's preflight carries the AGENT rules too, so a task on
  // an agent that cannot pair shows Pair disabled with why, and a non-Claude
  // task shows Chat disabled — instead of a socket that is refused unread.
  test('pair on an agent that cannot pair, and chat on a non-Claude agent, are refused', async () => {
    const noPair = { ...TASK, status: 'blocked', agent_id: 'qa-agent' } as unknown as Task;
    const r1 = await withWorktree(noPair, (root) => taskModeRefusals({ projectRoot: root, task: noPair, callerEmail: null, multiMember: false, binary: 'docker' }));
    expect(r1.refusals.pair).toContain('does not support pairing');

    const cursor = { ...TASK, status: 'blocked', agent_id: 'cursor' } as unknown as Task;
    const r2 = await withWorktree(cursor, (root) => taskModeRefusals({ projectRoot: root, task: cursor, callerEmail: null, multiMember: false, binary: 'docker' }));
    expect(r2.refusals.pair).toBeUndefined();
    expect(r2.refusals.chat).toContain('chat only supports Claude Code');
  });
});
