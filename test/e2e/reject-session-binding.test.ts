/**
 * INVARIANT: reject/close on a still-working task must release the
 * session-credential binding. Reconcile only walks `working` tasks, so a
 * terminal path that stops the runner without releasing leaves the placeholder
 * resolving forever.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFile } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { goSilentScenario } from '../helpers/fake-claude';
import { readTaskStatus } from '../helpers/storage';
import { DaemonClient } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { getSessionCredentialsPath } from '../../src/daemon/paths';
import { clearUserCredentialCache, SERVICE_CREDENTIAL_USER_ID } from '../../src/daemon/user-credentials';
import { clearSessionCredentialCache } from '../../src/daemon/session-credentials';

const settle = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, budgetMs: number): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let last = await read();
  while (!ok(last) && Date.now() < deadline) {
    await settle(200);
    last = await read();
  }
  return last;
}

describe('terminal lifecycle releases session-credential binding', () => {
  let ctx: TestContext;
  let sharedToken: string;
  let target: string;

  async function rpc(command: string, params: Record<string, unknown> = {}) {
    return await DaemonClient.fromTarget(target, sharedToken).rpc(command, ctx.root, params);
  }

  async function readBindings(): Promise<Array<{ taskId: string; revokedAt: number | null }>> {
    try {
      const raw = await readFile(getSessionCredentialsPath(ctx.root), 'utf-8');
      return JSON.parse(raw).bindings ?? [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  /** Start a turn and wait until the task is `working` with a live binding. */
  async function startWorkingWithBinding(sessionId: string): Promise<string> {
    await ctx.setClaudeScenario(goSilentScenario({ sessionId, silentMs: 120_000 }));
    const taskId = await createTask(ctx, `Binding cleanup ${sessionId}`, 'Work');
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    await until(
      () => Promise.resolve(readTaskStatus(ctx.root, taskId)),
      (status) => status === 'working',
      15_000,
    );
    const bindings = await readBindings();
    expect(bindings.some(b => b.revokedAt === null)).toBe(true);
    return taskId;
  }

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true, fakeClaude: true });

    const resolvedTarget = getDaemonTcpTarget(ctx.root);
    const resolvedToken = readToken(ctx.root);
    if (!resolvedTarget || !resolvedToken) {
      throw new Error('test daemon did not record a TCP target and token');
    }
    target = resolvedTarget;
    sharedToken = resolvedToken;

    clearUserCredentialCache();
    clearSessionCredentialCache();
    await rpc('putUserCredential', { userId: 'u-bind', kind: 'oauth', token: 'oat-bind' });
    await rpc('putUserCredential', { userId: SERVICE_CREDENTIAL_USER_ID, kind: 'oauth', token: 'oat-svc' });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('rejecting a working task revokes its session-credential binding', async () => {
    const taskId = await startWorkingWithBinding('reject-bind');

    await rpc('rejectTask', { taskId, reason: 'Wrong approach' });

    const bindingsAfter = await until(
      () => readBindings(),
      (bindings) => bindings.every(b => b.revokedAt !== null),
      10_000,
    );
    expect(bindingsAfter.every(b => b.revokedAt !== null)).toBe(true);
  });

  test('closing a working task revokes its session-credential binding', async () => {
    const taskId = await startWorkingWithBinding('close-bind');

    await rpc('closeTask', { taskId, reason: 'No longer needed' });

    const bindingsAfter = await until(
      () => readBindings(),
      (bindings) => bindings.every(b => b.revokedAt !== null),
      10_000,
    );
    expect(bindingsAfter.every(b => b.revokedAt !== null)).toBe(true);
  });
});
