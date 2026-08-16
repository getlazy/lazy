/**
 * INVARIANT: rotating the shared daemon token actually invalidates the leaked
 * one, and strands nobody.
 *
 * `lazy upgrade` rotates this token when it purges the pre-v0.20 MCP configs
 * that leaked it into the repo (src/upgrade/legacy-mcp-purge.ts). The engineer's
 * requirement is explicit: chat, pair, builder and everything else must keep
 * working across a rotation. That holds because of three facts, and each one is
 * asserted below against the REAL daemon rather than assumed:
 *
 *   1. A restarted daemon adopts the rotated token from disk — so the rotation
 *      takes effect at all.
 *   2. The OLD token is refused on `/rpc/*`. If it still worked, the purge would
 *      be theatre: the credential every agent could read stays valid.
 *   3. Per-identity MCP tokens are a SEPARATE registry, so `/mcp/*` — every
 *      `lazy_*` tool call a task agent or builder makes — is untouched by a
 *      rotation. This is what makes the blast radius empty.
 *
 * Host CLI clients heal on their own (DaemonClient re-reads the token file on a
 * 401), and the only class that could not re-read it — a process inside a
 * container — is stopped before the upgrade rotates. See the blast-radius note
 * in src/upgrade/legacy-mcp-purge.ts.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { startDaemonServer, type RunningDaemon } from '../../src/daemon/server';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { pinConfig } from '../helpers/pin-config';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { findFullTaskId } from '../helpers/storage';
import { createTask } from '../helpers/fixtures';
import { generateToken, readToken } from '../../src/daemon/lifecycle';
import { mintMcpToken, clearMcpTokenCache } from '../../src/daemon/mcp-tokens';
import { purgeLegacyDaemonMcpConfigs, legacyMcpConfigDir } from '../../src/upgrade/legacy-mcp-purge';
import { isolateInProcessDaemonEnv } from '../helpers/in-process-daemon';

isolateInProcessDaemonEnv();

describe('shared daemon token rotation', () => {
  let ctx: TestContext;
  let tmpDir: string;
  let socketPath: string;
  let daemon: RunningDaemon | undefined;
  let restoreConfig: (() => void) | undefined;
  let daemonBaseDir: string;
  let restoreDaemonBaseDir: (() => void) | undefined;

  beforeEach(async () => {
    process.env.LAZY_TEST = '1';
    daemonBaseDir = await makeDaemonBaseDir();
    restoreDaemonBaseDir = pinDaemonBaseDir(daemonBaseDir);
    clearMcpTokenCache();

    ctx = await setupTestLazy();
    restoreConfig = pinConfig(ctx.root);

    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-rotation-'));
    socketPath = join(tmpDir, 'test.sock');
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

  /** GET an /rpc route over the daemon's unix socket with a given bearer token. */
  function rpc(token: string): Promise<Response> {
    return fetch('http://localhost/rpc/list', {
      unix: socketPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-Lazy-Project': ctx.root,
      },
      body: JSON.stringify({}),
    } as any);
  }

  function mcp(token: string): Promise<Response> {
    return fetch('http://localhost/mcp/_/lazy_list', {
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

  // The rotation has to actually reach the running system: a daemon started
  // afterwards must serve the NEW token and refuse the old one. Without this,
  // the purge deletes files and leaves the leaked credential live.
  test('a daemon started after the rotation honours the new token and refuses the old', async () => {
    const leaked = generateToken(ctx.root);

    // What upgrade does, in the window where nothing holds the token.
    await Bun.write(join(legacyMcpConfigDir(ctx.root), 'daemon-mcp-lazy-old.json'),
      JSON.stringify({ token: leaked }));
    const result = await purgeLegacyDaemonMcpConfigs(ctx.root);
    expect(result.rotated).toBe(true);

    const rotated = readToken(ctx.root)!;
    expect(rotated).not.toBe(leaked);

    // Same call ensureDaemon makes: no explicit token, so it adopts the file.
    daemon = await startDaemonServer({ socketPath, projectRoot: ctx.root });

    expect((await rpc(rotated)).status).toBe(200);
    // INVARIANT: the credential every agent could read is now worthless. Do not
    // add a compatibility fallback for the old token — that would undo the fix.
    expect((await rpc(leaked)).status).toBe(401);
  });

  // INVARIANT — the no-strand guarantee. Agents authenticate to /mcp with a
  // PER-IDENTITY token from a separate registry, so a shared-token rotation
  // cannot take a running agent's lazy_* tools away. This is precisely why the
  // rotation's blast radius is empty once containers are stopped.
  test('per-identity MCP tokens keep working across a rotation', async () => {
    generateToken(ctx.root);
    const shortId = await createTask(ctx, 'Rotation bystander');
    const taskId = findFullTaskId(ctx.root, shortId);
    const agentToken = await mintMcpToken(ctx.root, { kind: 'builder' }, 'builder-rotation');
    const taskToken = await mintMcpToken(ctx.root, { kind: 'task', taskId }, 'lazy-rotation');

    await Bun.write(join(legacyMcpConfigDir(ctx.root), 'daemon-mcp-lazy-old.json'), '{"token":"x"}');
    expect((await purgeLegacyDaemonMcpConfigs(ctx.root)).rotated).toBe(true);

    daemon = await startDaemonServer({ socketPath, projectRoot: ctx.root });

    expect((await mcp(agentToken)).status).toBe(200);
    // A task token on its own surface is likewise untouched (403 here would be
    // an identity mismatch, 401 a dead token — neither may happen).
    const taskResp = await fetch(`http://localhost/mcp/${taskId}/lazy_status`, {
      unix: socketPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${taskToken}`,
        'X-Lazy-Project': ctx.root,
      },
      body: JSON.stringify({ arguments: {} }),
    } as any);
    expect(taskResp.status).toBe(200);
  });
});
