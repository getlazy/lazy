/** `lazy_token_stats` through the authenticated daemon MCP route. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { startDaemonServer, type RunningDaemon } from '../../src/daemon/server';
import { auditLogPath } from '../../src/proxy/audit-log';
import { mintMcpToken, clearMcpTokenCache } from '../../src/daemon/mcp-tokens';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { findFullTaskId } from '../helpers/storage';
import { extractTaskId } from '../helpers/assertions';
import { pinConfig } from '../helpers/pin-config';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { isolateInProcessDaemonEnv } from '../helpers/in-process-daemon';
import { putUserCredential, revokeUserCredential, clearUserCredentialCache } from '../../src/daemon/user-credentials';
import { bindTurnCredential, revokeTaskSessionBinding, clearSessionCredentialCache } from '../../src/daemon/session-credentials';

isolateInProcessDaemonEnv();

describe('lazy_token_stats over MCP', () => {
  let ctx: TestContext;
  let daemon: RunningDaemon | undefined;
  let restoreConfig: (() => void) | undefined;
  let restoreBase: (() => void) | undefined;
  let baseDir: string;
  let url: string;
  let parentId: string;
  let childId: string;
  let otherId: string;
  let taskToken: string;
  let builderToken: string;
  const alice = 'token-stats-alice@example.com';
  const bob = 'token-stats-bob@example.com';

  beforeEach(async () => {
    process.env.LAZY_TEST = '1';
    baseDir = await makeDaemonBaseDir();
    restoreBase = pinDaemonBaseDir(baseDir);
    clearMcpTokenCache();
    clearUserCredentialCache();
    clearSessionCredentialCache();
    ctx = await setupTestLazy();
    restoreConfig = pinConfig(ctx.root);
    const parent = await createTask(ctx, 'Token parent');
    const child = await ctx.lazy(['create', '--goal', 'Token child', '--parent', parent]);
    expect(child.exitCode).toBe(0);
    const childShort = extractTaskId(child.stdout);
    const other = await createTask(ctx, 'Other member task');
    parentId = findFullTaskId(ctx.root, parent);
    childId = findFullTaskId(ctx.root, childShort);
    otherId = findFullTaskId(ctx.root, other);

    const line = (id: string, taskId: string, tokens: number, tool: string) => JSON.stringify({
      id, seq: Number(id.slice(1)), ts: Date.now(), role: 'agent', taskId,
      backend: 'proxy', upstream: 'https://api.anthropic.com', method: 'POST', path: '/v1/messages',
      endpoint: 'messages', model: 'opus', tier: null, stream: false, requestShape: null,
      toolUses: [{ id: `tool-${id}`, name: tool, path: null, command: null, target: null, connector: false, inputPreview: '{}' }],
      toolResults: [{ toolUseId: `tool-${id}`, isError: false, contentPreview: '', contentLen: 10, contentTokens: tokens }], status: 200,
      usage: { inputTokens: tokens, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      stopReason: 'end_turn', error: null, durationMs: 10, reroute: null,
    });
    const path = auditLogPath(join(ctx.root, '.lazy'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, [line('r1', parentId, 10, 'Read'), line('r2', childId, 20, 'Search'), line('r3', otherId, 100, 'Secret')].join('\n') + '\n');

    await putUserCredential(ctx.root, { userId: alice, kind: 'oauth', token: 'oat-alice' });
    await putUserCredential(ctx.root, { userId: bob, kind: 'oauth', token: 'oat-bob' });
    await bindTurnCredential(ctx.root, { taskId: parentId, sessionId: 'token-stats-session', ownerUserId: alice, kind: 'oauth' });

    taskToken = await mintMcpToken(ctx.root, { kind: 'task', taskId: parentId }, 'token-stats-agent');
    builderToken = await mintMcpToken(ctx.root, { kind: 'builder' }, 'token-stats-builder');
    daemon = await startDaemonServer({ token: 'mcp-token-stats-shared', projectRoot: ctx.root });
    url = `http://127.0.0.1:${daemon.webPort}`;
  });

  afterEach(async () => {
    await daemon?.stop();
    restoreConfig?.();
    clearMcpTokenCache();
    await revokeTaskSessionBinding(ctx.root, parentId);
    await revokeUserCredential(ctx.root, alice);
    await revokeUserCredential(ctx.root, bob);
    clearUserCredentialCache();
    clearSessionCredentialCache();
    await ctx.cleanup();
    restoreBase?.();
    await removeDaemonBaseDir(baseDir);
  });

  async function call(token: string, args: Record<string, unknown>, segment = '_') {
    const response = await fetch(`${url}/mcp/${encodeURIComponent(segment)}/lazy_token_stats`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Lazy-Project': ctx.root },
      body: JSON.stringify({ arguments: args }),
    });
    expect(response.status).toBe(200);
    const lines = (await response.text()).trim().split('\n').filter(Boolean);
    return JSON.parse(lines.at(-1)!).result;
  }

  test('reports traffic, sums a subtree, and narrows agent task details', async () => {
    const builder = await call(builderToken, { scope: 'tokens', task: parentId, subtree: true, top: 20 });
    expect(builder.totals.requests).toBe(2);
    expect(builder.totals.totalTokens).toBe(32);
    const top = await call(builderToken, { scope: 'tokens', top: 1 });
    expect(top.tasks.map((row: { taskId: string }) => row.taskId)).toEqual([otherId]);

    const agent = await call(taskToken, { scope: 'tokens', subtree: true, top: 20 }, parentId);
    expect(agent.totals.requests).toBe(2);
    expect(agent.tasks.map((row: { taskId: string }) => row.taskId).sort()).toEqual([childId, parentId].sort());
    expect(JSON.stringify(agent)).not.toContain(otherId);
    expect(JSON.stringify(agent)).not.toContain(alice);
    expect(JSON.stringify(agent)).not.toContain(bob);

    const ownOnly = await call(taskToken, { scope: 'tokens', subtree: false, top: 20 }, parentId);
    expect(ownOnly.totals.requests).toBe(1);
    expect(ownOnly.tasks.map((row: { taskId: string }) => row.taskId)).toEqual([parentId]);

    const tools = await call(taskToken, { scope: 'tools', subtree: true, since: '1h', top: 1 }, parentId);
    expect(tools.tools.totalRows).toBe(2);
    expect(tools.tools.rows).toHaveLength(1);
    expect(tools.tools.source).toBe('window');
  });

  test('a stale task token fails closed instead of receiving project details', async () => {
    const missingId = '00000000-0000-4000-8000-000000000001';
    const stale = await mintMcpToken(ctx.root, { kind: 'task', taskId: missingId }, 'token-stats-stale');
    const response = await fetch(`${url}/mcp/${missingId}/lazy_token_stats`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${stale}`, 'X-Lazy-Project': ctx.root },
      body: JSON.stringify({ arguments: { scope: 'tokens' } }),
    });
    const body = await response.text();
    expect(response.status).not.toBe(200);
    expect(body).toContain('Task not found');
    expect(body).not.toContain(otherId);
  });

  test('rejects an invalid task type at the external boundary', async () => {
    const response = await fetch(`${url}/mcp/_/lazy_token_stats`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${builderToken}`, 'X-Lazy-Project': ctx.root },
      body: JSON.stringify({ arguments: { scope: 'tokens', task_type: 'made-up' } }),
    });
    expect(response.status).not.toBe(200);
    expect(await response.text()).toContain('task_type must be one of');
  });
});
