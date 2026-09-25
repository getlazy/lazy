/**
 * WORK NOBODY ASKED FOR IS ATTRIBUTED TO THE ACCOUNT THAT CONFIGURED IT.
 *
 * A turn the daemon starts by itself — the reconciler resuming a crashed one,
 * auto-delivery, a sync nothing typed — has no owner, and until now its rows
 * named nobody. They name the configured identity instead
 * (docs/design/actor-identity-and-remote-clients.md §3.3 case 3):
 *
 *   in TEAMS, the owner of the project's service credential, pushed to the
 *   daemon beside the secret those turns already spend;
 *   on a LAPTOP, the git identity — the same person every other case collapses
 *   to (§3.4), which is why the ROLE on these rows is `system` rather than the
 *   channel. It is the only thing telling "they typed it" from "their daemon
 *   did it by itself".
 *
 * Nothing is ever invented: with no identity configured the rows name nobody,
 * exactly as they did before this existed.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { readTurns, readSessionJson, writeSessionJson, storageDirFor, findFullTaskId, setTaskStatus, readTaskStatus } from '../helpers/storage';
import { runReconcile } from '../helpers/reconcile';
import { consumeResponse, protocolDir as getProtocolDir } from '../../src/protocol';
import { DaemonClient } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { SERVICE_CREDENTIAL_USER_ID } from '../../src/daemon/user-credentials';
import { NO_SERVICE_CREDENTIAL_MARKER } from '../../src/daemon/turn-credentials';
import { getLogPath } from '../../src/daemon/paths';
import { readFile } from 'fs/promises';

interface AttributedRow {
  content?: string;
  role?: string;
  actor?: string;
  actor_email?: string;
  actor_name?: string;
}

function turnsOf(ctx: TestContext, taskId: string): AttributedRow[] {
  return readTurns(ctx.root, taskId) as unknown as AttributedRow[];
}

/** The auto-resume notice the reconciler writes for a turn nobody asked for. */
function resumeNotice(rows: AttributedRow[]): AttributedRow | undefined {
  return rows.filter(t => t.content?.startsWith('[system] Session interrupted and auto-resumed')).at(-1);
}

describe('a turn nobody asked for on a laptop', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: on a single-person install the system identity IS the git
  // identity (§3.4) — but the row says `system`, not `human` and not `agent`.
  // Both cases name the same human here, so dropping the role would make a turn
  // the daemon started by itself indistinguishable from one they asked for.
  test('carries the git identity under the role system', async () => {
    const taskId = await createTask(ctx, 'Auto-resume identity task', 'Some work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    expect(await ctx.lazy(['wait', taskId])).toHaveProperty('exitCode', 0);

    // A human asked for that first turn, and its agent row is theirs — the
    // CHANNEL, with the person beside it.
    const afterHuman = turnsOf(ctx, taskId).filter(t => t.role === 'agent').at(-1);
    expect(afterHuman?.actor).toBe('agent');
    expect(afterHuman?.actor_email).toBe('test@lazy.test');

    // Stop the daemon so the reconcile pass below is the only thing running,
    // then crash the task mid-turn: `working`, with no response to settle.
    await ctx.lazy(['daemon', 'stop', '--yes']);
    const fullTaskId = findFullTaskId(ctx.root, taskId);
    setTaskStatus(ctx.root, taskId, 'working');
    consumeResponse(getProtocolDir(fullTaskId));

    const reconciled = await runReconcile(ctx.root, ctx.protocolBase);
    expect(reconciled.exitCode).toBe(0);

    // The record of who ASKED is still empty — nobody did.
    expect(readSessionJson(ctx.root, taskId)?.turn_owner_email ?? null).toBeNull();

    // The notice the reconciler wrote for its own turn.
    const notice = resumeNotice(turnsOf(ctx, taskId));
    expect(notice?.actor).toBe('system');
    expect(notice?.actor_email).toBe('test@lazy.test');
    expect(notice?.actor_name).toBe('Lazy Test');

    // And the agent turn that turn produced.
    await runReconcile(ctx.root, ctx.protocolBase);
    const resumed = turnsOf(ctx, taskId).filter(t => t.role === 'agent').at(-1);
    expect(resumed?.actor_email).toBe('test@lazy.test');
    expect(resumed?.actor).toBe('system');
  });

  // INVARIANT: nothing is invented. With no git identity to resolve, a
  // system-initiated row names nobody — the pre-identity shape, and the only
  // honest answer available.
  test('names nobody when the install has configured no identity', async () => {
    const taskId = await createTask(ctx, 'Unconfigured identity task', 'Some work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    expect(await ctx.lazy(['wait', taskId])).toHaveProperty('exitCode', 0);

    await ctx.lazy(['daemon', 'stop', '--yes']);
    // An EMPTY repo-local value, not an unset one: the machine running this
    // suite has a ~/.gitconfig of its own and an unset repo key would fall
    // through to it. Same idiom as the single-person identity suite.
    ctx.git('-C', ctx.root, 'config', 'user.email', '');
    ctx.git('-C', ctx.root, 'config', 'user.name', '');

    const fullTaskId = findFullTaskId(ctx.root, taskId);
    setTaskStatus(ctx.root, taskId, 'working');
    consumeResponse(getProtocolDir(fullTaskId));

    expect((await runReconcile(ctx.root, ctx.protocolBase)).exitCode).toBe(0);

    const notice = resumeNotice(turnsOf(ctx, taskId));
    expect(notice?.actor).toBe('system');
    expect(notice?.actor_email).toBeUndefined();
  });
});

describe('a turn nobody asked for in managed mode', () => {
  let ctx: TestContext;
  let target: string;
  let controlToken: string;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    const resolvedTarget = getDaemonTcpTarget(ctx.root);
    const resolvedToken = readToken(ctx.root);
    if (!resolvedTarget || !resolvedToken) {
      throw new Error('test daemon did not record a TCP target and token');
    }
    target = resolvedTarget;
    controlToken = resolvedToken;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function rpc(command: string, params: Record<string, unknown> = {}) {
    return await DaemonClient.fromTarget(target, controlToken).rpc(command, ctx.root, params);
  }

  /**
   * A task with one finished turn, then put in managed mode.
   *
   * Every fixture is built BEFORE managed mode is armed: on a managed host a
   * human action may not ride the control token, and creating a task is one.
   */
  async function taskUnderManagedDaemon(goal: string): Promise<string> {
    const taskId = await createTask(ctx, goal, 'Some work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    expect(await ctx.lazy(['wait', taskId])).toHaveProperty('exitCode', 0);

    await ctx.restartDaemon({
      LAZY_MANAGED: '1',
      LAZY_MANAGED_STORAGE_PATH: storageDirFor(ctx.root),
    });
    const restarted = getDaemonTcpTarget(ctx.root);
    if (restarted) target = restarted;
    return taskId;
  }

  /**
   * Crash the task mid-turn and let the DAEMON'S OWN reconciler find it: the
   * task is `working` with no response and a container that is not there.
   *
   * The interaction timestamp is backdated past the reconciler's grace period,
   * which is what makes this one tick rather than a 30-second wait; the real
   * daemon deliberately does not run with the test-only zero grace.
   */
  function crashMidTurn(taskId: string): void {
    const session = readSessionJson(ctx.root, taskId);
    if (!session) throw new Error('task has no session to crash');
    session.last_interaction_at = new Date(Date.now() - 120_000).toISOString();
    session.container_name = 'lazy-container-that-is-gone';
    writeSessionJson(ctx.root, taskId, session);
    setTaskStatus(ctx.root, taskId, 'working');
    consumeResponse(getProtocolDir(findFullTaskId(ctx.root, taskId)));
  }

  // INVARIANT: in Teams the system identity is the SERVICE CREDENTIAL'S OWNER —
  // the member whose Anthropic account the turn is already spending — pushed to
  // the daemon beside the secret. Not the last human to touch the task, and not
  // anything derived from the operator-facing label.
  test('carries the service credential owner under the role system', async () => {
    const taskId = await taskUnderManagedDaemon('Managed system-turn task');

    // The control plane configures the project's automation: the secret, and
    // whose account it is.
    await rpc('putUserCredential', {
      userId: SERVICE_CREDENTIAL_USER_ID,
      kind: 'oauth',
      token: 'oat-service-secret',
      label: 'service (ops@example.com)',
      ownerEmail: 'ops@example.com',
    });

    crashMidTurn(taskId);

    const notice = await waitForResumeNotice(ctx, taskId);
    expect(notice?.actor).toBe('system');
    expect(notice?.actor_email).toBe('ops@example.com');

    // NOT the crash row the reconciler wrote just before: that one records the
    // turn that DIED, which a person had asked for, so it stays theirs. Only
    // the turn the daemon then started by itself is the system's.
    const crash = turnsOf(ctx, taskId).find(t => t.content?.startsWith('[Agent crashed]'));
    expect(crash?.actor).toBe('agent');
    expect(crash?.actor_email).not.toBe('ops@example.com');

    // The turn the resume produced carries it too, and nobody asked: the record
    // of who DID is still empty.
    const resumed = await waitForAgentTurnNaming(ctx, taskId, 'ops@example.com');
    expect(resumed?.actor).toBe('system');
    expect(readSessionJson(ctx.root, taskId)?.turn_owner_email ?? null).toBeNull();
  }, 45000);

  // INVARIANT: a project that has configured NO service credential keeps its
  // existing behaviour — the automation is disabled with the reason it already
  // gives, and no identity is invented for it. Attribution and turn credentials
  // read the same configuration, so its absence has to be the same answer in
  // both: no turn, and nobody named.
  test('is disabled with its stated reason when no service credential is configured', async () => {
    const taskId = await taskUnderManagedDaemon('Managed task with no service credential');

    // A per-user credential and no service one: the project runs per-user
    // billing, so a turn nobody asked for has nothing to spend.
    await rpc('putUserCredential', { userId: 'ada@example.com', kind: 'oauth', token: 'oat-ada' });

    crashMidTurn(taskId);

    // The reconciler settles the crash — so it did run, and the absence of a
    // resume below is a decision rather than a test that watched nothing.
    expect(await waitForCrashTurn(ctx, taskId)).toBeDefined();

    expect(await daemonLogContains(ctx, NO_SERVICE_CREDENTIAL_MARKER)).toBe(true);
    expect(resumeNotice(turnsOf(ctx, taskId))).toBeUndefined();
    expect(readTaskStatus(ctx.root, taskId)).toBe('interrupted');
  }, 45000);
});

/** Poll the daemon log until it states the reason, or give up. */
async function daemonLogContains(ctx: TestContext, text: string, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const log = await readFile(getLogPath(ctx.root), 'utf-8').catch(() => '');
    if (log.includes(text)) return true;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}

/** Poll until the reconciler has recorded the crash it found. */
async function waitForCrashTurn(
  ctx: TestContext,
  taskId: string,
  timeoutMs = 20000,
): Promise<AttributedRow | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const crash = turnsOf(ctx, taskId).find(t => t.content?.startsWith('[Agent crashed]'));
    if (crash) return crash;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return undefined;
}

/** Poll until an agent turn attributed to `email` has been recorded. */
async function waitForAgentTurnNaming(
  ctx: TestContext,
  taskId: string,
  email: string,
  timeoutMs = 20000,
): Promise<AttributedRow | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = turnsOf(ctx, taskId).filter(t => t.role === 'agent' && t.actor_email === email).at(-1);
    if (row) return row;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return undefined;
}

/** Poll until the daemon's reconciler has written the auto-resume notice. */
async function waitForResumeNotice(
  ctx: TestContext,
  taskId: string,
  timeoutMs = 20000,
): Promise<AttributedRow | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const notice = resumeNotice(turnsOf(ctx, taskId));
    if (notice) return notice;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return undefined;
}
