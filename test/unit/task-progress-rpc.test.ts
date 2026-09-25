/**
 * The `taskProgress` RPC — what a running task has spent so far, including the
 * turn still in flight.
 *
 * INVARIANT (docs/design/lazy-teams.md §14): mid-turn numbers come from the
 * proxy's in-memory tally, not the store, because the store has nothing until
 * the reconciler records the turn. The handler adds the two together and marks
 * the answer `live` only while the task is working — that flag is what stops a
 * client polling a task that has finished.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  initDaemonStorage,
  getOrCreateStorage,
  closeAllStorage,
  handleTaskProgress,
  RpcError,
} from '../../src/daemon/rpc-handlers';
import { taskProgress } from '../../src/daemon/task-progress';
import { runGit } from '../../src/utils/git';
import { getWorktreePath } from '../../src/task/identity';
import type { ProxyAuditRecord } from '../../src/storage/types';

function proxyRequest(taskId: string, ts: number, tokens: number): ProxyAuditRecord {
  return {
    id: `r${ts}`,
    seq: ts,
    ts,
    role: 'agent',
    taskId,
    backend: 'anthropic',
    upstream: 'https://api.anthropic.com',
    method: 'POST',
    path: '/v1/messages',
    endpoint: 'messages',
    model: 'claude-opus-5',
    tier: 'opus',
    stream: true,
    usage: {
      inputTokens: tokens,
      outputTokens: 0,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    },
  } as ProxyAuditRecord;
}

describe('taskProgress RPC', () => {
  let root: string;
  let prevLazyConfig: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-taskprogress-'));
    const configPath = join(root, 'lazy.toml');
    await writeFile(
      configPath,
      `[storage]\nbackend = "external"\nexternal_path = "${join(root, 'store')}"\n`,
    );
    // The in-process test cwd is lazy's own worktree, so loadConfig would
    // otherwise adopt lazy's lazy.toml and its live store.
    prevLazyConfig = process.env.LAZY_CONFIG;
    process.env.LAZY_CONFIG = configPath;
    taskProgress.reset();
    initDaemonStorage(root);
  });

  afterEach(async () => {
    await closeAllStorage();
    taskProgress.reset();
    if (prevLazyConfig === undefined) delete process.env.LAZY_CONFIG;
    else process.env.LAZY_CONFIG = prevLazyConfig;
    await rm(root, { recursive: true, force: true });
  });

  async function workingTask() {
    const storage = await getOrCreateStorage();
    const task = await storage.createTask('Demo', undefined, undefined, 'demo-task');
    const session = await storage.createSession(task.id, 'claude', `lazy/${task.code}`, 'abc123');
    await storage.updateTaskStatus(task.id, 'working');
    return { storage, task, session };
  }

  test('adds the in-flight turn to what the store already recorded', async () => {
    const { storage, task, session } = await workingTask();
    await storage.updateSessionUsage(session.id, {
      inputTokens: 900,
      outputTokens: 100,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });

    // Every proxy request the agent has made since the (absent) last turn.
    taskProgress.record(proxyRequest(task.id, Date.now() + 1000, 250));

    const progress = await handleTaskProgress(root, { taskId: task.id });
    expect(progress.live).toBe(true);
    expect(progress.tokens.recorded).toBe(1000);
    expect(progress.tokens.turn).toBe(250);
    expect(progress.tokens.total).toBe(1250);
    expect(progress.requests.turn).toBe(1);
    expect(progress.displayId).toBe('demo-task');
  });

  // INVARIANT: proxy traffic that predates the last recorded turn is already IN
  // `session.total_usage`. Counting it again is the double-count the timestamp
  // boundary exists to prevent — and it self-corrects with no reconciler hook.
  test('traffic from a turn already recorded is not counted twice', async () => {
    const { storage, task, session } = await workingTask();
    const turnAt = Date.now();
    await storage.createTurn({
      sessionId: session.id,
      sequence: 1,
      role: 'agent',
      content: 'first turn',
      usage: { inputTokens: 500, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    });
    await storage.updateSessionUsage(session.id, {
      inputTokens: 500,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });

    // The requests that produced that turn, plus one from the turn now running.
    taskProgress.record(proxyRequest(task.id, turnAt - 60_000, 500));
    taskProgress.record(proxyRequest(task.id, turnAt + 60_000, 40));

    const progress = await handleTaskProgress(root, { taskId: task.id });
    expect(progress.tokens.recorded).toBe(500);
    expect(progress.tokens.turn).toBe(40);
    expect(progress.tokens.total).toBe(540);
    expect(progress.turns).toBe(1);
  });

  // A finished task has nothing left to tick, and `live: false` is what tells a
  // page to stop asking. The live tally is not even consulted.
  test('a task that is not working reports no live figures', async () => {
    const { storage, task } = await workingTask();
    await storage.updateTaskStatus(task.id, 'blocked');
    taskProgress.record(proxyRequest(task.id, Date.now() + 1000, 250));

    const progress = await handleTaskProgress(root, { taskId: task.id });
    expect(progress.live).toBe(false);
    expect(progress.tokens.turn).toBe(0);
    expect(progress.requests.turn).toBe(0);
  });

  test('counts the commits the store knows about', async () => {
    const { storage, task, session } = await workingTask();
    await storage.createCommit(session.id, 'aaa1111', 'first');
    await storage.createCommit(session.id, 'bbb2222', 'second');
    await storage.updateTaskStatus(task.id, 'blocked');

    const progress = await handleTaskProgress(root, { taskId: task.id });
    expect(progress.commits).toBe(2);
  });

  /**
   * A live task whose worktree carries its own commit plus a merge of an
   * upstream line — the shape that made the store record 790 commits, asked
   * here of the LIVE counter instead.
   */
  async function liveTaskWithMergedUpstream() {
    const storage = await getOrCreateStorage();
    const task = await storage.createTask('Merged', undefined, undefined, 'merged-task');

    const wt = getWorktreePath(root, task);
    const git = async (...args: string[]) => {
      const r = await runGit(args, { cwd: wt });
      if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    await runGit(['init', '-q', '-b', 'main', wt], { cwd: root });
    await git('config', 'user.email', 't@e.com');
    await git('config', 'user.name', 'T');

    await writeFile(join(wt, 'a.txt'), 'a\n');
    await git('add', '.');
    await git('commit', '-q', '-m', 'base');
    const branchPoint = await git('rev-parse', 'HEAD');

    await git('checkout', '-q', '-b', 'task');
    await writeFile(join(wt, 'own.txt'), 'own\n');
    await git('add', '.');
    await git('commit', '-q', '-m', 'task: own work');

    // Upstream gains five commits, which the task then merges.
    await git('checkout', '-q', 'main');
    for (let i = 0; i < 5; i++) {
      await writeFile(join(wt, `up${i}.txt`), `${i}\n`);
      await git('add', '.');
      await git('commit', '-q', '-m', `upstream: ${i}`);
    }
    await git('checkout', '-q', 'task');
    await git('merge', '-q', '--no-ff', '-m', 'Merge main', 'main');

    const session = await storage.createSession(task.id, 'claude', `lazy/${task.code}`, branchPoint);
    await storage.updateTaskStatus(task.id, 'working');
    return { storage, task, session, branchPoint };
  }

  test('the live commit count is what THIS branch did, not what it merged', async () => {
    // INVARIANT: the live readout counts FIRST-PARENT from the branch point.
    // A bare `rev-list --count` reports every commit of a merged-in line as
    // work done this turn — the counting twin of the range bug this task
    // exists to remove. Here that would answer 7 instead of 2.
    const { task } = await liveTaskWithMergedUpstream();

    const progress = await handleTaskProgress(root, { taskId: task.id });

    // The task's own commit and the merge commit. The five the merge carried
    // in are upstream's work.
    expect(progress.live).toBe(true);
    expect(progress.commits).toBe(2);
  });

  test('a stale legacy record cannot drag the live count backwards', async () => {
    // The store sorts by WRITE time while git answers newest-first, so on a
    // task carrying legacy records the last element is the OLDEST of its
    // batch. Anchoring the live range there is the compounding half of the
    // bug: it would answer 8 (1 recorded + 7 walked from an ancient commit).
    const { storage, task, session, branchPoint } = await liveTaskWithMergedUpstream();
    await storage.createCommit(session.id, branchPoint, 'upstream: ancient');

    const progress = await handleTaskProgress(root, { taskId: task.id });

    // Still anchored at the branch point: 2 on the branch, 1 already recorded.
    expect(progress.commits).toBe(2);
  });

  test('an unknown task is a 404, not an empty readout', async () => {
    await workingTask();
    await expect(handleTaskProgress(root, { taskId: 'nope-not-a-task' })).rejects.toBeInstanceOf(RpcError);
  });
});
