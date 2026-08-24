/**
 * INVARIANT: the builder container writes captured conversations through
 * POST /builder/storage, authenticated by its own BUILDER-kind MCP token, and
 * that surface exposes only a tiny allowlist of Storage methods.
 *
 * WHY this route exists at all (the bug it fixes): the builder supervisor runs
 * inside the container and posted capture writes to /rpc/storage using the MCP
 * token from its mounted daemon config. /rpc/* requires the SHARED daemon token,
 * so every 30-second capture tick 401'd for the whole life of every containerized
 * builder session — silently losing the session's incremental history and, with
 * it, the resume-intent stamp `lazy upgrade` needs.
 *
 * There were three ways to fix it and two of them are wrong:
 *   - Mount the shared daemon token in the container. That hands a container
 *     whose agent can read its own config file the full /rpc/<command> CLI
 *     pass-through and the unrestricted Storage interface.
 *   - Teach /rpc/* to accept MCP tokens. That collapses the deliberate,
 *     documented split between the two surfaces (public-docs/lazy-agent-design.md).
 * So capture got its own surface instead, strictly narrower than both: builder
 * tokens only, four methods only.
 *
 * These tests run a REAL daemon in-process and drive the route over its socket,
 * so an auth check that only passed in a mock could not pass here.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { startDaemonServer, type RunningDaemon } from '../../src/daemon/server';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { pinConfig } from '../helpers/pin-config';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { mintMcpToken, clearMcpTokenCache } from '../../src/daemon/mcp-tokens';
import { isolateInProcessDaemonEnv } from '../helpers/in-process-daemon';

const SHARED_TOKEN = 'shared-daemon-token-builder-storage-test';
const BUILDER_NAME = 'builder-1700000000000';

isolateInProcessDaemonEnv();

describe('POST /builder/storage — the builder capture surface', () => {
  let ctx: TestContext;
  let tmpDir: string;
  let socketPath: string;
  let daemon: RunningDaemon | undefined;
  let restoreConfig: (() => void) | undefined;
  let daemonBaseDir: string;
  let restoreDaemonBaseDir: (() => void) | undefined;
  let builderToken: string;
  let taskToken: string;

  beforeEach(async () => {
    process.env.LAZY_TEST = '1';
    daemonBaseDir = await makeDaemonBaseDir();
    restoreDaemonBaseDir = pinDaemonBaseDir(daemonBaseDir);
    clearMcpTokenCache();

    ctx = await setupTestLazy();
    restoreConfig = pinConfig(ctx.root);

    builderToken = await mintMcpToken(ctx.root, { kind: 'builder' }, BUILDER_NAME);
    taskToken = await mintMcpToken(ctx.root, { kind: 'task', taskId: 'deadbeef' }, 'task-deadbeef');

    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-builder-storage-'));
    socketPath = join(tmpDir, 'test.sock');
    daemon = await startDaemonServer({ socketPath, token: SHARED_TOKEN, projectRoot: ctx.root });
  });

  afterEach(async () => {
    if (daemon) await daemon.stop();
    daemon = undefined;
    restoreConfig?.();
    restoreConfig = undefined;
    clearMcpTokenCache();
    await ctx.cleanup();
    restoreDaemonBaseDir?.();
    restoreDaemonBaseDir = undefined;
    await removeDaemonBaseDir(daemonBaseDir);
    await rm(tmpDir, { recursive: true, force: true });
  });

  function post(path: string, token: string, body: unknown, project = ctx.root): Promise<Response> {
    return fetch(`http://localhost${path}`, {
      unix: socketPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-Lazy-Project': project,
      },
      body: JSON.stringify(body),
    } as any);
  }

  // The bug, inverted: this is the exact call the capture monitor makes.
  test('a builder token can call the allowlisted capture methods', async () => {
    const probe = await post('/builder/storage', builderToken, { method: 'getStoragePath', args: {} });
    expect(probe.status).toBe(200);

    const intents = await post('/builder/storage', builderToken, {
      method: 'listBuilderResumeIntents',
      args: {},
    });
    expect(intents.status).toBe(200);
    expect(await intents.json()).toEqual([]);
  });

  // The regression itself: the credential the container actually holds is NOT
  // accepted by /rpc/*, which is why capture must not be routed there.
  test('the same builder token is still refused on /rpc/storage', async () => {
    const resp = await post('/rpc/storage', builderToken, { method: 'getStoragePath', args: {} });
    expect(resp.status).toBe(401);
  });

  // A task container must not be able to write the builder's conversations.
  test('a task-kind MCP token is refused', async () => {
    const resp = await post('/builder/storage', taskToken, { method: 'getStoragePath', args: {} });
    expect(resp.status).toBe(401);
    const body = await resp.json() as { error?: string };
    expect(body.error).toContain('builder');
  });

  // Not a back door for the shared token either — the surface is defined by the
  // credential kind, not by "at least as privileged as".
  test('the shared daemon token is refused', async () => {
    const resp = await post('/builder/storage', SHARED_TOKEN, { method: 'getStoragePath', args: {} });
    expect(resp.status).toBe(401);
  });

  test('an unknown token is refused', async () => {
    const resp = await post('/builder/storage', 'not-a-real-token', { method: 'getStoragePath', args: {} });
    expect(resp.status).toBe(401);
    const body = await resp.json() as { error?: string };
    expect(body.error).toContain('requires a builder-session MCP token');
  });

  // INVARIANT: authentication is not authorization. A valid builder token is a
  // key to FOUR methods, not to the Storage interface.
  test('a non-allowlisted storage method is a 403, not a 200', async () => {
    const resp = await post('/builder/storage', builderToken, { method: 'saveTask', args: {} });
    expect(resp.status).toBe(403);
    const body = await resp.json() as { error?: string };
    expect(body.error).toContain('not available on the builder surface');
  });

  test('a missing method is a 400', async () => {
    const resp = await post('/builder/storage', builderToken, { args: {} });
    expect(resp.status).toBe(400);
  });

  // Same containment rule as every other daemon route: one daemon serves one
  // project, and a mismatched header is a caller bug rather than a silent write
  // into the wrong store.
  test('a mismatched project header is a 400', async () => {
    const resp = await post('/builder/storage', builderToken, { method: 'getStoragePath', args: {} }, '/some/other/repo');
    expect(resp.status).toBe(400);
  });
});
