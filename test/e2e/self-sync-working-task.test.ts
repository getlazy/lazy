/**
 * A task's own agent syncing itself while its turn is running — the loop case.
 *
 * A loop task is `working` for its whole turn, so `lazy sync` (which refuses a
 * working task, and would launch a second supervisor if it did not) cannot reach
 * it. Its branch therefore stays frozen at whatever its parent was when the loop
 * started, and every child it cuts inherits that stale base. The self-sync route
 * closes that: the agent calls `lazy_sync` on itself and the daemon performs the
 * merges in place while the agent waits inside the tool call.
 *
 * WHY THE FAKE-BINARY SEAM: the first test needs a task that is GENUINELY
 * working, with a real supervisor and a real live turn, while a separate MCP
 * client calls `lazy_sync` on it. The module mock replaces the supervisor
 * entirely, so a turn there is never in flight long enough to sync into.
 *
 * The later tests only need the daemon's view of a `working` task, so they set
 * that status directly and drive the real MCP server against it.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { successScenario, sessionStartEvent, toolUseEvent, toolResultEvent, resultEvent } from '../helpers/fake-claude';
import type { ClaudeScenario, ClaudeStep } from '../helpers/fake-claude';
import { allTurns, waitForStatus } from '../helpers/agent-seam';
import { findFullTaskId, setTaskStatus, readTaskStatus, worktreePathFor, readSessionJson, writeSessionJson } from '../helpers/storage';
import { consumeResponse, protocolDir as getProtocolDir } from '../../src/protocol';
import { runMcpSession, mcpPayload, mcpText } from '../helpers/mcp-session';

function gitIn(cwd: string, ...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), exitCode: result.exitCode };
}

/**
 * A turn that keeps making visible progress for a while, so the test can act on
 * the task WHILE it is working. Alternating tool-use/tool-result events are real
 * forward progress, so the no-progress guard does not fire during the window.
 */
function longTurnScenario(seconds: number): ClaudeScenario {
  const sessionId = 'fake-sess-selfsync';
  const steps: ClaudeStep[] = [{ kind: 'emit', event: sessionStartEvent(sessionId) }];
  for (let i = 0; i < seconds; i++) {
    steps.push({ kind: 'emit', event: toolUseEvent(`toolu_${i}`) });
    steps.push({ kind: 'sleep', ms: 1000 });
    steps.push({ kind: 'emit', event: toolResultEvent(`toolu_${i}`) });
  }
  steps.push({ kind: 'emit', event: resultEvent({ result: 'Loop turn done.', sessionId }) });
  return { steps };
}

describe('lazy_sync on your own working task', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** Run one turn on a task so it has a session, a branch and a worktree. */
  async function startedTask(goal: string, file: { path: string; content: string }): Promise<string> {
    const taskId = await createTask(ctx, goal, 'Do the work');
    await ctx.setClaudeScenario(successScenario({
      result: 'First pass.',
      commit: { message: `Add ${file.path}`, files: [file] },
    }));
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    return taskId;
  }

  /** One `lazy_sync` call as the given task's OWN agent. */
  async function selfSync(shortId: string): Promise<Record<string, unknown>> {
    const responses = await runMcpSession(
      ctx.root,
      findFullTaskId(ctx.root, shortId),
      worktreePathFor(ctx.root, shortId),
      [
        { method: 'initialize', id: 1, params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } },
        { method: 'tools/call', id: 2, params: { name: 'lazy_sync', arguments: { task_id: shortId } } },
      ],
      { timeoutMs: 60_000 },
    );
    const response = responses.find(r => r.id === 2);
    const payload = mcpPayload(response);
    // An error comes back as text, not JSON — surface it so a failing assertion
    // shows the refusal instead of an empty object.
    return Object.keys(payload).length ? payload : { _error: mcpText(response) };
  }

  test('a loop merges its parent mid-turn, and the next child branches from the new base', async () => {
    const loopResult = await ctx.lazy([
      'create', '--goal', 'Drive the children', '--prompt', 'Run them', '--type', 'cluster',
    ]);
    expectSuccess(loopResult);
    const loopId = loopResult.stdout.match(/Created task ([a-f0-9]{8})/)![1];

    // A long first turn, so the loop is really working while we sync it.
    await ctx.setClaudeScenario(longTurnScenario(45));
    expectSuccess(await ctx.lazy(['start', loopId, '--yes']));
    await waitForStatus(ctx.root, loopId, ['working'], 30_000);

    // The parent moves while the loop is running — today's Dockerfile fix landing
    // on the release branch an hour into the loop.
    ctx.git('checkout', 'main');
    await writeFile(join(ctx.root, 'from-parent.txt'), 'landed on main\n');
    ctx.git('add', 'from-parent.txt');
    ctx.git('commit', '-m', 'Parent side');
    const parentSha = ctx.git('rev-parse', 'HEAD').stdout.trim();
    ctx.git('checkout', '-');

    const payload = await selfSync(loopId);
    expect(payload.status).toBe('merged');
    expect(String(payload.output)).toContain('Merged main');

    // Merged in place: no supervisor was launched, and the task is still working.
    const worktree = worktreePathFor(ctx.root, loopId);
    expect(await readFile(join(worktree, 'from-parent.txt'), 'utf-8')).toContain('landed on main');
    expect(gitIn(worktree, 'merge-base', '--is-ancestor', parentSha, 'HEAD').exitCode).toBe(0);
    expect(readTaskStatus(ctx.root, loopId)).toBe('working');

    // Recorded like any other sync, so the history shows what was merged.
    const syncRows = (await allTurns(ctx.root, loopId)).filter(t => t.turn_type === 'sync');
    const syncTurns = syncRows.map(t => String(t.content ?? ''));
    expect(syncTurns.some(c => c.includes('Merged main'))).toBe(true);

    // INVARIANT: the merge is lazy's (`supervisor` — the channel `recordSyncTurns`
    // dedupes on, which is why it does not become `system` for an unrequested
    // sync), and the PERSON on it is whoever the running turn belongs to. A sync
    // that happens inside a turn somebody asked for is theirs, not the
    // automation account's — the configured identity only steps in where nobody
    // asked (test/unit/system-turn-attribution.test.ts).
    const merged = syncRows.find(t => String(t.content ?? '').includes('Merged main'));
    expect(merged?.actor).toBe('supervisor');
    expect((merged as { actor_email?: string } | undefined)?.actor_email).toBe('test@lazy.test');

    // THE POINT OF THE FEATURE: the next child branches from the loop's new HEAD.
    const childResult = await ctx.lazy([
      'create', '--goal', 'Next child', '--prompt', 'Child work', '--parent', loopId,
    ]);
    expectSuccess(childResult);
    const childId = childResult.stdout.match(/Created task ([a-f0-9]{8})/)![1];
    await ctx.setClaudeScenario(successScenario({ result: 'Child pass.' }));
    expectSuccess(await ctx.lazy(['start', childId, '--yes']));
    const childWorktree = worktreePathFor(ctx.root, childId);
    expect(await readFile(join(childWorktree, 'from-parent.txt'), 'utf-8')).toContain('landed on main');
  }, 240_000);

  test('a parent conflict is handed back, and a second call finishes the sync', async () => {
    const taskId = await startedTask('Conflicting task', { path: 'shared.txt', content: 'task version\n' });

    // The parent adds the same file with different content — a real conflict.
    ctx.git('checkout', 'main');
    await writeFile(join(ctx.root, 'shared.txt'), 'parent version\n');
    ctx.git('add', 'shared.txt');
    ctx.git('commit', '-m', 'Parent side');
    ctx.git('checkout', '-');

    // The daemon's view of a running turn is the only thing this route needs.
    setTaskStatus(ctx.root, taskId, 'working');

    const first = await selfSync(taskId);
    expect(first.status).toBe('conflict');
    expect(String(first.output)).toContain('Step 2 of 2');
    expect(String(first.instructions)).toContain('lazy_commit');
    const steps = first.steps as Array<Record<string, unknown>>;
    expect(steps[0].conflicted_files).toEqual(['shared.txt']);

    // The agent resolves in its own worktree and concludes the merge exactly as
    // the instructions say — through lazy_commit, which is what creates the
    // merge commit for an agent that cannot move refs itself.
    const worktree = worktreePathFor(ctx.root, taskId);
    expect(gitIn(worktree, 'rev-parse', '--verify', 'MERGE_HEAD').exitCode).toBe(0);
    await writeFile(join(worktree, 'shared.txt'), 'task version\nparent version\n');
    expect(gitIn(worktree, 'add', 'shared.txt').exitCode).toBe(0);

    const commitResponses = await runMcpSession(
      ctx.root,
      findFullTaskId(ctx.root, taskId),
      worktree,
      [
        { method: 'initialize', id: 1, params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } },
        { method: 'tools/call', id: 2, params: { name: 'lazy_commit', arguments: { message: 'Merge main' } } },
      ],
      { timeoutMs: 60_000 },
    );
    expect(mcpPayload(commitResponses.find(r => r.id === 2)).committed).toBe(true);
    // A merge commit, with both parents — not a hand-copied single-parent commit.
    expect(gitIn(worktree, 'rev-parse', '--verify', 'HEAD^2').exitCode).toBe(0);

    // Re-issued: the step that landed is a no-op and nothing is left.
    const second = await selfSync(taskId);
    expect(second.status).toBe('up_to_date');
  }, 180_000);

  // INVARIANT: a working agent that self-syncs and then crashes is resumed as
  // `interrupted`, never parked as "[Recovered]" work. The self-sync route
  // records no commits (the agent's own open turn owns that SHA window), so the
  // sync merge is the only unrecorded commit — and a merge is an integration,
  // never evidence the agent finished. Reading it as a lost finalize parked the
  // task `blocked` over work nobody did, with no automatic way back.
  test('a task that self-syncs and then crashes is auto-resumed, not recovered', async () => {
    const taskId = await startedTask('Self-sync then crash', { path: 'own.txt', content: 'own\n' });

    // The parent moves without touching the task's files: a clean merge.
    ctx.git('checkout', 'main');
    await writeFile(join(ctx.root, 'upstream-only.txt'), 'moved on the parent\n');
    ctx.git('add', 'upstream-only.txt');
    ctx.git('commit', '-m', 'Parent side');
    ctx.git('checkout', '-');

    setTaskStatus(ctx.root, taskId, 'working');
    const synced = await selfSync(taskId);
    expect(synced.status).toBe('merged');
    const worktree = worktreePathFor(ctx.root, taskId);
    expect(gitIn(worktree, 'rev-parse', '--verify', 'HEAD^2').exitCode).toBe(0);

    // Script the resumed turn BEFORE staging the crash: the reconciler may resume
    // the moment the crash is visible, and must not replay the first turn.
    await ctx.setClaudeScenario(successScenario({ result: 'Resumed after the crash.' }));

    // Crash mid-turn: no response to settle, a container that is not there, and
    // the last interaction backdated past the reconciler's grace period.
    const session = readSessionJson(ctx.root, taskId);
    if (!session) throw new Error('task has no session to crash');
    session.last_interaction_at = new Date(Date.now() - 120_000).toISOString();
    session.container_name = 'lazy-container-that-is-gone';
    writeSessionJson(ctx.root, taskId, session);
    consumeResponse(getProtocolDir(findFullTaskId(ctx.root, taskId)));

    await waitForStatus(ctx.root, taskId, ['blocked'], 60_000);

    const contents = (await allTurns(ctx.root, taskId)).map(t => String(t.content ?? ''));
    expect(contents.some(c => c.includes('[Recovered]'))).toBe(false);
    expect(contents.some(c => c.includes('Resumed after the crash.'))).toBe(true);
  }, 180_000);

  test('a human lazy sync is still refused while the task is working', async () => {
    const taskId = await startedTask('Human refusal', { path: 'a.txt', content: 'a\n' });
    setTaskStatus(ctx.root, taskId, 'working');

    const result = await ctx.lazy(['sync', taskId]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('currently working');
  }, 120_000);

  test('another task\'s agent cannot sync a working task', async () => {
    // INVARIANT: only the task's OWN agent gets the working-status exception, and
    // the ownership gate ("your own task or a direct subtask") is unchanged.
    const target = await startedTask('Sync target', { path: 'b.txt', content: 'b\n' });
    const other = await startedTask('Unrelated task', { path: 'c.txt', content: 'c\n' });
    setTaskStatus(ctx.root, target, 'working');

    const responses = await runMcpSession(
      ctx.root,
      findFullTaskId(ctx.root, other),
      worktreePathFor(ctx.root, other),
      [
        { method: 'initialize', id: 1, params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } },
        { method: 'tools/call', id: 2, params: { name: 'lazy_sync', arguments: { task_id: target } } },
      ],
      { timeoutMs: 60_000 },
    );
    const text = mcpText(responses.find(r => r.id === 2));
    expect(text).toMatch(/own task|subtask/i);
  }, 180_000);

  test('a loop\'s agent still cannot sync a working CHILD — only itself', async () => {
    // The child passes the ownership gate (it IS a direct subtask), so this is
    // the status gate on its own: a merge under someone else's running turn.
    const parent = await startedTask('Parent of child', { path: 'd.txt', content: 'd\n' });
    const childResult = await ctx.lazy([
      'create', '--goal', 'Working child', '--prompt', 'Child work', '--parent', parent,
    ]);
    expectSuccess(childResult);
    const childId = childResult.stdout.match(/Created task ([a-f0-9]{8})/)![1];
    await ctx.setClaudeScenario(successScenario({ result: 'Child pass.' }));
    expectSuccess(await ctx.lazy(['start', childId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', childId]));
    setTaskStatus(ctx.root, childId, 'working');

    const responses = await runMcpSession(
      ctx.root,
      findFullTaskId(ctx.root, parent),
      worktreePathFor(ctx.root, parent),
      [
        { method: 'initialize', id: 1, params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } },
        { method: 'tools/call', id: 2, params: { name: 'lazy_sync', arguments: { task_id: childId } } },
      ],
      { timeoutMs: 60_000 },
    );
    expect(mcpText(responses.find(r => r.id === 2))).toContain('currently working');
  }, 180_000);
});
