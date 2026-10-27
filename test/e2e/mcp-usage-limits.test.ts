/**
 * `lazy_usage_limits` through the daemon's MCP route, on a Teams-mode daemon
 * (per-user credentials stored): the builder sees every credential's reading;
 * a task agent sees only the credential its own turn is spending.
 *
 * Readings are filed per member ENDPOINT credential
 * (`memberEndpointUsageKey(member, endpoint)`); the project's service credential
 * spends its HOLDER's endpoint account, so its reading is the holder's key. A
 * project is on member billing once a member credential is stored, and stays
 * there when one is revoked — a single-person install is one that never stored
 * a member credential.
 *
 * The daemon runs in-process, so the readings, the stored credentials and the
 * turn's credential binding are set through the same singletons the proxy and
 * the launch path write — no agent turn is needed to exercise the route.
 */
import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { startDaemonServer, type RunningDaemon } from '../../src/daemon/server';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { pinConfig } from '../helpers/pin-config';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { findFullTaskId } from '../helpers/storage';
import { createTask } from '../helpers/fixtures';
import { mintMcpToken, clearMcpTokenCache } from '../../src/daemon/mcp-tokens';
import { isolateInProcessDaemonEnv } from '../helpers/in-process-daemon';
import { putUserCredential, revokeUserCredential, clearUserCredentialCache, SERVICE_CREDENTIAL_USER_ID } from '../../src/daemon/user-credentials';
import { bindTurnCredential, clearSessionCredentialCache, revokeTaskSessionBinding } from '../../src/daemon/session-credentials';
import { daemonUsageLimits, memberEndpointUsageKey } from '../../src/proxy/usage-limits';
import { resetUsageReadingsForTest } from '../../src/daemon/usage-readings';

const SHARED_TOKEN = 'shared-daemon-token-usage-limits-test';

isolateInProcessDaemonEnv();

describe('lazy_usage_limits over MCP', () => {
  let ctx: TestContext;
  let daemon: RunningDaemon | undefined;
  let daemonUrl: string;
  let restoreConfig: (() => void) | undefined;
  let daemonBaseDir: string;
  let restoreDaemonBaseDir: (() => void) | undefined;
  let taskId: string;
  let taskToken: string;
  let builderToken: string;
  let boundBuilderToken: string;
  // Unique per run: the reading tracker is a process singleton.
  const tag = Math.random().toString(36).slice(2, 8);
  const alice = `alice-${tag}@example.com`;
  const bob = `bob-${tag}@example.com`;
  // The admin holding the project's service credential.
  const carol = `carol-${tag}@example.com`;
  const keyOf = (member: string) => memberEndpointUsageKey(member, 'builtin:anthropic');

  beforeEach(async () => {
    process.env.LAZY_TEST = '1';
    daemonBaseDir = await makeDaemonBaseDir();
    restoreDaemonBaseDir = pinDaemonBaseDir(daemonBaseDir);
    clearMcpTokenCache();
    clearUserCredentialCache();
    clearSessionCredentialCache();
    // The daemon installs its reading store as a process singleton bound to
    // THAT test's project; without this, the next test's credential pushes
    // clear readings through a store whose project is already deleted.
    resetUsageReadingsForTest();

    ctx = await setupTestLazy();
    restoreConfig = pinConfig(ctx.root);
    taskId = findFullTaskId(ctx.root, await createTask(ctx, 'Usage limits probe'));
    taskToken = await mintMcpToken(ctx.root, { kind: 'task', taskId }, 'lazy-usage');
    builderToken = await mintMcpToken(ctx.root, { kind: 'builder' }, 'builder-usage');
    // A daemon-owned builder session: token label builder-<id>, credential bound under <id>.
    boundBuilderToken = await mintMcpToken(ctx.root, { kind: 'builder' }, 'builder-sess1');

    observeReadings();

    daemon = await startDaemonServer({ token: SHARED_TOKEN, projectRoot: ctx.root });
    daemonUrl = `http://127.0.0.1:${daemon.webPort}`;
  });

  // Storing a credential clears its slot's reading (it may be a different
  // account now), so readings are (re)taken after any credential is stored.
  function observeReadings(): void {
    const now = Date.now();
    for (const [who, used] of [[alice, '0.16'], [bob, '0.91'], [carol, '0.30']] as const) {
      daemonUsageLimits.observeReading({
        credential: keyOf(who), ts: now, upstream: 'https://api.anthropic.com', backend: 'proxy',
        status: 200, taskId: null, model: null,
        headers: {
          'anthropic-ratelimit-unified-5h-utilization': used,
          'anthropic-ratelimit-unified-overage-status': 'rejected',
        },
      });
    }
  }

  // Two members on one Teams host plus Carol's service credential; the task's
  // turn (and the bound builder session) spends Alice's.
  async function teamsHost(): Promise<void> {
    await putUserCredential(ctx.root, { userId: alice, kind: 'oauth', token: 'oat-alice' });
    await putUserCredential(ctx.root, { userId: bob, kind: 'oauth', token: 'oat-bob' });
    await putUserCredential(ctx.root, { userId: SERVICE_CREDENTIAL_USER_ID, kind: 'oauth', token: 'oat-carol', ownerEmail: carol });
    await bindTurnCredential(ctx.root, { taskId, sessionId: 's-1', ownerUserId: alice, kind: 'oauth' });
    await bindTurnCredential(ctx.root, { taskId: 'sess1', sessionId: 'sess1', ownerUserId: alice, kind: 'oauth' });
    observeReadings();
  }

  afterEach(async () => {
    if (daemon) await daemon.stop();
    daemon = undefined;
    restoreConfig?.();
    clearMcpTokenCache();
    clearUserCredentialCache();
    clearSessionCredentialCache();
    await ctx.cleanup();
    restoreDaemonBaseDir?.();
    await removeDaemonBaseDir(daemonBaseDir);
  });

  async function call(token: string, segment: string): Promise<Record<string, any>> {
    const res = await fetch(`${daemonUrl}/mcp/${encodeURIComponent(segment)}/lazy_usage_limits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Lazy-Project': ctx.root },
      body: JSON.stringify({ arguments: {} }),
    } as any);
    const text = await res.text();
    expect(res.status).toBe(200);
    // The route may frame the reply with heartbeat lines; the result is the last JSON line.
    const lines = text.trim().split('\n').filter(Boolean);
    const body = JSON.parse(lines[lines.length - 1]);
    expect(body.result).toBeDefined();
    return body.result;
  }

  const credsOf = (view: Record<string, any>): string[] =>
    view.readings.map((r: { credential: string }) => r.credential);

  // INVARIANT: on a Teams host a builder reads no more than a member's own CLI
  // can — never another member's reading. The project-wide view is
  // control-plane only there, and the builder is a member's session.
  test('a Teams builder sees the service credential but no member\'s', async () => {
    await teamsHost();
    const view = await call(builderToken, '_');
    expect(view.scope).toBe('member');
    expect(view.credential).toBeNull();
    expect(credsOf(view)).toContain(keyOf(carol));
    expect(JSON.stringify(view)).not.toContain(alice);
    expect(JSON.stringify(view)).not.toContain(bob);
  });

  test('a Teams builder session bound to a member sees that member\'s credential, not another\'s', async () => {
    await teamsHost();
    const view = await call(boundBuilderToken, '_');
    expect(view.scope).toBe('member');
    expect(view.credential).toBe(keyOf(alice));
    const creds = credsOf(view);
    expect(creds).toContain(keyOf(alice));
    expect(creds).toContain(keyOf(carol));
    const own = view.readings.find((r: { credential: string }) => r.credential === keyOf(alice));
    expect(own.windows[0].usedPercent).toBe(16);
    expect(own.overage).toEqual({ status: 'rejected', reason: null });
    expect(JSON.stringify(view)).not.toContain(bob);
  });

  // On a single-person install there is nobody else's reading to hide.
  // A single-person install is one that never stored a member credential.
  test('a builder on a single-person install sees every credential', async () => {
    const view = await call(builderToken, '_');
    expect(view.scope).toBe('project');
    const creds = credsOf(view);
    expect(creds).toContain(keyOf(alice));
    expect(creds).toContain(keyOf(bob));
  });

  // INVARIANT: member billing does not end when the members' credentials are
  // revoked — the project stays a Teams host, and the builder still sees no
  // other member's reading. (Ending it on revocation would widen the view.)
  test('revoking the members\' credentials does not widen a Teams builder\'s view', async () => {
    await teamsHost();
    await revokeUserCredential(ctx.root, alice);
    await revokeUserCredential(ctx.root, bob);
    const view = await call(builderToken, '_');
    expect(view.scope).toBe('member');
    expect(JSON.stringify(view)).not.toContain(alice);
    expect(JSON.stringify(view)).not.toContain(bob);
  });

  // INVARIANT: a task agent on a Teams host sees only the credential its own
  // turn spends. The others are other members' accounts, and the narrowing is
  // the daemon's, not the client's.
  test('a task agent sees only its own turn\'s credential', async () => {
    await teamsHost();
    const view = await call(taskToken, taskId);
    expect(view.scope).toBe('task');
    expect(view.credential).toBe(keyOf(alice));
    expect(view.readings.map((r: { credential: string }) => r.credential)).toEqual([keyOf(alice)]);
    expect(JSON.stringify(view)).not.toContain(bob);
    // The budget is built over the same narrowed view: its own credential, its own task.
    expect(view.budget.scope).toBe('task');
    expect(view.budget.credentials.map((c: { credential: string }) => c.credential)).toEqual([keyOf(alice)]);
    expect(view.budget.tasks.every((t: { taskId: string }) => t.taskId === taskId)).toBe(true);
  });

  // INVARIANT: with no live binding lazy cannot tell which credential the turn
  // spends, so the agent sees none — never a fallback to every credential.
  test('a task agent whose turn has ended sees no credential', async () => {
    await teamsHost();
    await revokeTaskSessionBinding(ctx.root, taskId);
    const view = await call(taskToken, taskId);
    expect(view.scope).toBe('task');
    expect(view.credential).toBeNull();
    expect(view.readings).toEqual([]);
    expect(JSON.stringify(view)).not.toContain(alice);
    expect(JSON.stringify(view)).not.toContain(bob);
  });
});
