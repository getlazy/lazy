/**
 * The one-member-at-a-time hold on a task, and the member's own container it
 * owns (src/server/member-terminals.ts).
 */

import { describe, test, expect, afterEach } from 'bun:test';
import {
  claimMemberTerminal,
  releaseMemberTerminal,
  markMemberTerminalEntered,
  memberTerminalContainer,
  memberTerminalHolder,
  memberInsideTask,
  resetMemberTerminalsForTests,
  setMemberVacateRetryDelaysForTests,
  holdLeftoverMemberContainer,
  LEFTOVER_HOLDER,
  type HeldContainer,
} from '../../src/server/member-terminals';

afterEach(() => resetMemberTerminalsForTests());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeContainer(name: string, removed: string[] = []): HeldContainer {
  return { name, binary: 'docker', remove: async () => { removed.push(name); } };
}

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
    expect(memberTerminalHolder('t1')).toBeNull();
    expect(claimMemberTerminal('t1', 'alice@example.com').ok).toBe(true);
  });

  // INVARIANT: a claim that never got past the entry touched nothing, so
  // releasing it frees the environment AT ONCE — a refused attempt must not
  // keep every other member, or a turn, out for the whole grace.
  test('a claim released before entering frees the environment immediately', () => {
    let vacated = false;
    expect(claimMemberTerminal('t2', 'alice@example.com').ok).toBe(true);
    releaseMemberTerminal('t2', 'alice@example.com', async () => { vacated = true; }, 60_000);
    expect(memberTerminalHolder('t2')).toBeNull();
    expect(claimMemberTerminal('t2', 'bob@example.com').ok).toBe(true);
    expect(vacated).toBe(false);
  });

  test('a claim that entered keeps the environment — and turns off — through the grace', async () => {
    await enterWithContainer('t3', 'alice@example.com', fakeContainer('c3'));
    releaseMemberTerminal('t3', 'alice@example.com', async () => {}, 60_000);
    expect(claimMemberTerminal('t3', 'bob@example.com')).toMatchObject({ ok: false, holder: 'alice@example.com' });
    expect(memberInsideTask('t3')).toBe('alice@example.com');
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
    expect(memberInsideTask('t4')).toBeNull();
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
    expect(memberInsideTask('t6')).toBeNull();
    expect(claimMemberTerminal('t6', 'bob@example.com').ok).toBe(true);
  });

  test('a claim that has not got past the entry does not keep turns out', () => {
    expect(claimMemberTerminal('t7', 'alice@example.com').ok).toBe(true);
    expect(memberTerminalHolder('t7')).toBe('alice@example.com');
    expect(memberInsideTask('t7')).toBeNull();
  });
});

// INVARIANT: a member's environment that could not be discarded keeps the
// task held — no turn, no other member — and is retried until it is gone. A
// process the member left in it (a watcher, a dev server) would otherwise keep
// writing into the worktree under the next turn.
describe('a vacate that fails', () => {
  test('keeps the task held and retries until the removal works', async () => {
    setMemberVacateRetryDelaysForTests([5]);
    await enterWithContainer('v1', 'alice@example.com', fakeContainer('c-v1'));
    let attempts = 0;
    releaseMemberTerminal('v1', 'alice@example.com', async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('daemon busy');
    }, 5);
    await sleep(15);
    expect(attempts).toBeGreaterThanOrEqual(1);
    expect(memberInsideTask('v1')).toBe('alice@example.com');
    expect(claimMemberTerminal('v1', 'bob@example.com')).toMatchObject({ ok: false, vacating: true });
    await sleep(60);
    expect(attempts).toBe(3);
    expect(memberInsideTask('v1')).toBeNull();
    expect(claimMemberTerminal('v1', 'bob@example.com').ok).toBe(true);
  });

  test('a leftover container the daemon found at startup holds its task the same way', async () => {
    setMemberVacateRetryDelaysForTests([5]);
    let attempts = 0;
    holdLeftoverMemberContainer('v2', async () => {
      attempts += 1;
      if (attempts < 2) throw new Error('still there');
    });
    expect(memberInsideTask('v2')).toBe(LEFTOVER_HOLDER);
    await sleep(40);
    expect(attempts).toBe(2);
    expect(memberInsideTask('v2')).toBeNull();
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
