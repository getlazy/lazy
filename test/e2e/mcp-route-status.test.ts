/**
 * INVARIANT: POST /mcp/:taskId/:toolName preserves the status an MCP tool
 * handler raised — an argument error is a 400, not a 500 — on the plain reply
 * and inside the heartbeat envelope alike. And a :taskId path segment that
 * cannot be a task reference fails as a malformed request (400), instead of
 * being fed to task resolution and reported as a missing task.
 *
 * Regression (two defects, one investigation — fix-builder-wait-timeout):
 *   1. `lazy_wait` with a missing/renamed `task_id` raises RpcError(400) from
 *      handleWait, but queryWait re-wrapped it as a plain Error, so the route's
 *      `err instanceof RpcError` test failed and the caller got HTTP 500. An
 *      argument mistake looked like a daemon crash, which sends the operator to
 *      debug the daemon and mis-trains error classification in mcp-proxy.
 *   2. A hand-rolled `POST /mcp/<builder-token>/lazy_wait` answered
 *      `Task not found: <the token>` — the route passed the token straight into
 *      task resolution rather than rejecting the path.
 *
 * The daemon here is the REAL one (startDaemonServer on a unix socket), because
 * the status mapping lives in that route and nowhere else.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { startDaemonServer, type RunningDaemon } from '../../src/daemon/server';
import { heartbeatRequestHeaders, isHeartbeatEnvelope, readHeartbeatEnvelope } from '../../src/daemon/heartbeat';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { pinConfig } from '../helpers/pin-config';
import { makeDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { mintMcpToken, clearMcpTokenCache } from '../../src/daemon/mcp-tokens';

const TOKEN = 'test-token-mcp-status';

describe('MCP route preserves handler status', () => {
  let ctx: TestContext;
  let tmpDir: string;
  let socketPath: string;
  let daemon: RunningDaemon | undefined;
  let restoreConfig: (() => void) | undefined;
  let daemonBaseDir: string;
  /**
   * The BUILDER's own MCP token. /mcp routes no longer accept the shared daemon
   * token — identity comes from a per-identity token (see
   * src/daemon/mcp-tokens.ts) — so these status tests present the builder's.
   */
  let builderToken: string;

  beforeEach(async () => {
    // Daemonless project + an in-process daemon: LAZY_TEST=1 keeps tryRpc from
    // looking for a daemon of its own, so the MCP handler executes the RPC
    // handler directly — exactly what LAZY_IS_DAEMON=1 does in production.
    process.env.LAZY_TEST = '1';
    ctx = await setupTestLazy();
    // This daemon starts in-process, so loadConfig would otherwise walk up from
    // `bun test`'s cwd (lazy's own worktree) and adopt lazy's real storage path.
    restoreConfig = pinConfig(ctx.root);
    // The MCP token registry lives in the daemon state dir — isolate it.
    daemonBaseDir = await makeDaemonBaseDir();
    process.env.LAZY_DAEMON_BASE_DIR = daemonBaseDir;
    clearMcpTokenCache();
    builderToken = await mintMcpToken(ctx.root, { kind: 'builder' }, 'builder-mcp-status');
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-mcp-status-'));
    socketPath = join(tmpDir, 'test.sock');
    daemon = await startDaemonServer({ socketPath, token: TOKEN, projectRoot: ctx.root });
  });

  afterEach(async () => {
    if (daemon) await daemon.stop();
    daemon = undefined;
    restoreConfig?.();
    restoreConfig = undefined;
    clearMcpTokenCache();
    delete process.env.LAZY_DAEMON_BASE_DIR;
    await removeDaemonBaseDir(daemonBaseDir);
    await ctx.cleanup();
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** POST a tool call over the daemon's unix socket. */
  function call(
    taskSegment: string,
    toolName: string,
    args: Record<string, unknown>,
    opts: { enveloped?: boolean } = {},
  ): Promise<Response> {
    return fetch(`http://localhost/mcp/${encodeURIComponent(taskSegment)}/${encodeURIComponent(toolName)}`, {
      unix: socketPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${builderToken}`,
        'X-Lazy-Project': ctx.root,
        ...(opts.enveloped ? heartbeatRequestHeaders() : {}),
      },
      body: JSON.stringify({ arguments: args }),
    } as any);
  }

  // INVARIANT: an argument error from a tool handler arrives as 400. A 500 here
  // would tell the caller the daemon broke when in fact their call was wrong.
  test('a 400 from a tool handler arrives as HTTP 400 (plain reply)', async () => {
    const resp = await call('_', 'lazy_wait', {}); // task_id omitted

    expect(resp.status).toBe(400);
    const body = await resp.json() as { error?: string };
    expect(body.error).toContain('taskId is required');
  });

  // INVARIANT: the heartbeat envelope carries the REAL status in its final
  // {"status":N} line. The HTTP status of an enveloped reply is always 200, so
  // a flattened status inside the envelope is invisible until the client
  // reconstructs it — same defect, one layer down.
  test('a 400 from a tool handler arrives as 400 inside the heartbeat envelope', async () => {
    const resp = await call('_', 'lazy_wait', {}, { enveloped: true });

    expect(resp.status).toBe(200); // headers precede the outcome, by design
    expect(isHeartbeatEnvelope(resp)).toBe(true);

    const { status, body } = await readHeartbeatEnvelope(resp, 'lazy_wait');
    expect(status).toBe(400);
    expect((body as { error?: string }).error).toContain('taskId is required');
  });

  // INVARIANT: a status that is genuinely "not found" still reads as 404 — the
  // fix preserves statuses, it does not rewrite them all to 400.
  test('a 404 from a tool handler still arrives as HTTP 404', async () => {
    const resp = await call('_', 'lazy_wait', { task_id: 'no-such-task' });

    expect(resp.status).toBe(404);
    const body = await resp.json() as { error?: string };
    expect(body.error).toContain('Task not found');
  });

  // INVARIANT: a bearer token in the :taskId segment is a malformed path, not a
  // missing task. The reported symptom was the misleading
  // `Task not found: <the token>`.
  test('the caller own token in the :taskId segment is a clear 400, not "task not found"', async () => {
    const resp = await call(builderToken, 'lazy_wait', { task_id: 'anything' });

    expect(resp.status).toBe(400);
    const body = await resp.json() as { error?: string };
    expect(body.error).toContain('daemon auth token');
    expect(body.error).toContain('/mcp/_/');
    expect(body.error).not.toContain('Task not found');
  });

  // Any bearer token is 64 hex chars (32 random bytes). Even when it is not one
  // this daemon knows — a stale token, another project's — it can never be a
  // task id, so the path is rejected on shape.
  test('a token-shaped :taskId segment is a clear 400', async () => {
    const resp = await call('a'.repeat(64), 'lazy_wait', { task_id: 'anything' });

    expect(resp.status).toBe(400);
    const body = await resp.json() as { error?: string };
    expect(body.error).toContain('daemon auth token');
    expect(body.error).not.toContain('Task not found');
  });

  // INVARIANT: garbage that is neither a task id nor a code fails on the path,
  // with the shape rule stated, before any storage lookup.
  test('a garbage :taskId segment is a clear 400', async () => {
    const resp = await call('not a task id!', 'lazy_wait', { task_id: 'anything' });

    expect(resp.status).toBe(400);
    const body = await resp.json() as { error?: string };
    expect(body.error).toContain('Invalid :taskId path segment');
    expect(body.error).not.toContain('Task not found');
  });

  // INVARIANT: an unknown TOOL is still a 404 (the tool name is not validated as
  // a task segment), so the two failure modes stay distinguishable.
  test('an unknown tool name is still a 404', async () => {
    const resp = await call('_', 'lazy_not_a_tool', {});

    expect(resp.status).toBe(404);
    const body = await resp.json() as { error?: string };
    expect(body.error).toContain('Unknown tool');
  });
});
