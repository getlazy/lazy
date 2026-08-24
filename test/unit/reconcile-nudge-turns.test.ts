/**
 * Unit tests for supervised-turn materialization in the reconciler.
 *
 * A completed command now returns a BUNDLE of full CompletedResponse objects —
 * one per `claude -p` invocation. responses[0] is the work response; the rest are
 * supervised follow-ups (protected-file push-back, maintained-files nudge), each a
 * full response with its OWN usage (incl. cache tokens), SHA window, and (for
 * push-back) re-detected violation set. The reconciler materializes each as a
 * discrete turn pair: a `supervisor`-actored prompt turn + the agent's reply turn.
 *
 * INVARIANTS this file encodes:
 *
 *   1. The work turn's content is CLEAN — supervised text is never appended; the
 *      work turn carries NO violations.
 *   2. Each supervised follow-up becomes a (supervisor prompt, agent reply) pair,
 *      in order, AFTER the work turn, tagged turn_type 'nudge' with actor
 *      'supervisor' on the prompt turn.
 *   3. Supervised reply turns carry their OWN usage (incl. cache write/read tokens)
 *      and their OWN per-invocation SHA window.
 *   4. Violation finality: the FINAL (post-push-back) violation set drives the
 *      conflict/blocked decision and lands on the push-back turn — never the work
 *      turn. A resolved push-back ([] violations) yields 'blocked'.
 *   5. Session token usage sums EVERY invocation (work + supervised).
 *   6. Idempotency: re-running the reconciler does not duplicate turns.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';
import { handleCompletedResponses } from '../../src/utils/reconcile';
import { latestWorkAgentTurn, latestViolationTurn } from '../../src/utils/turns';
import { protocolDir as getProtocolDir } from '../../src/protocol';
import type { CompletedResponse } from '../../src/protocol';
import { getWorktreePathForRef, taskRef } from '../../src/cli/helpers';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';

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
  const lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-sup-root-'));
  const basePath = await mkdtemp(join(tmpdir(), 'lazy-sup-store-'));

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

/** A `working` task with a session, a worktree, and a recorded human turn. */
async function makeWorkingTask(env: Env, goal: string): Promise<{ ref: string; taskId: string; sessionId: string }> {
  const task = await env.storage.createTask(goal, undefined, env.baseSha);
  const ref = taskRef(task);
  const branch = `lazy/${ref}`;

  const session = await env.storage.createSession(task.id, 'claude-code', branch, env.baseSha);
  await env.storage.updateTaskStatus(task.id, 'working', 'system');

  git(env.lazyRoot, 'branch', branch, env.baseSha);
  const wt = getWorktreePathForRef(env.lazyRoot, ref);
  await mkdir(dirname(wt), { recursive: true });
  git(env.lazyRoot, 'worktree', 'add', wt, branch);

  const seq = await env.storage.getNextTurnSequence(session.id);
  await env.storage.createTurn({
    sessionId: session.id,
    sequence: seq,
    role: 'human',
    content: 'Do the work.',
    actor: 'human',
  });

  return { ref, taskId: task.id, sessionId: session.id };
}

function sessionArg(session: { id: string; agent_session_id: string | null; git_start_sha: string; container_name: string | null }) {
  return {
    id: session.id,
    agent_session_id: session.agent_session_id,
    git_start_sha: session.git_start_sha,
    container_name: session.container_name,
  };
}

const WORK_USAGE = { input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 };
const SUP_USAGE = { input_tokens: 50, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 };

describe('reconciler: supervised follow-up turns', () => {
  let env: Env;

  beforeEach(async () => {
    process.env.LAZY_TEST = '1';
    env = await setupEnv();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  // INVARIANTS 1, 2, 3: discrete turn pairs, supervisor actor, per-invocation
  // usage (incl. cache) and SHA windows; work turn stays clean.
  test('materializes a maintain follow-up as a supervisor→agent turn pair with full usage', async () => {
    const { ref, taskId, sessionId } = await makeWorkingTask(env, 'work + maintain nudge');
    const session = await env.storage.getSessionByTaskId(ref);
    const worktreePath = getWorktreePathForRef(env.lazyRoot, ref);
    const protoDir = getProtocolDir(taskId);

    const responses: CompletedResponse[] = [
      { status: 'completed', result: 'Did the work. Clean summary.', session_id: 'sess-work', usage: WORK_USAGE },
      {
        status: 'completed', result: 'Intra-release; no docs needed.', session_id: 'sess-maintain', usage: SUP_USAGE,
        start_sha_work: env.baseSha, end_sha_work: env.baseSha,
        supervised: { kind: 'maintain', prompt: 'You skipped docs. Update or justify.' },
      },
    ];

    await handleCompletedResponses(env.storage, taskId, sessionArg(session!), responses, worktreePath, protoDir);

    const turns = await env.storage.getSessionTurns(sessionId);
    const agentTurns = turns.filter(t => t.role === 'agent');
    const nudgeTurns = turns.filter(t => t.turn_type === 'nudge');

    // Work turn — clean summary, no supervised text, no violations.
    const workTurn = agentTurns[0];
    expect(workTurn.content).toBe('Did the work. Clean summary.');
    expect(workTurn.content).not.toContain('Intra-release');
    expect(workTurn.violations ?? []).toHaveLength(0);
    expect(latestWorkAgentTurn(turns)!.id).toBe(workTurn.id);

    // Supervised pair: supervisor prompt turn + agent reply turn.
    expect(nudgeTurns).toHaveLength(2);
    const [promptTurn, replyTurn] = nudgeTurns;
    expect(promptTurn.role).toBe('human');
    expect(promptTurn.actor).toBe('supervisor');
    expect(promptTurn.content).toContain('## Maintained Files Review');
    expect(promptTurn.content).toContain('You skipped docs');
    expect(turns.indexOf(workTurn)).toBeLessThan(turns.indexOf(promptTurn));

    // The reply turn carries the follow-up invocation's OWN usage incl. cache.
    expect(replyTurn.role).toBe('agent');
    expect(replyTurn.content).toBe('Intra-release; no docs needed.');
    expect(replyTurn.usage?.cacheCreationTokens).toBe(30);
    expect(replyTurn.usage?.cacheReadTokens).toBe(40);
    expect(replyTurn.usage?.inputTokens).toBe(50);

    expect((await env.storage.getTask(taskId))!.status).toBe('blocked');
  });

  // INVARIANT 4 + work-turn identification: push-back violations land on the
  // push-back turn (final set), NOT the work turn; conflict; latestViolationTurn
  // finds them while latestWorkAgentTurn still returns the clean work turn.
  test('push-back with remaining violations → conflict, final set on the push-back turn', async () => {
    const { ref, taskId, sessionId } = await makeWorkingTask(env, 'push-back remains');
    const session = await env.storage.getSessionByTaskId(ref);
    const worktreePath = getWorktreePathForRef(env.lazyRoot, ref);
    const protoDir = getProtocolDir(taskId);

    const violation = { file: 'test.spec.ts', base_sha: env.baseSha, status: 'pending' as const };
    const responses: CompletedResponse[] = [
      { status: 'completed', result: 'Work summary.', session_id: 'sess-work', usage: WORK_USAGE, pushed_back: true },
      {
        status: 'completed', result: 'The change is essential.', session_id: 'sess-pb', usage: SUP_USAGE,
        start_sha_work: env.baseSha, end_sha_work: env.baseSha,
        violations: [violation],
        supervised: { kind: 'permission_pushback', prompt: 'You modified a protected file. Revert or justify.' },
      },
    ];

    await handleCompletedResponses(env.storage, taskId, sessionArg(session!), responses, worktreePath, protoDir);

    const turns = await env.storage.getSessionTurns(sessionId);
    const workTurn = latestWorkAgentTurn(turns)!;
    const violationTurn = latestViolationTurn(turns)!;

    // The work turn never carries violations; the FINAL set is on the push-back turn.
    expect(workTurn.violations ?? []).toHaveLength(0);
    expect(workTurn.content).toBe('Work summary.');
    expect(workTurn.id).not.toBe(violationTurn.id);
    expect(violationTurn.turn_type).toBe('nudge');
    expect(violationTurn.violations).toHaveLength(1);
    expect(violationTurn.violations![0].file).toBe('test.spec.ts');
    expect(violationTurn.violations![0].status).toBe('pending');
    // The push-back reply turn carries its OWN usage incl. cache tokens.
    expect(violationTurn.usage?.cacheCreationTokens).toBe(30);
    expect(violationTurn.usage?.cacheReadTokens).toBe(40);

    // Violations remain → conflict.
    expect((await env.storage.getTask(taskId))!.status).toBe('conflict');
  });

  // INVARIANT 4 (resolved): a push-back that re-detects NO violations ([]) must
  // yield 'blocked' — the final empty set overrides the work response, and no turn
  // carries violations (latestViolationTurn is undefined).
  test('push-back that resolves all violations → blocked, no violation turn', async () => {
    const { ref, taskId, sessionId } = await makeWorkingTask(env, 'push-back resolved');
    const session = await env.storage.getSessionByTaskId(ref);
    const worktreePath = getWorktreePathForRef(env.lazyRoot, ref);
    const protoDir = getProtocolDir(taskId);

    const responses: CompletedResponse[] = [
      { status: 'completed', result: 'Work summary.', session_id: 'sess-work', usage: WORK_USAGE, pushed_back: true },
      {
        status: 'completed', result: 'Reverted the file.', session_id: 'sess-pb', usage: SUP_USAGE,
        start_sha_work: env.baseSha, end_sha_work: env.baseSha,
        violations: [], // re-detected: none remain
        supervised: { kind: 'permission_pushback', prompt: 'You modified a protected file. Revert or justify.' },
      },
    ];

    await handleCompletedResponses(env.storage, taskId, sessionArg(session!), responses, worktreePath, protoDir);

    const turns = await env.storage.getSessionTurns(sessionId);
    expect(latestViolationTurn(turns)).toBeUndefined();
    expect((await env.storage.getTask(taskId))!.status).toBe('blocked');
  });

  // INVARIANT 5: session usage rolls up EVERY invocation (work + supervised).
  test('session token usage sums work and supervised invocations', async () => {
    const { ref, taskId } = await makeWorkingTask(env, 'usage sum');
    const session = await env.storage.getSessionByTaskId(ref);
    const worktreePath = getWorktreePathForRef(env.lazyRoot, ref);
    const protoDir = getProtocolDir(taskId);

    const responses: CompletedResponse[] = [
      { status: 'completed', result: 'work', session_id: 'sess-work', usage: WORK_USAGE },
      {
        status: 'completed', result: 'nudge reply', session_id: 'sess-maintain', usage: SUP_USAGE,
        start_sha_work: env.baseSha, end_sha_work: env.baseSha,
        supervised: { kind: 'maintain', prompt: 'Update or justify.' },
      },
    ];

    await handleCompletedResponses(env.storage, taskId, sessionArg(session!), responses, worktreePath, protoDir);

    const updated = await env.storage.getSessionByTaskId(ref);
    const usage = updated!.total_usage!;
    // input: 100 + 50, output: 200 + 20, cache write: 10 + 30, cache read: 20 + 40
    expect(usage.inputTokens).toBe(150);
    expect(usage.outputTokens).toBe(220);
    expect(usage.cacheCreationTokens).toBe(40);
    expect(usage.cacheReadTokens).toBe(60);
  });

  // INVARIANT 6: a second reconcile pass does not duplicate turns.
  test('a second reconcile pass does not duplicate supervised turns', async () => {
    const { ref, taskId, sessionId } = await makeWorkingTask(env, 'idempotent');
    const session = await env.storage.getSessionByTaskId(ref);
    const worktreePath = getWorktreePathForRef(env.lazyRoot, ref);
    const protoDir = getProtocolDir(taskId);

    const responses: CompletedResponse[] = [
      { status: 'completed', result: 'work', session_id: 'sess-work', usage: WORK_USAGE },
      {
        status: 'completed', result: 'reply', session_id: 'sess-maintain', usage: SUP_USAGE,
        start_sha_work: env.baseSha, end_sha_work: env.baseSha,
        supervised: { kind: 'maintain', prompt: 'Update or justify.' },
      },
    ];

    await handleCompletedResponses(env.storage, taskId, sessionArg(session!), responses, worktreePath, protoDir);
    await handleCompletedResponses(env.storage, taskId, sessionArg(session!), responses, worktreePath, protoDir);

    const turns = await env.storage.getSessionTurns(sessionId);
    expect(turns.filter(t => t.turn_type === 'nudge')).toHaveLength(2);
    expect(turns.filter(t => t.role === 'agent')).toHaveLength(2); // work + 1 nudge reply
  });
});
