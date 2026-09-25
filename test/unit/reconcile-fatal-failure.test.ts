/**
 * Unit tests for how the reconciler handles a CLASSIFIED agent failure.
 *
 * INVARIANT: a failure the supervisor deliberately stopped retrying must land
 * the task in `blocked`, not `interrupted`. `maybeAutoResume` only ever fires on
 * `interrupted` tasks, so `blocked` is what actually stops the reconciler from
 * relaunching the agent into a condition that cannot recover (dead credential,
 * bad model id, an endpoint that never answers).
 *
 * INVARIANT: an UNclassified crash keeps the pre-existing behavior
 * (`interrupted` + auto-resume). This change must not make ordinary crashes
 * require a human.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';
import { handleErrorResponse } from '../../src/utils/reconcile';
import { protocolDir as getProtocolDir, writeResponse } from '../../src/protocol';
import type { ErrorResponse } from '../../src/protocol';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import { consumeSyncRestoreStatus, markSyncRestoreStatus } from '../../src/task/sync-restore-status';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSyncUnsupervised(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return result.stdout?.toString().trim() ?? '';
}

interface Env {
  lazyRoot: string;
  storage: FileStorage;
  baseSha: string;
  cleanup: () => Promise<void>;
}

async function setupEnv(): Promise<Env> {
  const lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-fatal-root-'));
  const basePath = await mkdtemp(join(tmpdir(), 'lazy-fatal-store-'));

  git(lazyRoot, 'init');
  git(lazyRoot, 'config', 'user.email', 'test@lazy.test');
  git(lazyRoot, 'config', 'user.name', 'Lazy Test');
  git(lazyRoot, 'checkout', '-b', 'main');
  await writeFile(join(lazyRoot, 'README.md'), '# base\n');
  git(lazyRoot, 'add', '.');
  git(lazyRoot, 'commit', '-m', 'base');
  const baseSha = git(lazyRoot, 'rev-parse', 'HEAD');

  const storage = new FileStorage(lazyRoot, { basePath });
  await storage.initialize();

  return {
    lazyRoot,
    storage,
    baseSha,
    cleanup: async () => {
      await storage.close();
      await Promise.all([
        rm(lazyRoot, { recursive: true, force: true }),
        rm(basePath, { recursive: true, force: true }),
      ]);
    },
  };
}

async function makeTask(env: Env, status: 'working' | 'interrupted') {
  const task = await env.storage.createTask('Do a thing', undefined, env.baseSha);
  const session = await env.storage.createSession(task.id, 'claude-code', `lazy/${task.id}`, env.baseSha);
  await env.storage.updateTaskStatus(task.id, 'working', 'system');
  if (status === 'interrupted') {
    await env.storage.updateTaskStatus(task.id, 'interrupted', 'system');
  }
  const seq = await env.storage.getNextTurnSequence(session.id);
  await env.storage.createTurn({
    sessionId: session.id,
    sequence: seq,
    role: 'human',
    content: 'Do the work.',
    actor: 'human',
  });
  const protoDir = getProtocolDir(task.id);
  await mkdir(protoDir, { recursive: true });
  return { taskId: task.id, sessionId: session.id, protoDir };
}

/**
 * Deliver a crash report the way production does: the supervisor WROTE it to
 * response.json, and the reconciler is acting on the file that is still there.
 *
 * That is now load-bearing, not decoration. `handleErrorResponse` treats a
 * missing response.json as "a newer command superseded this report" and skips
 * every live-state mutation — because `writeCommand` moves an unconsumed
 * response aside rather than deleting it, so the file's absence is a signal.
 * A fixture that never wrote the file would look permanently superseded.
 */
function deliver(protoDir: string, response: ErrorResponse) {
  writeResponse(protoDir, response);
}

const fatalResponse: ErrorResponse = {
  status: 'error',
  error: 'API Error: 401 {"type":"authentication_error"}',
  phase: 'work',
  exit_code: 1,
  failure_class: 'fatal_auth',
  failure_reason: 'model provider rejected the credential',
  failure_attempts: 1,
};

const plainCrash: ErrorResponse = {
  status: 'error',
  error: 'Segmentation fault',
  phase: 'work',
  exit_code: 139,
};

/**
 * What the fast-crash-loop backstop puts on the wire: a class, but always
 * `unknown` — the detector runs for no other class (fix-cursor-action-required).
 */
const crashLoop: ErrorResponse = {
  status: 'error',
  error: 'Work phase failed: Crash loop detected: Segmentation fault',
  phase: 'work',
  failure_class: 'unknown',
  failure_reason: 'unrecognized claude-code failure',
  failure_attempts: 3,
};

describe('reconciler: classified agent failures', () => {
  let env: Env;

  beforeEach(async () => { env = await setupEnv(); });
  afterEach(async () => { await env.cleanup(); });

  test('a fatal failure blocks the task instead of interrupting it', async () => {
    const { taskId, sessionId, protoDir } = await makeTask(env, 'working');

    deliver(protoDir, fatalResponse);

    await handleErrorResponse(env.storage, taskId, { id: sessionId }, fatalResponse, protoDir, env.lazyRoot);

    const task = await env.storage.getTask(taskId);
    expect(task?.status).toBe('blocked');
  });

  test('the classification is recorded where a human will see it', async () => {
    const { taskId, sessionId, protoDir } = await makeTask(env, 'working');

    deliver(protoDir, fatalResponse);

    await handleErrorResponse(env.storage, taskId, { id: sessionId }, fatalResponse, protoDir, env.lazyRoot);

    const turns = await env.storage.getSessionTurns(sessionId);
    const last = turns[turns.length - 1]!;
    expect(last.role).toBe('agent');
    expect(last.content).toContain('unrecoverable');
    expect(last.content).toContain('fatal_auth');
    expect(last.content).toContain('model provider rejected the credential');
    expect(last.content).toContain('Attempts before giving up: 1');
  });

  // The stale-response sweep calls this handler on tasks that are ALREADY
  // interrupted, and 'interrupted' → 'blocked' is not a valid transition. If
  // this regresses, the throw is swallowed by the sweep's catch and the task
  // silently stays in the auto-resume queue.
  test('an already-interrupted task still reaches blocked', async () => {
    const { taskId, sessionId, protoDir } = await makeTask(env, 'interrupted');

    deliver(protoDir, fatalResponse);

    await handleErrorResponse(env.storage, taskId, { id: sessionId }, fatalResponse, protoDir, env.lazyRoot);

    const task = await env.storage.getTask(taskId);
    expect(task?.status).toBe('blocked');
  });

  // INVARIANT (fix-empty-failed-turn): a turn that dies must always leave a
  // visible record. Idempotency for the error turn is scoped to the CURRENT turn
  // attempt — an identical failure from an EARLIER attempt is a new occurrence.
  //
  // This regressed in the field: with a dead credential, the first unblock
  // recorded a fatal_auth turn, and the SECOND unblock recorded nothing at all
  // (a FatalAgentError response carries no duration_ms/exit_code, so two
  // consecutive fatal_auth failures produce byte-identical turn content). The
  // task came back from 'working' in seconds with an empty turns list.
  test('a repeat of the same fatal failure on a NEW attempt is recorded again', async () => {
    const { taskId, sessionId, protoDir } = await makeTask(env, 'working');

    await handleErrorResponse(env.storage, taskId, { id: sessionId }, fatalResponse, protoDir, env.lazyRoot);
    const afterFirst = await env.storage.getSessionTurns(sessionId);
    expect(afterFirst.filter(t => t.role === 'agent')).toHaveLength(1);

    // Second unblock: human feedback turn, back to working, same failure.
    await env.storage.createTurn({
      sessionId,
      sequence: await env.storage.getNextTurnSequence(sessionId),
      role: 'human',
      content: 'Try again.',
      actor: 'human',
    });
    await env.storage.updateTaskStatus(taskId, 'working', 'human');

    await handleErrorResponse(env.storage, taskId, { id: sessionId }, fatalResponse, protoDir, env.lazyRoot);

    const afterSecond = await env.storage.getSessionTurns(sessionId);
    expect(afterSecond.filter(t => t.role === 'agent')).toHaveLength(2);
    expect(afterSecond[afterSecond.length - 1]!.content).toContain('fatal_auth');
  });

  // The other half of the same invariant: re-processing the SAME response within
  // one attempt (reconcile pass racing the stale-response sweep) must not
  // duplicate the turn.
  test('re-processing the same response within one attempt records one turn', async () => {
    const { taskId, sessionId, protoDir } = await makeTask(env, 'working');

    await handleErrorResponse(env.storage, taskId, { id: sessionId }, fatalResponse, protoDir, env.lazyRoot);
    await handleErrorResponse(env.storage, taskId, { id: sessionId }, fatalResponse, protoDir, env.lazyRoot);

    const turns = await env.storage.getSessionTurns(sessionId);
    expect(turns.filter(t => t.role === 'agent')).toHaveLength(1);
  });

  test('an unclassified crash keeps the interrupted + auto-resume path', async () => {
    const { taskId, sessionId, protoDir } = await makeTask(env, 'working');

    deliver(protoDir, plainCrash);

    await handleErrorResponse(env.storage, taskId, { id: sessionId }, plainCrash, protoDir, env.lazyRoot);

    const task = await env.storage.getTask(taskId);
    expect(task?.status).toBe('interrupted');

    const turns = await env.storage.getSessionTurns(sessionId);
    expect(turns[turns.length - 1]!.content).toContain('[Agent crashed]');
  });

  // INVARIANT: an `unknown` class is DIAGNOSIS, never a verdict. The crash-loop
  // backstop now reports what it knows, but "we could not classify this" has
  // never been a reason to stop auto-resume — making it block would flip every
  // crash loop onto the human's queue, which the detector's own comment
  // explicitly rejects.
  test('a crash-loop report stays interrupted, but shows its class and attempts', async () => {
    const { taskId, sessionId, protoDir } = await makeTask(env, 'working');

    deliver(protoDir, crashLoop);

    await handleErrorResponse(env.storage, taskId, { id: sessionId }, crashLoop, protoDir, env.lazyRoot);

    const task = await env.storage.getTask(taskId);
    expect(task?.status).toBe('interrupted');

    const turns = await env.storage.getSessionTurns(sessionId);
    const last = turns[turns.length - 1]!;
    expect(last.content).toContain('[Agent crashed]');
    expect(last.content).not.toContain('unrecoverable');
    expect(last.content).toContain('Failure class: unknown');
    expect(last.content).toContain('Attempts before giving up: 3');
  });
});


/**
 * A crashed SYNC restores the status it found — and ONLY for the sync that
 * recorded it.
 *
 * A merge that died says no more about where the task stands with its reviewer
 * than one that succeeded, so the marker `syncTaskRun` leaves is honoured on the
 * crash path too, not only by `recordSyncTurns`. That reader sees EVERY turn
 * type, which is why the marker names the command that wrote it. See
 * src/task/sync-restore-status.ts and docs/sync-restores-submitted.md.
 */
describe('reconciler: a crashed sync and the restore marker', () => {
  let env: Env;

  const SYNC_CMD = 'cmd-the-sync-that-died';

  /** The same crash report, correlated to a given command, as the supervisor writes it. */
  function correlated(response: ErrorResponse, commandId: string): ErrorResponse {
    return { ...response, command_id: commandId };
  }

  beforeEach(async () => { env = await setupEnv(); });
  afterEach(async () => { await env.cleanup(); });

  // INVARIANT: a fatal crash during a sync parks the task in the status the
  // sync found, not `blocked`. Parking `blocked` here loses the open PR from
  // the review queue in exactly the way the successful path no longer does.
  test('a fatal crash restores submitted instead of parking blocked', async () => {
    const { taskId, sessionId, protoDir } = await makeTask(env, 'working');
    await markSyncRestoreStatus(env.storage, taskId, 'submitted', SYNC_CMD);

    const crash = correlated(fatalResponse, SYNC_CMD);
    deliver(protoDir, crash);
    await handleErrorResponse(env.storage, taskId, { id: sessionId }, crash, protoDir, env.lazyRoot);

    expect((await env.storage.getTask(taskId))?.status).toBe('submitted');
  });

  // INVARIANT (the marker names its own turn): a marker a dead sync left behind
  // must never be claimable by an unrelated LATER turn.
  //
  // The sequence this forbids: a sync on a submitted task writes the marker and
  // then dies with no response at all (killed supervisor, or a throw between the
  // two writes); the task parks; turns later an ordinary WORK turn crashes
  // fatally and reaches this same reader. Without the id it would claim that
  // marker and park `submitted` — putting a task nobody submitted into the
  // review queue and onto PR-comment auto-react, with no PR behind it.
  test('an unrelated work turn crashing cannot claim a dead sync’s marker', async () => {
    const { taskId, sessionId, protoDir } = await makeTask(env, 'working');
    await markSyncRestoreStatus(env.storage, taskId, 'submitted', SYNC_CMD);

    const otherTurnCrash = correlated(fatalResponse, 'cmd-an-ordinary-work-turn');
    deliver(protoDir, otherTurnCrash);
    await handleErrorResponse(env.storage, taskId, { id: sessionId }, otherTurnCrash, protoDir, env.lazyRoot);

    expect((await env.storage.getTask(taskId))?.status).toBe('blocked');
    // The mismatch left the marker ALONE — it is still owed to the turn it
    // names, and it is inert until (never) that turn presents itself.
    expect(await consumeSyncRestoreStatus(env.storage, taskId, SYNC_CMD)).toBe('submitted');
  });

  // Version skew: a crash report from an older supervisor carries no command id.
  // It names no turn, so it claims nothing — losing a restore is the safe
  // direction, asserting `submitted` on an unidentified turn is not.
  test('a crash report with no command id claims nothing', async () => {
    const { taskId, sessionId, protoDir } = await makeTask(env, 'working');
    await markSyncRestoreStatus(env.storage, taskId, 'submitted', SYNC_CMD);

    deliver(protoDir, fatalResponse);
    await handleErrorResponse(env.storage, taskId, { id: sessionId }, fatalResponse, protoDir, env.lazyRoot);

    expect((await env.storage.getTask(taskId))?.status).toBe('blocked');
  });

  // A crashed turn on a task that never synced has no marker, so nothing
  // changes: the fatal park is `blocked`, exactly as before.
  test('a crash with no marker still parks blocked', async () => {
    const { taskId, sessionId, protoDir } = await makeTask(env, 'working');

    const crash = correlated(fatalResponse, SYNC_CMD);
    deliver(protoDir, crash);
    await handleErrorResponse(env.storage, taskId, { id: sessionId }, crash, protoDir, env.lazyRoot);

    expect((await env.storage.getTask(taskId))?.status).toBe('blocked');
  });
});
