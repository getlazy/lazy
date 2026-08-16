/**
 * The reconciler's half of "a stranded merge is never silent".
 *
 * Two things happen daemon-side once a supervisor reports on a half-merged
 * worktree, and both are load-bearing:
 *
 *   1. A rollback the supervisor performed is JOURNALLED, attributed to it.
 *      A rollback destroys work — possibly a human's in-progress resolution —
 *      so it must leave a durable record. The journal is the right home: it is
 *      never fed back into a prompt, so recording there cannot corrupt the next
 *      turn's guidance.
 *   2. A merge error turn is recorded even when the previous turn was an agent
 *      turn. The old guard skipped recording whenever the last turn came from
 *      the agent, which swallowed exactly the failure this task exists to
 *      surface: conflict → resolution agent turn → merge conclusion fails →
 *      nothing recorded, task back to `blocked` looking settled.
 *
 * Both are regression tests for the live incident in fix-sync-silent-conflict.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';
import { handleCompletedResponses, handleErrorResponse } from '../../src/utils/reconcile';
import { protocolDir as getProtocolDir } from '../../src/protocol';
import type { CompletedResponse, ErrorResponse, WorktreeRecovery } from '../../src/protocol';
import { getWorktreePathForRef, taskRef } from '../../src/cli/helpers';
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
  const lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-strand-root-'));
  const basePath = await mkdtemp(join(tmpdir(), 'lazy-strand-store-'));

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

async function makeWorkingTask(env: Env, goal: string) {
  const task = await env.storage.createTask(goal, undefined, env.baseSha);
  const ref = taskRef(task);
  const branch = `lazy/${ref}`;

  const session = await env.storage.createSession(task.id, 'claude-code', branch, env.baseSha);
  await env.storage.updateTaskStatus(task.id, 'working', 'system');

  git(env.lazyRoot, 'branch', branch, env.baseSha);
  const worktreePath = getWorktreePathForRef(env.lazyRoot, ref);
  await mkdir(dirname(worktreePath), { recursive: true });
  git(env.lazyRoot, 'worktree', 'add', worktreePath, branch);

  return { ref, taskId: task.id, sessionId: session.id, worktreePath };
}

const RECOVERY: WorktreeRecovery = {
  found: 'merge_in_progress',
  summary: 'Discarded a half-applied merge left in the worktree before running sync.',
  files: ['CHANGELOG.md'],
  patch_path: '.lazy/recovery/merge-rollback-2026-08-04T00-50-00.000Z.patch',
  context: 'sync',
};

describe('reconciler: stranded-merge reporting', () => {
  let env: Env;

  beforeEach(async () => {
    process.env.LAZY_TEST = '1';
    env = await setupEnv();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  // INVARIANT (fix-sync-silent-conflict): a rollback of a half-merged worktree
  // is never silent. It destroys work — possibly a human's or an agent's
  // in-progress resolution — so it is recorded, attributed, and names the
  // recovery patch the discarded content was saved to.
  test('a sync that rolled back a half-merged worktree journals what it discarded', async () => {
    const { ref, taskId, worktreePath } = await makeWorkingTask(env, 'sync after strand');
    const session = await env.storage.getSessionByTaskId(ref);
    const protoDir = getProtocolDir(taskId);

    const responses: CompletedResponse[] = [
      {
        status: 'completed',
        result: 'Already up to date: HEAD already contains main. No merge performed.',
        session_id: '',
        usage: { input_tokens: 0, output_tokens: 0 },
        sync: { merged: false, conflicts: 0 },
        worktree_recovery: RECOVERY,
      },
    ];

    await handleCompletedResponses(
      env.storage,
      taskId,
      {
        id: session!.id,
        agent_session_id: session!.agent_session_id,
        git_start_sha: session!.git_start_sha,
        container_name: session!.container_name,
      },
      responses,
      worktreePath,
      protoDir,
    );

    const entries = await env.storage.getTaskJournal(taskId);
    expect(entries).toHaveLength(1);
    expect(entries[0].actor).toBe('supervisor');
    expect(entries[0].content).toContain('Discarded a half-applied merge');
    expect(entries[0].content).toContain('CHANGELOG.md');
    expect(entries[0].content).toContain('merge-rollback-');
  });

  // INVARIANT (fix-sync-silent-conflict): idempotency for error turns is
  // CONTENT-based, not "was the last turn an agent turn". The old positional
  // guard dropped the merge failure that followed a conflict-resolution agent
  // turn — the exact silent strand this task exists to fix.
  test('records a merge error turn even when the last turn is an agent turn', async () => {
    const { ref, taskId, sessionId } = await makeWorkingTask(env, 'error after agent turn');
    const session = await env.storage.getSessionByTaskId(ref);
    const protoDir = getProtocolDir(taskId);

    // The conflict-resolution reply the agent produced just before the failure.
    await env.storage.createTurn({
      sessionId,
      sequence: await env.storage.getNextTurnSequence(sessionId),
      role: 'agent',
      content: 'Resolved the conflict in CHANGELOG.md.',
    });

    const response: ErrorResponse = {
      status: 'error',
      error: 'Sync merge failed: merge is still in progress (MERGE_HEAD exists).',
      phase: 'merge_and_fix',
      merge_state: {
        settled: false,
        detail: 'The worktree is STILL mid-merge and could not be settled automatically.',
      },
      worktree_recovery: RECOVERY,
    };

    await handleErrorResponse(env.storage, taskId, { id: sessionId }, response, protoDir);

    const turns = await env.storage.getSessionTurns(sessionId);
    const errorTurns = turns.filter(t => t.content.includes('Sync merge failed'));
    expect(errorTurns).toHaveLength(1);
    // The turn names the state of the files on disk, not just "merge failed".
    expect(errorTurns[0].content).toContain('NOT settled');
    // ...and the rollback is journalled from the error path too.
    expect((await env.storage.getTaskJournal(taskId)).length).toBe(1);
    expect(session).toBeTruthy();
  });

  test('does not record the same error twice, but does record a different one', async () => {
    const { taskId, sessionId } = await makeWorkingTask(env, 'error idempotency');
    const protoDir = getProtocolDir(taskId);

    const first: ErrorResponse = {
      status: 'error',
      error: 'Sync merge failed: merge is still in progress (MERGE_HEAD exists).',
      phase: 'merge_and_fix',
    };

    await handleErrorResponse(env.storage, taskId, { id: sessionId }, first, protoDir);
    await handleErrorResponse(env.storage, taskId, { id: sessionId }, first, protoDir);

    let turns = await env.storage.getSessionTurns(sessionId);
    expect(turns.filter(t => t.content.includes('merge is still in progress'))).toHaveLength(1);

    await handleErrorResponse(
      env.storage,
      taskId,
      { id: sessionId },
      { ...first, error: 'Sync merge failed: could not abort the merge.' },
      protoDir,
    );

    turns = await env.storage.getSessionTurns(sessionId);
    expect(turns.filter(t => t.content.includes('could not abort the merge'))).toHaveLength(1);
  });
});
