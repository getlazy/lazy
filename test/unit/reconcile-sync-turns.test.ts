/**
 * Unit tests for upstream-merge (sync) turn materialization in the reconciler.
 *
 * A sync command's completed response carries a `sync` marker (responses[0].sync).
 * The reconciler routes it to recordSyncTurns, which records turns based on the
 * merge OUTCOME rather than the generic work-turn machinery.
 *
 * INVARIANTS this file encodes:
 *
 *   1. Skip-when-noop: a no-op sync (merged: false) records ZERO turns. This is
 *      the whole reason turn creation moved off the daemon (which pre-created a
 *      turn before the outcome was known) onto the reconciler here.
 *   2. A real clean merge produces EXACTLY ONE turn: a `supervisor`-actored,
 *      turn_type 'sync' merge turn. No agent turn (no agent was invoked). The
 *      merge commit is recorded.
 *   3. A conflicted merge produces the `supervisor` merge turn PLUS a discrete
 *      `agent` conflict-resolution turn carrying its OWN usage (incl. cache
 *      tokens) — never appended to the supervisor turn.
 *   4. Every sync completion transitions the task out of 'working' to 'blocked',
 *      including the no-op case (so a no-op sync never strands the task).
 *   5. Idempotency: a second reconcile pass does not duplicate sync turns.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';
import { handleCompletedResponses } from '../../src/utils/reconcile';
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
  const lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-sync-root-'));
  const basePath = await mkdtemp(join(tmpdir(), 'lazy-sync-store-'));

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

/** A `working` task with a session, a worktree, and one recorded human turn. */
async function makeWorkingTask(env: Env, goal: string): Promise<{ ref: string; taskId: string; sessionId: string; worktreePath: string }> {
  const task = await env.storage.createTask(goal, undefined, env.baseSha);
  const ref = taskRef(task);
  const branch = `lazy/${ref}`;

  const session = await env.storage.createSession(task.id, 'claude-code', branch, env.baseSha);
  await env.storage.updateTaskStatus(task.id, 'working', 'system');

  git(env.lazyRoot, 'branch', branch, env.baseSha);
  const worktreePath = getWorktreePathForRef(env.lazyRoot, ref);
  await mkdir(dirname(worktreePath), { recursive: true });
  git(env.lazyRoot, 'worktree', 'add', worktreePath, branch);

  const seq = await env.storage.getNextTurnSequence(session.id);
  await env.storage.createTurn({
    sessionId: session.id,
    sequence: seq,
    role: 'human',
    content: 'Do the work.',
    actor: 'human',
  });

  return { ref, taskId: task.id, sessionId: session.id, worktreePath };
}

/** Simulate a merge commit landing on the worktree; returns the new HEAD sha. */
function commitMerge(worktreePath: string, file: string): string {
  // Sync write: test setup, and git must see the file before `add` (CLAUDE.md
  // permits sync fs calls in test setup/teardown).
  writeFileSync(join(worktreePath, file), 'merged upstream\n');
  git(worktreePath, 'add', '.');
  git(worktreePath, 'commit', '-m', 'Merge main');
  return git(worktreePath, 'rev-parse', 'HEAD');
}

function sessionArg(session: { id: string; agent_session_id: string | null; git_start_sha: string; container_name: string | null }) {
  return {
    id: session.id,
    agent_session_id: session.agent_session_id,
    git_start_sha: session.git_start_sha,
    container_name: session.container_name,
  };
}

const SYNC_USAGE = { input_tokens: 80, output_tokens: 30, cache_creation_input_tokens: 15, cache_read_input_tokens: 25 };

describe('reconciler: upstream-merge (sync) turns', () => {
  let env: Env;

  beforeEach(async () => {
    process.env.LAZY_TEST = '1';
    env = await setupEnv();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  // INVARIANT 1 + 4: a no-op sync records ZERO turns but still leaves 'working'.
  test('no-op sync (merged:false) records no turn and transitions to blocked', async () => {
    const { ref, taskId, sessionId, worktreePath } = await makeWorkingTask(env, 'noop sync');
    const session = await env.storage.getSessionByTaskId(ref);
    const protoDir = getProtocolDir(taskId);

    const before = (await env.storage.getSessionTurns(sessionId)).length;

    const responses: CompletedResponse[] = [
      {
        status: 'completed',
        result: 'Already up to date: HEAD already contains main. No merge performed.',
        session_id: '',
        usage: { input_tokens: 0, output_tokens: 0 },
        sync: { merged: false, conflicts: 0 },
      },
    ];

    await handleCompletedResponses(env.storage, taskId, sessionArg(session!), responses, worktreePath, protoDir);

    const after = await env.storage.getSessionTurns(sessionId);
    expect(after.length).toBe(before); // ZERO new turns
    expect((await env.storage.getTask(taskId))!.status).toBe('blocked');
  });

  // INVARIANT 2: a clean merge → exactly one supervisor-actored sync turn, no
  // agent turn, and the merge commit is recorded.
  test('clean merge records exactly one supervisor sync turn and the merge commit', async () => {
    const { ref, taskId, sessionId, worktreePath } = await makeWorkingTask(env, 'clean merge');
    const session = await env.storage.getSessionByTaskId(ref);
    const protoDir = getProtocolDir(taskId);

    const postMergeSha = commitMerge(worktreePath, 'from-upstream.txt');

    const agentTurnsBefore = (await env.storage.getSessionTurns(sessionId)).filter(t => t.role === 'agent').length;

    const responses: CompletedResponse[] = [
      {
        status: 'completed',
        result: `Merged main @ ${postMergeSha.substring(0, 8)}. HEAD: ${env.baseSha.substring(0, 8)} → ${postMergeSha.substring(0, 8)}.`,
        session_id: '',
        usage: { input_tokens: 0, output_tokens: 0 },
        sync: { merged: true, conflicts: 0 },
        start_sha_work: env.baseSha,
        end_sha_work: postMergeSha,
      },
    ];

    await handleCompletedResponses(env.storage, taskId, sessionArg(session!), responses, worktreePath, protoDir);

    const turns = await env.storage.getSessionTurns(sessionId);
    const syncTurns = turns.filter(t => t.turn_type === 'sync');
    expect(syncTurns).toHaveLength(1);

    const [mergeTurn] = syncTurns;
    expect(mergeTurn.role).toBe('human');
    expect(mergeTurn.actor).toBe('supervisor');
    expect(mergeTurn.auto_triggered).toBe(true);
    expect(mergeTurn.content).toContain('Merged main');

    // No agent turn — a clean merge invokes no agent.
    const agentTurnsAfter = turns.filter(t => t.role === 'agent').length;
    expect(agentTurnsAfter).toBe(agentTurnsBefore);

    // The merge commit is recorded on the session.
    const commits = await env.storage.getSessionCommits(sessionId);
    expect(commits.some(c => c.sha === postMergeSha)).toBe(true);

    expect((await env.storage.getTask(taskId))!.status).toBe('blocked');
  });

  // INVARIANT 3: a conflicted merge → the supervisor merge turn PLUS a discrete
  // agent conflict-resolution turn carrying its OWN usage (incl. cache tokens).
  test('conflicted merge records supervisor turn + agent conflict-resolution turn with own usage', async () => {
    const { ref, taskId, sessionId, worktreePath } = await makeWorkingTask(env, 'conflict merge');
    const session = await env.storage.getSessionByTaskId(ref);
    const protoDir = getProtocolDir(taskId);

    const postMergeSha = commitMerge(worktreePath, 'resolved.txt');

    const responses: CompletedResponse[] = [
      {
        status: 'completed',
        result: `Merged main @ ${postMergeSha.substring(0, 8)} with 1 resolved conflict(s). HEAD: ${env.baseSha.substring(0, 8)} → ${postMergeSha.substring(0, 8)}.`,
        session_id: '',
        usage: { input_tokens: 0, output_tokens: 0 },
        sync: { merged: true, conflicts: 1 },
        // Build the conflict-marker string dynamically from repeated chars. A raw
        // 7-char marker sequence in committed test content false-positives lazy's own
        // accept-time conflict scan (checkMergeConflictsIntoTarget greps merge-tree
        // output for those markers), which would mechanically block the accept.
        merge_conflicts: [{ path: 'resolved.txt', content: ['<'.repeat(7), 'a', '='.repeat(7), 'b', '>'.repeat(7), ''].join('\n'), merge_source: 'main' }],
      },
      {
        status: 'completed',
        result: 'Resolved the conflict in resolved.txt by keeping both changes.',
        session_id: 'sess-merge-resolve',
        usage: SYNC_USAGE,
        start_sha_work: env.baseSha,
        end_sha_work: postMergeSha,
      },
    ];

    await handleCompletedResponses(env.storage, taskId, sessionArg(session!), responses, worktreePath, protoDir);

    const turns = await env.storage.getSessionTurns(sessionId);
    const syncTurns = turns.filter(t => t.turn_type === 'sync');
    // One supervisor turn + one agent reply turn, both tagged 'sync'.
    expect(syncTurns).toHaveLength(2);

    const mergeTurn = syncTurns[0];
    expect(mergeTurn.role).toBe('human');
    expect(mergeTurn.actor).toBe('supervisor');
    expect(mergeTurn.content).toContain('1 resolved conflict');
    // The supervisor turn is NOT polluted with the agent's resolution text.
    expect(mergeTurn.content).not.toContain('keeping both changes');

    const replyTurn = syncTurns[1];
    expect(replyTurn.role).toBe('agent');
    expect(replyTurn.content).toBe('Resolved the conflict in resolved.txt by keeping both changes.');
    // The reply turn carries the conflict-resolution invocation's OWN usage incl. cache.
    expect(replyTurn.usage?.inputTokens).toBe(80);
    expect(replyTurn.usage?.cacheCreationTokens).toBe(15);
    expect(replyTurn.usage?.cacheReadTokens).toBe(25);

    // The conflict-resolution session id is reconciled onto the session.
    expect((await env.storage.getSessionByTaskId(ref))!.agent_session_id).toBe('sess-merge-resolve');

    expect((await env.storage.getTask(taskId))!.status).toBe('blocked');
  });

  // INVARIANT 5: a second reconcile pass does not duplicate the sync turn.
  test('a second reconcile pass does not duplicate sync turns', async () => {
    const { ref, taskId, sessionId, worktreePath } = await makeWorkingTask(env, 'idempotent sync');
    const session = await env.storage.getSessionByTaskId(ref);
    const protoDir = getProtocolDir(taskId);

    const postMergeSha = commitMerge(worktreePath, 'from-upstream.txt');

    const responses: CompletedResponse[] = [
      {
        status: 'completed',
        result: `Merged main @ ${postMergeSha.substring(0, 8)}. HEAD: ${env.baseSha.substring(0, 8)} → ${postMergeSha.substring(0, 8)}.`,
        session_id: '',
        usage: { input_tokens: 0, output_tokens: 0 },
        sync: { merged: true, conflicts: 0 },
        start_sha_work: env.baseSha,
        end_sha_work: postMergeSha,
      },
    ];

    await handleCompletedResponses(env.storage, taskId, sessionArg(session!), responses, worktreePath, protoDir);
    await handleCompletedResponses(env.storage, taskId, sessionArg(session!), responses, worktreePath, protoDir);

    const turns = await env.storage.getSessionTurns(sessionId);
    expect(turns.filter(t => t.turn_type === 'sync')).toHaveLength(1);
  });
});
