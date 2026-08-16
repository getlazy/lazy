/**
 * INVARIANT: a builder's MCP token dies with its builder session.
 *
 * A builder session ends when the human closes the terminal — no lifecycle
 * event told the daemon about it, so a builder token used to stay valid for as
 * long as the registry kept the record (bounded only by its 50-entry builder
 * cap). A config file recovered from an exited session was still a working key
 * to the builder MCP surface, which runs UNSCOPED at the project root.
 *
 * `lazy builder` now brackets the session: it asks the daemon for a config
 * before launch and calls `revokeDaemonMcpToken` once the builder supervisor
 * has exited (src/builder/mcp-session.ts, called from the launch path's
 * `finally`). This file proves the daemon half of that bracket against the REAL
 * daemon over its socket: the token works during the session, and the very RPC
 * the exit path issues makes it stop working.
 *
 * Revocation deliberately goes through the daemon rather than by rewriting the
 * registry file from the CLI: the daemon caches the registry in memory and only
 * re-reads it on a token MISS, so a file edited behind its back would leave the
 * revoked token still accepted. This test runs the daemon in-process precisely
 * so a cache-only revocation could not pass.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { startDaemonServer, type RunningDaemon } from '../../src/daemon/server';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { pinConfig } from '../helpers/pin-config';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { mintMcpToken, peekMcpToken, clearMcpTokenCache } from '../../src/daemon/mcp-tokens';
import { isolateInProcessDaemonEnv } from '../helpers/in-process-daemon';

const SHARED_TOKEN = 'shared-daemon-token-builder-revoke-test';
const BUILDER_NAME = 'builder-1700000000000';

// This suite runs a daemon IN-PROCESS; keep the LAZY_IS_DAEMON flag that
// startDaemonServer() sets process-wide from leaking into later test files.
isolateInProcessDaemonEnv();

describe('builder MCP token revocation on supervisor exit', () => {
  let ctx: TestContext;
  let tmpDir: string;
  let socketPath: string;
  let daemon: RunningDaemon | undefined;
  let restoreConfig: (() => void) | undefined;
  let daemonBaseDir: string;
  let restoreDaemonBaseDir: (() => void) | undefined;
  let builderToken: string;

  beforeEach(async () => {
    process.env.LAZY_TEST = '1';
    // Set BEFORE setupTestLazy so subprocesses inherit it: the token registry
    // lives in the daemon state dir, never the developer's real one.
    daemonBaseDir = await makeDaemonBaseDir();
    restoreDaemonBaseDir = pinDaemonBaseDir(daemonBaseDir);
    clearMcpTokenCache();

    ctx = await setupTestLazy();
    // This daemon starts in-process, so loadConfig would otherwise walk up from
    // `bun test`'s cwd (lazy's own worktree) and adopt lazy's real storage.
    restoreConfig = pinConfig(ctx.root);

    builderToken = await mintMcpToken(ctx.root, { kind: 'builder' }, BUILDER_NAME);

    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-builder-revoke-'));
    socketPath = join(tmpDir, 'test.sock');
    daemon = await startDaemonServer({ socketPath, token: SHARED_TOKEN, projectRoot: ctx.root });
  });

  afterEach(async () => {
    if (daemon) await daemon.stop();
    daemon = undefined;
    restoreConfig?.();
    restoreConfig = undefined;
    clearMcpTokenCache();
    // Reap the daemon FIRST: cleanup resolves its pidfile through
    // LAZY_DAEMON_BASE_DIR, so unpinning before this looks under the default
    // base dir and leaves the daemon running.
    await ctx.cleanup();
    restoreDaemonBaseDir?.();
    restoreDaemonBaseDir = undefined;
    await removeDaemonBaseDir(daemonBaseDir);
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** A builder-surface MCP tool call (`_` = the unscoped builder segment). */
  function mcpCall(token: string, toolName: string): Promise<Response> {
    return fetch(`http://localhost/mcp/_/${toolName}`, {
      unix: socketPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-Lazy-Project': ctx.root,
      },
      body: JSON.stringify({ arguments: {} }),
    } as any);
  }

  /** The exact RPC `lazy builder` issues once the builder supervisor exits. */
  function revokeRpc(name: string): Promise<Response> {
    return fetch('http://localhost/rpc/revokeDaemonMcpToken', {
      unix: socketPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SHARED_TOKEN}`,
        'X-Lazy-Project': ctx.root,
      },
      body: JSON.stringify({ name }),
    } as any);
  }

  test('the builder token works during the session and is refused after the supervisor exits', async () => {
    // During the session: the token is a working key to the builder surface.
    expect((await mcpCall(builderToken, 'lazy_list')).status).toBe(200);

    // The supervisor exits → `lazy builder` revokes.
    const revoke = await revokeRpc(BUILDER_NAME);
    expect(revoke.status).toBe(200);
    expect(await revoke.json()).toEqual({ revoked: 1 });

    // After the session: refused, with the 401 that says the token is unknown.
    const after = await mcpCall(builderToken, 'lazy_list');
    expect(after.status).toBe(401);
    const body = await after.json() as { error?: string };
    expect(body.error).toContain('not a valid daemon MCP token');

    // And it is gone from the registry, not merely rejected in memory.
    expect(await peekMcpToken(ctx.root, { kind: 'builder' }, BUILDER_NAME)).toBeNull();
  });

  // Revocation is per builder session, not a global reset: a second builder the
  // human left open in another terminal must keep working.
  test('revoking one builder session leaves another builder untouched', async () => {
    const otherToken = await mintMcpToken(ctx.root, { kind: 'builder' }, 'builder-1700000009999');

    expect(await (await revokeRpc(BUILDER_NAME)).json()).toEqual({ revoked: 1 });

    expect((await mcpCall(builderToken, 'lazy_list')).status).toBe(401);
    expect((await mcpCall(otherToken, 'lazy_list')).status).toBe(200);
  });

  // Idempotent: the exit path is best-effort and may run twice (e.g. a relaunch
  // loop iteration that already revoked). A second call must not error.
  test('revoking an already-revoked or unknown builder name succeeds with revoked: 0', async () => {
    expect(await (await revokeRpc(BUILDER_NAME)).json()).toEqual({ revoked: 1 });
    expect(await (await revokeRpc(BUILDER_NAME)).json()).toEqual({ revoked: 0 });
    expect(await (await revokeRpc('builder-never-existed')).json()).toEqual({ revoked: 0 });
  });

  // A missing name is a caller bug, not a silent no-op: revoking "nothing in
  // particular" would quietly leave a live credential behind.
  test('revoking with no name is a 400', async () => {
    const resp = await revokeRpc('');
    expect(resp.status).toBe(400);
  });
});
