/**
 * AN AGENT'S WORK IS ATTRIBUTED TO WHOEVER ASKED FOR THE TURN.
 *
 * If ivan unblocked the task, that turn's agent actions are ivan's; if pete
 * unblocks the next turn, that turn's are pete's
 * (docs/design/actor-identity-and-remote-clients.md §3.3 case 2). The owner was
 * already recorded for BILLING, in a map that lives only in the daemon's
 * memory. Attribution cannot use that map — an agent writes for the whole
 * length of a turn, and a daemon restarted in the middle of one would forget
 * whose work it was — so the owner is recorded durably on the SESSION and read
 * back from there by every agent write.
 *
 * Three claims, one per test:
 *   1. the owner switches with the person who asked (managed mode, user tokens);
 *   2. it survives a daemon restart, which is exactly what the map loses;
 *   3. a turn the daemon starts by itself records NO ASKER — never the last
 *      human who happened to touch the task. (What its rows then NAME is the
 *      configured system identity, which arrived later and is proven in
 *      test/e2e/system-identity-attribution.test.ts.)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { readTurns, readSessionJson, taskFilePath, storageDirFor, findFullTaskId, setTaskStatus } from '../helpers/storage';
import { runReconcile } from '../helpers/reconcile';
import { consumeResponse, protocolDir as getProtocolDir } from '../../src/protocol';
import { DaemonClient } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { mintMcpToken, clearMcpTokenCache } from '../../src/daemon/mcp-tokens';
import { readFileSync } from 'fs';

interface AttributedRow {
  content?: string;
  actor?: string;
  actor_email?: string;
  actor_name?: string;
}

describe('agent turns carry the turn owner', () => {
  let ctx: TestContext;
  let sharedToken: string;
  let target: string;
  let managed = false;

  beforeEach(async () => {
    managed = false;
    clearMcpTokenCache();
    ctx = await setupTestLazy({ withDaemon: true });
    const resolvedTarget = getDaemonTcpTarget(ctx.root);
    const resolvedToken = readToken(ctx.root);
    if (!resolvedTarget || !resolvedToken) {
      throw new Error('test daemon did not record a TCP target and token');
    }
    target = resolvedTarget;
    sharedToken = resolvedToken;
  });

  afterEach(async () => {
    await ctx.cleanup();
    clearMcpTokenCache();
  });

  async function rpc(token: string, command: string, params: Record<string, unknown> = {}) {
    return await DaemonClient.fromTarget(target, token).rpc(command, ctx.root, params);
  }

  /**
   * Managed mode is what makes per-user tokens exist at all — outside it a
   * request never carries an identity and `/rpc/*` refuses a user token
   * (§3.4). Armed in the daemon's own environment through the harness's
   * restart, which keeps the module-mock preload.
   */
  async function armManagedMode(): Promise<void> {
    if (managed) return;
    await ctx.restartDaemon({
      LAZY_MANAGED: '1',
      LAZY_MANAGED_STORAGE_PATH: storageDirFor(ctx.root),
    });
    const resolvedTarget = getDaemonTcpTarget(ctx.root);
    if (resolvedTarget) target = resolvedTarget;
    managed = true;
  }

  async function mintUserToken(email: string, name: string): Promise<string> {
    await armManagedMode();
    await rpc(sharedToken, 'putUserCredential', { userId: email, kind: 'oauth', token: `oat-for-${email}` });
    const result = await rpc(sharedToken, 'mintActorToken', { kind: 'user', email, name }) as { token: string };
    return result.token;
  }

  /** One real turn, so the task reaches `blocked` with a live session. */
  async function runOneTurn(taskId: string): Promise<void> {
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    const waited = await ctx.lazy(['wait', taskId]);
    if (waited.exitCode !== 0) {
      throw new Error(`wait failed for ${taskId}: ${waited.stderr}\n${waited.stdout}`);
    }
  }

  /**
   * A write the way an AGENT makes it: over the daemon's MCP route, on a
   * task-scoped token. The daemon derives the task from the token and the
   * person from the task — the agent sends no identity, and this is the path
   * that proves it cannot.
   *
   * `lazy_journal` is the probe because it is the deliberately ungated write:
   * an agent may not comment on its own task, so a refusal here could only
   * ever be about identity.
   */
  async function agentJournalWrite(fullTaskId: string, message: string): Promise<number> {
    clearMcpTokenCache();
    const token = await mintMcpToken(ctx.root, { kind: 'task', taskId: fullTaskId }, 'e2e-agent');
    const base = target.startsWith('http') ? target : `http://${target}`;
    const resp = await fetch(`${base}/mcp/${fullTaskId}/lazy_journal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-Lazy-Project': ctx.root,
      },
      body: JSON.stringify({ arguments: { message } }),
    } as any);
    return resp.status;
  }

  function readJournal(shortId: string): AttributedRow[] {
    try {
      return JSON.parse(readFileSync(taskFilePath(ctx.root, shortId, 'journal.json'), 'utf-8')).journal;
    } catch {
      return [];
    }
  }

  function agentTurns(shortId: string): AttributedRow[] {
    return readTurns(ctx.root, shortId).filter(t => t.role === 'agent') as unknown as AttributedRow[];
  }

  // INVARIANT: the person on an agent's work is whoever asked for THAT turn.
  // Not the task's creator, not the last person to touch it — the one who
  // pressed unblock for the turn the agent is running.
  test("ivan's unblock makes that turn's agent work ivan's, and pete's next unblock switches it", async () => {
    const taskId = await createTask(ctx, 'Attribution task', 'Some work');
    await runOneTurn(taskId);
    const fullTaskId = findFullTaskId(ctx.root, taskId);

    const ivanToken = await mintUserToken('ivan@example.com', 'Ivan');
    const peteToken = await mintUserToken('pete@example.com', 'Pete');

    await rpc(ivanToken, 'unblockTask', { taskId, message: 'Handle the empty case too' });
    expect(await ctx.lazy(['wait', taskId])).toHaveProperty('exitCode', 0);

    // The durable record, which is what a restarted daemon would read.
    expect(readSessionJson(ctx.root, taskId)?.turn_owner_email).toBe('ivan@example.com');
    expect(readSessionJson(ctx.root, taskId)?.turn_owner_name).toBe('Ivan');

    // The agent's own turn row — the thing `stats-attribute-turn-spend` groups
    // by, now that the usage and the person are on the same row.
    const afterIvan = agentTurns(taskId);
    expect(afterIvan.at(-1)?.actor_email).toBe('ivan@example.com');
    expect(afterIvan.at(-1)?.actor_name).toBe('Ivan');

    // And a row the AGENT wrote, over its own MCP token.
    expect(await agentJournalWrite(fullTaskId, 'agent note during ivan\'s turn')).toBe(200);
    const ivanNote = readJournal(taskId).at(-1);
    expect(ivanNote?.actor_email).toBe('ivan@example.com');
    // The CHANNEL is still 'agent': "ivan's agent decided this" must stay
    // tellable from "ivan typed this".
    expect(ivanNote?.actor).toBe('agent');

    await rpc(peteToken, 'unblockTask', { taskId, message: 'Now rename the module' });
    expect(await ctx.lazy(['wait', taskId])).toHaveProperty('exitCode', 0);

    expect(readSessionJson(ctx.root, taskId)?.turn_owner_email).toBe('pete@example.com');

    const afterPete = agentTurns(taskId);
    expect(afterPete.length).toBeGreaterThan(afterIvan.length);
    expect(afterPete.at(-1)?.actor_email).toBe('pete@example.com');
    // History is not rewritten: ivan's turn stays ivan's.
    expect(afterPete[afterIvan.length - 1]?.actor_email).toBe('ivan@example.com');

    expect(await agentJournalWrite(fullTaskId, 'agent note during pete\'s turn')).toBe(200);
    expect(readJournal(taskId).at(-1)?.actor_email).toBe('pete@example.com');
  });

  // INVARIANT: the owner is DURABLE. This is the case the in-memory map loses
  // and the reason the record moved to the session: the daemon that reads the
  // owner back is frequently not the daemon that recorded it.
  test('a restarted daemon still knows whose turn the agent is running', async () => {
    const taskId = await createTask(ctx, 'Restart attribution task', 'Some work');
    await runOneTurn(taskId);
    const fullTaskId = findFullTaskId(ctx.root, taskId);

    // A laptop install: the person is the daemon's own git config (§3.4), which
    // the harness sets on the test repo.
    expect(readSessionJson(ctx.root, taskId)?.turn_owner_email).toBe('test@lazy.test');

    await ctx.restartDaemon();
    const resolvedTarget = getDaemonTcpTarget(ctx.root);
    if (resolvedTarget) target = resolvedTarget;

    // Nothing in the new daemon's memory knows about that turn — and the answer
    // is the same one anyway.
    expect(readSessionJson(ctx.root, taskId)?.turn_owner_email).toBe('test@lazy.test');

    expect(await agentJournalWrite(fullTaskId, 'note written after the restart')).toBe(200);
    const note = readJournal(taskId).at(-1);
    expect(note?.actor_email).toBe('test@lazy.test');
    expect(note?.actor_name).toBe('Lazy Test');
  });
});

// A turn the daemon starts by itself is nobody's — nobody ASKED for it, which
// is what the session record answers and what this file is about. Who the rows
// it writes NAME is a later question, answered by the configured system
// identity under the role `system` (test/e2e/system-identity-attribution.test.ts).
// Driven through the reconcile subprocess — the daemonless seam that runs the real auto-resume path — so the
// launch provably happens with no human anywhere near it.
describe('a turn nobody asked for records no asker', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: auto-resume must NEVER inherit the last human's identity. The
  // reconciler resuming a crashed task is §3.3 case 3 — system-initiated — and
  // naming the person who unblocked it hours earlier would put their name on
  // work they did not ask for.
  test('an auto-resumed turn clears the previous turn owner instead of inheriting it', async () => {
    const taskId = await createTask(ctx, 'Auto-resume attribution task', 'Some work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    expect(await ctx.lazy(['wait', taskId])).toHaveProperty('exitCode', 0);

    // A human asked for that first turn, and the record says so.
    expect(readSessionJson(ctx.root, taskId)?.turn_owner_email).toBe('test@lazy.test');
    const humanTurns = readTurns(ctx.root, taskId).filter(t => t.role === 'agent');
    expect((humanTurns.at(-1) as unknown as AttributedRow)?.actor_email).toBe('test@lazy.test');

    // Stop the daemon so the reconcile pass below is the only thing running,
    // then crash the task mid-turn: `working`, with no response to settle.
    await ctx.lazy(['daemon', 'stop', '--yes']);
    const fullTaskId = findFullTaskId(ctx.root, taskId);
    setTaskStatus(ctx.root, taskId, 'working');
    consumeResponse(getProtocolDir(fullTaskId));

    // The reconciler auto-resumes it — nobody asked for this turn.
    const reconciled = await runReconcile(ctx.root, ctx.protocolBase);
    expect(reconciled.exitCode).toBe(0);
    expect(readSessionJson(ctx.root, taskId)?.turn_owner_email ?? null).toBeNull();

    // And the turn it produces is the SYSTEM's, not the human's. On this
    // laptop both name the same person — the git identity is what a
    // single-person install configures for all three cases (§3.4) — so the
    // ROLE is what carries the distinction this test is about: `system`, not
    // the `agent` channel every turn somebody asked for records.
    // (system-actions-carry-a-configured-identity, §7.1 task 7; before it, this
    // row named nobody at all.)
    await runReconcile(ctx.root, ctx.protocolBase);
    const resumed = readTurns(ctx.root, taskId).filter(t => t.role === 'agent').at(-1) as unknown as AttributedRow;
    expect(resumed?.actor).toBe('system');
    expect(resumed?.actor_email).toBe('test@lazy.test');
  });
});
