/**
 * A REAL daemon restart under a live MCP session.
 *
 * The field failure (v0.20 release, 2026-08-03): the engineer rebuilt the daemon
 * from the release branch and restarted it while a builder session was live. The
 * builder's lazy tools never came back — the only documented remedy was to throw
 * the conversation away and relaunch. Task agents hit the same wall mid-turn as
 * "MCP error -32000: Connection closed".
 *
 * The unit suites pin the two halves in isolation (daemon-mcp-reconnect,
 * builder-mcp-reissue). This file puts them together against a daemon that is
 * genuinely stopped and genuinely started again — a different server object, a
 * different socket — with the mounted config file rewritten in place exactly as
 * `refreshDaemonMcpConfigs` rewrites it on daemon start. The proxy handler under
 * test is the same one the container's MCP server builds.
 *
 * Security is re-asserted here rather than assumed: the recovery must not have
 * turned per-session tokens into long-lived ones, must not let one identity
 * borrow another's, and must not resurrect a credential the session's owner
 * deliberately revoked.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { startDaemonServer, type RunningDaemon } from '../../src/daemon/server';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { pinConfig } from '../helpers/pin-config';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import {
  mintMcpToken,
  clearMcpTokenCache,
  revokeBuilderMcpToken,
} from '../../src/daemon/mcp-tokens';
import { getMcpTokensPath } from '../../src/daemon/paths';
import { createDaemonProxyHandler, readDaemonMcpConfig } from '../../src/daemon/mcp-proxy';
import { isolateInProcessDaemonEnv } from '../helpers/in-process-daemon';

const SHARED_TOKEN = 'shared-daemon-token-restart-test';
const BUILDER_NAME = 'builder-1700000000000';

// This suite runs a daemon IN-PROCESS; keep the LAZY_IS_DAEMON flag that
// startDaemonServer() sets process-wide from leaking into later test files.
isolateInProcessDaemonEnv();

describe('MCP survives a real daemon restart', () => {
  let ctx: TestContext;
  let tmpDir: string;
  let daemon: RunningDaemon | undefined;
  let restoreConfig: (() => void) | undefined;
  let daemonBaseDir: string;
  let restoreDaemonBaseDir: (() => void) | undefined;
  let configPath: string;
  let builderToken: string;
  let socketA: string;
  let socketB: string;

  beforeEach(async () => {
    process.env.LAZY_TEST = '1';
    // Before setupTestLazy so subprocesses inherit it: the token registry lives
    // in this test's daemon state dir, never the developer's real one.
    daemonBaseDir = await makeDaemonBaseDir();
    restoreDaemonBaseDir = pinDaemonBaseDir(daemonBaseDir);
    clearMcpTokenCache();

    ctx = await setupTestLazy();
    // The daemon starts in-process, so loadConfig would otherwise walk up from
    // `bun test`'s cwd (lazy's own worktree) and adopt lazy's real storage.
    restoreConfig = pinConfig(ctx.root);

    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-daemon-restart-mcp-'));
    socketA = join(tmpDir, 'a.sock');
    socketB = join(tmpDir, 'b.sock');
    configPath = join(tmpDir, 'daemon-mcp-builder.json');

    builderToken = await mintMcpToken(ctx.root, { kind: 'builder' }, BUILDER_NAME);
    await writeConfig({ token: builderToken, target: socketA });

    daemon = await startDaemonServer({ socketPath: socketA, token: SHARED_TOKEN, projectRoot: ctx.root });
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

  /**
   * Write the mounted MCP config the way the daemon does: truncate in place,
   * never rename — a rename would break the container's single-file bind mount,
   * which is why the container can trust re-reading the same path.
   */
  async function writeConfig(body: { token: string; target: string }): Promise<void> {
    await writeFile(configPath, JSON.stringify({
      token: body.token,
      projectRoot: ctx.root,
      taskId: '',            // '' = the unscoped builder surface
      target: body.target,
    }, null, 2), { mode: 0o600 });
  }

  /** The handler the container's MCP server builds for one lazy tool. */
  function handlerFor(toolName: string, opts?: { reauthWindowMs?: number; reconnectWindowMs?: number }) {
    const config = readDaemonMcpConfig(configPath);
    return {
      config,
      call: createDaemonProxyHandler(config, toolName, { log: () => {}, ...opts }),
    };
  }

  /** A raw MCP call, bypassing the proxy — for the security assertions. */
  function rawCall(socket: string, token: string, taskId: string, toolName: string): Promise<Response> {
    return fetch(`http://localhost/mcp/${encodeURIComponent(taskId || '_')}/${toolName}`, {
      unix: socket,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-Lazy-Project': ctx.root,
      },
      body: JSON.stringify({ arguments: {} }),
    } as any);
  }

  // THE TASK: a rebuild+restart while a session is live must not end the
  // session. The call is issued while the daemon is DOWN — it waits, re-reads
  // the rewritten config, finds the daemon at its new address, and returns.
  test('a tool call issued while the daemon is down succeeds when it comes back', async () => {
    // Sanity: the session is working before the restart.
    expect(await handlerFor('lazy_list').call({})).toHaveProperty('tasks');

    // The rebuild: the daemon goes away entirely.
    await daemon!.stop();
    daemon = undefined;

    // A lazy_* call lands in the gap. Nothing is listening at socketA.
    const pending = handlerFor('lazy_list').call({});

    // The daemon comes back — a different server, a different socket, exactly
    // as a restart that could not re-bind its old address would — and rewrites
    // every mounted config in place with the new target.
    await new Promise((r) => setTimeout(r, 300));
    daemon = await startDaemonServer({ socketPath: socketB, token: SHARED_TOKEN, projectRoot: ctx.root });
    await writeConfig({ token: builderToken, target: socketB });

    // No relaunch: the call the human made before the restart returns normally.
    expect(await pending).toHaveProperty('tasks');
  }, 30_000);

  // The other half: the daemon comes back WITHOUT this session's token record
  // (registry moved by an upgrade, cleared by a repair, label evicted by the
  // builder cap). The session's OWNER re-issues under the same label; the
  // in-flight call picks that up instead of declaring the session dead.
  test('a credential re-issued by the session owner rescues a call that 401s', async () => {
    await daemon!.stop();

    // The registry is lost across the restart. The old token is now unknown.
    await rm(getMcpTokensPath(ctx.root), { force: true });
    clearMcpTokenCache();

    daemon = await startDaemonServer({ socketPath: socketB, token: SHARED_TOKEN, projectRoot: ctx.root });
    await writeConfig({ token: builderToken, target: socketB });

    // The old token really is refused by the restarted daemon.
    expect((await rawCall(socketB, builderToken, '', 'lazy_list')).status).toBe(401);

    const pending = handlerFor('lazy_list').call({});

    // What `startBuilderMcpReissueWatcher` does on the host when it notices a
    // new daemon instance: ask for a config under THIS session's own label.
    await new Promise((r) => setTimeout(r, 300));
    const reissued = await mintMcpToken(ctx.root, { kind: 'builder' }, BUILDER_NAME);
    await writeConfig({ token: reissued, target: socketB });

    expect(await pending).toHaveProperty('tasks');
    // A genuinely NEW credential — not the old one resurrected.
    expect(reissued).not.toBe(builderToken);
    // And the container took it from the mounted file, nowhere else.
    expect(JSON.parse(await readFile(configPath, 'utf-8')).token).toBe(reissued);
  }, 30_000);

  // SECURITY INVARIANT: the pre-loss token stays dead. Recovery re-issues a new
  // credential; it never makes an unknown token acceptable again.
  test('the token the restarted daemon does not know stays refused forever', async () => {
    await daemon!.stop();
    await rm(getMcpTokensPath(ctx.root), { force: true });
    clearMcpTokenCache();
    daemon = await startDaemonServer({ socketPath: socketB, token: SHARED_TOKEN, projectRoot: ctx.root });

    // Re-issue for the session, as the watcher would.
    const reissued = await mintMcpToken(ctx.root, { kind: 'builder' }, BUILDER_NAME);
    expect((await rawCall(socketB, reissued, '', 'lazy_list')).status).toBe(200);

    // The old one is not honoured by any grace period.
    const old = await rawCall(socketB, builderToken, '', 'lazy_list');
    expect(old.status).toBe(401);
    expect((await old.json() as { error?: string }).error).toContain('not a valid daemon MCP token');
  }, 30_000);

  // SECURITY INVARIANT: a token the session's owner REVOKED must not come back
  // just because the daemon restarted. Nothing daemon-side re-mints from a
  // lingering config file — re-issue is always the live session asking.
  test('a revoked builder token is not resurrected by a restart', async () => {
    expect(await revokeBuilderMcpToken(ctx.root, BUILDER_NAME)).toBe(1);

    await daemon!.stop();
    daemon = await startDaemonServer({ socketPath: socketB, token: SHARED_TOKEN, projectRoot: ctx.root });
    // The config file is still mounted and still names the revoked token.
    await writeConfig({ token: builderToken, target: socketB });

    expect((await rawCall(socketB, builderToken, '', 'lazy_list')).status).toBe(401);

    // Even after the reconnect/re-auth windows are spent, it fails — the wait
    // gives the owner time to re-issue, it does not soften the check.
    const { call } = handlerFor('lazy_list', { reauthWindowMs: 500 });
    await expect(call({})).rejects.toThrow(/401 Unauthorized/);
  }, 30_000);

  // SECURITY INVARIANT: no cross-identity reuse. The :taskId in the URL is a
  // claim; the token is the proof. A restart changes nothing about that.
  test('a builder token claiming a task identity is refused after a restart', async () => {
    await daemon!.stop();
    daemon = await startDaemonServer({ socketPath: socketB, token: SHARED_TOKEN, projectRoot: ctx.root });

    const resp = await rawCall(socketB, builderToken, 'deadbeefdeadbeef', 'lazy_list');
    expect(resp.status).toBe(403);

    // The shared daemon token is likewise not an MCP identity — the MCP surface
    // has no fallback that would put every agent back on one credential.
    expect((await rawCall(socketB, SHARED_TOKEN, '', 'lazy_list')).status).toBe(401);
  }, 30_000);
});
