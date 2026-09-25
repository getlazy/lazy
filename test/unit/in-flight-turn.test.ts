/**
 * The in-flight turn record, and the correlation it makes possible.
 *
 * INVARIANT: `ask` and `review` are the turns the daemon runs outside the
 * reconciler's ordinary "park the task and move on" flow, because their answer
 * has a designated reader and a reserved turn sequence (the mechanical
 * acceptance gate is synchronous too, but it waits on the response FILE and
 * holds no record at all). Every other turn is flushed fire-and-forget by the
 * reconciler. `pre_accept` and `wrap_up` are RETIRED owners: the type keeps
 * them so a legacy record can be READ and abandoned, never written. Those owners used to race over one unaddressed mailbox
 * (`~/.lazy/protocol/<taskId>/response.json` carries no command id), and the
 * reconciler always won: it recorded the turn, parked the task and deleted the
 * file while the synchronous caller polled for a file that no longer existed,
 * until its budget expired.
 *
 * The exclusion cannot come from the worktree lock — `checkLock` is
 * deliberately pid-re-entrant and the reconcile loop runs in the SAME daemon
 * process that holds it — nor from task status, which describes what the task
 * looks like NOW rather than what is running. It comes from a persisted record
 * on the task naming the RESERVED turn sequence the answer must occupy. These
 * tests pin the three properties that record has to have:
 *
 *   - it excludes other writers while it is live, and only while it is live;
 *   - the reconciler SETTLES a turn that has a waiter instead of parking it,
 *     and an ordinary turn with no record still reconciles exactly as before
 *     (a guard that skipped everything would otherwise look like a pass);
 *   - a response that is not this turn's answer is refused by sequence, and a
 *     retired `pre_accept` record — possible only as a pre-rename leftover —
 *     is abandoned, never recorded.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';
import { reconcileTasks } from '../../src/utils/reconcile';
import { settleInFlightTurnFromProtocol } from '../../src/daemon/task-lifecycle';
import { isInFlightLive, isTurnInFlight, expiredSyncRestore, IN_FLIGHT_SETTLED_GRACE_MS } from '../../src/daemon/in-flight-turn';
import { protocolDir as getProtocolDir, writeResponse, hasResponse, newCommandId } from '../../src/protocol';
import type { CompletedResponse } from '../../src/protocol';
import type { InFlightTurn, InFlightTurnOwner } from '../../src/types';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { pinConfig } from '../helpers/pin-config';

// This suite calls production code (reconcileTasks) IN-PROCESS — see CLAUDE.md.
enableInProcessTestMode();

function git(cwd: string, ...args: string[]): string {
  const result = spawnSyncUnsupervised(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return result.stdout?.toString().trim() ?? '';
}

interface Env {
  lazyRoot: string;
  storage: FileStorage;
  cleanup: () => Promise<void>;
}

/**
 * Minimal project config. `reconcileTasks` builds a Runner from `loadConfig`,
 * which walks UP from cwd — lazy's OWN worktree under `bun test` — so without a
 * pin this suite silently adopts the developer's live lazy.toml (CLAUDE.md,
 * "In-process daemons → pin LAZY_CONFIG"). The docker runner never gets used:
 * every case here returns on the response branch, before any liveness probe.
 */
const PROJECT_TOML = `[runner]
type = "docker"

[agent]
agent_id = "claude-code"
`;

async function setupEnv(): Promise<Env> {
  const lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-inflight-root-'));
  const basePath = await mkdtemp(join(tmpdir(), 'lazy-inflight-store-'));

  git(lazyRoot, 'init');
  git(lazyRoot, 'config', 'user.email', 'test@lazy.test');
  git(lazyRoot, 'config', 'user.name', 'Lazy Test');
  git(lazyRoot, 'checkout', '-b', 'main');
  await writeFile(join(lazyRoot, 'README.md'), '# base\n');
  git(lazyRoot, 'add', '.');
  git(lazyRoot, 'commit', '-m', 'base');

  await writeFile(join(lazyRoot, 'lazy.toml'), PROJECT_TOML);
  const unpinConfig = pinConfig(lazyRoot);

  const storage = new FileStorage(lazyRoot, { basePath });
  await storage.initialize();

  return {
    lazyRoot,
    storage,
    cleanup: async () => {
      unpinConfig();
      await storage.close();
      await Promise.all([
        rm(lazyRoot, { recursive: true, force: true }),
        rm(basePath, { recursive: true, force: true }),
      ]);
    },
  };
}

/**
 * A `working` task with a finished response on disk — the exact state a
 * mid-ask task is in the instant the supervisor answers.
 */
async function workingTaskWithResponse(
  env: Env,
  response?: Partial<CompletedResponse>,
  commandId?: string,
) {
  const baseSha = git(env.lazyRoot, 'rev-parse', 'HEAD');
  const task = await env.storage.createTask('Validate before merge', undefined, baseSha);
  const session = await env.storage.createSession(task.id, 'claude-code', `lazy/${task.id}`, baseSha);
  await env.storage.updateTaskStatus(task.id, 'working', 'system');

  const protoDir = getProtocolDir(task.id);
  await mkdir(protoDir, { recursive: true });
  writeResponse(protoDir, {
    status: 'completed',
    result: 'the answer from the turn',
    session_id: 'agent-session-preaccept',
    usage: { input_tokens: 0, output_tokens: 0 },
    ...(commandId ? { command_id: commandId } : {}),
    ...response,
  } as CompletedResponse);

  return { task, session, protoDir };
}

/** Claim the task the way `claimSyncTurn` does, without the RPC layer around it. */
async function claim(
  env: Env,
  taskId: string,
  sessionId: string,
  owner: InFlightTurnOwner,
  overrides: Partial<InFlightTurn> = {},
): Promise<InFlightTurn> {
  const first = await env.storage.reserveTurnSequences(sessionId, 2);
  await env.storage.createTurn({
    sessionId,
    sequence: first,
    role: 'human',
    content:
      owner === 'ask'
        ? '[system] Answering your question'
        : '[system] Pre-accept validation before merge',
    actor: 'system',
    turnType: owner === 'ask' ? 'ask' : 'pre_accept',
  });
  const now = Date.now();
  const commandId = overrides.command_id ?? newCommandId();
  const record: InFlightTurn = {
    session_id: sessionId,
    owner,
    turn_type: owner === 'ask' ? 'ask' : 'pre_accept',
    command_id: commandId,
    turn_sequence: first + 1,
    human_turn_sequence: first,
    restore_status: 'blocked',
    started_at: now,
    expires_at: now + 10 * 60 * 1000,
    ...overrides,
  };
  const ok = await env.storage.beginInFlightTurn(taskId, record);
  expect(ok).toBe(true);
  return record;
}

describe('in-flight turn state', () => {
  let env: Env;

  beforeEach(async () => { env = await setupEnv(); });
  afterEach(async () => { await env.cleanup(); });

  // CONTROL: with no record the reconciler behaves exactly as it always has.
  // Without this, a guard that skipped every task would look like a pass.
  test('a task with NO in-flight record still has its response reconciled', async () => {
    const { task, session, protoDir } = await workingTaskWithResponse(env);
    const seq = await env.storage.getNextTurnSequence(session.id);
    await env.storage.createTurn({
      sessionId: session.id, sequence: seq, role: 'human', content: 'do the thing', actor: 'human',
    });

    expect(await isTurnInFlight(env.storage, task.id)).toBe(false);
    await reconcileTasks(env.storage, env.lazyRoot);

    expect(hasResponse(protoDir)).toBe(false);
    const after = await env.storage.getTask(task.id);
    expect(after?.status).not.toBe('working');
  });

  test('the reconciler SETTLES a turn that has a waiter instead of parking it', async () => {
    const recordCommandId = newCommandId();
    const { task, session, protoDir } = await workingTaskWithResponse(env, {
      result: 'the answer',
    }, recordCommandId);
    const record = await claim(env, task.id, session.id, 'ask', { command_id: recordCommandId });

    await reconcileTasks(env.storage, env.lazyRoot);

    const after = await env.storage.getTask(task.id);
    // The agent turn landed at the sequence that was reserved for it, not
    // wherever `getNextTurnSequence` happened to point. Ask waits on the
    // recorded TURN — durable — so nothing is lost by releasing the record.
    const turns = await env.storage.getSessionTurns(session.id);
    const agentTurn = turns.find(t => t.role === 'agent');
    expect(agentTurn?.sequence).toBe(record.turn_sequence);
    // The response is consumed, and the task went back to where it came from
    // rather than being parked by the reconciler's ordinary path.
    expect(hasResponse(protoDir)).toBe(false);
    expect(after?.status).toBe('blocked');
    // The record is released with the turn recorded: ask/review hold it only
    // while the turn is live.
    expect(after?.in_flight_turn ?? null).toBeNull();
  });

  // INVARIANT (retirement): the pre-accept agent turn is retired — the
  // mechanical acceptance gate runs at accept and files no turn. A live
  // `pre_accept` record can only be legacy (a pre-rename supervisor finishing
  // an accept its own, pre-rename daemon can no longer complete), so it is
  // ABANDONED: the response is consumed without being recorded, the task is
  // restored, and the record is released. Nothing the retired turn wrote may
  // stand in for a merge this daemon never ran the gate for.
  test('a legacy pre_accept record is abandoned, not recorded', async () => {
    const recordCommandId = newCommandId();
    const { task, session, protoDir } = await workingTaskWithResponse(env, {
      result: 'the retired turn\'s answer',
    }, recordCommandId);
    const record = await claim(env, task.id, session.id, 'pre_accept', { command_id: recordCommandId });

    const verdict = await settleInFlightTurnFromProtocol(
      env.storage, task, session, record, env.lazyRoot,
    );

    expect(verdict).toBe('settled');
    const after = await env.storage.getTask(task.id);
    // Nothing was recorded as a turn...
    const turns = await env.storage.getSessionTurns(session.id);
    expect(turns.some(t => t.role === 'agent')).toBe(false);
    // ...the response is CONSUMED (its verdict must never validate a merge)...
    expect(hasResponse(protoDir)).toBe(false);
    // ...the task is restored to where it came from...
    expect(after?.status).toBe('blocked');
    // ...and the record is released — no waiter exists to read an outcome.
    expect(after?.in_flight_turn ?? null).toBeNull();
  });

  // INVARIANT (retirement): the SAME treatment for `wrap_up`, and it is the
  // same branch — the standalone wrap-up turn behind `lazy finalize` is gone,
  // so a live record can only be a pre-removal daemon's. Asserted separately
  // from `pre_accept` because the two were once separate branches, and the
  // collapse into one owner set must not quietly drop either owner.
  test('a legacy wrap_up record is abandoned, not recorded', async () => {
    const recordCommandId = newCommandId();
    const { task, session, protoDir } = await workingTaskWithResponse(env, {
      result: 'the retired wrap-up\'s answer',
    }, recordCommandId);
    const record = await claim(env, task.id, session.id, 'wrap_up', { command_id: recordCommandId });

    const verdict = await settleInFlightTurnFromProtocol(
      env.storage, task, session, record, env.lazyRoot,
    );

    expect(verdict).toBe('settled');
    const after = await env.storage.getTask(task.id);
    const turns = await env.storage.getSessionTurns(session.id);
    expect(turns.some(t => t.role === 'agent')).toBe(false);
    expect(hasResponse(protoDir)).toBe(false);
    expect(after?.status).toBe('blocked');
    expect(after?.in_flight_turn ?? null).toBeNull();
  });

  test('a response whose command id does not match is foreign', async () => {
    const recordCommandId = newCommandId();
    const { task, session, protoDir } = await workingTaskWithResponse(env, {
      result: 'some other command\'s answer',
      accept_gate: { passed: true },
    }, newCommandId());
    const record = await claim(env, task.id, session.id, 'pre_accept', { command_id: recordCommandId });

    const verdict = await settleInFlightTurnFromProtocol(
      env.storage, task, session, record, env.lazyRoot,
    );

    expect(verdict).toBe('foreign');
    const after = await env.storage.getTask(task.id);
    // The mismatch runs before the abandon branch and records no turn — even
    // a payload carrying a gate verdict does not validate anything here. The
    // response stays in the slot: it belongs to whatever command wrote it, and
    // the ordinary reconciliation path owns it.
    expect(after?.in_flight_turn ?? null).toBeNull();
    expect(hasResponse(protoDir)).toBe(true);
  });

  test('a legacy record without command_id abandons too (uncorrelated)', async () => {
    // While a record is live no other writer may run, so the response in the
    // slot is the exchange's own output even without a correlation id — the
    // abandon branch owns every response shape.
    const { task, session, protoDir } = await workingTaskWithResponse(env, {
      result: 'an answer',
    });
    const record = await claim(env, task.id, session.id, 'pre_accept');
    delete record.command_id;

    const verdict = await settleInFlightTurnFromProtocol(
      env.storage, task, session, record, env.lazyRoot,
    );

    expect(verdict).toBe('settled');
    const after = await env.storage.getTask(task.id);
    expect(hasResponse(protoDir)).toBe(false);
    expect(after?.status).toBe('blocked');
    expect(after?.in_flight_turn ?? null).toBeNull();
  });

  test('an ask waiter ignores a response with no command id (version skew)', async () => {
    const recordCommandId = newCommandId();
    const { task, session } = await workingTaskWithResponse(env, {
      result: 'an answer with no correlation id',
    });
    const record = await claim(env, task.id, session.id, 'ask', { command_id: recordCommandId });

    const verdict = await settleInFlightTurnFromProtocol(
      env.storage, task, session, record, env.lazyRoot,
    );

    expect(verdict).toBe('none');
    const after = await env.storage.getTask(task.id);
    expect(after?.in_flight_turn?.outcome).toBeFalsy();
  });

  test('an outcome recorded against a different sequence is not this turn\'s answer', async () => {
    const { task, session } = await workingTaskWithResponse(env);
    const record = await claim(env, task.id, session.id, 'ask');

    const settled = await env.storage.settleInFlightTurn(task.id, record.turn_sequence + 7, {
      kind: 'completed', result: 'someone else\'s answer', settled_at: Date.now(),
    });

    expect(settled).toBe(false);
    const after = await env.storage.getTask(task.id);
    expect(after?.in_flight_turn?.outcome).toBeFalsy();
  });

  test('a live record excludes a second synchronous turn; an expired one does not', async () => {
    const { task, session } = await workingTaskWithResponse(env);
    const record = await claim(env, task.id, session.id, 'ask');

    const second: InFlightTurn = { ...record, turn_sequence: record.turn_sequence + 10 };
    expect(await env.storage.beginInFlightTurn(task.id, second)).toBe(false);

    // Staleness is bounded by the DEADLINE, not by probing whether the claimer
    // is alive: a recycled pid makes a dead holder look alive forever.
    await env.storage.clearInFlightTurn(task.id);
    await env.storage.beginInFlightTurn(task.id, { ...record, expires_at: Date.now() - 1 });
    expect(await isTurnInFlight(env.storage, task.id)).toBe(false);
    expect(await env.storage.beginInFlightTurn(task.id, second)).toBe(true);
  });

  test('a settled record still holds other writers off, for the pickup grace only', () => {
    const base: InFlightTurn = {
      session_id: 's', owner: 'ask', turn_type: 'ask', command_id: 'cmd-1', turn_sequence: 1,
      human_turn_sequence: 0, restore_status: 'blocked',
      started_at: 0, expires_at: Date.now() + 60_000,
    };
    const settledAt = Date.now();
    const settled: InFlightTurn = {
      ...base,
      outcome: { kind: 'completed', settled_at: settledAt },
    };
    // The waiter has not read its outcome yet — auto-resume must not launch a
    // new turn on top of a task the accept is still mid-flight on.
    expect(isInFlightLive(settled, settledAt + 1_000)).toBe(true);
    // But a waiter that died cannot wedge the task indefinitely.
    expect(isInFlightLive(settled, settledAt + IN_FLIGHT_SETTLED_GRACE_MS + 1)).toBe(false);
  });

  test('an expired review or ask with no outcome is a restore, not an interrupt', () => {
    const now = Date.now();
    const expiredReview: InFlightTurn = {
      session_id: 's', owner: 'review', turn_type: 'review', command_id: 'cmd-r',
      turn_sequence: 3, human_turn_sequence: 2, restore_status: 'submitted',
      started_at: now - 10_000, expires_at: now - 1,
    };
    // INVARIANT: after the waiter's deadline the reconciler must restore
    // submitted/blocked, never fall through to interrupted → auto-resume of a
    // work turn on a task the review was only visiting.
    expect(expiredSyncRestore(expiredReview, now)).toBe(expiredReview);
    expect(expiredSyncRestore({ ...expiredReview, owner: 'ask', turn_type: 'ask', restore_status: 'blocked' }, now)).not.toBeNull();
    // Still live — waiter / container may finish.
    expect(expiredSyncRestore({ ...expiredReview, expires_at: now + 60_000 }, now)).toBeNull();
    // Already settled — pickup grace, not this path.
    expect(expiredSyncRestore({
      ...expiredReview,
      outcome: { kind: 'completed', settled_at: now - 1_000 },
    }, now)).toBeNull();
    // A legacy pre_accept record restores too: its waiter (the old accept
    // RPC) is gone on the new code, and falling through would interrupt →
    // auto-resume a work turn on a task that was only ever mid-accept.
    expect(expiredSyncRestore({ ...expiredReview, owner: 'pre_accept', turn_type: 'pre_accept' }, now)).not.toBeNull();
  });

  test('reserved sequences are never handed out again', async () => {
    const { task, session } = await workingTaskWithResponse(env);
    const first = await env.storage.reserveTurnSequences(session.id, 2);

    // The whole point of reserving: "my answer is the next turn" was identity
    // by convention, and any turn written in between took the number.
    const next = await env.storage.getNextTurnSequence(session.id);
    expect(next).toBeGreaterThan(first + 1);
    expect(await env.storage.reserveTurnSequences(session.id, 1)).toBeGreaterThan(first + 1);
    expect(task.in_flight_turn ?? null).toBeNull();
  });
});
