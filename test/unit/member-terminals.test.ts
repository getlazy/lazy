/**
 * Each member's hold on a task, and the member's own container it owns (src/server/member-terminals.ts).
 */

import { describe, test, expect, afterEach } from 'bun:test';
import {
  claimMemberTerminal,
  releaseMemberTerminal,
  markMemberTerminalEntered,
  markMemberTerminalAttached,
  memberTerminalContainer,
  memberTerminalHolders,
  membersInsideTask,
  resetMemberTerminalsForTests,
  setMemberVacateRetryDelaysForTests,
  holdLeftoverMemberContainer,
  adoptMemberTerminal,
  LEFTOVER_HOLDER,
  type HeldContainer,
} from '../../src/server/member-terminals';

afterEach(() => resetMemberTerminalsForTests());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeContainer(name: string, removed: string[] = []): HeldContainer {
  return { name, binary: 'docker', remove: async () => { removed.push(name); } };
}

// INVARIANT: failed restart preparation never falls through to removing the
// member's stopped environment or launching a replacement.
test('retries recovery before considering replacement of a stopped container', async () => {
  const removed: string[] = [];
  const container = fakeContainer('kept', removed);
  let ready = false;
  container.prepare = async () => { if (!ready) throw new Error('runtime unavailable'); };
  expect(adoptMemberTerminal('task', 'alice', container, 0, { waitForAttach: true })).toBe(true);
  expect(claimMemberTerminal('task', 'alice').ok).toBe(true);
  let launches = 0;
  const launch = async () => { launches++; return fakeContainer('replacement'); };
  await expect(memberTerminalContainer('task', 'alice', launch, async () => false)).rejects.toThrow('runtime unavailable');
  expect(removed).toEqual([]);
  expect(launches).toBe(0);
  ready = true;
  expect(await memberTerminalContainer('task', 'alice', launch, async () => true)).toBe(container);
});

/** Claim, enter and bring up a container, as the attach route does. */
async function enterWithContainer(taskId: string, email: string, container: HeldContainer): Promise<void> {
  expect(claimMemberTerminal(taskId, email).ok).toBe(true);
  markMemberTerminalEntered(taskId, email);
  await memberTerminalContainer(taskId, email, async () => container, async () => true);
}

describe('member terminal hold', () => {
  // INVARIANT: while the vacate is removing a member's environment, no
  // terminal can be opened — not even by the same member. A reclaim in that
  // moment would otherwise exec into a container being torn down (or be
  // left holding one that is gone).
  test('a reclaim while the vacate runs is refused, and succeeds once it has finished', async () => {
    let finishVacate!: () => void;
    const vacating = new Promise<void>((r) => { finishVacate = r; });
    let vacateStarted = false;

    await enterWithContainer('t1', 'alice@example.com', fakeContainer('c1'));
    releaseMemberTerminal('t1', 'alice@example.com', async () => { vacateStarted = true; await vacating; }, 5);
    await sleep(25);
    expect(vacateStarted).toBe(true);

    const during = claimMemberTerminal('t1', 'alice@example.com');
    expect(during).toMatchObject({ ok: false, vacating: true });

    finishVacate();
    await sleep(5);
    expect((memberTerminalHolders('t1')[0] ?? null)).toBeNull();
    expect(claimMemberTerminal('t1', 'alice@example.com').ok).toBe(true);
  });

  // INVARIANT: a claim that never got past the entry touched nothing, so
  // releasing it frees the environment AT ONCE — a refused attempt must not
  // keep every other member, or a turn, out for the whole grace.
  test('a claim released before entering frees the environment immediately', () => {
    let vacated = false;
    expect(claimMemberTerminal('t2', 'alice@example.com').ok).toBe(true);
    releaseMemberTerminal('t2', 'alice@example.com', async () => { vacated = true; }, 60_000);
    expect((memberTerminalHolders('t2')[0] ?? null)).toBeNull();
    expect(claimMemberTerminal('t2', 'bob@example.com').ok).toBe(true);
    expect(vacated).toBe(false);
  });

  test('a claim that entered keeps the environment through the grace', async () => {
    await enterWithContainer('t3', 'alice@example.com', fakeContainer('c3'));
    releaseMemberTerminal('t3', 'alice@example.com', async () => {}, 60_000);
    expect(membersInsideTask('t3')).toEqual(['alice@example.com']);
  });

  // INVARIANT: several members may be inside one task at once, each in their
  // own container; humans coordinate (engineer, 2026-10-21). Holds are per
  // member: one member's grace or vacate never touches another's.
  test('several members are inside one task at once, each with their own container', async () => {
    const removed: string[] = [];
    await enterWithContainer('t8', 'alice@example.com', fakeContainer('c-alice', removed));
    await enterWithContainer('t8', 'bob@example.com', fakeContainer('c-bob', removed));
    expect(membersInsideTask('t8')).toEqual(['alice@example.com', 'bob@example.com']);
    releaseMemberTerminal('t8', 'alice@example.com', async (c) => { await c?.remove(); }, 5);
    await sleep(25);
    expect(removed).toEqual(['c-alice']);
    expect(membersInsideTask('t8')).toEqual(['bob@example.com']);
  });

  // INVARIANT: whatever a member leaves running dies with their session. The
  // vacate is handed THEIR container, and once it has run the task is free —
  // for another member and for turns alike.
  test('the vacate is handed the member\'s own container, and afterwards nobody is inside', async () => {
    const container = fakeContainer('lazymember-t4');
    await enterWithContainer('t4', 'alice@example.com', container);
    let handed: HeldContainer | null = null;
    releaseMemberTerminal('t4', 'alice@example.com', async (c) => { handed = c; }, 5);
    await sleep(25);
    expect(handed as HeldContainer | null).toBe(container);
    expect((membersInsideTask('t4')[0] ?? null)).toBeNull();
  });

  test("the member's terminals share one container; a dead one is replaced", async () => {
    const removed: string[] = [];
    let launches = 0;
    const launch = async () => fakeContainer(`c${++launches}`, removed);
    expect(claimMemberTerminal('t5', 'alice@example.com').ok).toBe(true);
    markMemberTerminalEntered('t5', 'alice@example.com');
    const first = await memberTerminalContainer('t5', 'alice@example.com', launch, async () => true);
    expect(claimMemberTerminal('t5', 'alice@example.com').ok).toBe(true);
    const second = await memberTerminalContainer('t5', 'alice@example.com', launch, async () => true);
    expect(second).toBe(first);
    expect(launches).toBe(1);

    const third = await memberTerminalContainer('t5', 'alice@example.com', launch, async () => false);
    expect(third.name).toBe('c2');
    expect(removed).toEqual(['c1']);
  });

  test('a container that never came up frees the task at once when the claim is released', async () => {
    expect(claimMemberTerminal('t6', 'alice@example.com').ok).toBe(true);
    markMemberTerminalEntered('t6', 'alice@example.com');
    await expect(memberTerminalContainer('t6', 'alice@example.com', async () => { throw new Error('no image'); }, async () => true))
      .rejects.toThrow('no image');
    releaseMemberTerminal('t6', 'alice@example.com', async () => {}, 60_000);
    expect((membersInsideTask('t6')[0] ?? null)).toBeNull();
    expect(claimMemberTerminal('t6', 'bob@example.com').ok).toBe(true);
  });

  test('a claim that has not got past the entry does not count as inside', () => {
    expect(claimMemberTerminal('t7', 'alice@example.com').ok).toBe(true);
    expect((memberTerminalHolders('t7')[0] ?? null)).toBe('alice@example.com');
    expect((membersInsideTask('t7')[0] ?? null)).toBeNull();
  });
});

// INVARIANT: a member's environment that could not be discarded keeps that
// member counted as inside — so the task's worktree is not removed under it —
// and refuses that member's own new terminals until it is gone; it is retried
// until the removal works. Other members are unaffected.
describe('a vacate that fails', () => {
  test('keeps the member held and retries until the removal works', async () => {
    setMemberVacateRetryDelaysForTests([5]);
    await enterWithContainer('v1', 'alice@example.com', fakeContainer('c-v1'));
    let attempts = 0;
    releaseMemberTerminal('v1', 'alice@example.com', async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('daemon busy');
    }, 5);
    await sleep(15);
    expect(attempts).toBeGreaterThanOrEqual(1);
    expect((membersInsideTask('v1')[0] ?? null)).toBe('alice@example.com');
    expect(claimMemberTerminal('v1', 'alice@example.com')).toMatchObject({ ok: false, vacating: true });
    expect(claimMemberTerminal('v1', 'bob@example.com').ok).toBe(true);
    await sleep(60);
    expect(attempts).toBe(3);
    expect((membersInsideTask('v1')[0] ?? null)).toBeNull();
    expect(claimMemberTerminal('v1', 'alice@example.com').ok).toBe(true);
  });

  test('a leftover container the daemon found at startup holds its task the same way', async () => {
    setMemberVacateRetryDelaysForTests([5]);
    let attempts = 0;
    holdLeftoverMemberContainer('v2', async () => {
      attempts += 1;
      if (attempts < 2) throw new Error('still there');
    });
    expect((membersInsideTask('v2')[0] ?? null)).toBe(LEFTOVER_HOLDER);
    await sleep(40);
    expect(attempts).toBe(2);
    expect((membersInsideTask('v2')[0] ?? null)).toBeNull();
  });
});

// INVARIANT: at most one container replace per hold. Two terminals opened
// together onto a member's dead container must not both remove it and both
// launch a new one — the second would run with no hold owning it.
test('two terminals opened together onto a dead container launch one replacement', async () => {
  const removed: string[] = [];
  let launches = 0;
  const launch = async () => {
    launches += 1;
    await sleep(10);
    return fakeContainer(`c${launches}`, removed);
  };
  expect(claimMemberTerminal('r1', 'alice@example.com').ok).toBe(true);
  markMemberTerminalEntered('r1', 'alice@example.com');
  await memberTerminalContainer('r1', 'alice@example.com', launch, async () => true);
  expect(claimMemberTerminal('r1', 'alice@example.com').ok).toBe(true);
  expect(claimMemberTerminal('r1', 'alice@example.com').ok).toBe(true);
  let alive = false;
  const isRunning = async (c: HeldContainer) => { await sleep(5); return alive || c.name !== 'c1'; };
  const [a, b] = await Promise.all([
    memberTerminalContainer('r1', 'alice@example.com', launch, isRunning),
    memberTerminalContainer('r1', 'alice@example.com', launch, isRunning),
  ]);
  alive = true;
  expect(launches).toBe(2);
  expect(a).toBe(b);
  expect(removed).toEqual(['c1']);
});

// INVARIANT: a member's environment outlives their last terminal while it has
// a live tmux session to come back to (docs/design/task-sessions-and-ssh.md
// §1): closing a browser tab, a dropped connection or a reload must not end
// what they started. Only ending the last session removes it; idle sessions
// and failed activity probes preserve the environment.
describe("a member's environment with live sessions", () => {
  function withActivity(name: string, removed: string[], activity: () => Promise<{ sessions: number; attached: boolean; lastActivityMs: number | null }>): HeldContainer {
    return { ...fakeContainer(name, removed), activity };
  }

  test('is kept after the grace while a session is alive, and the member comes back to it', async () => {
    const removed: string[] = [];
    const c = withActivity('k1', removed, async () => ({ sessions: 1, attached: false, lastActivityMs: Date.now() }));
    await enterWithContainer('k1', 'alice@example.com', c);
    releaseMemberTerminal('k1', 'alice@example.com', async (x) => { await x?.remove(); }, 1, { checkEveryMs: 60_000 });
    await sleep(20);
    expect(removed).toEqual([]);
    expect((membersInsideTask('k1')[0] ?? null)).toBe('alice@example.com');
    // Back: the same container, not a new one.
    expect(claimMemberTerminal('k1', 'alice@example.com').ok).toBe(true);
    const again = await memberTerminalContainer('k1', 'alice@example.com', async () => fakeContainer('new'), async () => true);
    expect(again.name).toBe('k1');
  });

  test('is removed once its last session has ended', async () => {
    const removed: string[] = [];
    let sessions = 1;
    const c = withActivity('k2', removed, async () => ({ sessions, attached: false, lastActivityMs: Date.now() }));
    await enterWithContainer('k2', 'alice@example.com', c);
    releaseMemberTerminal('k2', 'alice@example.com', async (x) => { await x?.remove(); }, 1, { checkEveryMs: 5 });
    await sleep(15);
    expect(removed).toEqual([]);
    sessions = 0;
    await sleep(30);
    expect(removed).toEqual(['k2']);
    expect((membersInsideTask('k2')[0] ?? null)).toBeNull();
  });

  test('survives without clients however old its last activity', async () => {
    const removed: string[] = [];
    const c = withActivity('k3', removed, async () => ({ sessions: 2, attached: false, lastActivityMs: 1_000 }));
    await enterWithContainer('k3', 'alice@example.com', c);
    releaseMemberTerminal('k3', 'alice@example.com', async (x) => { await x?.remove(); }, 1, { checkEveryMs: 5 });
    await sleep(20);
    expect(removed).toEqual([]);
  });

  test('an attached client keeps it however old its last activity', async () => {
    const removed: string[] = [];
    const c = withActivity('k4', removed, async () => ({ sessions: 1, attached: true, lastActivityMs: 0 }));
    await enterWithContainer('k4', 'alice@example.com', c);
    releaseMemberTerminal('k4', 'alice@example.com', async (x) => { await x?.remove(); }, 1, { checkEveryMs: 60_000 });
    await sleep(20);
    expect(removed).toEqual([]);
  });

  test('a failed activity probe preserves the environment', async () => {
    const removed: string[] = [];
    const c = withActivity('k5', removed, async () => { throw new Error('No such container'); });
    await enterWithContainer('k5', 'alice@example.com', c);
    releaseMemberTerminal('k5', 'alice@example.com', async (x) => { await x?.remove(); }, 1);
    await sleep(20);
    expect(removed).toEqual([]);
  });

  // INVARIANT: failed session probes preserve work, but never obstruct
  // task-end or departure teardown. Neither teardown needs an activity probe.
  for (const ending of ["task end", "member departure"] as const) {
    test(ending + " removes an environment after its sessions probe fails", async () => {
      const { endMemberSessions, endMemberEnvironmentsOf } = await import("../../src/server/member-terminals");
      const removed: string[] = [];
      let probes = 0;
      let probed!: () => void;
      const firstProbe = new Promise<void>((resolve) => { probed = resolve; });
      const c = withActivity("failed-probe", removed, async () => {
        probes++;
        probed();
        throw new Error("session listing unavailable");
      });
      await enterWithContainer("failed-probe", "alice@example.com", c);
      releaseMemberTerminal("failed-probe", "alice@example.com", async (x) => { await x?.remove(); }, 1);
      await firstProbe;
      expect(removed).toEqual([]);
      if (ending === "task end") await endMemberSessions("failed-probe");
      else await endMemberEnvironmentsOf("alice@example.com");
      expect(removed).toEqual(["failed-probe"]);
      expect(membersInsideTask("failed-probe")).toEqual([]);
      expect(probes).toBe(1);
    });
  }

  test('endMemberSessions removes it at once, terminals open or not', async () => {
    const { endMemberSessions } = await import('../../src/server/member-terminals');
    const removed: string[] = [];
    expect(claimMemberTerminal('k6', 'alice@example.com', async (x) => { await x?.remove(); }).ok).toBe(true);
    markMemberTerminalEntered('k6', 'alice@example.com');
    await memberTerminalContainer('k6', 'alice@example.com', async () => withActivity('k6', removed, async () => ({ sessions: 1, attached: true, lastActivityMs: Date.now() })), async () => true);
    await endMemberSessions('k6');
    expect(removed).toEqual(['k6']);
    expect((membersInsideTask('k6')[0] ?? null)).toBeNull();
  });
});

// INVARIANT: a daemon restart does not end a member's environment. A container
// the startup sweep re-adopted gets its hold back as if the member's last
// terminal had just closed — the member is inside (teardown waits), their next
// terminal joins the SAME container, however long it has been idle. Ending it at every restart killed every member's tmux
// sessions on each upgrade and fleet roll.
describe('a member environment re-adopted after a daemon restart', () => {
  function withActivity(name: string, removed: string[], activity: () => Promise<{ sessions: number; attached: boolean; lastActivityMs: number | null }>): HeldContainer {
    return { ...fakeContainer(name, removed), activity };
  }

  test('counts the member inside, and their next terminal joins the same container', async () => {
    const removed: string[] = [];
    const c = withActivity('r1', removed, async () => ({ sessions: 1, attached: false, lastActivityMs: Date.now() }));
    expect(adoptMemberTerminal('r1', 'alice@example.com', c, 1, { checkEveryMs: 60_000 })).toBe(true);
    expect(membersInsideTask('r1')).toEqual(['alice@example.com']);
    await sleep(20);
    expect(removed).toEqual([]);
    expect(claimMemberTerminal('r1', 'alice@example.com').ok).toBe(true);
    markMemberTerminalEntered('r1', 'alice@example.com');
    const again = await memberTerminalContainer('r1', 'alice@example.com', async () => fakeContainer('new'), async () => true);
    expect(again.name).toBe('r1');
  });

  // INVARIANT: a runtime stop ends shells without the member exiting them.
  // Keep the restarted environment until reconnect, then resume normal cleanup.
  test('a restarted environment with no surviving shell waits for reconnect', async () => {
    const removed: string[] = [];
    const c = withActivity('restarted', removed, async () => ({ sessions: 0, attached: false, lastActivityMs: null }));
    adoptMemberTerminal('restarted', 'alice@example.com', c, 1, { waitForAttach: true });
    await sleep(20);
    expect(removed).toEqual([]);
    expect(claimMemberTerminal('restarted', 'alice@example.com').ok).toBe(true);
    markMemberTerminalEntered('restarted', 'alice@example.com');
    expect(await memberTerminalContainer('restarted', 'alice@example.com', async () => fakeContainer('new'), async () => true)).toBe(c);
    await markMemberTerminalAttached('restarted', 'alice@example.com', c);
    releaseMemberTerminal('restarted', 'alice@example.com', async container => { await container?.remove(); }, 1);
    await sleep(20);
    expect(removed).toEqual(['restarted']);
  });

  // INVARIANT: a refused, failed or abandoned reconnect is not a member exiting
  // their shells. Restart protection lasts until a terminal exec starts.
  for (const attempt of ['refused', 'failed', 'disconnected']) {
    test(`a ${attempt} reconnect keeps an empty recovered environment`, async () => {
      const removed: string[] = [];
      const c = withActivity(attempt, removed, async () => ({ sessions: 0, attached: false, lastActivityMs: null }));
      adoptMemberTerminal(attempt, 'alice@example.com', c, 1, { waitForAttach: true });
      expect(claimMemberTerminal(attempt, 'alice@example.com').ok).toBe(true);
      if (attempt !== 'refused') {
        markMemberTerminalEntered(attempt, 'alice@example.com');
        await memberTerminalContainer(attempt, 'alice@example.com', async () => fakeContainer('new'), async () => true);
      }
      releaseMemberTerminal(attempt, 'alice@example.com', undefined, 1);
      await sleep(20);
      expect(removed).toEqual([]);
      expect(membersInsideTask(attempt)).toEqual(['alice@example.com']);
    });
  }

  test('is removed after the grace when it has no session left', async () => {
    const removed: string[] = [];
    const c = withActivity('r2', removed, async () => ({ sessions: 0, attached: false, lastActivityMs: null }));
    adoptMemberTerminal('r2', 'alice@example.com', c, 1);
    await sleep(20);
    expect(removed).toEqual(['r2']);
    expect(membersInsideTask('r2')).toEqual([]);
  });

  test('survives restart adoption however old its last activity', async () => {
    const removed: string[] = [];
    const c = withActivity('r3', removed, async () => ({ sessions: 1, attached: false, lastActivityMs: 1_000 }));
    adoptMemberTerminal('r3', 'alice@example.com', c, 1, { checkEveryMs: 5 });
    await sleep(20);
    expect(removed).toEqual([]);
  });

  test('never replaces a hold the member already has', async () => {
    await enterWithContainer('r4', 'alice@example.com', fakeContainer('mine'));
    expect(adoptMemberTerminal('r4', 'alice@example.com', fakeContainer('other'))).toBe(false);
  });
});
