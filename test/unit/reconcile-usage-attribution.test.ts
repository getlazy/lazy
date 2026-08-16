/**
 * Unit tests for how the reconciler attributes token usage.
 *
 * Usage is stored twice — on the TURN that spent it and rolled into the SESSION
 * total — and those two views must always agree. Measured against the live store
 * on 2026-08-02, they did not: 25 sessions had `total_usage` strictly greater
 * than the sum of their turns' usage, 57.7M tokens attributed to no turn at all,
 * and the gap only ever went one way (session ≥ sum, never the reverse). See
 * docs/token-usage-recording.md.
 *
 * Two code paths produced that signature, and both are pinned here.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';
import { handleCompletedResponses, handleErrorResponse } from '../../src/utils/reconcile';
import { protocolDir as getProtocolDir } from '../../src/protocol';
import type { CompletedResponse, ErrorResponse } from '../../src/protocol';
import { spawnSync } from '../../src/utils/spawn';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return result.stdout?.toString().trim() ?? '';
}

interface Env {
  lazyRoot: string;
  storage: FileStorage;
  baseSha: string;
  cleanup: () => Promise<void>;
}

async function setupEnv(): Promise<Env> {
  const lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-usage-root-'));
  const basePath = await mkdtemp(join(tmpdir(), 'lazy-usage-store-'));

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

async function makeTask(env: Env) {
  const task = await env.storage.createTask('Do a thing', undefined, env.baseSha);
  const session = await env.storage.createSession(task.id, 'claude-code', `lazy/${task.id}`, env.baseSha);
  await env.storage.updateTaskStatus(task.id, 'working', 'system');
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
  return { taskId: task.id, session, protoDir };
}

const completed: CompletedResponse = {
  status: 'completed',
  result: 'Done.',
  session_id: 'agent-session-1',
  usage: {
    input_tokens: 1_000,
    output_tokens: 200,
    cache_creation_input_tokens: 30,
    cache_read_input_tokens: 4_000,
  },
};

/** Sum of every turn's usage — the number a session total must never exceed. */
async function turnTokenSum(storage: FileStorage, sessionId: string): Promise<number> {
  const turns = await storage.getSessionTurns(sessionId);
  return turns.reduce((acc, t) => acc + (t.usage
    ? t.usage.inputTokens + t.usage.outputTokens + t.usage.cacheCreationTokens + t.usage.cacheReadTokens
    : 0), 0);
}

async function sessionTokenTotal(storage: FileStorage, sessionId: string): Promise<number> {
  const session = await storage.getSession(sessionId);
  const u = session?.total_usage;
  if (!u) return 0;
  return u.inputTokens + u.outputTokens + u.cacheCreationTokens + u.cacheReadTokens;
}

describe('reconciler: token-usage attribution', () => {
  let env: Env;

  beforeEach(async () => { env = await setupEnv(); });
  afterEach(async () => { await env.cleanup(); });

  // INVARIANT: the session rollup shares the turn write's idempotency guard.
  //
  // Turn creation was already guarded ("last turn is already an agent turn"),
  // but the rollup that followed sat OUTSIDE that guard, and `consumeResponse`
  // runs at the very END of the handler after several fallible steps. So a
  // second pass over the same unconsumed response.json recorded no turn and yet
  // re-added its tokens — producing a session total permanently above the sum of
  // its turns, with the excess attributed to nothing. Do not move the rollup back
  // out of the turn-creation branch.
  test('re-flushing the same completed response counts its tokens exactly once', async () => {
    const { taskId, session, protoDir } = await makeTask(env);

    await handleCompletedResponses(env.storage, taskId, session, [completed], env.lazyRoot, protoDir);
    const afterFirst = await sessionTokenTotal(env.storage, session.id);
    expect(afterFirst).toBe(5_230);

    // Same response, reconciled again — as happens when the handler is re-entered
    // before the response file was consumed.
    await handleCompletedResponses(env.storage, taskId, session, [completed], env.lazyRoot, protoDir);

    expect(await sessionTokenTotal(env.storage, session.id)).toBe(afterFirst);
    expect(await turnTokenSum(env.storage, session.id)).toBe(afterFirst);
  });

  test('a completed turn leaves the session total equal to the sum of its turns', async () => {
    const { taskId, session, protoDir } = await makeTask(env);

    await handleCompletedResponses(env.storage, taskId, session, [completed], env.lazyRoot, protoDir);

    expect(await sessionTokenTotal(env.storage, session.id)).toBe(await turnTokenSum(env.storage, session.id));
  });

  // INVARIANT: a turn that spent tokens and THEN died still records them.
  //
  // The error path recorded a turn with no usage and rolled up nothing, so every
  // crashed or watchdog-killed turn's tokens were dropped on the floor — real
  // spend, invisible in both views. The supervisor now salvages what the agent
  // reported before it died (src/supervisor/usage.ts) and puts it on the wire.
  test('a crashed turn records the tokens it spent before dying', async () => {
    const { taskId, session, protoDir } = await makeTask(env);
    const crashed: ErrorResponse = {
      status: 'error',
      error: 'Segmentation fault',
      phase: 'work',
      exit_code: 139,
      usage: { input_tokens: 700, output_tokens: 50, cache_read_input_tokens: 2_000 },
    };

    await handleErrorResponse(env.storage, taskId, { id: session.id }, crashed, protoDir, env.lazyRoot);

    const turns = await env.storage.getSessionTurns(session.id);
    const last = turns[turns.length - 1]!;
    expect(last.role).toBe('agent');
    expect(last.usage).toEqual({
      inputTokens: 700,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 2_000,
    });
    expect(await sessionTokenTotal(env.storage, session.id)).toBe(2_750);
    expect(await turnTokenSum(env.storage, session.id)).toBe(2_750);
  });

  test('re-flushing the same error response counts its tokens exactly once', async () => {
    const { taskId, session, protoDir } = await makeTask(env);
    const crashed: ErrorResponse = {
      status: 'error',
      error: 'Segmentation fault',
      phase: 'work',
      exit_code: 139,
      usage: { input_tokens: 700, output_tokens: 50 },
    };

    await handleErrorResponse(env.storage, taskId, { id: session.id }, crashed, protoDir, env.lazyRoot);
    await handleErrorResponse(env.storage, taskId, { id: session.id }, crashed, protoDir, env.lazyRoot);

    expect(await sessionTokenTotal(env.storage, session.id)).toBe(750);
    expect(await turnTokenSum(env.storage, session.id)).toBe(750);
  });

  // A supervisor older than the `usage` field on ErrorResponse sends no usage at
  // all. That must stay a clean "nothing recorded", not a zeroed turn or a throw.
  test('an error response without usage records a turn carrying none', async () => {
    const { taskId, session, protoDir } = await makeTask(env);
    const crashed: ErrorResponse = { status: 'error', error: 'boom', phase: 'work' };

    await handleErrorResponse(env.storage, taskId, { id: session.id }, crashed, protoDir, env.lazyRoot);

    const turns = await env.storage.getSessionTurns(session.id);
    expect(turns[turns.length - 1]!.usage ?? undefined).toBeUndefined();
    expect(await sessionTokenTotal(env.storage, session.id)).toBe(0);
  });

  // Agents are an external surface: a malformed usage block must be rejected at
  // the boundary rather than propagated as NaN into every later sum.
  test('a malformed usage block is rejected, not coerced', async () => {
    const { taskId, session, protoDir } = await makeTask(env);
    const crashed = {
      status: 'error',
      error: 'boom',
      phase: 'work',
      usage: { input_tokens: 'lots', output_tokens: null },
    } as unknown as ErrorResponse;

    await handleErrorResponse(env.storage, taskId, { id: session.id }, crashed, protoDir, env.lazyRoot);

    const turns = await env.storage.getSessionTurns(session.id);
    expect(turns[turns.length - 1]!.usage ?? undefined).toBeUndefined();
    expect(await sessionTokenTotal(env.storage, session.id)).toBe(0);
  });
});
