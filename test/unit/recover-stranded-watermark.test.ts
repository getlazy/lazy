/**
 * Unit tests for watermark-based stranded-turn recovery.
 *
 * The Claude Code transcript is a rolling record of the WHOLE session — every
 * turn's text, not just the current one's. Recovery used to take "the latest
 * assistant message" as the stranded turn's report. That is wrong when a turn
 * strands having produced NO report (a crash before the agent wrote anything):
 * the latest message is then the PREVIOUS turn's report, and it would be
 * misattributed to this turn under a "[Recovered]" banner.
 *
 * The fix is a watermark: recover only transcript content NEWER than the last
 * finalized turn. The persisted turns' timestamps are the high-water mark of
 * consumed transcript, so this needs no new persistent state.
 *
 * INVARIANTS this file encodes:
 *
 *   1. No-report-this-turn: when nothing in the transcript is newer than the
 *      last finalized turn, recovery falls back to the lossy placeholder and
 *      does NOT resurface the previous turn's report.
 *
 *   2. Has-report-this-turn: when the transcript DOES contain content newer than
 *      the last finalized turn, recovery surfaces THAT content — and only that,
 *      not the stale previous-turn report that also sits in the transcript.
 *
 * The sweep's safety/liveness invariants live in recover-stranded-working.test.ts;
 * the basic transcript-extraction invariants live in recover-stranded-report.test.ts.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';
import { recoverStrandedWorkingTasks } from '../../src/utils/reconcile';
import { encodeProjectPath } from '../../src/import/claude-code-logs';
import { getWorktreePathForRef, taskRef } from '../../src/cli/helpers';
import type { Runner } from '../../src/runner';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';

function git(cwd: string, ...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSyncUnsupervised(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
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
  const lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-wm-root-'));
  const basePath = await mkdtemp(join(tmpdir(), 'lazy-wm-store-'));

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
 * Build a `working` task that has ALREADY had one turn finalized (a prior agent
 * turn + its committed work recorded in storage), then a human feedback turn,
 * and is now stranded on a SECOND turn whose work is committed on the branch but
 * never recorded. This is the realistic shape where the resurfacing bug bites:
 * the prior turn's report sits in the transcript, and the watermark must stop it
 * from being misattributed to the stranded turn.
 */
async function makeStrandedSecondTurn(env: Env, goal: string): Promise<{
  ref: string;
  taskId: string;
  sessionId: string;
  watermarkMs: number;
  priorSha: string;
}> {
  const task = await env.storage.createTask(goal, undefined, env.baseSha);
  const ref = taskRef(task);
  const branch = `lazy/${ref}`;

  const session = await env.storage.createSession(task.id, 'claude-code', branch, env.baseSha);
  await env.storage.updateTaskStatus(task.id, 'working', 'system');

  git(env.lazyRoot, 'branch', branch, env.baseSha);
  const wt = getWorktreePathForRef(env.lazyRoot, ref);
  await mkdir(dirname(wt), { recursive: true });
  git(env.lazyRoot, 'worktree', 'add', wt, branch);

  // --- Prior turn: real committed work, recorded in storage. ---
  await writeFile(join(wt, 'first.ts'), 'export const a = 1;\n');
  git(wt, 'add', '.');
  git(wt, 'commit', '-m', 'agent: first turn');
  const priorSha = git(wt, 'rev-parse', 'HEAD').stdout;
  await env.storage.createCommit(session.id, priorSha, 'agent: first turn');

  // Prior agent turn, then a human feedback turn (so the last persisted turn is
  // NOT an agent turn — otherwise the idempotency guard would skip recovery).
  await env.storage.createTurn({
    sessionId: session.id,
    sequence: await env.storage.getNextTurnSequence(session.id),
    role: 'agent',
    content: 'First turn report (already finalized).',
  });
  const humanTurn = await env.storage.createTurn({
    sessionId: session.id,
    sequence: await env.storage.getNextTurnSequence(session.id),
    role: 'human',
    content: 'Please also do the second thing.',
  });

  // --- Stranded second turn: committed work, NOT recorded in storage. ---
  await writeFile(join(wt, 'second.ts'), 'export const b = 2;\n');
  git(wt, 'add', '.');
  git(wt, 'commit', '-m', 'agent: second turn');

  return { ref, taskId: task.id, sessionId: session.id, watermarkMs: humanTurn.timestamp, priorSha };
}

/** Write a transcript with arbitrary assistant messages into the worktree's sandbox. */
async function writeTranscript(
  env: Env,
  ref: string,
  messages: Array<{ text: string; ms: number }>,
  sessionId = 'sess-watermark-test',
): Promise<void> {
  const wt = getWorktreePathForRef(env.lazyRoot, ref);
  const projectDir = join(wt, '.lazy-task-sandbox', '.claude', 'projects', encodeProjectPath(wt));
  await mkdir(projectDir, { recursive: true });
  const lines = [
    JSON.stringify({
      type: 'user',
      uuid: 'u1',
      timestamp: new Date(messages[0].ms - 1000).toISOString(),
      sessionId,
      cwd: wt,
      message: { role: 'user', content: 'go' },
    }),
    ...messages.map((m, i) =>
      JSON.stringify({
        type: 'assistant',
        uuid: `a${i}`,
        timestamp: new Date(m.ms).toISOString(),
        sessionId,
        message: { role: 'assistant', content: [{ type: 'text', text: m.text }] },
      }),
    ),
  ];
  await writeFile(join(projectDir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
}

describe('watermark-based stranded recovery', () => {
  let env: Env;

  beforeEach(async () => {
    process.env.LAZY_TEST = '1'; // grace period → 0 so the sweep acts immediately
    env = await setupEnv();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  // INVARIANT 1: a turn that produced NO report must fall back to the placeholder
  // and must NOT resurface the previous turn's report (the latest message in the
  // transcript), which sits at/before the watermark.
  test('no report this turn → placeholder, does NOT resurface the prior turn report', async () => {
    const { ref, watermarkMs } = await makeStrandedSecondTurn(env, 'stranded with no new report');
    const PRIOR_REPORT = 'PRIOR TURN REPORT — must NOT be resurfaced as this turn.';
    // Only the prior turn's report exists in the transcript, timestamped BEFORE
    // the watermark — the stranded turn wrote nothing.
    await writeTranscript(env, ref, [{ text: PRIOR_REPORT, ms: watermarkMs - 60_000 }]);

    await recoverStrandedWorkingTasks(env.storage, env.lazyRoot, makeRunner(false));

    const session = await env.storage.getSessionByTaskId(ref);
    const turns = await env.storage.getSessionTurns(session!.id);
    const recoveryTurn = turns[turns.length - 1];

    expect(recoveryTurn.role).toBe('agent');
    // Falls back to the lossy placeholder...
    expect(recoveryTurn.content).toContain('written report for this turn was lost');
    // ...and does NOT misattribute the previous turn's report to this turn.
    expect(recoveryTurn.content).not.toContain(PRIOR_REPORT);
    // Task still moved to blocked (the committed work was backfilled).
    const task = await env.storage.getTask(ref);
    expect(task?.status).toBe('blocked');
  });

  // INVARIANT 2: when this turn DID produce content newer than the watermark,
  // recovery surfaces THAT content — and not the stale prior-turn report that
  // also lives in the transcript.
  test('report this turn → surfaces the new report, not the stale prior report', async () => {
    const { ref, watermarkMs } = await makeStrandedSecondTurn(env, 'stranded with a new report');
    const PRIOR_REPORT = 'STALE PRIOR REPORT — older than the watermark.';
    const NEW_REPORT = 'THIS TURN report — newer than the watermark.';
    await writeTranscript(env, ref, [
      { text: PRIOR_REPORT, ms: watermarkMs - 60_000 },
      { text: NEW_REPORT, ms: watermarkMs + 60_000 },
    ]);

    await recoverStrandedWorkingTasks(env.storage, env.lazyRoot, makeRunner(false));

    const session = await env.storage.getSessionByTaskId(ref);
    const turns = await env.storage.getSessionTurns(session!.id);
    const recoveryTurn = turns[turns.length - 1];

    expect(recoveryTurn.role).toBe('agent');
    // Surfaces this turn's real report...
    expect(recoveryTurn.content).toContain(NEW_REPORT);
    expect(recoveryTurn.content).toContain('Recovered');
    // ...without the lossy placeholder...
    expect(recoveryTurn.content).not.toContain('written report for this turn was lost');
    // ...and without resurfacing the stale prior report.
    expect(recoveryTurn.content).not.toContain(PRIOR_REPORT);
  });
});
