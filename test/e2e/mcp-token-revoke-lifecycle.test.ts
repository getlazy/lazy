/**
 * INVARIANT: a task's MCP token dies with its session.
 *
 * test/e2e/mcp-token-identity.test.ts proves the daemon REFUSES a revoked token
 * (401). This file proves the other half: that the real lifecycle actually
 * revokes it — accept/reject/close call revokeTaskMcpTokens, so an agent whose
 * task has ended cannot act at all, even as itself. Without this, the
 * credential would outlive the session for as long as the daemon ran.
 *
 * It drives the REAL CLI (`lazy start`, `lazy close`) rather than calling the
 * registry function directly, and therefore must NOT start an in-process daemon:
 * that daemon holds the store's .storage-lock and every CLI subprocess would
 * block on it.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { findFullTaskId } from '../helpers/storage';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { mintMcpToken, peekMcpToken, clearMcpTokenCache } from '../../src/daemon/mcp-tokens';

describe('MCP token revocation on session end', () => {
  let ctx: TestContext;
  let daemonBaseDir: string;
  let restoreDaemonBaseDir: (() => void) | undefined;

  beforeEach(async () => {
    // Set BEFORE setupTestLazy so the CLI subprocesses inherit it: the token
    // registry lives in the daemon state dir, and a test must never touch the
    // developer's real one.
    daemonBaseDir = await makeDaemonBaseDir();
    restoreDaemonBaseDir = pinDaemonBaseDir(daemonBaseDir);
    clearMcpTokenCache();
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    clearMcpTokenCache();
    // Reap the daemon FIRST: cleanup resolves its pidfile through
    // LAZY_DAEMON_BASE_DIR, so unpinning before this looks under the default
    // base dir and leaves the daemon running.
    await ctx.cleanup();
    restoreDaemonBaseDir?.();
    restoreDaemonBaseDir = undefined;
    await removeDaemonBaseDir(daemonBaseDir);
  });

  test('closing a task revokes its token, and only its own', async () => {
    const aShort = await createTask(ctx, 'Task A', 'Do the A thing');
    const bShort = await createTask(ctx, 'Task B', 'Do the B thing');
    const aId = findFullTaskId(ctx.root, aShort);
    const bId = findFullTaskId(ctx.root, bShort);

    // A session must exist — that is the state a live agent (and its token) has.
    expectSuccess(await ctx.lazyMocked(['start', aShort, '--yes'], MOCK_CLAUDE_SUCCESS));

    const tokenA = await mintMcpToken(ctx.root, { kind: 'task', taskId: aId }, `lazy-${aShort}`);
    const tokenB = await mintMcpToken(ctx.root, { kind: 'task', taskId: bId }, `lazy-${bShort}`);
    expect(tokenA).not.toBe(tokenB);

    expectSuccess(await ctx.lazy(['close', aShort, '--reason', 'done', '--yes']));

    // The CLI subprocess rewrote the registry on disk; drop our cached copy.
    clearMcpTokenCache();

    expect(await peekMcpToken(ctx.root, { kind: 'task', taskId: aId }, `lazy-${aShort}`)).toBeNull();
    // Revocation is per identity, not a global reset — B is untouched.
    expect(await peekMcpToken(ctx.root, { kind: 'task', taskId: bId }, `lazy-${bShort}`)).toBe(tokenB);
  });
});
