/**
 * Unit tests: handing comments queued during a running work turn to that turn
 * (src/daemon/turn-comments.ts) — the daemon's half of the supervisor's
 * end-of-turn notes check.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';
import type { Task } from '../../src/types';
import { claimPendingNotesForRunningTurn, acknowledgePendingNotes, requireSupervisorCredential } from '../../src/daemon/turn-comments';
import { mintNotesSecret, verifyNotesSecret } from '../../src/protocol/notes-secret';
import { getNonHumanTurnCount } from '../../src/daemon/turn-budget';
import { raceWait } from '../../src/daemon/wait-race';

describe('comments queued during a running turn', () => {
  let storage: FileStorage;
  let lazyRoot: string;
  let basePath: string;
  let task: Task;
  let sessionId: string;

  async function fresh(): Promise<Task> {
    return (await storage.getTask(task.id))!;
  }

  beforeEach(async () => {
    lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-tc-root-'));
    basePath = await mkdtemp(join(tmpdir(), 'lazy-tc-store-'));
    await writeFile(join(lazyRoot, 'lazy.toml'), '[limits]\nmax_turns_without_human = 2\n');
    storage = new FileStorage(lazyRoot, { basePath });
    await storage.initialize();
    task = await storage.createTask('Turn comments test');
    const session = await storage.createSession(task.id, 'claude-code', 'lazy/tc', 'abc123');
    sessionId = session.id;
    // The turn launched (and delivered everything before it) at t=1000.
    await storage.markNotesDelivered(sessionId, 1000);
    await storage.updateTaskStatus(task.id, 'working');
  });

  afterEach(async () => {
    await storage.close();
    await Promise.all([
      rm(lazyRoot, { recursive: true, force: true }),
      rm(basePath, { recursive: true, force: true }),
    ]);
  });

  test('nothing queued answers none and spends no budget', async () => {
    expect((await claimPendingNotesForRunningTurn(storage, lazyRoot, await fresh())).kind).toBe('none');
    expect(await getNonHumanTurnCount(storage, task.id)).toBe(0);
  });

  // INVARIANT: notes are marked delivered only on ACKNOWLEDGEMENT, never on
  // claim — an invocation that fails must leave them queued for the next turn.
  // Human feedback is never lost.
  test('a claim returns the unblock notes block without marking it delivered', async () => {
    await storage.createComment(task.id, 'Handle the empty input case', 'human');
    const claim = await claimPendingNotesForRunningTurn(storage, lazyRoot, await fresh());
    expect(claim.kind).toBe('notes');
    if (claim.kind !== 'notes') return;
    expect(claim.notes).toContain('NOTES ADDED SINCE YOUR LAST TURN:');
    expect(claim.notes).toContain('Handle the empty input case');
    expect((await storage.getSession(sessionId))?.notes_delivered_through).toBe(1000);

    expect((await acknowledgePendingNotes(storage, await fresh(), claim.through, claim.claim_id)).kind).toBe('acknowledged');
    expect((await storage.getSession(sessionId))?.notes_delivered_through).toBe(claim.through);
    expect((await claimPendingNotesForRunningTurn(storage, lazyRoot, await fresh())).kind).toBe('none');
  });

  // INVARIANT: every hand-off counts against [limits] max_turns_without_human,
  // and past it the notes stay QUEUED — something that comments all the time
  // cannot keep a turn alive forever, and nothing is dropped.
  test('hand-offs are bounded by max_turns_without_human', async () => {
    for (let i = 1; i <= 2; i++) {
      await storage.createComment(task.id, `comment ${i}`, 'human');
      const claim = await claimPendingNotesForRunningTurn(storage, lazyRoot, await fresh());
      expect(claim.kind).toBe('notes');
      if (claim.kind === 'notes') await acknowledgePendingNotes(storage, await fresh(), claim.through, claim.claim_id);
    }
    await storage.createComment(task.id, 'comment 3', 'human');
    const refused = await claimPendingNotesForRunningTurn(storage, lazyRoot, await fresh());
    expect(refused.kind).toBe('budget_exhausted');
    expect(await getNonHumanTurnCount(storage, task.id)).toBe(2);
  });

  // INVARIANT: lazy's own notices (`[Subtask accepted]` and the like) never
  // keep a turn going by themselves — a cluster accepting its own children
  // would otherwise spend its whole budget talking to itself.
  test('system notices alone do not trigger a hand-off, but ride along', async () => {
    await storage.createComment(task.id, '[Subtask accepted] child — merged', 'system');
    expect((await claimPendingNotesForRunningTurn(storage, lazyRoot, await fresh())).kind).toBe('none');
    expect(await getNonHumanTurnCount(storage, task.id)).toBe(0);

    await storage.createComment(task.id, 'Also update the docs', 'builder');
    const claim = await claimPendingNotesForRunningTurn(storage, lazyRoot, await fresh());
    expect(claim.kind).toBe('notes');
    if (claim.kind !== 'notes') return;
    expect(claim.notes).toContain('[Subtask accepted]');
    expect(claim.notes).toContain('Also update the docs');
  });

  // INVARIANT: an acknowledgement can never move the delivery mark past the
  // newest existing comment. The mark is monotonic, so a far-future value
  // would silently hide every comment written afterwards — lost feedback.
  test('an acknowledgement past the newest comment is refused and moves nothing', async () => {
    await storage.createComment(task.id, 'real comment', 'human');
    await expect(acknowledgePendingNotes(storage, await fresh(), 9e15, "x")).rejects.toThrow(/past the newest comment/);
    expect((await storage.getSession(sessionId))?.notes_delivered_through).toBe(1000);
  });

  // INVARIANT: forge/CI comments have their own auto-react delivery; they
  // must not trigger a mid-turn hand-off alone, or they are delivered twice.
  test('forge-imported comments alone do not trigger a hand-off', async () => {
    await storage.createComment(task.id, '[PR #1 @x] please rename', 'human', 'remote');
    expect((await claimPendingNotesForRunningTurn(storage, lazyRoot, await fresh())).kind).toBe('none');
  });

  // INVARIANT: only a running WORK turn may take a task's notes — a parked
  // task's notes wait for the unblock that delivers them.
  test('a task that is not working cannot take its notes', async () => {
    await storage.createComment(task.id, 'queued', 'human');
    await storage.updateTaskStatus(task.id, 'blocked');
    expect((await claimPendingNotesForRunningTurn(storage, lazyRoot, await fresh())).kind).toBe('no_work_turn');
    expect((await acknowledgePendingNotes(storage, await fresh(), 99_999_999_999_999, "x")).kind).toBe('no_work_turn');
    expect(await getNonHumanTurnCount(storage, task.id)).toBe(0);
  });

  // INVARIANT: an acknowledgement is bound to the claim that carried the notes
  // and accepted once. The task token is reachable by the agent and any process
  // in its container; without the binding, anything holding it could mark human
  // comments delivered that no agent received — lost feedback, and accept's
  // undelivered-feedback gate bypassed.
  test('an acknowledgement without the claim nonce is refused; a replay too', async () => {
    await storage.createComment(task.id, 'Please also test X', 'human');
    const newest = (await storage.getTaskComments(task.id))[0]!.created_at;
    await expect(acknowledgePendingNotes(storage, await fresh(), newest, 'forged')).rejects.toThrow(/No outstanding hand-off/);
    expect((await storage.getSession(sessionId))?.notes_delivered_through).toBe(1000);

    const claim = await claimPendingNotesForRunningTurn(storage, lazyRoot, await fresh());
    if (claim.kind !== 'notes') throw new Error('expected notes');
    await expect(acknowledgePendingNotes(storage, await fresh(), claim.through, 'forged')).rejects.toThrow(/No outstanding hand-off/);
    expect((await acknowledgePendingNotes(storage, await fresh(), claim.through, claim.claim_id)).kind).toBe('acknowledged');
    await expect(acknowledgePendingNotes(storage, await fresh(), claim.through, claim.claim_id)).rejects.toThrow(/No outstanding hand-off/);
  });

  // INVARIANT: claiming the same batch again spends no budget. Otherwise
  // anything holding the task token could burn max_turns_without_human by
  // claiming repeatedly.
  test('repeated claims of one batch count once', async () => {
    await storage.createComment(task.id, 'one', 'human');
    const a = await claimPendingNotesForRunningTurn(storage, lazyRoot, await fresh());
    const b = await claimPendingNotesForRunningTurn(storage, lazyRoot, await fresh());
    const c = await claimPendingNotesForRunningTurn(storage, lazyRoot, await fresh());
    expect(a.kind === 'notes' && b.kind === 'notes' && c.kind === 'notes' && a.claim_id === c.claim_id).toBe(true);
    expect(await getNonHumanTurnCount(storage, task.id)).toBe(1);
  });
});

describe('the supervisor credential for comment hand-offs', () => {
  const task = { id: 'task-a', code: 'a' } as unknown as Task;

  // INVARIANT: the per-task MCP token (held by the agent and every process in its
  // container) is not enough to claim or acknowledge comments; only the secret the
  // turn's command carried is. Otherwise a token holder could mark human feedback
  // delivered that no agent received.
  test('a holder of only the task token (no secret) is refused', () => {
    expect(() => requireSupervisorCredential(task, {})).toThrow(/Only the supervisor/);
    expect(() => requireSupervisorCredential(task, { command_id: 'c1' })).toThrow(/Only the supervisor/);
    expect(() => requireSupervisorCredential(task, { command_id: 'c1', notes_secret: 'deadbeef' })).toThrow(/Only the supervisor/);
  });

  test('a secret minted for another task or command is refused', () => {
    const s = mintNotesSecret('task-a', 'c1');
    expect(verifyNotesSecret('task-b', 'c1', s)).toBe(false);
    expect(verifyNotesSecret('task-a', 'c2', s)).toBe(false);
  });

  // INVARIANT: a secret is good only for the newest command written for the
  // task (the live turn's); one from an earlier command is refused.
  test('a secret from an earlier command is refused once a newer command is written', () => {
    const old = mintNotesSecret('task-a', 'c1');
    const fresh = mintNotesSecret('task-a', 'c2');
    expect(verifyNotesSecret('task-a', 'c1', old)).toBe(false);
    expect(verifyNotesSecret('task-a', 'c2', fresh)).toBe(true);
  });

  test('the secret minted for this task and command is accepted', () => {
    expect(() => requireSupervisorCredential(task, { command_id: 'c1', notes_secret: mintNotesSecret('task-a', 'c1') })).not.toThrow();
  });
});

describe('lazy_wait comment interruption over the real claim', () => {
  let storage: FileStorage;
  let lazyRoot: string;
  let basePath: string;
  let waiter: Task;
  let child: Task;

  beforeEach(async () => {
    lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-wc-root-'));
    basePath = await mkdtemp(join(tmpdir(), 'lazy-wc-store-'));
    await writeFile(join(lazyRoot, 'lazy.toml'), '[limits]\nmax_turns_without_human = 3\n');
    storage = new FileStorage(lazyRoot, { basePath });
    await storage.initialize();
    waiter = await storage.createTask('Waiter');
    const ws = await storage.createSession(waiter.id, 'claude-code', 'lazy/w', 'abc');
    await storage.markNotesDelivered(ws.id, 1000);
    await storage.updateTaskStatus(waiter.id, 'working');
    child = await storage.createTask('Child', undefined, waiter.id);
    await storage.createSession(child.id, 'claude-code', 'lazy/c', 'abc');
    await storage.updateTaskStatus(child.id, 'working');
  });

  afterEach(async () => {
    await storage.close();
    await Promise.all([rm(lazyRoot, { recursive: true, force: true }), rm(basePath, { recursive: true, force: true })]);
  });

  const claimHook = () => async () => {
    const answer = await claimPendingNotesForRunningTurn(storage, lazyRoot, (await storage.getTask(waiter.id))!);
    return answer.kind === 'notes' ? { notes: answer.notes, count: answer.count, through: answer.through, claim_id: answer.claim_id } : null;
  };

  // INVARIANT: system notices (what the waiter's own accepts/creates write) never
  // interrupt a wait; a human or builder comment does, and delivery happens once.
  test('system notices are ignored; a builder comment interrupts, then is delivered exactly once', async () => {
    await storage.createComment(waiter.id, '[Subtask added] child', 'system');
    setTimeout(() => { void storage.createComment(waiter.id, 'Engineer decided: use option B', 'builder'); }, 60);

    const result = await raceWait(storage, [child.id], { timeoutSecs: 5, pollIntervalMs: 20, claimComments: claimHook() });

    expect(result.interrupted?.reason).toBe('comment_added');
    expect(result.interrupted?.notes).toContain('Engineer decided: use option B');
    // Claimed but not yet marked: delivery is acknowledged separately.
    const sessionId = (await storage.getSessionByTaskId(waiter.id))!.id;
    expect((await storage.getSession(sessionId))?.notes_delivered_through).toBe(1000);

    const claim = result.interrupted!.claim!;
    await acknowledgePendingNotes(storage, (await storage.getTask(waiter.id))!, claim.through, claim.claim_id);
    expect((await claimPendingNotesForRunningTurn(storage, lazyRoot, (await storage.getTask(waiter.id))!)).kind).toBe('none');

    // Nothing left: the next wait runs to its timeout.
    const again = await raceWait(storage, [child.id], { timeoutSecs: 0.2, pollIntervalMs: 20, claimComments: claimHook() });
    expect(again.timed_out).toBe(true);
    expect(again.interrupted).toBeUndefined();
  });

  test('a human comment interrupts too, and counts against the turn budget', async () => {
    setTimeout(() => { void storage.createComment(waiter.id, 'human says stop', 'human'); }, 60);
    const result = await raceWait(storage, [child.id], { timeoutSecs: 5, pollIntervalMs: 20, claimComments: claimHook() });
    expect(result.interrupted?.notes).toContain('human says stop');
    expect(await getNonHumanTurnCount(storage, waiter.id)).toBe(1);
  });

  // INVARIANT: a claim nobody acknowledged (the answer never reached the agent)
  // marks nothing delivered, and the next wait re-issues the SAME claim without
  // spending budget again — at-least-once, never lost.
  test('an unacknowledged claim is re-issued uncounted and moves no mark', async () => {
    await storage.createComment(waiter.id, 'please read me', 'builder');
    const first = await raceWait(storage, [child.id], { timeoutSecs: 5, pollIntervalMs: 20, claimComments: claimHook() });
    const sessionId = (await storage.getSessionByTaskId(waiter.id))!.id;
    expect((await storage.getSession(sessionId))?.notes_delivered_through).toBe(1000);

    const again = await raceWait(storage, [child.id], { timeoutSecs: 5, pollIntervalMs: 20, claimComments: claimHook() });
    expect(again.interrupted?.claim?.claim_id).toBe(first.interrupted?.claim?.claim_id);
    expect(await getNonHumanTurnCount(storage, waiter.id)).toBe(1);
  });

  // INVARIANT: with the turn budget spent the wait is NOT interrupted and the
  // comment stays queued for a person's unblock.
  test('a spent budget leaves the wait running and the comment queued', async () => {
    for (let i = 1; i <= 3; i++) {
      await storage.createComment(waiter.id, `c${i}`, 'human');
      const r = await claimPendingNotesForRunningTurn(storage, lazyRoot, (await storage.getTask(waiter.id))!);
      if (r.kind !== 'notes') throw new Error('expected notes');
      await acknowledgePendingNotes(storage, (await storage.getTask(waiter.id))!, r.through, r.claim_id);
    }
    await storage.createComment(waiter.id, 'too many', 'human');
    const result = await raceWait(storage, [child.id], { timeoutSecs: 0.3, pollIntervalMs: 20, claimComments: claimHook() });
    expect(result.timed_out).toBe(true);
    expect(result.interrupted).toBeUndefined();
  });
});
