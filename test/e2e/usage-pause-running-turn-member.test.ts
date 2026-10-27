/**
 * The running-turn stop on a Teams host (member billing): a running turn is
 * judged on the credential it actually SPENDS — its live session binding's
 * owner — never on the project's service credential.
 *
 * In-process daemon; readings, credentials and the turn's binding are set
 * through the same singletons the proxy and the launch path write.
 */
import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { readFile, writeFile } from 'fs/promises';
import { startDaemonServer, type RunningDaemon } from '../../src/daemon/server';
import { getOrCreateStorage } from '../../src/daemon/rpc-handlers';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { pinConfig } from '../helpers/pin-config';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { findFullTaskId, setTaskStatus } from '../helpers/storage';
import { createTask } from '../helpers/fixtures';
import { clearMcpTokenCache } from '../../src/daemon/mcp-tokens';
import { isolateInProcessDaemonEnv } from '../helpers/in-process-daemon';
import { putUserCredential, clearUserCredentialCache, SERVICE_CREDENTIAL_USER_ID } from '../../src/daemon/user-credentials';
import { bindTurnCredential, clearSessionCredentialCache } from '../../src/daemon/session-credentials';
import { daemonUsageLimits, memberEndpointUsageKey } from '../../src/proxy/usage-limits';
import { resetUsageReadingsForTest } from '../../src/daemon/usage-readings';
import { runningTurnStopFor, resetRunningTurnStopForTest } from '../../src/daemon/running-turn-stop';
import { putEndpointCredential } from '../../src/daemon/user-credentials';
import { loadConfig } from '../../src/config/loader';
import { profileForAgentNameOrNull } from '../../src/config/agent-profiles';
import { endpointRequirementsForProfile } from '../../src/credentials/endpoint-requirements';

isolateInProcessDaemonEnv();

describe('running-turn stop under member billing', () => {
  let ctx: TestContext;
  let daemon: RunningDaemon | undefined;
  let restoreConfig: (() => void) | undefined;
  let daemonBaseDir: string;
  let restoreDaemonBaseDir: (() => void) | undefined;
  let taskId: string;
  let codexTask: string;
  const tag = Math.random().toString(36).slice(2, 8);
  const alice = `alice-${tag}@example.com`;
  const carol = `carol-${tag}@example.com`;
  const keyOf = (member: string) => memberEndpointUsageKey(member, 'builtin:anthropic');

  function observe(who: string, used: string): void {
    daemonUsageLimits.observeReading({
      credential: keyOf(who), ts: Date.now(), upstream: 'https://api.anthropic.com', backend: 'proxy',
      status: 200, taskId: null, model: null,
      headers: {
        'anthropic-ratelimit-unified-5h-utilization': used,
        'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600),
      },
    });
  }

  beforeEach(async () => {
    process.env.LAZY_TEST = '1';
    daemonBaseDir = await makeDaemonBaseDir();
    restoreDaemonBaseDir = pinDaemonBaseDir(daemonBaseDir);
    clearMcpTokenCache();
    clearUserCredentialCache();
    clearSessionCredentialCache();
    resetUsageReadingsForTest();
    resetRunningTurnStopForTest();

    ctx = await setupTestLazy();
    const configPath = join(ctx.root, 'lazy.toml');
    await writeFile(configPath, `${await readFile(configPath, 'utf-8')}\n[usage_pause]\nthreshold_percent = 95\n`);
    restoreConfig = pinConfig(ctx.root);
    taskId = findFullTaskId(ctx.root, await createTask(ctx, 'Member turn'));
    setTaskStatus(ctx.root, taskId, 'working');
    // Created before the in-process daemon starts: it holds the storage lock.
    codexTask = findFullTaskId(ctx.root, await createTask(ctx, 'Codex turn', 'Work', { agent: 'codex-subscription' }));
    setTaskStatus(ctx.root, codexTask, 'working');

    await putUserCredential(ctx.root, { userId: alice, kind: 'oauth', token: 'oat-alice' });
    await putUserCredential(ctx.root, { userId: SERVICE_CREDENTIAL_USER_ID, kind: 'oauth', token: 'oat-carol', ownerEmail: carol });
    await bindTurnCredential(ctx.root, { taskId, sessionId: 's-1', ownerUserId: alice, kind: 'oauth' });

    daemon = await startDaemonServer({ token: 'running-turn-member-test', projectRoot: ctx.root });
  });

  afterEach(async () => {
    if (daemon) await daemon.stop();
    daemon = undefined;
    restoreConfig?.();
    clearUserCredentialCache();
    clearSessionCredentialCache();
    await ctx.cleanup();
    restoreDaemonBaseDir?.();
    await removeDaemonBaseDir(daemonBaseDir);
  });

  // INVARIANT: a running member turn is stopped on the reading of the MEMBER
  // credential it spends. Judged on the service credential (the request-scope
  // owner is empty on the proxy path), a member past their threshold ran on.
  test('a member past the threshold is stopped', async () => {
    observe(alice, '0.97');
    observe(carol, '0.10');
    const stop = await runningTurnStopFor(ctx.root, await getOrCreateStorage(), taskId);
    expect(stop?.kind).toBe('usage');
    expect(stop?.usage?.credential).toBe(keyOf(alice));
  });

  // INVARIANT: the service holder's full window never stops a turn that spends
  // a member's credential.
  test('the service holder past the threshold does not stop a member turn', async () => {
    observe(alice, '0.10');
    observe(carol, '0.97');
    const stop = await runningTurnStopFor(ctx.root, await getOrCreateStorage(), taskId);
    expect(stop).toBeNull();
  });

  // INVARIANT (bug-class rule: every harness): a running CODEX turn is stopped
  // the same way, on the Codex usage windows the proxy reads for its member
  // credential — not only Claude Code turns.
  test('a codex turn past the threshold is stopped too', async () => {
    const config = await loadConfig(ctx.root);
    const requirement = endpointRequirementsForProfile(profileForAgentNameOrNull(config, 'codex-subscription')!, config)[0]!;
    await putEndpointCredential(ctx.root, {
      userId: alice, endpointId: requirement.endpointId, origin: requirement.scope, provider: requirement.provider,
      session: requirement.session, kind: 'oauth', token: 'chatgpt-alice',
    });
    await bindTurnCredential(ctx.root, { taskId: codexTask, sessionId: 's-2', ownerUserId: alice, kind: 'oauth' });
    daemonUsageLimits.observeReading({
      credential: memberEndpointUsageKey(alice, requirement.endpointId), ts: Date.now(), upstream: requirement.origin,
      backend: 'proxy', status: 200, taskId: null, model: null,
      headers: { 'x-codex-primary-used-percent': '97', 'x-codex-primary-reset-after-seconds': '3600' },
    });
    const stop = await runningTurnStopFor(ctx.root, await getOrCreateStorage(), codexTask);
    expect(stop?.kind).toBe('usage');
    expect(stop?.usage?.credential).toBe(memberEndpointUsageKey(alice, requirement.endpointId));
  });
});
