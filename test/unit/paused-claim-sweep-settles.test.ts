/**
 * The paused-claim sweep must actually RELEASE the claim, including down the
 * error path.
 *
 * WHY THIS EXISTS. `sweepPausedSyncClaims` is the last resort for a claim no
 * other sweep can see — the primary sweep visits `working` tasks only, and
 * `sweepPausedResponses` skips any task carrying a claim. So when it fails, the
 * task stays wedged: the live record suppresses every automatic launch that
 * reads `isTurnInFlight`, including the auto-review retry, until the 24-hour
 * backstop.
 *
 * And it did fail, on the commonest ending there is. Settling a crashed ask
 * runs `recordAskErrorTurn`, which parks the task `interrupted`
 * unconditionally — and <paused> → `interrupted` is not a valid transition, so
 * `updateTaskStatus` threw AFTER the turn had been created and `response.json`
 * consumed, leaving `settleInFlightTurn` and `releaseAsyncClaim` unreached. The
 * sweep's own catch logged it and moved on. The fix is the hop through
 * `working` that `sweepPausedResponses` and `sweepInterruptedResponses` already
 * do for the same handlers, and this test is the thing that would have caught
 * it: it asserts the claim is GONE, not merely that a turn was written.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';
import { sweepPausedSyncClaims } from '../../src/utils/reconcile';
import { IN_FLIGHT_ASYNC_BACKSTOP_MS, CLAIMING_PROCESS_ID } from '../../src/daemon/in-flight-turn';
import { protocolDir as getProtocolDir, writeResponse } from '../../src/protocol';
import type { ErrorResponse } from '../../src/protocol';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import type { InFlightTurn, TaskStatus } from '../../src/types';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSyncUnsupervised(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return result.stdout?.toString().trim() ?? '';
}

interface Env {
  lazyRoot: string;
  storage: FileStorage;
  baseSha: string;
  protocolBase: string;
  previousProtocolBase: string | undefined;
  cleanup: () => Promise<void>;
}

async function setupEnv(): Promise<Env> {
  const lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-claim-sweep-root-'));
  const basePath = await mkdtemp(join(tmpdir(), 'lazy-claim-sweep-store-'));
  const protocolBase = await mkdtemp(join(tmpdir(), 'lazy-claim-sweep-proto-'));
  const previousProtocolBase = process.env.LAZY_PROTOCOL_BASE;
  process.env.LAZY_PROTOCOL_BASE = protocolBase;

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
    protocolBase,
    previousProtocolBase,
    cleanup: async () => {
      if (previousProtocolBase === undefined) delete process.env.LAZY_PROTOCOL_BASE;
      else process.env.LAZY_PROTOCOL_BASE = previousProtocolBase;
      await storage.close();
      await Promise.all([
        rm(lazyRoot, { recursive: true, force: true }),
        rm(basePath, { recursive: true, force: true }),
        rm(protocolBase, { recursive: true, force: true }),
      ]);
    },
  };
}

/**
 * A task PARKED while an ask claim is still live — the dead zone this sweep
 * owns. Built through the real transitions, so the statuses are ones the state
 * machine actually allows.
 */
async function pausedTaskHoldingAskClaim(
  env: Env,
  parkedStatus: Extract<TaskStatus, 'blocked' | 'submitted'>,
): Promise<{ taskId: string; sessionId: string; protoDir: string; record: InFlightTurn }> {
  const task = await env.storage.createTask('Do a thing', undefined, env.baseSha);
  const session = await env.storage.createSession(task.id, 'claude-code', `lazy/${task.id}`, env.baseSha);
  await env.storage.updateTaskStatus(task.id, 'working', 'system');
  await env.storage.updateTaskStatus(task.id, 'blocked', 'system');
  if (parkedStatus !== 'blocked') {
    await env.storage.updateTaskStatus(task.id, parkedStatus, 'system');
  }

  const first = await env.storage.reserveTurnSequences(session.id, 2);
  await env.storage.createTurn({
    sessionId: session.id,
    sequence: first,
    role: 'human',
    content: 'why did you drop the retry?',
    turnType: 'ask',
    actor: 'human',
  });

  const now = Date.now();
  const record: InFlightTurn = {
    session_id: session.id,
    owner: 'ask',
    turn_type: 'ask',
    command_id: 'cmd-ask-1',
    turn_sequence: first + 1,
    human_turn_sequence: first,
    restore_status: parkedStatus,
    started_at: now,
    expires_at: now + IN_FLIGHT_ASYNC_BACKSTOP_MS,
    run_name: 'lazy-ask-run',
    // Made by THIS process, as every claim a live daemon settles is: one a
    // previous daemon made is abandoned on sight (abandonPreviousGenerationClaim).
    claimed_by_process: CLAIMING_PROCESS_ID,
  } as InFlightTurn;
  await env.storage.beginInFlightTurn(task.id, record);

  const protoDir = getProtocolDir(task.id);
  await mkdir(protoDir, { recursive: true });
  return { taskId: task.id, sessionId: session.id, protoDir, record };
}

const askCrash: ErrorResponse = {
  status: 'error',
  error: 'Organization spend limit reached',
  phase: 'work',
  exit_code: 1,
  command_id: 'cmd-ask-1',
} as ErrorResponse;

describe('sweepPausedSyncClaims settles the claim it exists to clear', () => {
  let env: Env;

  beforeEach(async () => {
    env = await setupEnv();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  // INVARIANT: the claim is RELEASED. Everything else this sweep does is in
  // service of that — a live record on a task nothing else visits is what
  // suppresses the auto-review retry and every other automatic launch.
  test('a crashed ask on a blocked task: the claim is released and the turn recorded', async () => {
    const { taskId, sessionId, protoDir, record } = await pausedTaskHoldingAskClaim(env, 'blocked');
    writeResponse(protoDir, askCrash);

    await sweepPausedSyncClaims(env.storage, env.lazyRoot);

    const after = await env.storage.getTask(taskId);
    expect(after?.in_flight_turn ?? null).toBeNull();

    // The crashed ask is recorded at its RESERVED sequence, so a waiter sees an
    // answer rather than polling one that never comes.
    const turns = await env.storage.getSessionTurns(sessionId);
    const ending = turns.find((t) => t.sequence === record.turn_sequence);
    expect(ending?.role).toBe('agent');
    expect(ending?.turn_type).toBe('ask');
    expect(ending?.content ?? '').toContain('Organization spend limit reached');

    // And the task lands where a crashed ask belongs: `interrupted`, which is
    // what makes it auto-resumable. Reaching it at all is the fix — from
    // `blocked` that transition is invalid without the hop.
    expect(after?.status).toBe('interrupted');
  });

  // The same ending from the other paused status the sweep admits, because the
  // transition table is what broke and `submitted` → `interrupted` is refused
  // just as `blocked` → `interrupted` is.
  test('a crashed ask on a submitted task is settled too', async () => {
    const { taskId } = await pausedTaskHoldingAskClaim(env, 'submitted');
    writeResponse(getProtocolDir(taskId), askCrash);

    await sweepPausedSyncClaims(env.storage, env.lazyRoot);

    const after = await env.storage.getTask(taskId);
    expect(after?.in_flight_turn ?? null).toBeNull();
    expect(after?.status).toBe('interrupted');
  });

  // INVARIANT: the hop moves the task ONLY when there is a response to settle.
  // A task parked with a live claim and an empty mailbox is waiting for an
  // answer that may still arrive; taking it to `working` with nothing running
  // is the stranded state the claim machinery exists to prevent.
  test('no response: the task stays parked and keeps its claim', async () => {
    const { taskId } = await pausedTaskHoldingAskClaim(env, 'blocked');

    await sweepPausedSyncClaims(env.storage, env.lazyRoot);

    const after = await env.storage.getTask(taskId);
    expect(after?.status).toBe('blocked');
    // The run is named but not running, so the abandon path is watching it; the
    // claim only goes once that grace elapses, never on this first sight.
    expect(after?.in_flight_turn ?? null).not.toBeNull();
  });
});
