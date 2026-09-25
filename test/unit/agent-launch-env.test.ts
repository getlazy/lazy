/**
 * Unit tests: handleGetAgentLaunchEnv — the daemon route an in-container TASK
 * supervisor uses to refresh its model/proxy env before a retry relaunch.
 *
 * INVARIANT: a task container reaches the daemon with its own per-task MCP
 * token and nothing else. The daemon RPC client locates the daemon through
 * host-side port-marker and token FILES, which are deliberately never mounted
 * into a task container, so the refresh cannot go through it — it went through
 * it anyway, reported "Daemon is not running" against a live daemon, and turned
 * every in-container retry into a fatal error naming the wrong cause.
 *
 * INVARIANT: which task the refresh is for comes from the TOKEN, never from the
 * request, so no container can refresh into another task's credential grant.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { handleGetAgentLaunchEnv, initDaemonStorage, getOrCreateStorage, closeAllStorage } from '../../src/daemon/rpc-handlers';
import { mintMcpToken, clearMcpTokenCache } from '../../src/daemon/mcp-tokens';
import { setDaemonContext, setDaemonProxyPort, clearDaemonContext } from '../../src/daemon/context';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { pinConfig } from '../helpers/pin-config';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';

describe('handleGetAgentLaunchEnv', () => {
  let ctx: TestContext;
  let restoreConfig: (() => void) | undefined;
  let daemonBaseDir: string;
  let restoreDaemonBaseDir: (() => void) | undefined;
  let taskId: string;
  let taskToken: string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token-for-agent-launch-env';
    daemonBaseDir = await makeDaemonBaseDir();
    restoreDaemonBaseDir = pinDaemonBaseDir(daemonBaseDir);
    clearMcpTokenCache();

    ctx = await setupTestLazy();
    restoreConfig = pinConfig(ctx.root);

    initDaemonStorage(ctx.root);
    const storage = await getOrCreateStorage();
    const task = await storage.createTask(
      'refresh me', undefined, undefined, 'refresh-me', 'task', 'claude-code',
    );
    taskId = task.id;

    taskToken = await mintMcpToken(ctx.root, { kind: 'task', taskId }, `lazy-${taskId.substring(0, 8)}`);
    setDaemonContext({ webPort: 43011, token: 'shared' });
    setDaemonProxyPort(45771);
  });

  afterEach(async () => {
    clearDaemonContext();
    await closeAllStorage();
    if (restoreConfig) restoreConfig();
    if (restoreDaemonBaseDir) restoreDaemonBaseDir();
    if (daemonBaseDir) await removeDaemonBaseDir(daemonBaseDir);
    await ctx.cleanup();
    process.env = { ...savedEnv };
  });

  test('returns the live proxy address and a placeholder for a task MCP token', async () => {
    const body = await handleGetAgentLaunchEnv(ctx.root, taskToken);
    const baseUrl = body.authEnvVars.find(v => v.key === 'ANTHROPIC_BASE_URL');
    expect(baseUrl?.value).toMatch(/^http:\/\/(127\.0\.0\.1|host\.docker\.internal):45771/);
    expect(body.proxyBaseUrl).toMatch(/:45771/);
    expect(body.lazyVersion.length).toBeGreaterThan(0);
    // The credential that reaches a container is a per-launch placeholder, never
    // the real token — the same rule the initial launch follows.
    const credential = body.authEnvVars.find(
      v => v.key === 'ANTHROPIC_AUTH_TOKEN' || v.key === 'CLAUDE_CODE_OAUTH_TOKEN' || v.key === 'ANTHROPIC_API_KEY',
    );
    expect(credential?.value).not.toBe('test-oauth-token-for-agent-launch-env');
  });

  test('rejects a builder MCP token', async () => {
    const builderToken = await mintMcpToken(ctx.root, { kind: 'builder' }, 'builder-x');
    await expect(handleGetAgentLaunchEnv(ctx.root, builderToken)).rejects.toThrow(/task MCP token/i);
  });

  test('rejects an unknown token', async () => {
    await expect(handleGetAgentLaunchEnv(ctx.root, 'not-a-real-token')).rejects.toThrow(/task MCP token/i);
  });
});
