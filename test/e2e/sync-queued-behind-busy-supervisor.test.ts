/**
 * A sync whose command QUEUES behind a supervisor that is still busy — on the
 * real supervisor (fake claude), because the queueing is the supervisor's.
 *
 * A task can be parked while its supervisor is still running a turn (a
 * liveness probe that read the live run as dead and "recovered" it). The next
 * launch then finds the task's run alive and leaves its command for that
 * supervisor to pick up next, so the OLD turn's response is the next thing in
 * the mailbox. The reconciler used to read it as the new turn's answer and park
 * the task — and the queued sync then ran under `blocked`, where the
 * conflict-resolving agent's `lazy_commit` was refused with "the task has no
 * turn running" and the merge stayed staged until somebody unblocked the task.
 * Seen on two tasks of the 2026-10-18 release cluster.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync } from 'fs';
import { join } from 'path';
import { readFile, writeFile, rm } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { successScenario, sessionStartEvent, resultEvent, type ClaudeScenario } from '../helpers/fake-claude';
import { allTurns } from '../helpers/agent-seam';
import { findFullTaskId, readTaskStatus, setTaskStatus, worktreePathFor } from '../helpers/storage';
import { getDaemonTcpTarget } from '../../src/daemon/lifecycle';
import { mintMcpToken, clearMcpTokenCache } from '../../src/daemon/mcp-tokens';

function gitIn(cwd: string, ...args: string[]): { stdout: string; exitCode: number } {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return { stdout: result.stdout.toString(), exitCode: result.exitCode };
}

async function waitFor(what: string, check: () => boolean | Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** An invocation that stays live while `holdPath` exists, then answers. */
function heldInvocation(sessionId: string, holdPath: string, result: string, before: ClaudeScenario['steps'] = []): ClaudeScenario {
  return {
    steps: [
      { kind: 'emit', event: sessionStartEvent(sessionId) },
      ...before,
      { kind: 'hold-while-file', path: holdPath },
      { kind: 'declare-presentation' },
      { kind: 'emit', event: resultEvent({ result, sessionId }) },
    ],
  };
}

describe('a sync queued behind a busy supervisor', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    clearMcpTokenCache();
    ctx = await setupTestLazy({ fakeClaude: true });
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    const after = before.replace('# mode = "low_high"', 'mode = "off"');
    expect(after).not.toBe(before);
    await writeFile(configPath, after);
    ctx.git('add', 'lazy.toml');
    expect(ctx.git('commit', '-m', 'Test config').exitCode).toBe(0);
  });

  afterEach(async () => {
    await ctx.cleanup();
    clearMcpTokenCache();
  });

  /** A call the way the turn's agent makes it: the task's own token, through the daemon route. */
  async function taskTool(fullTaskId: string, tool: string, args: Record<string, unknown>): Promise<{ status: number; body: string }> {
    clearMcpTokenCache();
    const token = await mintMcpToken(ctx.root, { kind: 'task', taskId: fullTaskId }, 'e2e-agent');
    const target = getDaemonTcpTarget(ctx.root);
    if (!target) throw new Error('test daemon did not record a TCP target');
    const base = target.startsWith('http') ? target : `http://${target}`;
    const resp = await fetch(`${base}/mcp/${fullTaskId}/${tool}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'X-Lazy-Project': ctx.root },
      body: JSON.stringify({ arguments: args }),
    } as any);
    return { status: resp.status, body: await resp.text() };
  }

  // INVARIANT: a response only ends the turn it answers. The answer to an
  // earlier command is recorded as a superseded turn and the task stays
  // `working` for the command queued behind it, so that command's agent can
  // write — here, conclude the conflicted merge with lazy_commit — instead of
  // being refused as having no turn running.
  test('the conflict-resolving agent of the queued sync commits the merge through lazy_commit', async () => {
    const holdWork = join(ctx.root, '..', `hold-work-${Date.now()}`);
    const holdMerge = join(ctx.root, '..', `hold-merge-${Date.now()}`);
    await writeFile(holdWork, '');

    const taskId = await createTask(ctx, 'Queued sync', 'Do the work');
    const fullTaskId = findFullTaskId(ctx.root, taskId);
    await ctx.setClaudeScenario({ sequence: [
      heldInvocation('qs-work', holdWork, 'First turn done.', [
        { kind: 'commit', message: 'Task side', files: [{ path: 'shared.txt', content: 'task version\n' }] },
      ]),
      // The first turn's wrap-up presentation step.
      successScenario({ result: 'Presented.', sessionId: 'qs-work', declarePresentation: true }),
      heldInvocation('qs-merge', holdMerge, 'Resolved the conflict and committed the merge.'),
    ] });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    const worktree = worktreePathFor(ctx.root, taskId);
    await waitFor('the first turn to commit', () => gitIn(worktree, 'log', '-1', '--format=%s').stdout.trim() === 'Task side');

    // Main moves on the same file, so the sync conflicts.
    ctx.git('checkout', 'main');
    await writeFile(join(ctx.root, 'shared.txt'), 'main version\n');
    ctx.git('add', 'shared.txt');
    expect(ctx.git('commit', '-m', 'Main side').exitCode).toBe(0);
    const mainSha = ctx.git('rev-parse', 'HEAD').stdout.trim();

    // The task is parked while its supervisor is still inside the first turn,
    // as a false "dead run" recovery leaves it.
    setTaskStatus(ctx.root, taskId, 'blocked');

    // The sync finds the run alive and queues its command behind the turn.
    await writeFile(holdMerge, '');
    expectSuccess(await ctx.lazy(['sync', taskId]));
    expect(readTaskStatus(ctx.root, taskId)).toBe('working');

    // The first turn ends; its supervisor then picks up the queued sync, and
    // the conflicted merge is handed to the agent.
    await rm(holdWork, { force: true });
    await waitFor('the queued sync to leave its merge for the agent', () =>
      gitIn(worktree, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').exitCode === 0);
    // The reconciler has read the FIRST turn's answer — it is on the task
    // (recorded as a superseded turn) — and did not park the task under the
    // queued sync.
    await waitFor('the first turn to be recorded', async () =>
      (await allTurns(ctx.root, taskId)).some(t => String(t.content ?? '').includes('First turn done.')));
    expect(readTaskStatus(ctx.root, taskId)).toBe('working');

    // The agent resolves the conflict and concludes the merge.
    await writeFile(join(worktree, 'shared.txt'), 'merged version\n');
    const commit = await taskTool(fullTaskId, 'lazy_commit', { message: 'Merge main' });
    expect(commit.body).not.toContain('no turn running');
    expect(commit.status).toBe(200);

    await rm(holdMerge, { force: true });
    expectSuccess(await ctx.lazy(['wait', taskId]));

    // A real merge of main, concluded by the agent's own commit, and the sync
    // parked on its own answer.
    const parents = gitIn(worktree, 'rev-list', '--parents', '-n', '1', 'HEAD').stdout.trim().split(' ');
    expect(parents.length).toBe(3);
    expect(gitIn(worktree, 'merge-base', '--is-ancestor', mainSha, 'HEAD').exitCode).toBe(0);
    expect(await readFile(join(worktree, 'shared.txt'), 'utf-8')).toBe('merged version\n');
    const turns = await allTurns(ctx.root, taskId);
    expect(turns.some(t => t.turn_type === 'sync' && String(t.content ?? '').includes('resolved conflict'))).toBe(true);
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
  }, 240_000);
});
