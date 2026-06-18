/**
 * Unit tests for incremental turn persistence — recovering the agent's REAL
 * written report (not a placeholder) when a turn's finalize is lost.
 *
 * When the supervisor never produces a processable response (crash / kill / OOM
 * / teardown / hang at finalize), stranded-`working` recovery still runs. The
 * agent's report only ever lived in that lost response — EXCEPT that Claude Code
 * writes its session transcript JSONL to disk incrementally as the agent
 * produces text. Recovery reads the report back from that transcript instead of
 * dropping a placeholder.
 *
 * INVARIANTS this file encodes:
 *
 *   1. When the transcript is on disk, recovery surfaces the agent's ACTUAL
 *      report — not the lossy "written report for this turn was lost" placeholder.
 *
 *   2. Convergence: a late real finalize arriving AFTER recovery reconciles with
 *      the already-persisted recovered turn — exactly one agent turn, content
 *      kept, no duplicate and no clobber. Turn-completion semantics are
 *      unchanged; this is content-preservation only.
 *
 * The sweep's safety/liveness invariants live in recover-stranded-working.test.ts.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';
import { recoverStrandedWorkingTasks, handleCompletedResponse } from '../../src/utils/reconcile';
import { encodeProjectPath } from '../../src/import/claude-code-logs';
import { protocolDir as getProtocolDir } from '../../src/protocol';
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
  const lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-report-root-'));
  const basePath = await mkdtemp(join(tmpdir(), 'lazy-report-store-'));

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
 * Create a `working` task with a session and a `lazy/<ref>` branch carrying a
 * real (tree-changing) commit in the task's worktree — a turn whose work is
 * committed but whose finalize was lost.
 */
async function makeWorkingTask(env: Env, goal: string): Promise<{ ref: string; taskId: string }> {
  const task = await env.storage.createTask(goal, undefined, env.baseSha);
  const ref = taskRef(task);
  const branch = `lazy/${ref}`;

  await env.storage.createSession(task.id, 'claude-code', branch, env.baseSha);
  await env.storage.updateTaskStatus(task.id, 'working', 'system');

  git(env.lazyRoot, 'branch', branch, env.baseSha);
  const wt = getWorktreePathForRef(env.lazyRoot, ref);
  await mkdir(dirname(wt), { recursive: true });
  git(env.lazyRoot, 'worktree', 'add', wt, branch);

  await writeFile(join(wt, 'feature.ts'), 'export const x = 1;\n');
  git(wt, 'add', '.');
  git(wt, 'commit', '-m', 'agent: implement feature');

  return { ref, taskId: task.id };
}

/**
 * Write a synthetic Claude Code session JSONL into the worktree's sandbox
 * project directory — the byte-for-byte location the real agent writes its
 * transcript, and where stranded recovery reads the report back from. The
 * final assistant text block is the agent's report.
 */
async function writeAgentTranscript(
  env: Env,
  ref: string,
  reportText: string,
  sessionId = 'sess-recover-test',
): Promise<void> {
  const wt = getWorktreePathForRef(env.lazyRoot, ref);
  const projectDir = join(wt, '.lazy-task-sandbox', '.claude', 'projects', encodeProjectPath(wt));
  await mkdir(projectDir, { recursive: true });
  const lines = [
    JSON.stringify({
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-06-16T10:00:00.000Z',
      sessionId,
      cwd: wt,
      message: { role: 'user', content: 'Implement the feature.' },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2026-06-16T10:01:00.000Z',
      sessionId,
      message: { role: 'assistant', content: [{ type: 'text', text: reportText }] },
    }),
  ];
  await writeFile(join(projectDir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
}

describe('stranded recovery: agent report from transcript', () => {
  let env: Env;

  beforeEach(async () => {
    // grace periods → 0 so the sweep acts immediately on aged sessions.
    process.env.LAZY_TEST = '1';
    env = await setupEnv();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  // INVARIANT 1: the agent's transcript is on disk (Claude Code writes it
  // incrementally as the agent produces text), so recovery surfaces the actual
  // report — not the lossy "report was lost" placeholder.
  test('recovers the real agent report from the session transcript, not a placeholder', async () => {
    const { ref } = await makeWorkingTask(env, 'finished, transcript on disk');
    const report = 'Implemented the widget. Confidence high; edge cases covered.';
    await writeAgentTranscript(env, ref, report);

    await recoverStrandedWorkingTasks(env.storage, env.lazyRoot, makeRunner(false));

    const session = await env.storage.getSessionByTaskId(ref);
    const turns = await env.storage.getSessionTurns(session!.id);
    const agentTurn = turns.find(t => t.role === 'agent');

    // The real report is surfaced...
    expect(agentTurn?.content).toContain(report);
    // ...and the lossy "report for this turn was lost" placeholder is NOT used.
    expect(agentTurn?.content).not.toContain('written report for this turn was lost');
    // Still flagged as a recovery so the lost-finalize gap stays visible.
    expect(agentTurn?.content).toContain('Recovered');
  });

  // INVARIANT 2: a late real finalize arriving AFTER recovery must reconcile with
  // the already-persisted recovered turn — exactly one agent turn, content kept,
  // no duplicate or clobber.
  test('a late finalize after recovery does not duplicate or clobber the recovered turn', async () => {
    const { ref, taskId } = await makeWorkingTask(env, 'recovered then late finalize');
    const report = 'The agent report recovered from the transcript.';
    await writeAgentTranscript(env, ref, report);

    await recoverStrandedWorkingTasks(env.storage, env.lazyRoot, makeRunner(false));

    const session = await env.storage.getSessionByTaskId(ref);
    const worktreePath = getWorktreePathForRef(env.lazyRoot, ref);
    const protoDir = getProtocolDir(taskId);

    // The supervisor's real response arrives late (e.g. a racy liveness probe).
    await handleCompletedResponse(
      env.storage,
      taskId,
      {
        id: session!.id,
        agent_session_id: session!.agent_session_id,
        git_start_sha: session!.git_start_sha,
        container_name: session!.container_name,
      },
      {
        status: 'completed',
        result: 'The late, fully-finalized agent report.',
        session_id: 'sess-recover-test',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      worktreePath,
      protoDir,
    );

    const turns = await env.storage.getSessionTurns(session!.id);
    const agentTurns = turns.filter(t => t.role === 'agent');
    // Converged on ONE agent turn — the recovered one is kept, the late finalize
    // does not append a duplicate.
    expect(agentTurns.length).toBe(1);
    expect(agentTurns[0].content).toContain(report);
    expect(agentTurns[0].content).not.toContain('late, fully-finalized');

    const task = await env.storage.getTask(ref);
    expect(task?.status).toBe('blocked');
  });
});
