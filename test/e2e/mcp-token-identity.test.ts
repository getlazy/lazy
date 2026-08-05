/**
 * INVARIANT — THE ANTI-IMPERSONATION BOUNDARY.
 *
 * Agents reach the daemon at POST /mcp/:taskId/:toolName. The `:taskId` segment
 * is a CLAIM made by the caller; it proves nothing. While every agent presented
 * the same shared daemon bearer token, any agent could claim any task id and
 * act as that task — pose as its own PARENT and accept itself, unblock a
 * sibling, close someone else's work — which made every server-side ownership
 * gate (agent-subtask-mcp, allow-agent-accept-subtask) advisory against a
 * deliberately malicious agent.
 *
 * Identity is now cryptographic: each task session and each builder session
 * holds its OWN token, bound server-side to exactly one identity
 * (src/daemon/mcp-tokens.ts). The daemon derives the caller from the token and
 * REFUSES (403) when the claim disagrees — it never silently retargets the call
 * to the token's identity, because a caller acting on the wrong task while
 * believing it acts on another is worse than a hard error, and a silent
 * override would hide a real impersonation attempt.
 *
 * These tests must not be relaxed. A green run here is the only mechanical
 * evidence that a task agent can only ever act as itself.
 *
 * The daemon is the REAL one (startDaemonServer on a unix socket) because the
 * enforcement lives in that route and nowhere else.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { startDaemonServer, type RunningDaemon } from '../../src/daemon/server';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { pinConfig } from '../helpers/pin-config';
import { makeDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { findFullTaskId, taskFilePath } from '../helpers/storage';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import {
  mintMcpToken,
  revokeTaskMcpTokens,
  peekMcpToken,
  clearMcpTokenCache,
} from '../../src/daemon/mcp-tokens';

const SHARED_TOKEN = 'shared-daemon-token-identity-test';

describe('per-task MCP token identity', () => {
  let ctx: TestContext;
  let tmpDir: string;
  let socketPath: string;
  let daemon: RunningDaemon | undefined;
  let restoreConfig: (() => void) | undefined;
  let daemonBaseDir: string;

  let taskAShort: string;
  let taskBShort: string;
  let taskAId: string;
  let taskBId: string;
  let tokenA: string;
  let tokenB: string;
  let builderToken: string;

  beforeEach(async () => {
    process.env.LAZY_TEST = '1';
    // Set BEFORE setupTestLazy so CLI subprocesses inherit it: the MCP token
    // registry lives in the daemon state dir, and a test must never touch the
    // developer's real one.
    daemonBaseDir = await makeDaemonBaseDir();
    process.env.LAZY_DAEMON_BASE_DIR = daemonBaseDir;
    clearMcpTokenCache();

    ctx = await setupTestLazy();
    // This daemon starts in-process, so loadConfig would otherwise walk up from
    // `bun test`'s cwd (lazy's own worktree) and adopt lazy's real storage.
    restoreConfig = pinConfig(ctx.root);

    taskAShort = await createTask(ctx, 'Task A');
    taskBShort = await createTask(ctx, 'Task B');
    taskAId = findFullTaskId(ctx.root, taskAShort);
    taskBId = findFullTaskId(ctx.root, taskBShort);

    tokenA = await mintMcpToken(ctx.root, { kind: 'task', taskId: taskAId }, 'lazy-a');
    tokenB = await mintMcpToken(ctx.root, { kind: 'task', taskId: taskBId }, 'lazy-b');
    builderToken = await mintMcpToken(ctx.root, { kind: 'builder' }, 'builder-1');

    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-mcp-identity-'));
    socketPath = join(tmpDir, 'test.sock');
    daemon = await startDaemonServer({ socketPath, token: SHARED_TOKEN, projectRoot: ctx.root });
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

  /** POST a tool call over the daemon's unix socket with a given bearer token. */
  function call(
    token: string,
    taskSegment: string,
    toolName: string,
    args: Record<string, unknown> = {},
  ): Promise<Response> {
    return fetch(`http://localhost/mcp/${encodeURIComponent(taskSegment)}/${encodeURIComponent(toolName)}`, {
      unix: socketPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-Lazy-Project': ctx.root,
      },
      body: JSON.stringify({ arguments: args }),
    } as any);
  }

  /** Comments the task actually has — the observable side effect of lazy_comment. */
  async function commentCount(shortId: string): Promise<number> {
    let raw: string;
    try {
      raw = await readFile(taskFilePath(ctx.root, shortId, 'comments.json'), 'utf-8');
    } catch (err) {
      // No comments file yet means no comment was ever written — that IS zero.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }
    return (JSON.parse(raw).comments as unknown[]).length;
  }

  // INVARIANT: task A's token claiming task B is refused, and NOTHING runs.
  // This is the whole point of the feature — the case that used to succeed.
  test('task A token claiming task B is refused (403) and executes nothing', async () => {
    const resp = await call(tokenA, taskBId, 'lazy_comment', { message: 'marker-impersonation' });

    expect(resp.status).toBe(403);
    const body = await resp.json() as { error?: string };
    expect(body.error).toContain('Identity mismatch');
    expect(body.error).toContain(taskAId);
    expect(body.error).toContain(taskBId);

    // The side effect must not have happened: refusal precedes execution.
    expect(await commentCount(taskBShort)).toBe(0);
  });

  // INVARIANT: a short id or code for ANOTHER task is refused too — the check
  // resolves the claim rather than comparing raw strings, so spelling the
  // victim's id differently is not a bypass.
  test('a SHORT id for another task is refused just the same', async () => {
    const resp = await call(tokenA, taskBShort, 'lazy_comment', { message: 'marker-short' });

    expect(resp.status).toBe(403);
    expect(await commentCount(taskBShort)).toBe(0);
  });

  // The mirror image: an agent may not escape into the builder/project-wide
  // surface, where tools run unscoped at the project root.
  test('a task token claiming the builder surface is refused (403)', async () => {
    const resp = await call(tokenA, '_', 'lazy_list');

    expect(resp.status).toBe(403);
    const body = await resp.json() as { error?: string };
    expect(body.error).toContain('Identity mismatch');
    expect(body.error).toContain('builder');
  });

  // Legitimate traffic must be untouched: this feature is a boundary, not a
  // wall. Both the canonical id and the short id resolve to the same identity.
  test('an agent presenting its own token acts normally', async () => {
    const byFullId = await call(tokenA, taskAId, 'lazy_comment', { message: 'marker-own-full' });
    expect(byFullId.status).toBe(200);

    const byShortId = await call(tokenA, taskAShort, 'lazy_comment', { message: 'marker-own-short' });
    expect(byShortId.status).toBe(200);

    expect(await commentCount(taskAShort)).toBe(2);
  });

  // INVARIANT: the token dies with the session. accept/reject/close call
  // revokeTaskMcpTokens; after that the agent cannot act at all, even as
  // itself, and the 401 says why and what to do.
  test('the token of an ended session is refused (401)', async () => {
    expect(await revokeTaskMcpTokens(ctx.root, taskAId)).toBe(1);

    const resp = await call(tokenA, taskAId, 'lazy_comment', { message: 'marker-revoked' });

    expect(resp.status).toBe(401);
    const body = await resp.json() as { error?: string };
    expect(body.error).toContain('not a valid daemon MCP token');
    expect(await commentCount(taskAShort)).toBe(0);

    // Task B is unaffected — revocation is per identity, not a global reset.
    expect((await call(tokenB, taskBId, 'lazy_comment', { message: 'marker-b' })).status).toBe(200);
  });

  // (That accept/reject/close actually CALL revokeTaskMcpTokens is proven end
  // to end in test/e2e/mcp-token-revoke-lifecycle.test.ts — it drives the real
  // CLI, which cannot share a process with this suite's in-process daemon
  // because that daemon holds the storage lock.)

  // INVARIANT: the SHARED daemon token no longer opens /mcp. Keeping it working
  // "for compatibility" would restore the single shared identity this feature
  // exists to remove, so there is deliberately no fallback path.
  test('the shared daemon token is refused on /mcp (401)', async () => {
    const resp = await call(SHARED_TOKEN, '_', 'lazy_list');

    expect(resp.status).toBe(401);
    const body = await resp.json() as { error?: string };
    expect(body.error).toContain('not a valid daemon MCP token');
  });

  test('an unknown token is refused (401)', async () => {
    const resp = await call('f'.repeat(64), '_', 'lazy_list');
    expect(resp.status).toBe(401);
  });

  // The builder legitimately acts project-wide, with no task of its own.
  test('a builder token works on the builder surface', async () => {
    const resp = await call(builderToken, '_', 'lazy_list');

    expect(resp.status).toBe(200);
    const body = await resp.json() as { result?: unknown };
    expect(body.result).toBeDefined();
  });

  // ...but it is not a skeleton key: claiming a task id with a builder token is
  // refused, so a compromised builder config cannot act AS a task either.
  test('a builder token claiming a task id is refused (403)', async () => {
    const resp = await call(builderToken, taskAId, 'lazy_comment', { message: 'marker-builder' });

    expect(resp.status).toBe(403);
    const body = await resp.json() as { error?: string };
    expect(body.error).toContain('BUILDER token');
    expect(await commentCount(taskAShort)).toBe(0);
  });
});
