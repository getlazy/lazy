/**
 * Unit tests: the TURN OWNER — who asked for the turn an agent is running, and
 * how that person reaches the rows the agent writes.
 *
 * The owner already existed for BILLING, in an in-memory map that a daemon
 * restart erases (src/daemon/turn-credentials.ts). Attribution cannot use that
 * map: an agent writes for the whole length of a turn, and a daemon restarted
 * in the middle of one would lose the person while the agent kept working. So
 * the owner is recorded durably on the SESSION at launch, and every agent write
 * resolves it from there.
 *
 * Rationale: docs/design/actor-identity-and-remote-clients.md §3.3 case 2.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';
import {
  createAgentTurn,
  createRecoveredAgentTurn,
  recordSessionTurnOwner,
  sessionTurnOwner,
  runAsTurnOwnerRequest,
  personForCurrentTurn,
  taskTurnOwner,
  getPendingTurnOwner,
  turnOwnerOfClaim,
  turnOwnerOfSession,
  TurnOwnerNotClearedError,
} from '../../src/daemon/turn-owner';
import { planTurnCredential, releaseTurnCredential } from '../../src/daemon/turn-credentials';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { mcpActor, mcpRole, type McpToolContext } from '../../src/mcp/tools';
import type { Storage } from '../../src/storage/interface';
import type { TurnOwner } from '../../src/types';

describe('turn owner on the session', () => {
  let storage: FileStorage;
  let lazyRoot: string;
  let basePath: string;
  let taskId: string;
  let sessionId: string;

  beforeEach(async () => {
    lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-owner-root-'));
    basePath = await mkdtemp(join(tmpdir(), 'lazy-owner-store-'));
    storage = new FileStorage(lazyRoot, { basePath });
    await storage.initialize();
    const task = await storage.createTask('Turn owner test');
    taskId = task.id;
    const session = await storage.createSession(task.id, 'claude-code', 'lazy/owner', 'abc123');
    sessionId = session.id;
  });

  afterEach(async () => {
    await storage.close();
    await Promise.all([
      rm(lazyRoot, { recursive: true, force: true }),
      rm(basePath, { recursive: true, force: true }),
    ]);
  });

  test('a fresh session has no owner, and names nobody', async () => {
    expect(await sessionTurnOwner(storage, sessionId)).toBeNull();
    expect(await taskTurnOwner(storage, taskId)).toBeNull();

    // And in the shape a WRITE needs. A session no launch has stamped names
    // NOBODY — not the configured system identity, even though the machine
    // running this suite has a git config that would resolve to one. "The
    // daemon started this turn itself" is a recorded mark
    // (`Session.turn_system_initiated`), never the absence of an owner, because
    // a failed best-effort person write produces that absence too.
    expect(await personForCurrentTurn(storage, sessionId, lazyRoot)).toBeNull();
  });

  test('the recorded owner round-trips, name included', async () => {
    await storage.setSessionTurnOwner(sessionId, { email: 'ivan@example.com', name: 'Ivan' });
    expect(await sessionTurnOwner(storage, sessionId)).toEqual({ email: 'ivan@example.com', name: 'Ivan' });
  });

  // INVARIANT: the owner belongs to the TURN, not to the task. A turn nobody
  // asked for CLEARS the previous turn's owner rather than inheriting it —
  // otherwise the daemon's own automations (auto-resume, auto-deliver, a sync)
  // would silently attribute their work to whoever touched the task last, which
  // is precisely the wrong human to name.
  test('recording a null owner clears the previous person', async () => {
    await storage.setSessionTurnOwner(sessionId, { email: 'ivan@example.com', name: 'Ivan' });
    await storage.setSessionTurnOwner(sessionId, null);

    expect(await sessionTurnOwner(storage, sessionId)).toBeNull();
  });

  // INVARIANT: the durable half survives the process. This is the whole reason
  // it is not the in-memory map: a daemon restarted mid-turn must still be able
  // to say whose work the rows arriving afterwards are.
  test('the owner survives a new Storage instance over the same store', async () => {
    await storage.setSessionTurnOwner(sessionId, { email: 'ivan@example.com', name: 'Ivan' });

    const reopened = new FileStorage(lazyRoot, { basePath });
    await reopened.initialize();
    try {
      expect(await sessionTurnOwner(reopened, sessionId)).toEqual({ email: 'ivan@example.com', name: 'Ivan' });
    } finally {
      await reopened.close();
    }
  });

  test('an unknown session id resolves to nobody rather than throwing', async () => {
    expect(await sessionTurnOwner(storage, 'no-such-session')).toBeNull();
  });

  test('turnOwnerOfSession reads a session record the caller already holds', async () => {
    expect(turnOwnerOfSession(null)).toBeNull();
    expect(turnOwnerOfSession({ turn_owner_email: null })).toBeNull();
    expect(turnOwnerOfSession({ turn_owner_email: 'ivan@example.com' })).toEqual({ email: 'ivan@example.com' });
    expect(turnOwnerOfSession({ turn_owner_email: 'ivan@example.com', turn_owner_name: 'Ivan' }))
      .toEqual({ email: 'ivan@example.com', name: 'Ivan' });
  });
});

/**
 * INVARIANT: the two directions of the durable write fail DIFFERENTLY.
 *
 * Failing to write a PERSON is harmless — the rows name nobody, which is what
 * every agent row looked like before attribution existed, and is never a claim
 * about anyone. Failing to CLEAR one is not: the previous human's address stays
 * on the session and every append-only row the system-initiated turn then
 * writes is durably stamped with somebody who did not ask for the work. So the
 * clear is retried, then VERIFIED by reading the session back — a write that
 * reported success is not proof, since `FileStorage` returns silently when it
 * cannot resolve the session and `RemoteStorage` refuses the call outright —
 * and the launch is refused if the person is still there.
 */
describe('the clearing direction fails closed', () => {
  /** A Storage that answers only what recordSessionTurnOwner asks of it. */
  function fakeStorage(behaviour: {
    write: (owner: TurnOwner | null) => Promise<void>;
    stored: () => { turn_owner_email?: string | null; turn_owner_name?: string | null } | null;
    readThrows?: boolean;
  }): Storage {
    return {
      async setSessionTurnOwner(_sessionId: string, owner: TurnOwner | null) {
        await behaviour.write(owner);
      },
      async getSession() {
        if (behaviour.readThrows) throw new Error('store unreadable');
        return behaviour.stored() as never;
      },
    } as unknown as Storage;
  }

  const input = { taskId: 'ffffffff-0000-0000-0000-000000000000', sessionId: 'sess-1' };


  test('a refused clear on a session that still names a person refuses the launch', async () => {
    let stored: { turn_owner_email?: string | null } | null = { turn_owner_email: 'ivan@example.com' };
    const storage = fakeStorage({
      write: async () => { throw new Error('store is read-only'); },
      stored: () => stored,
    });

    await expect(recordSessionTurnOwner({ ...input, storage })).rejects.toThrow(TurnOwnerNotClearedError);
    // The refusal names what it is protecting, not just what failed.
    await expect(recordSessionTurnOwner({ ...input, storage })).rejects.toThrow(/store is read-only/);
    expect(stored?.turn_owner_email).toBe('ivan@example.com');
  });

  // The route a silent no-op takes: the write REPORTS success and changes
  // nothing. Unverified, this is the case that reads as fine and is not.
  test('a clear that silently did nothing is caught by the read-back', async () => {
    const storage = fakeStorage({
      write: async () => { /* "succeeds", writes nothing */ },
      stored: () => ({ turn_owner_email: 'ivan@example.com' }),
    });

    await expect(recordSessionTurnOwner({ ...input, storage })).rejects.toThrow(TurnOwnerNotClearedError);
  });

  test('a clear that cannot be read back is refused rather than assumed', async () => {
    const storage = fakeStorage({
      write: async () => {},
      stored: () => null,
      readThrows: true,
    });

    await expect(recordSessionTurnOwner({ ...input, storage })).rejects.toThrow(/could not read the session back/);
  });

  test('a clear that succeeds on a retry is not a failure', async () => {
    let attempts = 0;
    let stored: { turn_owner_email?: string | null } | null = { turn_owner_email: 'ivan@example.com' };
    const storage = fakeStorage({
      write: async () => {
        attempts += 1;
        if (attempts < 2) throw new Error('transient');
        stored = { turn_owner_email: null };
      },
      stored: () => stored,
    });

    await recordSessionTurnOwner({ ...input, storage });
    expect(attempts).toBe(2);
  });

  // Nothing stale, nothing to protect: a store that refuses the write but shows
  // no person must not turn every system-initiated launch into a failure.
  test('a failed clear on a session that names nobody is not an error', async () => {
    const storage = fakeStorage({
      write: async () => { throw new Error('store is read-only'); },
      stored: () => ({ turn_owner_email: null }),
    });

    await recordSessionTurnOwner({ ...input, storage });
  });

  // INVARIANT: the PERSON direction stays best-effort. Attribution must never
  // be the reason somebody's own turn refuses to launch — and the worst it can
  // produce is a row naming nobody, never a row naming the wrong person.
  test('a failed person write is tolerated, and names nobody', async () => {
    const storage = fakeStorage({
      write: async () => { throw new Error('store is read-only'); },
      stored: () => null,
    });

    await runAsTurnOwnerRequest(
      { taskId: input.taskId, owner: { email: 'ivan@example.com', spendable: false } },
      () => recordSessionTurnOwner({ ...input, storage }),
    );
  });
});

describe('agent turns carry the owner', () => {
  let storage: FileStorage;
  let lazyRoot: string;
  let basePath: string;
  let sessionId: string;

  beforeEach(async () => {
    lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-agentturn-root-'));
    basePath = await mkdtemp(join(tmpdir(), 'lazy-agentturn-store-'));
    storage = new FileStorage(lazyRoot, { basePath });
    await storage.initialize();
    const task = await storage.createTask('Agent turn attribution test');
    const session = await storage.createSession(task.id, 'claude-code', 'lazy/at', 'abc123');
    sessionId = session.id;
  });

  afterEach(async () => {
    await storage.close();
    await Promise.all([
      rm(lazyRoot, { recursive: true, force: true }),
      rm(basePath, { recursive: true, force: true }),
    ]);
  });

  test("an agent turn records the turn owner's email and name", async () => {
    await storage.setSessionTurnOwner(sessionId, { email: 'ivan@example.com', name: 'Ivan' });

    const turn = await createAgentTurn(storage, {
      sessionId,
      sequence: await storage.getNextTurnSequence(sessionId),
      role: 'agent',
      content: 'Done.',
    });

    expect(turn.actor_email).toBe('ivan@example.com');
    expect(turn.actor_name).toBe('Ivan');
    // The CHANNEL is unchanged: "ivan's agent did this" must stay tellable from
    // "ivan typed this" (src/constants.ts).
    expect(turn.actor).toBe('agent');
  });

  // INVARIANT: never invent a person. A turn nobody asked for is written
  // exactly as every agent turn was written before any of this existed, which
  // is what makes "no recorded owner means system-initiated" readable off the
  // row rather than inferred.
  test('an agent turn with no owner is byte-identical to a pre-identity row', async () => {
    const turn = await createAgentTurn(storage, {
      sessionId,
      sequence: await storage.getNextTurnSequence(sessionId),
      role: 'agent',
      content: 'Done.',
    });

    expect(turn.actor_email).toBeUndefined();
    expect(turn.actor_name).toBeUndefined();
    expect(turn.actor).toBeUndefined();
  });

  test('a turn that already names a role keeps it and gains the person', async () => {
    await storage.setSessionTurnOwner(sessionId, { email: 'ivan@example.com' });

    const turn = await createAgentTurn(storage, {
      sessionId,
      sequence: await storage.getNextTurnSequence(sessionId),
      role: 'agent',
      content: 'Sync merge.',
      actor: 'supervisor',
    });

    expect(turn.actor).toBe('supervisor');
    expect(turn.actor_email).toBe('ivan@example.com');
  });
});

/**
 * INVARIANT: a row written for a turn that is ALREADY OVER never takes its
 * person from the session.
 *
 * Several recorders run late by construction — a displaced response is swept up
 * after a newer turn has launched, an abandoned claim is settled by whoever
 * ticks next. The session names the CURRENT turn's owner, so resolving at
 * record time puts ivan's work, and ivan's token usage, on a row that says
 * pete. That is worse than the stale owner the clearing direction refuses a
 * launch over: it names a specific wrong person, on an append-only row.
 */
describe('a turn that is over is never attributed to the turn that followed it', () => {
  let storage: FileStorage;
  let lazyRoot: string;
  let basePath: string;
  let sessionId: string;

  beforeEach(async () => {
    lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-late-root-'));
    basePath = await mkdtemp(join(tmpdir(), 'lazy-late-store-'));
    storage = new FileStorage(lazyRoot, { basePath });
    await storage.initialize();
    const task = await storage.createTask('Late recovery attribution test');
    const session = await storage.createSession(task.id, 'claude-code', 'lazy/late', 'abc123');
    sessionId = session.id;
    // Pete's turn owns the session now. Ivan's turn is the one being recorded.
    await storage.setSessionTurnOwner(sessionId, { email: 'pete@example.com', name: 'Pete' });
  });

  afterEach(async () => {
    await storage.close();
    await Promise.all([
      rm(lazyRoot, { recursive: true, force: true }),
      rm(basePath, { recursive: true, force: true }),
    ]);
  });

  test("a captured owner wins over the session's current one", async () => {
    const turn = await createRecoveredAgentTurn(storage, {
      sessionId,
      sequence: await storage.getNextTurnSequence(sessionId),
      role: 'agent',
      content: "ivan's turn, ended late",
    }, { email: 'ivan@example.com', name: 'Ivan' });

    expect(turn.actor_email).toBe('ivan@example.com');
    expect(turn.actor_email).not.toBe('pete@example.com');
    expect(turn.actor_name).toBe('Ivan');
  });

  // The fallback for the paths where nothing survived the turn to name its
  // owner (a displaced response file is written in an agent-writable worktree
  // and is not an identity source). Nobody is repairable later; pete is not.
  test('with no captured owner the row names NOBODY, never the newer turn', async () => {
    const turn = await createRecoveredAgentTurn(storage, {
      sessionId,
      sequence: await storage.getNextTurnSequence(sessionId),
      role: 'agent',
      content: 'a displaced response, swept up late',
    }, null);

    expect(turn.actor_email).toBeUndefined();
    expect(turn.actor).toBeUndefined();
  });

  // The live path is unchanged: when the row IS the session's current turn,
  // the session is the right source and still answers.
  test('the live path still takes the person from the session', async () => {
    const turn = await createAgentTurn(storage, {
      sessionId,
      sequence: await storage.getNextTurnSequence(sessionId),
      role: 'agent',
      content: "pete's own turn, recorded on time",
    });

    expect(turn.actor_email).toBe('pete@example.com');
  });

  // INVARIANT: one row, one person. The actor and the owner are different
  // facts — the channel a write came through, and whose turn it belongs to —
  // and merging them silently discards one of two humans. `lazy stop` is where
  // that bit: it passes the STOPPER's identity, and with a claim captured for
  // the person who asked for the turn, the row reading "Stopped by user: …"
  // came out under a name that had stopped nothing. Worse, the answer depended
  // on whether the claim happened to carry an owner at all — the same call
  // named two different people. A caller holding two people has to say which
  // one the row is about.
  test('a row handed two different people is refused, not merged', async () => {
    await expect(createRecoveredAgentTurn(storage, {
      sessionId,
      sequence: await storage.getNextTurnSequence(sessionId),
      role: 'agent',
      content: '[Ask stopped]\n\nStopped by user: never mind',
      actor: { role: 'human', email: 'pete@example.com', name: 'Pete' },
    }, { email: 'ivan@example.com', name: 'Ivan' })).rejects.toThrow(/names two people/);
  });

  test('the refusal names both people and how to decide', async () => {
    const attempt = createRecoveredAgentTurn(storage, {
      sessionId,
      sequence: await storage.getNextTurnSequence(sessionId),
      role: 'agent',
      content: 'x',
      actor: { role: 'human', email: 'pete@example.com' },
    }, { email: 'ivan@example.com' });

    await expect(attempt).rejects.toThrow(/pete@example\.com/);
    await expect(attempt).rejects.toThrow(/ivan@example\.com/);
  });

  // The two coherent shapes both still work. An ACTION row carries its actor
  // whole and takes no owner; a TURN row carries the owner and an actor that
  // names only a channel.
  test('an action row keeps the actor it was given, person and all', async () => {
    const turn = await createRecoveredAgentTurn(storage, {
      sessionId,
      sequence: await storage.getNextTurnSequence(sessionId),
      role: 'agent',
      content: '[Ask stopped]\n\nStopped by user: never mind',
      actor: { role: 'human', email: 'pete@example.com', name: 'Pete' },
    }, null);

    expect(turn.actor).toBe('human');
    expect(turn.actor_email).toBe('pete@example.com');
    expect(turn.actor_name).toBe('Pete');
  });

  test('the same person in both arguments is one fact, not two', async () => {
    const turn = await createRecoveredAgentTurn(storage, {
      sessionId,
      sequence: await storage.getNextTurnSequence(sessionId),
      role: 'agent',
      content: 'x',
      // Canonically the same address — the comparison folds case, as every
      // identity comparison in this repo does.
      actor: { role: 'agent', email: 'Ivan@Example.com' },
    }, { email: 'ivan@example.com', name: 'Ivan' });

    expect(turn.actor_email).toBe('ivan@example.com');
  });

  test('turnOwnerOfClaim reads the pair an in-flight claim captured', () => {
    expect(turnOwnerOfClaim(null)).toBeNull();
    expect(turnOwnerOfClaim({})).toBeNull();
    expect(turnOwnerOfClaim({ turn_owner_email: 'ivan@example.com' })).toEqual({ email: 'ivan@example.com' });
    expect(turnOwnerOfClaim({ turn_owner_email: 'ivan@example.com', turn_owner_name: 'Ivan' }))
      .toEqual({ email: 'ivan@example.com', name: 'Ivan' });
  });
});

/**
 * INVARIANT: a review conversation never touches the task's turn owner.
 *
 * The builder behind a review conversation spends the REVIEWER's credential,
 * and it used to say so by writing the reviewer into the task's pending-owner
 * record — which was harmless while that record only chose a credential. It
 * now also decides a NAME. So while a reviewer had a conversation open, an
 * auto-deliver or auto-resume for the same task found the reviewer sitting in
 * that record and durably stamped THEM on a turn nobody asked for: the §3.3
 * case 3 inheritance the clearing direction exists to prevent, reached through
 * a door the clearing cannot see, because the record is present-but-wrong
 * rather than absent.
 *
 * The reverse bit too: releasing the review turn cleared a pending owner that a
 * real concurrent unblock had just written, turning a person's turn into a
 * system-initiated one.
 */
describe('a review conversation never takes the task\'s turn owner', () => {
  let storage: FileStorage;
  let lazyRoot: string;
  let basePath: string;
  let daemonBaseDir: string;
  let restoreDaemonBaseDir: (() => void) | undefined;
  let taskId: string;
  let sessionId: string;

  beforeEach(async () => {
    daemonBaseDir = await makeDaemonBaseDir();
    restoreDaemonBaseDir = pinDaemonBaseDir(daemonBaseDir);
    lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-review-owner-root-'));
    basePath = await mkdtemp(join(tmpdir(), 'lazy-review-owner-store-'));
    storage = new FileStorage(lazyRoot, { basePath });
    await storage.initialize();
    const task = await storage.createTask('Review conversation attribution test');
    taskId = task.id;
    const session = await storage.createSession(task.id, 'claude-code', 'lazy/rc', 'abc123');
    sessionId = session.id;
  });

  afterEach(async () => {
    await storage.close();
    await Promise.all([
      rm(lazyRoot, { recursive: true, force: true }),
      rm(basePath, { recursive: true, force: true }),
    ]);
    restoreDaemonBaseDir?.();
    await removeDaemonBaseDir(daemonBaseDir);
  });

  // A launch that runs BESIDE the task says who pays and nothing else. It must
  // not clear the owner of the turn the task is actually running either — the
  // review session id is not one of the task's sessions.
  //
  // Asserted against the task's REAL session id, which the review path never
  // passes — deliberately, so the assertion is about the `spender` rule itself
  // rather than about a review session id happening to resolve to nothing. A
  // launch that names its payer records no turn owner at all: not the payer,
  // and not the null that would wipe the owner of the turn the task is running.
  test('a spender records no turn owner and leaves the task\'s own alone', async () => {
    await storage.setSessionTurnOwner(sessionId, { email: 'ivan@example.com', name: 'Ivan' });

    await planTurnCredential(lazyRoot, {
      taskId,
      sessionId,
      storage,
      spender: { email: 'reviewer@example.com' },
    });

    expect(await sessionTurnOwner(storage, sessionId)).toEqual({ email: 'ivan@example.com', name: 'Ivan' });
  });

  // And it leaves the PENDING owner alone in both directions: it becomes none,
  // and its release does not take away the owner of a concurrent unblock —
  // here, one whose request the review launch runs inside.
  test("a review launch neither takes nor drops a member request's owner", async () => {
    await runAsTurnOwnerRequest({ taskId, owner: { email: 'ivan@example.com', spendable: true } }, async () => {
      await planTurnCredential(lazyRoot, {
        taskId,
        sessionId: 'review-session-id',
        storage,
        spender: { email: 'reviewer@example.com' },
      });
      expect(getPendingTurnOwner(taskId)?.email).toBe('ivan@example.com');

      await releaseTurnCredential(lazyRoot, taskId);
      expect(getPendingTurnOwner(taskId)?.email).toBe('ivan@example.com');
    });
  });

  // INVARIANT: a pending owner exists only inside the request that asked for
  // the turn — no release, clear or request-end bookkeeping is needed for it to
  // be gone, and a launch outside that request (a turn the daemon starts by
  // itself) records NO asker. It replaces "an ordinary release forgets the
  // pending owner", which guarded a shared per-task record that has been
  // removed: that record billed a member for any daemon-started turn on the
  // task while their request was in flight.
  test("a launch outside the member's request records no asker", async () => {
    await runAsTurnOwnerRequest({ taskId, owner: { email: 'ivan@example.com', spendable: true } }, async () => {
      expect(getPendingTurnOwner(taskId)?.email).toBe('ivan@example.com');
      // A different task inside Ivan's request is not Ivan's either.
      expect(getPendingTurnOwner('another-task')).toBeNull();
    });
    expect(getPendingTurnOwner(taskId)).toBeNull();

    await storage.setSessionTurnOwner(sessionId, { email: 'ivan@example.com', name: 'Ivan' });
    await planTurnCredential(lazyRoot, { taskId, sessionId, storage });
    const session = await storage.getSession(sessionId);
    expect(session?.turn_owner_email ?? null).toBeNull();
    expect(session?.turn_system_initiated).toBe(true);
  });

  // The launch path itself, asserted at the source because reaching it
  // behaviourally means admitting a builder slot and starting a container. Same
  // idiom as the reconcile ordering guard.
  test('the review-session launch uses the spender seam, not the task record', async () => {
    const source = await readFile('src/daemon/review-session-builder-turn.ts', 'utf-8');

    expect(source).not.toContain('setTurnOwner(');
    expect(source).toContain('spender:');
    // Nor does it run as, or read, the owner of a request on the task.
    expect(source).not.toContain('runAsTurnOwnerRequest');
    expect(source).not.toContain('PendingTurnOwner');
  });
});

describe('the MCP channel actor', () => {
  const taskCtx = (person?: { email: string; name?: string }): McpToolContext => ({
    taskId: 'task-uuid',
    worktreePath: '/tmp/wt',
    ...(person ? { actorPerson: person } : {}),
  });

  test("a task agent's write names the channel and the turn owner", () => {
    expect(mcpActor(taskCtx({ email: 'ivan@example.com', name: 'Ivan' })))
      .toEqual({ role: 'agent', email: 'ivan@example.com', name: 'Ivan' });
  });

  // INVARIANT: with no person resolved, this is the bare role it always was.
  // Every MCP context built outside the daemon takes this path, and a bare role
  // is also the only thing that may travel on an RPC request — a person on the
  // wire is a 403 (`applyCallerActor`).
  test('without a resolved person it is the bare role, as before', () => {
    expect(mcpActor(taskCtx())).toBe('agent');
    expect(mcpActor({ taskId: '', worktreePath: '/tmp/wt' })).toBe('builder');
  });

  // The builder is §3.3 case 1, a different question with a different answer
  // (the human at the interactive session, not a turn owner), and it is not
  // this mechanism's to answer.
  test('the builder surface is not attributed from a task turn owner', () => {
    expect(mcpActor({ taskId: '', worktreePath: '/tmp/wt', actorPerson: { email: 'ivan@example.com' } }))
      .toEqual({ role: 'builder', email: 'ivan@example.com' });
  });

  // INVARIANT: this door carries the CHANNEL and the asker, and deliberately
  // not the configured system identity a turn nobody asked for records on its
  // own rows: `actor` here is read as the channel by code that decides
  // behaviour (a loop telling its own agent's children from a human's), so the
  // `system` role may not travel through it until those readers agree.
  test('a turn nobody asked for still resolves no person here', () => {
    expect(mcpActor(taskCtx())).toBe('agent');
  });

  test('mcpRole is the channel alone, for rows with no person column', () => {
    expect(mcpRole(taskCtx({ email: 'ivan@example.com' }))).toBe('agent');
    expect(mcpRole({ taskId: '', worktreePath: '/tmp/wt' })).toBe('builder');
  });
});

/**
 * INVARIANT: every `role: 'agent'` turn is written through `createAgentTurn`.
 *
 * A source scan rather than a behavioural test because the failure is one call
 * site out of sixteen, added later, in a file nobody re-reads: an agent turn
 * written straight to `storage.createTurn` is silently unattributed, and
 * nothing downstream can tell that from a turn nobody asked for. Same shape as
 * the other completeness guards in this repo, and for the same reason.
 */
describe('no agent turn bypasses the attribution helper', () => {
  test('src/ writes agent turns only through createAgentTurn', async () => {
    const offenders: string[] = [];

    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(path);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        // The helper itself is where the one permitted `storage.createTurn`
        // for an agent turn lives.
        if (path.endsWith(join('daemon', 'turn-owner.ts'))) continue;

        const lines = (await readFile(path, 'utf-8')).split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (!/\.createTurn\(\{/.test(lines[i])) continue;
          const window = lines.slice(i, i + 16).join('\n');
          if (/role: 'agent'/.test(window)) offenders.push(`${path}:${i + 1}`);
        }
      }
    }

    await walk('src');

    expect(offenders).toEqual([]);
  });

  // A scan whose pattern stops matching passes by finding nothing. Assert it
  // still SEES the real call sites it is meant to police — through EITHER
  // helper, since a late recorder deliberately uses the explicit-owner one.
  test('the scan still finds the agent-turn call sites it guards', async () => {
    const found: string[] = [];
    for (const file of ['src/utils/reconcile.ts', 'src/daemon/task-lifecycle.ts']) {
      const lines = (await readFile(file, 'utf-8')).split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!/create(Recovered)?AgentTurn\(storage, \{/.test(lines[i])) continue;
        const window = lines.slice(i, i + 16).join('\n');
        if (/role: 'agent'/.test(window)) found.push(`${file}:${i + 1}`);
      }
    }

    // Reconcile settles a turn's outcome and task-lifecycle launches them;
    // between them they write every agent turn there is.
    expect(found.length).toBeGreaterThanOrEqual(10);
  });

  // Both helpers are permitted; what is NOT permitted is reaching
  // storage.createTurn directly with role 'agent'. Assert the late recorders
  // are actually using the explicit-owner one, so a future edit that "tidies"
  // them back to the session-reading helper fails here rather than silently
  // renaming somebody's work.
  test('the late recorders use the explicit-owner helper', async () => {
    const reconcile = await readFile('src/utils/reconcile.ts', 'utf-8');
    const lifecycle = await readFile('src/daemon/task-lifecycle.ts', 'utf-8');

    // The superseded sweep and its supervised follow-ups, and the two claim
    // settlers — each recorded for a turn that is already over.
    expect((reconcile.match(/createRecoveredAgentTurn\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect((lifecycle.match(/createRecoveredAgentTurn\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
