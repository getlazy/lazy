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
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { getDaemonDir } from '../../src/daemon/paths';
import { handleGetAgentLaunchEnv, initDaemonStorage, getOrCreateStorage, closeAllStorage } from '../../src/daemon/rpc-handlers';
import { mintMcpToken, clearMcpTokenCache } from '../../src/daemon/mcp-tokens';
import { setDaemonContext, setDaemonProxyPort, clearDaemonContext } from '../../src/daemon/context';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { pinConfig } from '../helpers/pin-config';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { resolveProfileCredential } from '../../src/agent/credentials';
import { setCredential } from '../../src/credentials/store';
import { resolveProfileLaunchCreds } from '../../src/utils/role-target';

async function writeLegacyKey(root: string, harness: string, secret: string): Promise<void> {
  await mkdir(getDaemonDir(root), { recursive: true });
  await writeFile(join(getDaemonDir(root), 'agent-credentials.json'), JSON.stringify({ [harness]: { api_key: secret } }));
}

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

  // INVARIANT: engineer-approved October 3 reversal of the restart fix's legacy fallback.
  // Initial launch and refresh still share one resolver, but neither accepts a legacy-only key.
  test.each([
    ['cursor', 'cursor', 'CURSOR_API_KEY'],
    ['codex', 'openai', 'OPENAI_API_KEY'],
  ])('launch and restart refuse a legacy-only %s key and name set-key', async (harness, provider, envVar) => {
    delete process.env[envVar];
    const storage = await getOrCreateStorage();
    await storage.updateTaskAgent(taskId, harness);
    await writeLegacyKey(ctx.root, harness, 'fake-legacy-key');
    expect(await resolveProfileCredential(ctx.root, { name: harness, harness, credential: provider })).toBeNull();
    await expect(resolveProfileLaunchCreds(ctx.root, {
      profile: harness, harness, credential: provider, endpoint: '',
    })).rejects.toThrow(`lazy system agent set-key ${harness}`);
    await expect(handleGetAgentLaunchEnv(ctx.root, taskToken)).rejects.toThrow(`lazy system agent set-key ${harness}`);
    await setCredential(ctx.root, { provider, kind: 'api-key', secret: 'fake-current-key' }, 'file');
    const body = await handleGetAgentLaunchEnv(ctx.root, taskToken);
    expect(body.authEnvVars.find(variable => variable.key === 'ANTHROPIC_AUTH_TOKEN')?.value).toBeTruthy();
    expect(body.authEnvVars.find(variable => variable.key === 'ANTHROPIC_AUTH_TOKEN')?.value).not.toBe('fake-current-key');
    expect(await resolveProfileCredential(ctx.root, { name: harness, harness, credential: provider }))
      .toEqual({ value: 'fake-current-key', source: 'store' });
    expect(body.proxyBaseUrl).toMatch(/:45771/);
  });

  test('refresh credential resolution does not borrow a legacy key for a named account', async () => {
    delete process.env.CURSOR_API_KEY;
    delete process.env.LAZY_CREDENTIAL_WORK_CURSOR;
    await writeLegacyKey(ctx.root, 'cursor', 'fake-legacy-cursor-key');
    await expect(resolveProfileLaunchCreds(ctx.root, {
      profile: 'work-cursor', harness: 'cursor', credential: 'work-cursor', endpoint: '',
    })).rejects.toThrow(/lazy auth set work-cursor/);
  });

  test('refresh credential resolution prefers the unified store over a legacy key', async () => {
    delete process.env.CURSOR_API_KEY;
    await writeLegacyKey(ctx.root, 'cursor', 'fake-legacy-cursor-key');
    await setCredential(ctx.root, {
      provider: 'cursor', kind: 'api-key', secret: 'fake-current-cursor-key',
    }, 'file');
    expect(await resolveProfileLaunchCreds(ctx.root, {
      profile: 'cursor', harness: 'cursor', credential: 'cursor', endpoint: '',
    })).toEqual([{ key: 'ANTHROPIC_AUTH_TOKEN', value: 'fake-current-cursor-key' }]);
  });

  test('rejects an unknown token', async () => {
    await expect(handleGetAgentLaunchEnv(ctx.root, 'not-a-real-token')).rejects.toThrow(/task MCP token/i);
  });
});
