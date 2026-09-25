/**
 * A turn resumed after the daemon restarted must run on a credential the NEW
 * daemon can still resolve.
 *
 * In team mode the agent never holds a real secret: its container gets a
 * `lazy-sess-…` placeholder, and the proxy swaps it for the owner's real token
 * by looking the placeholder up in the daemon's binding registry. A resumed
 * turn whose placeholder is not in that registry is not "degraded" — every
 * request it makes is refused with 401, and the supervisor classifies that as
 * `fatal_auth` and gives up after one attempt. Observed on a live fleet: a task
 * launched fine, its daemon died mid-turn, the restarted daemon resumed it, and
 * the resumed turn died instantly with "agent rejected the credential".
 *
 * Runs on the fake-binary seam with a real daemon and a real `lazy supervise`,
 * so the placeholder asserted on is the one the agent's own process actually
 * received — read back out of the agent's environment, not out of the argv lazy
 * composed. The fake agent makes no HTTP calls, so the proxy's verdict is
 * obtained by resolving that same placeholder through the real resolver the
 * proxy is wired with.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { goSilentScenario, type ClaudeInvocation } from '../helpers/fake-claude';
import { readTaskStatus } from '../helpers/storage';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { putUserCredential, clearUserCredentialCache, SERVICE_CREDENTIAL_USER_ID } from '../../src/daemon/user-credentials';
import { createSessionCredentialResolver } from '../../src/daemon/turn-credentials';
import { isSessionPlaceholderToken, clearSessionCredentialCache } from '../../src/daemon/session-credentials';

const ALICE_TOKEN = 'sk-ant-oat01-alice-real-secret';
const SERVICE_TOKEN = 'sk-ant-oat01-service-real-secret';

const settle = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Poll until `check` passes or the budget runs out; returns the last value. */
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, budgetMs: number): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let last = await read();
  while (!ok(last) && Date.now() < deadline) {
    await settle(500);
    last = await read();
  }
  return last;
}

/** The credential the agent's own process was launched with. */
function agentCredential(inv: ClaudeInvocation): string {
  const env = inv.env ?? {};
  const value = env.CLAUDE_CODE_OAUTH_TOKEN ?? env.ANTHROPIC_API_KEY;
  if (!value) {
    throw new Error(`agent invocation carried no credential env: ${JSON.stringify(env)}`);
  }
  return value;
}

describe('a turn resumed after a daemon restart keeps working auth', () => {
  let ctx: TestContext;
  let baseDir: string;
  let unpin: () => void;

  beforeEach(async () => {
    baseDir = await makeDaemonBaseDir();
    unpin = pinDaemonBaseDir(baseDir);
    ctx = await setupTestLazy({ fakeClaude: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
    // AFTER cleanup: the daemon pidfile is resolved from this variable.
    unpin();
    await removeDaemonBaseDir(baseDir);
    clearUserCredentialCache();
  });

  test('the resumed agent holds a placeholder the new daemon still resolves', async () => {
    // Team mode: at least one real per-user credential, plus the service
    // credential every system-initiated turn (auto-resume, sync) runs on.
    await putUserCredential(ctx.root, { userId: 'alice', kind: 'oauth', token: ALICE_TOKEN });
    await putUserCredential(ctx.root, {
      userId: SERVICE_CREDENTIAL_USER_ID,
      kind: 'oauth',
      token: SERVICE_TOKEN,
    });

    await ctx.recordClaudeEnvKeys(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);

    const taskId = await createTask(ctx, 'Survives a daemon restart', 'Work slowly');
    await ctx.setClaudeScenario(goSilentScenario({ sessionId: 'restart-auth-1', silentMs: 120_000 }));

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expect(await until(async () => readTaskStatus(ctx.root, taskId), s => s === 'working', 30_000)).toBe('working');

    const first = await until(() => ctx.claudeInvocations(), inv => inv.length > 0, 30_000);
    const firstToken = agentCredential(first[0]);
    // The agent never holds a real secret in team mode.
    expect(isSessionPlaceholderToken(firstToken)).toBe(true);
    expect(firstToken).not.toContain('real-secret');

    const before = await createSessionCredentialResolver(ctx.root)(firstToken);
    expect(before.ok).toBe(true);

    // The daemon dies mid-turn and a new one takes over.
    expectSuccess(await ctx.lazy(['daemon', 'stop']));
    await settle(500);
    await ctx.clearClaudeInvocations();
    await ctx.setClaudeScenario(goSilentScenario({ sessionId: 'restart-auth-2', silentMs: 120_000 }));
    expectSuccess(await ctx.lazy(['daemon', 'start']));

    // The restarted daemon auto-resumes the task it found interrupted; if it
    // has not by the time the sweep settles, ask for the resume explicitly —
    // both paths must land the turn on a resolvable credential.
    let status = await until(async () => readTaskStatus(ctx.root, taskId), s => s === 'working', 60_000);
    if (status !== 'working') {
      expectSuccess(await ctx.lazy(['resume', taskId]));
      status = await until(async () => readTaskStatus(ctx.root, taskId), s => s === 'working', 60_000);
    }
    expect(status).toBe('working');

    const second = await until(() => ctx.claudeInvocations(), inv => inv.length > 0, 60_000);
    expect(second.length).toBeGreaterThan(0);
    const resumedToken = agentCredential(second[second.length - 1]);
    expect(resumedToken).not.toContain('real-secret');
    expect(isSessionPlaceholderToken(resumedToken)).toBe(true);

    // THE ASSERTION THIS SUITE EXISTS FOR: the proxy resolves what the resumed
    // agent is actually holding. An unresolvable placeholder here is a 401 on
    // the agent's first request and a `fatal_auth` turn.
    // This process cached the registry file when it resolved the first token;
    // the daemon has rewritten it since.
    clearSessionCredentialCache();
    clearUserCredentialCache();
    const after = await createSessionCredentialResolver(ctx.root)(resumedToken);
    expect(after.ok).toBe(true);
  }, 240_000);
});
