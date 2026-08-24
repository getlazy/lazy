/**
 * INVARIANT: auto-react budget counters SURVIVE a successful agent turn.
 *
 * `handleCompletedResponses` (the reconciler's turn finalizer) must NOT reset the
 * per-task auto-react counters, the consecutive auto-turn counter, or the
 * auto-react paused flag. Rationale, from public-docs/release/v0.11-walkthrough.md
 * ("Reset triggers"):
 *
 *   > Counters reset only when a human manually unblocks or resumes the task —
 *   > this is the signal that a human reviewed the situation and it's safe to
 *   > reset. Budget counters are NOT reset on successful turn completion,
 *   > because doing so would defeat the budget gate (counter resets to 0 after
 *   > every turn, allowing unlimited auto-triggers).
 *
 * A successful turn is exactly what an auto-triggered turn produces, so resetting
 * on completion zeroes the counter between every auto-react and the gate can
 * never be reached.
 *
 * RESURRECTION HISTORY — this is why the invariant is tested rather than merely
 * commented. The reset was removed on purpose by `0cf4c1b5` (MR!364, 2026-04-04),
 * then silently reintroduced by the bad v0.12 release merge `5857bdb0`, where it
 * lived on main until Finding A of docs/spikes/v012-release-resurrection-audit.md
 * caught it. Nothing guarded it the first time. This file is that guard: if it
 * fails, someone re-added a counter reset to the completion path. Do not "fix" it
 * by relaxing the assertions.
 *
 * Deliberately NOT covered here: `resetConsecutiveInterruptions`. That is the
 * crash circuit breaker, not a budget counter — `0cf4c1b5` kept it, and it must
 * re-arm after a healthy turn. Its survival is asserted below in the positive
 * direction so a future edit can't quietly drop it either.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';
import { handleCompletedResponses } from '../../src/utils/reconcile';
import {
  getAutoReactCount,
  getConsecutiveAutoTurns,
  isAutoReactPaused,
  recordAutoReact,
  shouldAutoReact,
  incrementDailyBudget,
} from '../../src/daemon/auto-react-budget';
import { protocolDir as getProtocolDir } from '../../src/protocol';
import type { CompletedResponse } from '../../src/protocol';
import type { ResolvedConfig } from '../../src/config/types';
import { getWorktreePathForRef, taskRef } from '../../src/cli/helpers';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSyncUnsupervised(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return result.stdout?.toString().trim() ?? '';
}

function testConfig(overrides?: Partial<ResolvedConfig['daemon']>): ResolvedConfig {
  return {
    daemon: {
      auto_react_ci: true,
      auto_react_comments: true,
      auto_react_max_retries: 3,
      auto_react_backoff: 'none',
      auto_react_daily_budget: 50,
      max_auto_turns: 3,
      ...overrides,
    },
  } as ResolvedConfig;
}

interface Env {
  lazyRoot: string;
  storage: FileStorage;
  baseSha: string;
  dataDir: string;
  cleanup: () => Promise<void>;
}

async function setupEnv(): Promise<Env> {
  const lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-budget-root-'));
  const basePath = await mkdtemp(join(tmpdir(), 'lazy-budget-store-'));
  const dataDir = await mkdtemp(join(tmpdir(), 'lazy-budget-data-'));

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
    dataDir,
    cleanup: async () => {
      await storage.close();
      await Promise.all([
        rm(lazyRoot, { recursive: true, force: true }),
        rm(basePath, { recursive: true, force: true }),
        rm(dataDir, { recursive: true, force: true }),
      ]);
    },
  };
}

/** A `working` task with a session and a worktree, ready to be finalized. */
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

  return { ref, taskId: task.id, sessionId: session.id, worktreePath, protoDir: getProtocolDir(task.id) };
}

function sessionArg(session: { id: string; agent_session_id: string | null; git_start_sha: string; container_name: string | null }) {
  return {
    id: session.id,
    agent_session_id: session.agent_session_id,
    git_start_sha: session.git_start_sha,
    container_name: session.container_name,
  };
}

const OK: CompletedResponse[] = [
  { status: 'completed', result: 'Turn done.', session_id: 'sess-1', usage: { input_tokens: 1, output_tokens: 1 } },
];

describe('reconciler: auto-react budget counters survive a successful turn', () => {
  let env: Env;

  beforeEach(async () => {
    process.env.LAZY_TEST = '1';
    env = await setupEnv();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  // INVARIANT: per-trigger counts, the consecutive auto-turn count, and the
  // paused flag are all untouched by turn completion.
  test('per-task counters and paused flag survive turn completion', async () => {
    const { taskId, ref, worktreePath, protoDir } = await makeWorkingTask(env, 'counters survive');
    const session = await env.storage.getSessionByTaskId(ref);

    await recordAutoReact(env.storage, taskId, 'ci_failure', env.dataDir);
    await recordAutoReact(env.storage, taskId, 'ci_failure', env.dataDir);
    await recordAutoReact(env.storage, taskId, 'comment', env.dataDir);

    expect(await getAutoReactCount(env.storage, taskId, 'ci_failure')).toBe(2);
    expect(await getConsecutiveAutoTurns(env.storage, taskId)).toBe(3);

    await handleCompletedResponses(env.storage, taskId, sessionArg(session!), OK, worktreePath, protoDir);

    expect(await env.storage.getTask(taskId).then(t => t!.status)).toBe('blocked');
    expect(await getAutoReactCount(env.storage, taskId, 'ci_failure')).toBe(2);
    expect(await getAutoReactCount(env.storage, taskId, 'comment')).toBe(1);
    expect(await getConsecutiveAutoTurns(env.storage, taskId)).toBe(3);
  });

  // INVARIANT: the gate actually FIRES across successful turns. This is the
  // end-to-end statement of the bug: with the reset in place, the per-trigger
  // count returned to 0 after each auto-triggered turn completed, so
  // shouldAutoReact said "allowed" forever.
  test('per-trigger gate stays closed after the turn it triggered completes', async () => {
    const { taskId, ref, worktreePath, protoDir } = await makeWorkingTask(env, 'gate fires');
    const session = await env.storage.getSessionByTaskId(ref);
    const config = testConfig({ auto_react_max_retries: 3, max_auto_turns: 99 });

    // Three CI-failure auto-reacts, each followed by the successful turn it caused.
    for (let i = 0; i < 3; i++) {
      const decision = await shouldAutoReact(env.storage, taskId, 'ci_failure', config, env.dataDir);
      expect(decision.allowed).toBe(true);
      await recordAutoReact(env.storage, taskId, 'ci_failure', env.dataDir);
      await env.storage.updateTaskStatus(taskId, 'working', 'system');
      await handleCompletedResponses(env.storage, taskId, sessionArg(session!), OK, worktreePath, protoDir);
    }

    // Fourth attempt must be refused — the budget is spent and the task paused.
    const blocked = await shouldAutoReact(env.storage, taskId, 'ci_failure', config, env.dataDir);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain('retries exhausted');
    expect(await isAutoReactPaused(env.storage, taskId)).toBe(true);

    // And the pause itself survives the next completed turn.
    await env.storage.updateTaskStatus(taskId, 'working', 'system');
    await handleCompletedResponses(env.storage, taskId, sessionArg(session!), OK, worktreePath, protoDir);
    expect(await isAutoReactPaused(env.storage, taskId)).toBe(true);
    const stillBlocked = await shouldAutoReact(env.storage, taskId, 'ci_failure', config, env.dataDir);
    expect(stillBlocked.allowed).toBe(false);
  });

  // INVARIANT: the per-task consecutive auto-turn budget (max_auto_turns) also
  // survives — it is reset by the same resetAutoReactCounters() call.
  test('consecutive auto-turn budget stays exhausted across successful turns', async () => {
    const { taskId, ref, worktreePath, protoDir } = await makeWorkingTask(env, 'auto-turn budget fires');
    const session = await env.storage.getSessionByTaskId(ref);
    const config = testConfig({ max_auto_turns: 2, auto_react_max_retries: 99 });

    for (let i = 0; i < 2; i++) {
      await recordAutoReact(env.storage, taskId, 'upstream_sync', env.dataDir);
      await env.storage.updateTaskStatus(taskId, 'working', 'system');
      await handleCompletedResponses(env.storage, taskId, sessionArg(session!), OK, worktreePath, protoDir);
    }

    const decision = await shouldAutoReact(env.storage, taskId, 'upstream_sync', config, env.dataDir);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('Auto-turn budget exhausted');
  });

  // INVARIANT: the project-wide daily budget gate is likewise still closed after a
  // successful turn. The daily counter lives in a file rather than task metadata,
  // so it was never in reach of the reset — this asserts the whole gate chain,
  // not just the metadata half.
  test('daily budget gate stays closed across successful turns', async () => {
    const { taskId, ref, worktreePath, protoDir } = await makeWorkingTask(env, 'daily budget fires');
    const session = await env.storage.getSessionByTaskId(ref);
    const config = testConfig({ auto_react_daily_budget: 2 });

    await incrementDailyBudget(env.dataDir);
    await incrementDailyBudget(env.dataDir);

    await env.storage.updateTaskStatus(taskId, 'working', 'system');
    await handleCompletedResponses(env.storage, taskId, sessionArg(session!), OK, worktreePath, protoDir);

    const decision = await shouldAutoReact(env.storage, taskId, 'comment', config, env.dataDir);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('Daily auto-react budget exhausted');
  });

  // INVARIANT (opposite direction): the CRASH circuit breaker DOES reset on a
  // successful turn — it is not a budget counter, and a healthy turn must re-arm
  // auto-resume. `0cf4c1b5` removed only the auto-react reset and kept this one.
  test('consecutive interruption counter is still reset on turn completion', async () => {
    const { taskId, ref, sessionId, worktreePath, protoDir } = await makeWorkingTask(env, 'crash counter resets');
    const session = await env.storage.getSessionByTaskId(ref);

    const interrupt = { reason: 'crash', exit_code: 1, logs: null };
    await env.storage.recordInterrupt(sessionId, interrupt);
    await env.storage.recordInterrupt(sessionId, interrupt);
    expect((await env.storage.getSessionByTaskId(ref))!.consecutive_interruptions).toBe(2);

    await env.storage.updateTaskStatus(taskId, 'working', 'system');
    await handleCompletedResponses(env.storage, taskId, sessionArg(session!), OK, worktreePath, protoDir);

    expect((await env.storage.getSessionByTaskId(ref))!.consecutive_interruptions).toBe(0);
  });
});
