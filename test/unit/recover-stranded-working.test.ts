/**
 * Unit tests for the `recoverStrandedWorkingTasks` reconcile sweep.
 *
 * Background — the bug this sweep exists to fix:
 *
 *   An agent finishes a turn and commits real work to its branch, but the
 *   supervisor never produces a processable response (crash / kill / OOM /
 *   teardown at finalize, or an agent that committed and reported but never
 *   exited so no response is ever written). The normal completion path never
 *   runs, so the task wedges in `working` forever: zero agent turns, zero
 *   recorded commits, no blocked transition, no review notification. The live
 *   specimen had 625 committed lines on its branch while storage showed
 *   commit_count=0.
 *
 * INVARIANTS this file encodes:
 *
 *   1. The durable proof of work is the git branch, not storage. A `working`
 *      task whose run is no longer alive and whose branch holds real committed
 *      content is recovered to `blocked` with those commits backfilled.
 *
 *   2. The real-work gate: a branch with only an empty `lazy start` init commit
 *      (--allow-empty, no tree change) is NOT work. Such a task is left for the
 *      interrupted/auto-resume path — the sweep must not "recover" it to blocked.
 *
 *   3. Safety: liveness is authoritative. A genuinely-alive run (isRunning=true)
 *      is NEVER recovered — even with committed work and even with a stale
 *      turn-end marker present — because the marker means "the AGENT thinks it's
 *      done," not "the turn is done." The marker persists through legitimate
 *      post-turn finalization (post_turn_check / post_turn_sync / pushback)
 *      before the supervisor writes response.json; only that response finalizes
 *      a turn. Defense-in-depth: a not-alive run is still not recovered while its
 *      status.json phase shows active harness work (a racy liveness probe guard).
 *
 *   4. The recovery transition `working → blocked` goes through the canonical
 *      state machine (updateTaskStatus asserts the transition).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';
import { recoverStrandedWorkingTasks } from '../../src/utils/reconcile';
import { protocolDir as getProtocolDir, ensureProtocolDir, writeStatus } from '../../src/protocol';
import { writeTurnEndSignal } from '../../src/protocol/turn-end-signal';
import { getWorktreePathForRef, taskRef } from '../../src/cli/helpers';
import type { Runner } from '../../src/runner';
import { spawnSync } from '../../src/utils/spawn';

function git(cwd: string, ...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return {
    stdout: result.stdout?.toString().trim() ?? '',
    stderr: result.stderr?.toString().trim() ?? '',
    exitCode: result.exitCode ?? -1,
  };
}

/** Minimal Runner stub — only the methods the sweep calls are implemented. */
function makeRunner(alive: boolean): Runner {
  return {
    runNameForTask: (ref: string) => `lazy-${ref}`,
    isRunning: async () => alive,
    runExists: async () => false,
    removeRun: async () => {},
  } as unknown as Runner;
}

interface Env {
  lazyRoot: string;
  storage: FileStorage;
  baseSha: string;
  cleanup: () => Promise<void>;
}

async function setupEnv(): Promise<Env> {
  const lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-stranded-root-'));
  const basePath = await mkdtemp(join(tmpdir(), 'lazy-stranded-store-'));

  git(lazyRoot, 'init');
  git(lazyRoot, 'config', 'user.email', 'test@lazy.test');
  git(lazyRoot, 'config', 'user.name', 'Lazy Test');
  git(lazyRoot, 'checkout', '-b', 'main');
  await writeFile(join(lazyRoot, 'README.md'), '# base\n');
  git(lazyRoot, 'add', '.');
  git(lazyRoot, 'commit', '-m', 'base');
  const baseSha = git(lazyRoot, 'rev-parse', 'HEAD').stdout;

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

/**
 * Create a `working` task with a session and a `lazy/<ref>` branch checked out
 * in the task's worktree. When `realWork` is true the branch carries a commit
 * that changes the tree; otherwise it carries only an empty init commit.
 * Returns the task's short ref and full id.
 */
async function makeWorkingTask(env: Env, goal: string, realWork: boolean): Promise<{ ref: string; taskId: string }> {
  const task = await env.storage.createTask(goal, undefined, env.baseSha);
  const ref = taskRef(task);
  const branch = `lazy/${ref}`;

  await env.storage.createSession(task.id, 'claude-code', branch, env.baseSha);
  await env.storage.updateTaskStatus(task.id, 'working', 'system');

  // Lay down the branch in the task's worktree, exactly where the sweep looks.
  git(env.lazyRoot, 'branch', branch, env.baseSha);
  const wt = getWorktreePathForRef(env.lazyRoot, ref);
  await mkdir(dirname(wt), { recursive: true });
  git(env.lazyRoot, 'worktree', 'add', wt, branch);

  if (realWork) {
    await writeFile(join(wt, 'feature.ts'), 'export const x = 1;\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-m', 'agent: implement feature');
  } else {
    git(wt, 'commit', '--allow-empty', '-m', 'init');
  }

  return { ref, taskId: task.id };
}

describe('recoverStrandedWorkingTasks', () => {
  let env: Env;

  beforeEach(async () => {
    // grace periods → 0 so the sweep acts immediately on aged sessions.
    process.env.LAZY_TEST = '1';
    env = await setupEnv();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  // INVARIANT 1: stranded `working` task with real committed work + dead run →
  // recovered to `blocked`, commits backfilled, recovery turn recorded.
  test('recovers a stranded working task whose run is dead and backfills commits', async () => {
    const { ref } = await makeWorkingTask(env, 'finished but never finalized', true);

    await recoverStrandedWorkingTasks(env.storage, env.lazyRoot, makeRunner(false));

    const task = await env.storage.getTask(ref);
    expect(task?.status).toBe('blocked');

    const session = await env.storage.getSessionByTaskId(ref);
    const commits = await env.storage.getSessionCommits(session!.id);
    expect(commits.length).toBeGreaterThan(0);

    const turns = await env.storage.getSessionTurns(session!.id);
    const agentTurn = turns.find(t => t.role === 'agent');
    expect(agentTurn?.content).toContain('Recovered');
  });

  // INVARIANT 2: real-work gate — only the empty init commit means no work to
  // review, so the sweep leaves the task alone (interrupted/resume is
  // reconcileTask's job, not this sweep's).
  test('does NOT recover a working task whose branch has only an empty init commit', async () => {
    const { ref } = await makeWorkingTask(env, 'no real work', false);

    await recoverStrandedWorkingTasks(env.storage, env.lazyRoot, makeRunner(false));

    const task = await env.storage.getTask(ref);
    expect(task?.status).toBe('working');

    const session = await env.storage.getSessionByTaskId(ref);
    const commits = await env.storage.getSessionCommits(session!.id);
    expect(commits.length).toBe(0);
  });

  // INVARIANT 3: liveness is authoritative — a genuinely-alive run is NEVER
  // recovered, even with committed work.
  test('does NOT recover a task whose run is still alive', async () => {
    const { ref } = await makeWorkingTask(env, 'still working', true);

    await recoverStrandedWorkingTasks(env.storage, env.lazyRoot, makeRunner(true));

    const task = await env.storage.getTask(ref);
    expect(task?.status).toBe('working');
  });

  // INVARIANT 3 (regression): an ALIVE run with a STALE turn-end marker is still
  // never recovered. The marker means "the agent thinks it's done" and persists
  // through legitimate post-turn finalization (post_turn_check / post_turn_sync /
  // pushback) before the supervisor writes response.json — recovering there would
  // race the supervisor and corrupt the turn. Liveness, not the marker, decides.
  test('does NOT recover an alive run even with a stale turn-end marker present', async () => {
    const { ref, taskId } = await makeWorkingTask(env, 'finalizing, marker set', true);

    // Simulate the agent having signalled end-of-turn a long time ago.
    const protoDir = getProtocolDir(taskId);
    ensureProtocolDir(protoDir);
    await writeTurnEndSignal(protoDir, {
      commit_sha: 'deadbeef',
      written_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h ago
    });

    await recoverStrandedWorkingTasks(env.storage, env.lazyRoot, makeRunner(true));

    const task = await env.storage.getTask(ref);
    expect(task?.status).toBe('working');

    const session = await env.storage.getSessionByTaskId(ref);
    const commits = await env.storage.getSessionCommits(session!.id);
    expect(commits.length).toBe(0);
  });

  // INVARIANT 3 (defense-in-depth): even with a dead-looking run, a task whose
  // status.json phase shows active post-work harness machinery is NOT recovered —
  // this guards against a racy liveness probe stomping a turn mid-finalization.
  test('does NOT recover a (not-alive) task whose status phase is active harness work', async () => {
    const { ref, taskId } = await makeWorkingTask(env, 'post-turn check running', true);

    const protoDir = getProtocolDir(taskId);
    ensureProtocolDir(protoDir);
    const now = new Date().toISOString();
    writeStatus(protoDir, {
      phase: 'post_turn_check',
      task_id: taskId,
      command_type: 'start',
      started_at: now,
      updated_at: now,
      phase_started_at: now,
      pid: 0,
    });

    await recoverStrandedWorkingTasks(env.storage, env.lazyRoot, makeRunner(false));

    const task = await env.storage.getTask(ref);
    expect(task?.status).toBe('working');

    const session = await env.storage.getSessionByTaskId(ref);
    const commits = await env.storage.getSessionCommits(session!.id);
    expect(commits.length).toBe(0);
  });

  // INVARIANT 4: re-running the sweep is idempotent — once blocked, the task is
  // no longer `working`, so it is not processed again (no duplicate turns).
  test('is idempotent — a recovered task is not reprocessed', async () => {
    const { ref } = await makeWorkingTask(env, 'finished once', true);

    await recoverStrandedWorkingTasks(env.storage, env.lazyRoot, makeRunner(false));
    await recoverStrandedWorkingTasks(env.storage, env.lazyRoot, makeRunner(false));

    const session = await env.storage.getSessionByTaskId(ref);
    const turns = await env.storage.getSessionTurns(session!.id);
    const agentTurns = turns.filter(t => t.role === 'agent');
    expect(agentTurns.length).toBe(1);
  });
});
