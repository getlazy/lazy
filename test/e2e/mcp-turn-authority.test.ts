/**
 * A TASK'S MCP TOKEN ACTS ONLY FOR THE TURN THAT IS RUNNING.
 *
 * The token is minted per task and outlives every turn, and so do the
 * processes holding it: whatever an earlier turn left running in the task's
 * container, and the project's Start services command, which any member may set
 * and which runs in the TASK's container. Before this, the daemon resolved the
 * person behind a call from the task's current session whatever was calling, so
 * such a process could start subtasks billed to whoever owned the task's last
 * turn. Read-only turns had a second hole: a harness with a working shell
 * (Codex) can POST to the route directly, and the route ran any tool by name.
 *
 * Every call here goes through the real daemon route with a task-scoped token,
 * exactly as an agent (or a stray process in its container) makes it. A turn is
 * held open with the module mock's `LAZY_MOCK_HOLD_TURN_FILE`, so "during a
 * turn" is a real launch still in flight, not a hand-set status.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, extractTaskId } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { findFullTaskId, readSessionJson, readTaskJson, readTaskStatus, storageDirFor, taskFilePath } from '../helpers/storage';
import { DaemonClient } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { mintMcpToken, clearMcpTokenCache } from '../../src/daemon/mcp-tokens';

describe('MCP authority is bound to the live turn', () => {
  let ctx: TestContext;
  let sharedToken: string;
  let target: string;
  let holdFile: string;
  let managed = false;

  beforeEach(async () => {
    managed = false;
    clearMcpTokenCache();
    holdFile = join(process.env.TMPDIR ?? '/tmp', `lazy-hold-${process.pid}-${Date.now()}`);
    ctx = await setupTestLazy({ withDaemon: true, daemonEnv: { LAZY_MOCK_HOLD_TURN_FILE: holdFile } });
    refreshTarget();
    const resolvedToken = readToken(ctx.root);
    if (!resolvedToken) throw new Error('test daemon did not record a token');
    sharedToken = resolvedToken;
  }, 90_000);

  afterEach(async () => {
    rmSync(holdFile, { force: true });
    await ctx.cleanup();
    clearMcpTokenCache();
  }, 90_000);

  function refreshTarget(): void {
    const resolved = getDaemonTcpTarget(ctx.root);
    if (!resolved) throw new Error('test daemon did not record a TCP target');
    target = resolved;
  }

  async function rpc(token: string, command: string, params: Record<string, unknown> = {}) {
    return await DaemonClient.fromTarget(target, token).rpc(command, ctx.root, params);
  }

  async function armManagedMode(): Promise<void> {
    if (managed) return;
    await ctx.restartDaemon({ LAZY_MANAGED: '1', LAZY_MANAGED_STORAGE_PATH: storageDirFor(ctx.root) });
    refreshTarget();
    managed = true;
  }

  async function mintUserToken(email: string, name: string): Promise<string> {
    await armManagedMode();
    await rpc(sharedToken, 'putUserCredential', { userId: email, kind: 'oauth', token: `oat-for-${email}` });
    return (await rpc(sharedToken, 'mintActorToken', { kind: 'user', email, name }) as { token: string }).token;
  }

  /** A call the way anything holding the task's token makes it. */
  async function taskTool(fullTaskId: string, tool: string, args: Record<string, unknown>): Promise<{ status: number; body: string }> {
    clearMcpTokenCache();
    const token = await mintMcpToken(ctx.root, { kind: 'task', taskId: fullTaskId }, 'e2e-agent');
    const base = target.startsWith('http') ? target : `http://${target}`;
    const resp = await fetch(`${base}/mcp/${fullTaskId}/${tool}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'X-Lazy-Project': ctx.root },
      body: JSON.stringify({ arguments: args }),
    } as any);
    return { status: resp.status, body: await resp.text() };
  }

  async function waitFor(what: string, check: () => boolean, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  /**
   * Run `during` while a turn on `shortId` is held open: `launch` starts it
   * (not awaited — the launch is what is held), and the turn is released and
   * waited out afterwards.
   */
  async function duringHeldTurn(shortId: string, launch: () => Promise<unknown>, live: () => boolean, during: () => Promise<void>): Promise<void> {
    writeFileSync(holdFile, 'hold');
    const launched = launch().catch((err) => err);
    try {
      await waitFor(`a live turn on ${shortId}`, live);
      await during();
    } finally {
      rmSync(holdFile, { force: true });
      await launched;
    }
    expect(await ctx.lazy(['wait', shortId])).toHaveProperty('exitCode', 0);
  }

  async function runOneTurn(taskId: string): Promise<void> {
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    expect(await ctx.lazy(['wait', taskId])).toHaveProperty('exitCode', 0);
  }

  async function createChild(parentId: string): Promise<string> {
    const made = await ctx.lazy(['create', '--goal', 'Child', '--prompt', 'Child work', '--parent', parentId]);
    expectSuccess(made);
    return extractTaskId(made.stdout);
  }

  function journalCount(shortId: string): number {
    const file = taskFilePath(ctx.root, shortId, 'journal.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')).journal.length : 0;
  }

  function childIdFrom(body: string): string {
    const id = body.match(/\b([0-9a-f]{8})\b/)?.[1];
    if (!id) throw new Error(`no task id in lazy_create's answer: ${body}`);
    return id;
  }

  // INVARIANT: with no turn running, a task's token can neither launch a turn
  // nor write an attributed row — only reads answer. Services and leftover
  // processes in the task's container hold that token across turns and member
  // sessions; a launch from one of them would bill whoever owned the task's
  // last turn for work nobody asked for (raised item 36a893f4).
  test('a launch from a task token with no live turn is refused; reads still answer', async () => {
    const parentId = await createTask(ctx, 'Parent', 'Some work');
    await runOneTurn(parentId);
    const fullParentId = findFullTaskId(ctx.root, parentId);
    const childId = await createChild(parentId);
    expect(readTaskStatus(ctx.root, parentId)).toBe('blocked');

    const start = await taskTool(fullParentId, 'lazy_start', { task_id: childId });
    expect(start.status, start.body).toBe(403);
    expect(start.body).toContain('no turn running');
    expect(readTaskStatus(ctx.root, childId)).toBe('backlog');

    const journal = await taskTool(fullParentId, 'lazy_journal', { message: 'written by a stray process' });
    expect(journal.status, journal.body).toBe(403);
    expect(journalCount(parentId)).toBe(0);

    const show = await taskTool(fullParentId, 'lazy_show', { task_id: childId });
    expect(show.status, show.body).toBe(200);
  }, 90_000);

  // INVARIANT: a subtask launched during a work turn is billed to THAT turn's
  // owner, and the next member's turn moves it with them — never "whoever
  // touched the task last" outside a turn.
  test("a launch during ivan's turn bills ivan; during pete's later turn, pete", async () => {
    const parentId = await createTask(ctx, 'Parent', 'Some work');
    await runOneTurn(parentId);
    const fullParentId = findFullTaskId(ctx.root, parentId);
    const ivan = await mintUserToken('ivan@example.com', 'Ivan');
    const pete = await mintUserToken('pete@example.com', 'Pete');
    const working = () => readTaskStatus(ctx.root, parentId) === 'working';

    /**
     * The parent's agent creates and starts a child. The child's own launch is
     * held too (one hold file per daemon), so the start is awaited only once
     * the parent's turn is released.
     */
    async function agentStartsChild(goal: string): Promise<{ childId: string; started: Promise<{ status: number; body: string }> }> {
      const created = await taskTool(fullParentId, 'lazy_create', { goal, prompt: 'work' });
      expect(created.status, created.body).toBe(200);
      const childId = childIdFrom(created.body);
      const started = taskTool(fullParentId, 'lazy_start', { task_id: childId });
      await waitFor(`child ${childId} launching`, () => readTaskStatus(ctx.root, childId) === 'working');
      return { childId, started };
    }

    let ivanChild!: Awaited<ReturnType<typeof agentStartsChild>>;
    await duringHeldTurn(parentId, () => rpc(ivan, 'unblockTask', { taskId: parentId, message: 'Split it' }), working, async () => {
      ivanChild = await agentStartsChild('Ivan child');
    });
    const ivanStart = await ivanChild.started;
    expect(ivanStart.status, ivanStart.body).toBe(200);
    expect(await ctx.lazy(['wait', ivanChild.childId])).toHaveProperty('exitCode', 0);
    expect(readSessionJson(ctx.root, ivanChild.childId)?.turn_owner_email).toBe('ivan@example.com');

    // Between turns the session still names ivan — and that is no longer
    // authority to do anything but read.
    const stray = await taskTool(fullParentId, 'lazy_create', { goal: 'Stray child', prompt: 'work' });
    expect(stray.status, stray.body).toBe(403);

    let peteChild!: Awaited<ReturnType<typeof agentStartsChild>>;
    await duringHeldTurn(parentId, () => rpc(pete, 'unblockTask', { taskId: parentId, message: 'One more' }), working, async () => {
      peteChild = await agentStartsChild('Pete child');
    });
    const peteStart = await peteChild.started;
    expect(peteStart.status, peteStart.body).toBe(200);
    expect(await ctx.lazy(['wait', peteChild.childId])).toHaveProperty('exitCode', 0);
    expect(readSessionJson(ctx.root, peteChild.childId)?.turn_owner_email).toBe('pete@example.com');
  }, 120_000);

  // INVARIANT: while an ask (or review) claim is live, the task's token gets
  // exactly the tools that read-only turn is offered. What is OFFERED is not a
  // boundary on its own: a harness with a working shell in the container can
  // POST to the route directly.
  test('a write tool during an ask claim is refused; reads still answer', async () => {
    const parentId = await createTask(ctx, 'Parent', 'Some work');
    await runOneTurn(parentId);
    const fullParentId = findFullTaskId(ctx.root, parentId);
    const childId = await createChild(parentId);
    const asking = () => readTaskJson(ctx.root, parentId).in_flight_turn?.owner === 'ask';

    await duringHeldTurn(parentId, () => rpc(sharedToken, 'askTask', { taskId: fullParentId, message: 'why?' }), asking, async () => {
      const start = await taskTool(fullParentId, 'lazy_start', { task_id: childId });
      expect(start.status, start.body).toBe(403);
      expect(start.body).toContain('read-only');

      const journal = await taskTool(fullParentId, 'lazy_journal', { message: 'from a prompt-injected answerer' });
      expect(journal.status, journal.body).toBe(403);

      const show = await taskTool(fullParentId, 'lazy_show', { task_id: parentId });
      expect(show.status, show.body).toBe(200);
    });
    expect(readTaskStatus(ctx.root, childId)).toBe('backlog');
    expect(journalCount(parentId)).toBe(0);
  }, 90_000);

  // INVARIANT: a reflective (plan-mode) unblock is a read-only turn at the
  // daemon route too — it has no in-flight claim, so the launch writes a marker
  // naming its own turn. The marker must not outlive that turn: the next
  // ordinary work turn gets every tool back.
  test('a write tool during a reflective unblock is refused; the next work turn has full tools', async () => {
    const parentId = await createTask(ctx, 'Parent', 'Some work');
    await runOneTurn(parentId);
    const fullParentId = findFullTaskId(ctx.root, parentId);
    const working = () => readTaskStatus(ctx.root, parentId) === 'working';

    await duringHeldTurn(parentId, () => rpc(sharedToken, 'unblockTask', { taskId: parentId, message: 'Think about it', permissionMode: 'plan' }), working, async () => {
      const journal = await taskTool(fullParentId, 'lazy_journal', { message: 'from a prompt-injected reflective turn' });
      expect(journal.status, journal.body).toBe(403);
      expect(journal.body).toContain('reflective turn');
      const show = await taskTool(fullParentId, 'lazy_show', { task_id: parentId });
      expect(show.status, show.body).toBe(200);
    });
    expect(journalCount(parentId)).toBe(0);

    await duringHeldTurn(parentId, () => rpc(sharedToken, 'unblockTask', { taskId: parentId, message: 'Now do it' }), working, async () => {
      const journal = await taskTool(fullParentId, 'lazy_journal', { message: 'during the ordinary turn' });
      expect(journal.status, journal.body).toBe(200);
    });
    expect(journalCount(parentId)).toBe(1);
  }, 90_000);
});
