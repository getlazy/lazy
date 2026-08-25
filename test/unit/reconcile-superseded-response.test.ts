/**
 * The agent's completed turn must survive a racing command.
 *
 * INVARIANT (CLAUDE.md's "never lose human feedback", mirrored for the agent):
 * a turn the agent actually finished is evidence, and evidence is never
 * destroyed to make room for the next command. `writeCommand` used to `unlink`
 * an unconsumed `response.json` outright, so any command written between the
 * supervisor finishing a turn and the reconciler consuming its response
 * destroyed that turn permanently — no turn record, and no `agent_session_id`
 * to reconcile, which is why `lazy pair` afterwards opened a FRESH agent
 * session instead of the one that had just done the work. Both symptoms have
 * one cause: `handleCompletedResponses` is the single place that writes both,
 * and it never ran.
 *
 * INVARIANT: a reconciler sweep acting on a response it read EARLIER must not
 * clobber a turn that started in the meantime. The interrupted sweep reads
 * `response.json`, then awaits its way through `handleErrorResponse`; an
 * `unblock` landing inside that window moves the task to `working` and launches
 * a real turn. The sweep's trailing `updateTaskStatus(..., 'interrupted')` then
 * dragged the LIVE task back into the auto-resume queue, and the auto-resume it
 * triggered wrote another command — which is what destroyed the response of the
 * turn the human was watching. Observed in the wild, and fingerprinted on task
 * `build-smolvm-probes`, whose turn 10 reads
 * "[Agent crashed] Error: Work phase failed: Retry canceled: new command arrived"
 * — the running supervisor seeing the auto-resume command land mid-turn.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';
import { handleErrorResponse, sweepSupersededResponses } from '../../src/utils/reconcile';
import { protocolDir as getProtocolDir, writeCommand, writeResponse } from '../../src/protocol';
import type { ErrorResponse, CompletedResponse, UnblockCommand } from '../../src/protocol';
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
  const lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-superseded-root-'));
  const basePath = await mkdtemp(join(tmpdir(), 'lazy-superseded-store-'));

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

/** A turn the agent really finished — the thing that must never be destroyed. */
const finishedTurn: CompletedResponse = {
  status: 'completed',
  result: 'Done — here is everything I concluded and what remains.',
  session_id: 'agent-session-that-did-the-work',
  usage: { input_tokens: 1200, output_tokens: 340 },
};

/** Any command the host writes next — unblock, auto-resume, sync, all identical here. */
function nextCommand(taskId: string): UnblockCommand {
  return {
    type: 'unblock',
    task_id: taskId,
    goal: 'Do a thing',
    prompt: 'Carry on.',
  };
}

describe('a completed response is never destroyed by the next command', () => {
  let env: Env;

  beforeEach(async () => { env = await setupEnv(); });
  afterEach(async () => { await env.cleanup(); });

  test('the finished turn is still recorded after a racing command supersedes it', async () => {
    const { taskId, sessionId, protoDir } = await makeTask(env, 'working');

    // The supervisor finished the turn and wrote its response...
    writeResponse(protoDir, finishedTurn);
    // ...and before the reconciler consumed it, another command landed.
    writeCommand(protoDir, nextCommand(taskId));

    // The evidence must still be reachable, and the sweep must record it.
    await sweepSupersededResponses(env.storage, env.lazyRoot);

    const turns = await env.storage.getSessionTurns(sessionId);
    const agentTurns = turns.filter(t => t.role === 'agent');
    expect(agentTurns.length).toBe(1);
    expect(agentTurns[0]!.content).toContain('everything I concluded');
  });

  test('the session id of the superseded turn is reconciled, so pairing resumes it', async () => {
    const { taskId, sessionId, protoDir } = await makeTask(env, 'working');

    writeResponse(protoDir, finishedTurn);
    writeCommand(protoDir, nextCommand(taskId));
    await sweepSupersededResponses(env.storage, env.lazyRoot);

    const session = await env.storage.getSession(sessionId);
    expect(session?.agent_session_id).toBe('agent-session-that-did-the-work');
  });
});

describe('a stale sweep does not clobber a turn that started in the meantime', () => {
  let env: Env;

  beforeEach(async () => { env = await setupEnv(); });
  afterEach(async () => { await env.cleanup(); });

  const staleCrash: ErrorResponse = {
    status: 'error',
    error: 'Work phase failed: Retry canceled: new command arrived',
    phase: 'work',
  };

  test('an unblock landing mid-sweep keeps the task working, not interrupted', async () => {
    const { taskId, sessionId, protoDir } = await makeTask(env, 'interrupted');

    // The sweep has read this stale error response and is about to act on it.
    writeResponse(protoDir, staleCrash);

    // Meanwhile the human unblocks: the task goes working and a real turn starts.
    // `writeCommand` is what makes the sweep's response stale — it supersedes it.
    writeCommand(protoDir, nextCommand(taskId));
    await env.storage.updateTaskStatus(taskId, 'working', 'human');

    // Now the sweep finishes its await chain and acts on what it read earlier.
    await handleErrorResponse(env.storage, taskId, { id: sessionId }, staleCrash, protoDir, env.lazyRoot);

    // It must NOT drag the live turn back into the auto-resume queue.
    const task = await env.storage.getTask(taskId);
    expect(task?.status).toBe('working');
  });
});
