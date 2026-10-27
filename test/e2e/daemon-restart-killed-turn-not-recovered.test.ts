/**
 * A work turn killed by a daemon restart is resumed, never "recovered" as done.
 *
 * Stranded-completion recovery reads unrecorded commits as proof the agent
 * finished and only the finalize handshake was lost, and parks the task
 * `blocked` behind a "[Recovered]" turn. When the turn died because lazy's own
 * daemon went away, that inference is false: the agent was mid-work. Seen on an
 * upgrade — a task with one commit was parked `blocked` with mid-work narration
 * as its "report", and nothing resumed it.
 *
 * The restart reaper only sees runs alive in its pre-listen snapshot, so this
 * suite produces the gap it misses: the old daemon dies hard (no shutdown
 * sweep) and the supervisor is dead before the new daemon looks.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { sessionStartEvent, toolUseEvent, successScenario } from '../helpers/fake-claude';
import { readTaskStatus, taskFilePath, findFullTaskId, worktreePathFor } from '../helpers/storage';
import { allTurns, sessionInterrupt } from '../helpers/agent-seam';
import { protocolDir as getProtocolDir } from '../../src/protocol';
import { readPid } from '../../src/daemon/lifecycle';

const settle = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, budgetMs: number): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let last = await read();
  while (!ok(last) && Date.now() < deadline) {
    await settle(500);
    last = await read();
  }
  return last;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function killTree(pid: number): Promise<void> {
  // Children first (the fake agent), then the supervisor itself.
  await Bun.spawn(['pkill', '-KILL', '-P', String(pid)], { stdout: 'ignore', stderr: 'ignore' }).exited;
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

describe('daemon restart kills a turn that had already committed', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('the turn is interrupted and auto-resumed, and its commit is recorded once', async () => {
    const taskId = await createTask(ctx, 'Killed mid-work by a restart', 'Work, then keep working');
    // Commits, then keeps working — the agent is mid-turn, not finished.
    await ctx.setClaudeScenario({
      steps: [
        { kind: 'emit', event: sessionStartEvent('mid-work') },
        { kind: 'emit', event: toolUseEvent('toolu_work', 'Bash') },
        { kind: 'commit', message: 'Commit the first half', files: [{ path: 'half.txt', content: 'half\n' }] },
        { kind: 'sleep', ms: 60_000 },
      ],
    });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expect(await until(async () => readTaskStatus(ctx.root, taskId), s => s === 'working', 20_000)).toBe('working');

    const worktree = worktreePathFor(ctx.root, taskId);
    const headLog = async () => {
      const p = Bun.spawn(['git', '-C', worktree, 'log', '--format=%H %s', '-1'], { stdout: 'pipe', stderr: 'ignore' });
      return (await new Response(p.stdout).text()).trim();
    };
    const head = await until(headLog, l => l.endsWith('Commit the first half'), 30_000);
    expect(head).toEndWith('Commit the first half');
    const commitSha = head.split(' ')[0];

    const statusPath = join(getProtocolDir(findFullTaskId(ctx.root, taskId)), 'status.json');
    const supervisorPid = Number(JSON.parse(await readFile(statusPath, 'utf-8')).pid);
    expect(supervisorPid).toBeGreaterThan(0);

    // The old daemon dies without running its shutdown sweep, and its turn's
    // supervisor is gone before the new daemon starts.
    const daemonPid = readPid(ctx.root);
    expect(daemonPid).not.toBeNull();
    process.kill(daemonPid!, 'SIGKILL');
    await until(async () => alive(daemonPid!), a => !a, 10_000);
    await killTree(supervisorPid);
    await until(async () => alive(supervisorPid), a => !a, 10_000);
    expect(readTaskStatus(ctx.root, taskId)).toBe('working');

    await ctx.clearClaudeInvocations();
    await ctx.setClaudeScenario(successScenario({ sessionId: 'resumed', result: 'Finished the second half.' }));
    expectSuccess(await ctx.lazy(['daemon', 'start']));

    // INVARIANT: a turn the daemon's own restart killed is resumed, never
    // parked `blocked` as a "[Recovered]" finished turn because it committed.
    const interrupt = await until(
      () => sessionInterrupt(ctx.root, taskId).catch(() => ({ interrupt_reason: undefined })),
      i => typeof i.interrupt_reason === 'string' && /daemon restarted/.test(i.interrupt_reason),
      60_000,
    );
    expect(interrupt.interrupt_reason).toMatch(/daemon restarted/);

    const invocations = await until(() => ctx.claudeInvocations(), inv => inv.length > 0, 60_000);
    expect(invocations.length).toBeGreaterThan(0);

    const final = await until(async () => readTaskStatus(ctx.root, taskId), s => s === 'blocked', 60_000);
    expect(final).toBe('blocked');

    const turns = await allTurns(ctx.root, taskId);
    expect(turns.some(t => String(t.content ?? '').includes('[Recovered]'))).toBe(false);

    const recorded = (JSON.parse(await readFile(taskFilePath(ctx.root, taskId, 'commits.json'), 'utf-8')).commits as Array<{ sha: string }>)
      .filter(c => c.sha === commitSha);
    expect(recorded.length).toBe(1);
  }, 180_000);
});
